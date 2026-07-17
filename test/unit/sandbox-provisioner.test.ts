import { CustomObjectsApi, KubeConfig, Watch } from "@kubernetes/client-node";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/config.js";
import { claimNameForExecutionAttempt } from "../../src/sandbox/naming.js";
import { SandboxClaimExecutionAttemptProvisioner } from "../../src/sandbox/provisioner.js";
import type { ExecutionAttemptProvisioningInput, SandboxClaim } from "../../src/sandbox/types.js";

const NAMESPACE = "test-ns";
const input: ExecutionAttemptProvisioningInput = {
  tenantId: "tenant-1",
  executionId: "execution-1",
  attempt: 2,
  profileVersion: { id: "profile-version-7", profileId: "profile-1", version: 7 },
  sandboxTemplate: "opencode-template",
  warmPool: "opencode-pool",
  opencodeConfig: { agent: { coder: {} }, default_agent: "coder" },
  timeoutAt: new Date("2026-07-17T12:00:00.000Z"),
  ttlSecondsAfterFinished: 60,
};
const config: Config = {
  dispatcherEnabled: false,
  dispatcherIdlePollMs: 500,
  dispatcherLeaseDurationMs: 60_000,
  dispatcherRenewIntervalMs: 20_000,
  dispatcherWorkerId: "test-worker",
  executionMaintenanceBatchSize: 100,
  executionMaintenanceEnabled: true,
  executionMaintenanceIntervalMs: 5_000,
  executionMaxAttempts: 3,
  executionRetryDelayMs: 30_000,
  claimReadyTimeoutMs: 500,
  kubeNamespace: NAMESPACE,
  opencodeDirectory: "/workspace",
  opencodePort: 4096,
  port: 3000,
  sandboxClaimApiVersion: "v1alpha1",
};

function kubeConfig(): KubeConfig {
  const value = new KubeConfig();
  value.loadFromString(`apiVersion: v1
clusters:
- cluster: { server: https://localhost:6443 }
  name: test
contexts:
- context: { cluster: test, user: test }
  name: test
current-context: test
kind: Config
users:
- name: test
  user: { token: fake }
`);
  return value;
}

function ownership(): Record<string, string> {
  return {
    "agentbay.dev/tenant-id": input.tenantId,
    "agentbay.dev/execution-id": input.executionId,
    "agentbay.dev/attempt": String(input.attempt),
    "agentbay.dev/profile-version-id": input.profileVersion.id,
    "agentbay.dev/profile-id": input.profileVersion.profileId,
    "agentbay.dev/profile-version": String(input.profileVersion.version),
  };
}

function claim(ready = false): SandboxClaim {
  return {
    apiVersion: "extensions.agents.x-k8s.io/v1alpha1",
    kind: "SandboxClaim",
    metadata: { name: claimNameForExecutionAttempt(input.executionId, input.attempt), annotations: ownership() },
    spec: {
      sandboxTemplateRef: { name: input.sandboxTemplate },
      env: [{ name: "OPENCODE_SERVER_PASSWORD", value: "existing-password" }],
    },
    status: ready
      ? { conditions: [{ type: "Ready", status: "True", lastTransitionTime: "", message: "" }], sandbox: { name: "sandbox-1" } }
      : { conditions: [] },
  };
}

