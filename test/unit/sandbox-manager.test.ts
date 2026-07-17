/**
 * Unit tests for SandboxManager.waitForReady and SandboxManager.waitForDeleted.
 *
 * Both methods are private, so they are exercised via (manager as any). This
 * avoids wiring up the full claimFor / releaseClaim flow (which needs
 * createNamespacedCustomObject, buildClaim, etc.) and keeps the tests focused
 * on the watch event handling logic.
 *
 * The Kubernetes Watch and CustomObjectsApi are controlled through
 * vi.spyOn(…prototype…) which affects all instances and is restored in
 * afterEach.
 */

import { CustomObjectsApi, KubeConfig, Watch } from "@kubernetes/client-node";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/config.js";
import { SandboxManager } from "../../src/sandbox/manager.js";
import type { SandboxClaim, SandboxClaimCondition } from "../../src/sandbox/types.js";

// ---------------------------------------------------------------------------
// Config fixture
// ---------------------------------------------------------------------------

const CLAIM_NAME = "agentbay-abc123";
const NAMESPACE = "test-ns";
const PASSWORD = "s3cret";

const testConfig: Config = {
  botUserName: "agentbay",
  executionMaintenanceBatchSize: 100,
  executionMaintenanceEnabled: true,
  executionMaintenanceIntervalMs: 5_000,
  executionMaxAttempts: 3,
  executionRetryDelayMs: 30_000,
  claimReadyTimeoutMs: 500,
  claimShutdownHours: 1,
  claimTtlSecondsAfterFinished: 60,
  kubeNamespace: NAMESPACE,
  opencodeDirectory: "/workspace",
  opencodePort: 4096,
  port: 3000,
  sandboxClaimApiVersion: "v1alpha1",
  discord: { enabled: false },
  gchat: { enabled: false },
  github: { enabled: false },
  linear: { enabled: false },
  messenger: { enabled: false },
  slack: { enabled: false },
  teams: { enabled: false },
  telegram: { enabled: false },
  whatsapp: { enabled: false },
};

// ---------------------------------------------------------------------------
// KubeConfig factory (minimal but valid — no real cluster needed)
// ---------------------------------------------------------------------------

function makeKubeConfig(): KubeConfig {
  const kc = new KubeConfig();
  kc.loadFromString(`\
apiVersion: v1
clusters:
- cluster:
    server: https://localhost:6443
  name: test
contexts:
- context:
    cluster: test
    user: test
  name: test
current-context: test
kind: Config
users:
- name: test
  user:
    token: fake-token
`);
  return kc;
}

// ---------------------------------------------------------------------------
// SandboxClaim builders
// ---------------------------------------------------------------------------

function notReadyClaim(name = CLAIM_NAME): SandboxClaim {
  return {
    apiVersion: "extensions.agents.x-k8s.io/v1alpha1",
    kind: "SandboxClaim",
    metadata: { name, namespace: NAMESPACE },
    status: { conditions: [] },
  };
}

function readyCondition(): SandboxClaimCondition {
  return { type: "Ready", status: "True", lastTransitionTime: "", message: "", reason: "" };
}

