import assert from "node:assert/strict";
import {
  OPENCODE_SERVER_PASSWORD_ENV,
  buildSandboxClaim,
  ensureClaim,
  getClaimName,
  getClaimPassword,
  hashThreadId,
} from "../src/k8s/claim.ts";
import type { SandboxClaim } from "../src/k8s/client.ts";

async function main() {
  const threadId = "slack:C123:1234.567";
  const now = new Date("2026-01-01T00:00:00.000Z");
  const builtClaim = buildSandboxClaim(threadId, now);

  assert.equal(getClaimName(threadId), `wf-${hashThreadId(threadId).slice(0, 12)}`);
  assert.equal(builtClaim.metadata?.annotations?.["wolfgang.io/thread-id"], threadId);
  assert.equal(builtClaim.metadata?.labels?.["wolfgang.io/thread-id-hash"], hashThreadId(threadId));
  assert.equal(builtClaim.spec?.sandboxTemplateRef?.name, "opencode");
  assert.equal(
    builtClaim.spec?.env?.find((envVar) => envVar.name === OPENCODE_SERVER_PASSWORD_ENV)?.value,
    getClaimPassword(threadId),
  );
  assert.equal(builtClaim.spec?.lifecycle?.shutdownPolicy, "Delete");
  assert.equal(builtClaim.spec?.lifecycle?.shutdownTime, "2026-01-01T00:30:00.000Z");

  const pendingClaim = structuredClone(builtClaim);
  const readyClaim: SandboxClaim = {
    ...structuredClone(builtClaim),
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

  let getCallCount = 0;

  const client = {
    async get(name: string) {
      assert.equal(name, getClaimName(threadId));
      getCallCount += 1;

      if (getCallCount === 1) {
        const error = new Error("not found") as Error & { code: number };
        error.code = 404;
        throw error;
      }

      if (getCallCount === 2) {
        return pendingClaim;
      }

      return readyClaim;
    },
    async create(resource: SandboxClaim) {
      assert.deepEqual(resource, builtClaim);
      return resource;
    },
  };

  const result = await ensureClaim(threadId, {
    client,
    now,
    pollIntervalMs: 0,
    readyTimeoutMs: 10,
    sleep: async () => {},
  });

  assert.equal(result.claimName, getClaimName(threadId));
  assert.equal(result.password, getClaimPassword(threadId));
  assert.equal(result.podIP, "10.0.0.42");
  assert.deepEqual(result.claim, readyClaim);

  console.log("ensure-claim smoke test passed");
}

main().catch((error: unknown) => {
  console.error("ensure-claim smoke test failed", error);
  process.exit(1);
});