function provisioner(timeout = config.claimReadyTimeoutMs): SandboxClaimExecutionAttemptProvisioner {
  return new SandboxClaimExecutionAttemptProvisioner(kubeConfig(), { ...config, claimReadyTimeoutMs: timeout });
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("SandboxClaimExecutionAttemptProvisioner", () => {
  it("creates the exact attempt claim and returns its ready endpoint", async () => {
    vi.spyOn(CustomObjectsApi.prototype, "getNamespacedCustomObject").mockRejectedValue({ code: 404 });
    const create = vi.spyOn(CustomObjectsApi.prototype, "createNamespacedCustomObject").mockImplementation(async ({ body }) => {
      const created = body as SandboxClaim;
      return {
        ...created,
        status: {
          conditions: [{ type: "Ready", status: "True", lastTransitionTime: "", message: "" }],
          sandbox: { podIPs: ["10.0.0.8"] },
        },
      };
    });

    const result = await provisioner().provision(input, new AbortController().signal);

    expect(result).toMatchObject({
      workloadName: claimNameForExecutionAttempt(input.executionId, input.attempt),
      host: "10.0.0.8",
      password: expect.any(String),
    });
    const created = create.mock.calls[0]![0].body as SandboxClaim;
    expect(created.metadata.labels).toMatchObject({
      "app.kubernetes.io/managed-by": "agentbay",
      "agentbay.dev/execution": input.executionId,
      "agentbay.dev/attempt": "2",
      "agentbay.dev/profile": input.profileVersion.profileId,
    });
    expect(created.metadata.annotations).toEqual(ownership());
    expect(created.spec).toMatchObject({
      sandboxTemplateRef: { name: input.sandboxTemplate },
      warmpool: input.warmPool,
      lifecycle: {
        shutdownTime: input.timeoutAt.toISOString(),
        shutdownPolicy: "DeleteForeground",
        ttlSecondsAfterFinished: 60,
      },
    });
    expect(created.spec?.env).toEqual(expect.arrayContaining([
      { name: "OPENCODE_SERVER_USERNAME", value: "opencode" },
      { name: "OPENCODE_CONFIG_CONTENT", value: JSON.stringify(input.opencodeConfig) },
    ]));
  });

  it("observes an existing claim only when all ownership annotations match", async () => {
    vi.spyOn(CustomObjectsApi.prototype, "getNamespacedCustomObject").mockResolvedValue(claim(true));
    const create = vi.spyOn(CustomObjectsApi.prototype, "createNamespacedCustomObject");

    await expect(provisioner().provision(input, new AbortController().signal)).resolves.toEqual({
      workloadName: claimNameForExecutionAttempt(input.executionId, input.attempt),
      host: `sandbox-1.${NAMESPACE}.svc`,
      password: "existing-password",
      release: input,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("throws on an ownership mismatch without deleting the claim", async () => {
    const existing = claim(true);
    existing.metadata.annotations!["agentbay.dev/tenant-id"] = "other-tenant";
    vi.spyOn(CustomObjectsApi.prototype, "getNamespacedCustomObject").mockResolvedValue(existing);
    const remove = vi.spyOn(CustomObjectsApi.prototype, "deleteNamespacedCustomObject");

    await expect(provisioner().provision(input, new AbortController().signal)).rejects.toThrow(/not owned/);
    expect(remove).not.toHaveBeenCalled();
  });

  it("waits across watch reconnects until the claim is ready", async () => {
    vi.useFakeTimers();
    vi.spyOn(CustomObjectsApi.prototype, "getNamespacedCustomObject").mockResolvedValue(claim());
    const handles: Array<{ event: (phase: string, object: unknown) => void; done: (error: unknown) => void }> = [];
    vi.spyOn(Watch.prototype, "watch").mockImplementation(async (_path, _query, event, done) => {
      handles.push({ event, done });
      return new AbortController();
    });

    const result = provisioner(10_000).provision(input, new AbortController().signal);
    await Promise.resolve();
    await Promise.resolve();
    handles[0]!.done(null);
    await vi.advanceTimersByTimeAsync(1_001);
    handles[1]!.event("MODIFIED", claim(true));

    await expect(result).resolves.toMatchObject({ host: `sandbox-1.${NAMESPACE}.svc` });
  });

  it("aborts a readiness wait and closes its watch", async () => {
    vi.spyOn(CustomObjectsApi.prototype, "getNamespacedCustomObject").mockResolvedValue(claim());
    const watchController = new AbortController();
    vi.spyOn(Watch.prototype, "watch").mockResolvedValue(watchController);
    const controller = new AbortController();
    const result = provisioner().provision(input, controller.signal);
    await flush();

    controller.abort();

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(watchController.signal.aborted).toBe(true);
  });

  it("releases the deterministic claim with foreground propagation", async () => {
    const remove = vi.spyOn(CustomObjectsApi.prototype, "deleteNamespacedCustomObject").mockResolvedValue({});
    vi.spyOn(CustomObjectsApi.prototype, "getNamespacedCustomObject")
      .mockResolvedValueOnce(claim(true))
      .mockRejectedValue({ code: 404 });

    await provisioner().release(input, new AbortController().signal);

    expect(remove).toHaveBeenCalledWith(expect.objectContaining({
      name: claimNameForExecutionAttempt(input.executionId, input.attempt),
      propagationPolicy: "Foreground",
    }));
  });

  it("treats a missing claim as an idempotent release", async () => {
    const remove = vi.spyOn(CustomObjectsApi.prototype, "deleteNamespacedCustomObject");
    const get = vi.spyOn(CustomObjectsApi.prototype, "getNamespacedCustomObject").mockRejectedValue({ code: 404 });

    await expect(provisioner().release(input, new AbortController().signal)).resolves.toBeUndefined();
    expect(get).toHaveBeenCalledOnce();
    expect(remove).not.toHaveBeenCalled();
  });
});