function readyClaim(name = CLAIM_NAME, opts: { sandboxName?: string; podIPs?: string[] } = {}): SandboxClaim {
  return {
    apiVersion: "extensions.agents.x-k8s.io/v1alpha1",
    kind: "SandboxClaim",
    metadata: { name, namespace: NAMESPACE },
    status: {
      conditions: [readyCondition()],
      ...(opts.sandboxName || opts.podIPs
        ? { sandbox: { name: opts.sandboxName, podIPs: opts.podIPs } }
        : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Fake Watch infrastructure
// ---------------------------------------------------------------------------

type WatchCb = (phase: string, obj: unknown) => void;
type DoneCb = (err: unknown) => void;

interface WatchHandle {
  callback: WatchCb;
  done: DoneCb;
}

/**
 * Spies on Watch.prototype.watch and returns a `handles` array that tests
 * use to fire events and close the stream at will.
 *
 * Must be called inside a test (or beforeEach); vi.restoreAllMocks() in
 * afterEach automatically removes the spy.
 */
function makeFakeWatch(): { handles: WatchHandle[]; spy: ReturnType<typeof vi.spyOn> } {
  const handles: WatchHandle[] = [];
  const spy = vi.spyOn(Watch.prototype, "watch").mockImplementation(
    async (_path: string, _params: unknown, cb: WatchCb, done: DoneCb): Promise<AbortController> => {
      const ctrl = new AbortController();
      handles.push({ callback: cb, done });
      return ctrl;
    },
  );
  return { handles, spy };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManager(): SandboxManager {
  return new SandboxManager(makeKubeConfig(), testConfig);
}

/** Flush pending microtasks + one macro-task turn so startWatch can complete. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Like flush() but works when fake timers are active — uses only microtask
 * ticks so it is not captured by vi.useFakeTimers().
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

/** Call the private waitForReady with a stub logger. */
function waitForReady(manager: SandboxManager, initial: SandboxClaim): Promise<{ claimName: string; password: string; podFQDN: string }> {
  const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => log };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (manager as any).waitForReady(initial, PASSWORD, log);
}

/** Call the private waitForDeleted. */
function waitForDeleted(manager: SandboxManager, name = CLAIM_NAME): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (manager as any).waitForDeleted(name);
}

// ---------------------------------------------------------------------------
// waitForReady
// ---------------------------------------------------------------------------

describe("SandboxManager.waitForReady", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("resolves immediately when initial claim is already Ready (fast path, no watch opened)", async () => {
    const { spy } = makeFakeWatch();

    const result = await waitForReady(makeManager(), readyClaim(CLAIM_NAME, { sandboxName: "sb-1" }));

    expect(result).toMatchObject({ claimName: CLAIM_NAME, password: PASSWORD, podFQDN: `sb-1.${NAMESPACE}.svc` });
    expect(spy).not.toHaveBeenCalled();
  });

  it("resolves on ADDED event that carries Ready condition", async () => {
    const { handles } = makeFakeWatch();

    const promise = waitForReady(makeManager(), notReadyClaim());
    await flush();

    handles[0]!.callback("ADDED", readyClaim(CLAIM_NAME, { podIPs: ["10.0.0.1"] }));

    await expect(promise).resolves.toMatchObject({ claimName: CLAIM_NAME, podFQDN: "10.0.0.1" });
  });

  it("resolves on MODIFIED event that carries Ready condition", async () => {
    const { handles } = makeFakeWatch();

    const promise = waitForReady(makeManager(), notReadyClaim());
    await flush();

    // First MODIFIED: still not ready
    handles[0]!.callback("MODIFIED", notReadyClaim());
    // Second MODIFIED: ready
    handles[0]!.callback("MODIFIED", readyClaim(CLAIM_NAME, { sandboxName: "sb-mod" }));

    await expect(promise).resolves.toMatchObject({ podFQDN: `sb-mod.${NAMESPACE}.svc` });
  });

  it("rejects immediately on DELETED event", async () => {
    const { handles } = makeFakeWatch();

    const promise = waitForReady(makeManager(), notReadyClaim());
    await flush();

    handles[0]!.callback("DELETED", notReadyClaim());

    await expect(promise).rejects.toThrow(/deleted before becoming Ready/);
  });

  it("ignores unrecognised phases and waits for Ready", async () => {
    const { handles } = makeFakeWatch();

    const promise = waitForReady(makeManager(), notReadyClaim());
    await flush();

    handles[0]!.callback("BOOKMARK", {});
    handles[0]!.callback("MODIFIED", readyClaim(CLAIM_NAME, { podIPs: ["10.1.2.3"] }));

    await expect(promise).resolves.toMatchObject({ podFQDN: "10.1.2.3" });
  });

  it("uses podIPs[0] as podFQDN when present", async () => {
    const { handles } = makeFakeWatch();

    const promise = waitForReady(makeManager(), notReadyClaim());
    await flush();

    handles[0]!.callback("MODIFIED", readyClaim(CLAIM_NAME, { podIPs: ["192.168.1.5", "10.0.0.1"] }));

    await expect(promise).resolves.toMatchObject({ podFQDN: "192.168.1.5" });
  });

  it("falls back to <sandboxName>.<namespace>.svc when no podIPs", async () => {
    const { handles } = makeFakeWatch();

    const promise = waitForReady(makeManager(), notReadyClaim());
    await flush();

    handles[0]!.callback("MODIFIED", readyClaim(CLAIM_NAME, { sandboxName: "my-sandbox" }));

    await expect(promise).resolves.toMatchObject({ podFQDN: `my-sandbox.${NAMESPACE}.svc` });
  });

  it("rejects when a Ready claim has neither podIPs nor sandboxName", async () => {
    const { handles } = makeFakeWatch();

    const promise = waitForReady(makeManager(), notReadyClaim());
    await flush();

    // Ready but no address information
    handles[0]!.callback("MODIFIED", readyClaim(CLAIM_NAME));

    await expect(promise).rejects.toThrow(/did not expose/);
  });

  it("reconnects the watch when done fires before Ready, then resolves", async () => {
    vi.useFakeTimers();

    const { handles } = makeFakeWatch();
    // Use a long deadline so it does not race with the 1 000 ms reconnect timer.
    const manager = new SandboxManager(makeKubeConfig(), { ...testConfig, claimReadyTimeoutMs: 10_000 });

    const promise = waitForReady(manager, notReadyClaim());
    await flushMicrotasks();

    expect(handles).toHaveLength(1);

    // First watch closes without a Ready event
    handles[0]!.done(null);

    // Advance past the reconnect delay (Math.min(1 000, remaining) = 1 000 ms)
    await vi.advanceTimersByTimeAsync(1_001);
    await flushMicrotasks();

    expect(handles).toHaveLength(2);

    handles[1]!.callback("MODIFIED", readyClaim(CLAIM_NAME, { sandboxName: "sb-reconnect" }));

    await expect(promise).resolves.toMatchObject({ podFQDN: `sb-reconnect.${NAMESPACE}.svc` });
  });

  it("rejects with a timeout error when claimReadyTimeoutMs elapses", async () => {
    vi.useFakeTimers();

    makeFakeWatch();

    const promise = waitForReady(makeManager(), notReadyClaim());
    await flushMicrotasks();

    // Attach the assertion handler BEFORE advancing time so the rejection is
    // handled immediately and Node does not fire unhandledRejection.
    const assertion = expect(promise).rejects.toThrow(/Timed out waiting for SandboxClaim.*to become Ready/);
    await vi.advanceTimersByTimeAsync(testConfig.claimReadyTimeoutMs + 10);
    await assertion;
  });

  it("passes the correct field selector to the watch call", async () => {
    const { handles, spy } = makeFakeWatch();

    const promise = waitForReady(makeManager(), notReadyClaim());
    await flush();

    const [path, params] = spy.mock.calls[0]!;
    expect(path).toBe(`/apis/extensions.agents.x-k8s.io/v1alpha1/namespaces/${NAMESPACE}/sandboxclaims`);
    expect(params).toMatchObject({ fieldSelector: `metadata.name=${CLAIM_NAME}` });

    // Resolve the promise so the test doesn't hang
    handles[0]!.callback("MODIFIED", readyClaim(CLAIM_NAME, { sandboxName: "sb-x" }));
    await promise;
  });
});

// ---------------------------------------------------------------------------
// waitForDeleted
// ---------------------------------------------------------------------------

describe("SandboxManager.waitForDeleted", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("resolves immediately when initial getClaim returns null (already deleted)", async () => {
    const { spy: watchSpy } = makeFakeWatch();
    vi.spyOn(CustomObjectsApi.prototype, "getNamespacedCustomObject").mockRejectedValue({ code: 404 });

    await expect(waitForDeleted(makeManager())).resolves.toBeUndefined();
    expect(watchSpy).not.toHaveBeenCalled();
  });

  it("resolves when watch delivers a DELETED event", async () => {
    const { handles } = makeFakeWatch();
    vi.spyOn(CustomObjectsApi.prototype, "getNamespacedCustomObject").mockResolvedValue(notReadyClaim());

    const promise = waitForDeleted(makeManager());
    await flush();

    handles[0]!.callback("DELETED", {});

    await expect(promise).resolves.toBeUndefined();
  });

  it("resolves when watch closes and getClaim shows the claim is gone", async () => {
    const { handles } = makeFakeWatch();
    vi.spyOn(CustomObjectsApi.prototype, "getNamespacedCustomObject")
      .mockResolvedValueOnce(notReadyClaim()) // initial check: exists → open watch
      .mockRejectedValueOnce({ code: 404 }); // onDone check: gone → resolve

    const promise = waitForDeleted(makeManager());
    await flush();

    // Watch closes (e.g. server-side timeout) without delivering DELETED
    handles[0]!.done(null);
    // Give onDone's getClaim().then() time to run
    await flush();

    await expect(promise).resolves.toBeUndefined();
  });

  it("reconnects after watch closes when claim still exists, then resolves on DELETED", async () => {
    vi.useFakeTimers();

    const { handles } = makeFakeWatch();
    vi.spyOn(CustomObjectsApi.prototype, "getNamespacedCustomObject").mockResolvedValue(notReadyClaim());

    // Use a long deadline so it does not race with the 1 000 ms reconnect timer.
    const manager = new SandboxManager(makeKubeConfig(), { ...testConfig, claimReadyTimeoutMs: 10_000 });
    const promise = waitForDeleted(manager);
    await flushMicrotasks();

    expect(handles).toHaveLength(1);

    // Watch closes; getClaim still returns the claim → reconnect
    handles[0]!.done(null);
    await vi.advanceTimersByTimeAsync(1_001);
    await flushMicrotasks();

    expect(handles).toHaveLength(2);

    handles[1]!.callback("DELETED", {});

    await expect(promise).resolves.toBeUndefined();
  });

  it("rejects with a timeout error when claimReadyTimeoutMs elapses", async () => {
    vi.useFakeTimers();

    makeFakeWatch();
    vi.spyOn(CustomObjectsApi.prototype, "getNamespacedCustomObject").mockResolvedValue(notReadyClaim());

    const promise = waitForDeleted(makeManager());
    await flushMicrotasks();

    // Attach the assertion handler BEFORE advancing time so the rejection is
    // handled immediately and Node does not fire unhandledRejection.
    const assertion = expect(promise).rejects.toThrow(/Timed out waiting for SandboxClaim.*to be deleted/);
    await vi.advanceTimersByTimeAsync(testConfig.claimReadyTimeoutMs + 10);
    await assertion;
  });
});
