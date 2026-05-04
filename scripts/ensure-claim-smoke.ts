import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import {
  OPENCODE_SERVER_PASSWORD_ENV,
  SandboxClaimReadinessGate,
  buildSandboxClaim,
  ensureClaim,
  getClaimName,
  getClaimPassword,
  hashThreadId,
  waitForSandboxClaimReady,
  type SandboxClaimWatchSource,
} from "../src/k8s/claim.ts";
import type { SandboxClaim } from "../src/k8s/client.ts";

class FakeSandboxClaimWatchSource implements SandboxClaimWatchSource {
  startCount = 0;
  private readonly subscriptions = new Map<
    string,
    {
      onEvent: (claim: SandboxClaim) => void;
      onDelete: (claim: SandboxClaim) => void;
      onError: (error: unknown) => void;
    }
  >();

  async start(options: {
    claimName: string;
    resourceVersion?: string;
    onEvent: (claim: SandboxClaim) => void;
    onDelete: (claim: SandboxClaim) => void;
    onError: (error: unknown) => void;
  }) {
    this.startCount += 1;
    this.subscriptions.set(options.claimName, {
      onEvent: options.onEvent,
      onDelete: options.onDelete,
      onError: options.onError,
    });

    return () => {
      this.subscriptions.delete(options.claimName);
    };
  }

  emit(claim: SandboxClaim) {
    const claimName = claim.metadata?.name;
    if (claimName === undefined) {
      throw new Error("SandboxClaim metadata.name is required");
    }

    this.subscriptions.get(claimName)?.onEvent(claim);
  }

  delete(claim: SandboxClaim) {
    const claimName = claim.metadata?.name;
    if (claimName === undefined) {
      throw new Error("SandboxClaim metadata.name is required");
    }

    this.subscriptions.get(claimName)?.onDelete(claim);
  }

  fail(claimName: string, error: unknown) {
    this.subscriptions.get(claimName)?.onError(error);
  }
}

async function main() {
  const threadId = "slack:C123:1234.567";
  const now = new Date("2026-01-01T00:00:00.000Z");
  const builtClaim = buildSandboxClaim(threadId, now);
  const claimName = getClaimName(threadId);

  assert.equal(claimName, `ab-${hashThreadId(threadId).slice(0, 12)}`);
  assert.equal(builtClaim.metadata?.annotations?.["agentbay.io/thread-id"], threadId);
  assert.equal(builtClaim.metadata?.labels?.["agentbay.io/thread-id-hash"], hashThreadId(threadId));
  assert.equal(builtClaim.spec?.sandboxTemplateRef?.name, "opencode");
  assert.equal(
    builtClaim.spec?.env?.find((envVar) => envVar.name === OPENCODE_SERVER_PASSWORD_ENV)?.value,
    getClaimPassword(threadId),
  );
  assert.equal(builtClaim.spec?.lifecycle?.shutdownPolicy, "Delete");
  assert.equal(builtClaim.spec?.lifecycle?.shutdownTime, "2026-01-01T00:30:00.000Z");

  const pendingClaim: SandboxClaim = {
    ...structuredClone(builtClaim),
    metadata: cloneMetadata(builtClaim, "1"),
  };

  const readyClaim: SandboxClaim = {
    ...structuredClone(builtClaim),
    metadata: cloneMetadata(builtClaim, "2"),
    status: {
      conditions: [
        {
          type: "Ready",
          status: "True",
        },
      ],
      sandbox: {
        podIPs: ["10.0.0.42"],
      },
    },
  };

  const failedClaim: SandboxClaim = {
    ...structuredClone(builtClaim),
    metadata: cloneMetadata(builtClaim, "3"),
    status: {
      conditions: [
        {
          type: "Failed",
          status: "True",
          reason: "SchedulingFailed",
          message: "no nodes matched",
        },
      ],
    },
  };

  const sharedWatchSource = new FakeSandboxClaimWatchSource();
  const readinessGate = new SandboxClaimReadinessGate(sharedWatchSource);

  const waiterA = waitForSandboxClaimReady(pendingClaim, {
    timeoutMs: 50,
    readinessGate,
  });
  const waiterB = readinessGate.waitForReady(pendingClaim, { timeoutMs: 50 });

  assert.equal(sharedWatchSource.startCount, 1);

  queueMicrotask(() => {
    sharedWatchSource.emit(readyClaim);
  });

  const [readyFromWaiterA, readyFromWaiterB] = await Promise.all([waiterA, waiterB]);
  assert.deepEqual(readyFromWaiterA, readyClaim);
  assert.deepEqual(readyFromWaiterB, readyClaim);

  const failureWatchSource = new FakeSandboxClaimWatchSource();
  const failureGate = new SandboxClaimReadinessGate(failureWatchSource);
  const failureWait = failureGate.waitForReady(pendingClaim, { timeoutMs: 50 });
  await waitFor(() => failureWatchSource.startCount === 1);
  failureWatchSource.emit(failedClaim);

  await assert.rejects(failureWait, /terminal state: Failed: SchedulingFailed: no nodes matched/);

  const ensureWatchSource = new FakeSandboxClaimWatchSource();
  const ensureGate = new SandboxClaimReadinessGate(ensureWatchSource);

  let getCallCount = 0;
  const client = {
    async get(name: string) {
      assert.equal(name, claimName);
      getCallCount += 1;

      if (getCallCount === 1) {
        const error = new Error("not found") as Error & { code: number };
        error.code = 404;
        throw error;
      }

      return pendingClaim;
    },
    async create(resource: SandboxClaim) {
      assert.deepEqual(resource, builtClaim);
      return pendingClaim;
    },
    async patch() {
      throw new Error("patch should not be called when the claim is created in this flow");
    },
  };

  const ensurePromise = ensureClaim(threadId, {
    client,
    now,
    readyTimeoutMs: 50,
    readinessGate: ensureGate,
  });
  await waitFor(() => ensureWatchSource.startCount === 1);
  ensureWatchSource.emit(readyClaim);

  const result = await ensurePromise;

  assert.equal(result.claimName, claimName);
  assert.equal(result.password, getClaimPassword(threadId));
  assert.equal(result.podIP, "10.0.0.42");
  assert.deepEqual(result.claim, readyClaim);

  console.log("ensure-claim smoke test passed");
}

async function waitFor(predicate: () => boolean, timeoutMs = 50) {
  const startedAt = Date.now();

  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`condition was not met within ${timeoutMs}ms`);
    }

    await sleep(0);
  }
}

function cloneMetadata(claim: SandboxClaim, resourceVersion: string) {
  return {
    name: claim.metadata?.name,
    namespace: claim.metadata?.namespace,
    labels: structuredClone(claim.metadata?.labels),
    annotations: structuredClone(claim.metadata?.annotations),
    resourceVersion,
  };
}

main().catch((error: unknown) => {
  console.error("ensure-claim smoke test failed", error);
  process.exit(1);
});
