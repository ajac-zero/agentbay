import { CustomObjectsApi, KubeConfig, Watch } from "@kubernetes/client-node";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/config.js";
import { claimNameForExecutionAttempt } from "../../src/sandbox/naming.js";
import {
  SandboxClaimCleanupError,
  SandboxClaimExecutionAttemptProvisioner,
} from "../../src/sandbox/provisioner.js";
import type { ExecutionAttemptProvisioningInput, SandboxClaim } from "../../src/sandbox/types.js";

const NAMESPACE = "test-ns";
const input: ExecutionAttemptProvisioningInput = {
  connections: [],
  tenantId: "tenant-1",
  executionId: "execution-1",
  attempt: 2,
  profileVersion: { id: "profile-version-7", profileId: "profile-1", version: 7 },
  sandboxTemplate: "opencode-template",
  warmPool: "none",
  opencodeConfig: { agent: { coder: {} }, default_agent: "coder" },
  workspace: { type: "empty" },
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
  const authorization = "[]";
  return {
    "agentbay.dev/tenant-id": input.tenantId,
    "agentbay.dev/execution-id": input.executionId,
    "agentbay.dev/attempt": String(input.attempt),
    "agentbay.dev/profile-version-id": input.profileVersion.id,
    "agentbay.dev/profile-id": input.profileVersion.profileId,
    "agentbay.dev/profile-version": String(input.profileVersion.version),
    "agentbay.dev/workspace-digest": createHash("sha256").update('{"type":"empty"}').digest("hex"),
    "agentbay.dev/connections-digest": createHash("sha256").update(authorization).digest("hex"),
  };
}

function claim(ready = false): SandboxClaim {
  return {
    apiVersion: "extensions.agents.x-k8s.io/v1alpha1",
    kind: "SandboxClaim",
    metadata: {
      name: claimNameForExecutionAttempt(input.executionId, input.attempt),
      annotations: ownership(),
      labels: { "app.kubernetes.io/managed-by": "agentbay" },
    },
    spec: {
      sandboxTemplateRef: { name: input.sandboxTemplate },
      env: [{ containerName: "opencode", name: "OPENCODE_SERVER_PASSWORD", value: "existing-password" }],
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
      { containerName: "opencode", name: "OPENCODE_SERVER_USERNAME", value: "opencode" },
      { containerName: "opencode", name: "OPENCODE_CONFIG_CONTENT", value: JSON.stringify(input.opencodeConfig) },
      { containerName: "workspace-materializer", name: "AGENTBAY_WORKSPACE_TYPE", value: "empty" },
    ]));
    expect(created.spec?.env?.filter(({ name }) => name.startsWith("AGENTBAY_WORKSPACE_GIT_"))).toEqual([]);
    expect(created.spec?.env?.filter(({ name }) => name === "AGENTBAY_CONNECTIONS")).toEqual([]);
    expect(created.spec?.additionalPodMetadata?.annotations).toEqual({
      "agentbay.dev/connections-digest": createHash("sha256").update("[]").digest("hex"),
    });
  });

  it("groups sorted connection IDs into one canonical env value per sidecar", async () => {
    const connectionInput: ExecutionAttemptProvisioningInput = {
      ...input,
      connections: [
        { id: "zeta", sidecar: "mcp-b", type: "oauth", credentials: { token: "do-not-pass" } },
        { id: "charlie", sidecar: "mcp-a" },
        { id: "alpha", sidecar: "mcp-a" },
      ] as ExecutionAttemptProvisioningInput["connections"],
    };
    vi.spyOn(CustomObjectsApi.prototype, "getNamespacedCustomObject").mockRejectedValue({ code: 404 });
    const create = vi.spyOn(CustomObjectsApi.prototype, "createNamespacedCustomObject").mockImplementation(async ({ body }) => ({
      ...(body as SandboxClaim),
      status: {
        conditions: [{ type: "Ready", status: "True", lastTransitionTime: "", message: "" }],
        sandbox: { podIPs: ["10.0.0.8"] },
      },
    }));

    await provisioner().provision(connectionInput, new AbortController().signal);

    const created = create.mock.calls[0]![0].body as SandboxClaim;
    expect(created.spec?.env?.filter(({ name }) => name === "AGENTBAY_CONNECTIONS")).toEqual([
      {
        containerName: "mcp-a",
        name: "AGENTBAY_CONNECTIONS",
        value: '{"refs":["alpha","charlie"],"schemaVersion":1,"tenantId":"tenant-1"}',
      },
      {
        containerName: "mcp-b",
        name: "AGENTBAY_CONNECTIONS",
        value: '{"refs":["zeta"],"schemaVersion":1,"tenantId":"tenant-1"}',
      },
    ]);
    const authorization = '[{"id":"alpha","sidecar":"mcp-a"},{"id":"charlie","sidecar":"mcp-a"},{"id":"zeta","sidecar":"mcp-b"}]';
    const digest = createHash("sha256").update(authorization).digest("hex");
    expect(created.metadata.annotations).toMatchObject({ "agentbay.dev/connections-digest": digest });
    expect(created.metadata.annotations).not.toHaveProperty("agentbay.dev/connections");
    expect(created.spec?.additionalPodMetadata?.annotations).toEqual({
      "agentbay.dev/connections-digest": digest,
    });
    expect(JSON.stringify(created)).not.toContain("secret");
    expect(JSON.stringify(created)).not.toContain("credential");
  });

  it("digests canonical authorization sorted by ID independently of sidecar grouping", async () => {
    const connectionInput: ExecutionAttemptProvisioningInput = {
      ...input,
      connections: [
        { id: "alpha", sidecar: "z-sidecar" },
        { id: "zeta", sidecar: "a-sidecar" },
      ],
    };
    vi.spyOn(CustomObjectsApi.prototype, "getNamespacedCustomObject").mockRejectedValue({ code: 404 });
    const create = vi.spyOn(CustomObjectsApi.prototype, "createNamespacedCustomObject").mockImplementation(async ({ body }) => ({
      ...(body as SandboxClaim),
      status: {
        conditions: [{ type: "Ready", status: "True", lastTransitionTime: "", message: "" }],
        sandbox: { podIPs: ["10.0.0.8"] },
      },
    }));

    await provisioner().provision(connectionInput, new AbortController().signal);

    const created = create.mock.calls[0]![0].body as SandboxClaim;
    const authorization = '[{"id":"alpha","sidecar":"z-sidecar"},{"id":"zeta","sidecar":"a-sidecar"}]';
    expect(created.metadata.annotations?.["agentbay.dev/connections-digest"]).toBe(
      createHash("sha256").update(authorization).digest("hex"),
    );
    expect(created.metadata.annotations).not.toHaveProperty("agentbay.dev/connections");
    expect(created.spec?.env?.filter(({ name }) => name === "AGENTBAY_CONNECTIONS").map(({ containerName }) => containerName)).toEqual([
      "a-sidecar",
      "z-sidecar",
    ]);
  });

  it("adds git workspace materializer variables and omits credentials", async () => {
    const gitInput: ExecutionAttemptProvisioningInput = {
      ...input,
      workspace: {
        repository: { url: "https://example.com/repo.git" },
        revision: { commit: "0123456789abcdef", type: "commit" },
        type: "git",
      },
    };
    vi.spyOn(CustomObjectsApi.prototype, "getNamespacedCustomObject").mockRejectedValue({ code: 404 });
    const create = vi.spyOn(CustomObjectsApi.prototype, "createNamespacedCustomObject").mockImplementation(async ({ body }) => ({
      ...(body as SandboxClaim),
      status: {
        conditions: [{ type: "Ready", status: "True", lastTransitionTime: "", message: "" }],
        sandbox: { podIPs: ["10.0.0.8"] },
      },
    }));

    await provisioner().provision(gitInput, new AbortController().signal);

    const created = create.mock.calls[0]![0].body as SandboxClaim;
    const workspace = gitInput.workspace;
    if (workspace.type !== "git") throw new Error("Expected git workspace");
    expect(created.spec?.env).toEqual(expect.arrayContaining([
      { containerName: "workspace-materializer", name: "AGENTBAY_WORKSPACE_TYPE", value: "git" },
      { containerName: "workspace-materializer", name: "AGENTBAY_WORKSPACE_GIT_URL", value: workspace.repository.url },
      { containerName: "workspace-materializer", name: "AGENTBAY_WORKSPACE_GIT_COMMIT", value: workspace.revision.commit },
    ]));
    expect(created.spec).not.toHaveProperty("containers");
    expect(JSON.stringify(created)).not.toContain("credential");
  });

  it("rejects a git workspace with a warm pool before creating a claim", async () => {
    const get = vi.spyOn(CustomObjectsApi.prototype, "getNamespacedCustomObject");
    const create = vi.spyOn(CustomObjectsApi.prototype, "createNamespacedCustomObject");

    await expect(provisioner().provision({
      ...input,
      warmPool: "opencode-pool",
      workspace: {
        repository: { url: "https://example.com/repo.git" },
        revision: { commit: "0123456789abcdef", type: "commit" },
        type: "git",
      },
    }, new AbortController().signal)).rejects.toThrow(/warm pool/);
    expect(get).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects connections with a warm pool before reading or creating a claim", async () => {
    const get = vi.spyOn(CustomObjectsApi.prototype, "getNamespacedCustomObject");
    const create = vi.spyOn(CustomObjectsApi.prototype, "createNamespacedCustomObject");

    await expect(provisioner().provision({
      ...input,
      connections: [{ id: "github", sidecar: "mcp-proxy" }],
      warmPool: "opencode-pool",
    }, new AbortController().signal)).rejects.toThrow(/Connection authorization.*warm pool/);
    expect(get).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("never permits connection authorization to target opencode", async () => {
    const get = vi.spyOn(CustomObjectsApi.prototype, "getNamespacedCustomObject");

    await expect(provisioner().provision({
      ...input,
      connections: [{ id: "github", sidecar: "opencode" }],
    }, new AbortController().signal)).rejects.toThrow(/opencode/);
    expect(get).not.toHaveBeenCalled();
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

  it("rejects an existing claim when its workspace digest differs", async () => {
    const existing = claim(true);
    existing.metadata.annotations!["agentbay.dev/workspace-digest"] = "different";
    vi.spyOn(CustomObjectsApi.prototype, "getNamespacedCustomObject").mockResolvedValue(existing);
    const remove = vi.spyOn(CustomObjectsApi.prototype, "deleteNamespacedCustomObject");

    await expect(provisioner().provision(input, new AbortController().signal)).rejects.toThrow(/workspace-digest/);
    expect(remove).not.toHaveBeenCalled();
  });

  it("rejects an existing claim when its connection authorization digest differs", async () => {
    const existing = claim(true);
    existing.metadata.annotations!["agentbay.dev/connections-digest"] = "different";
    vi.spyOn(CustomObjectsApi.prototype, "getNamespacedCustomObject").mockResolvedValue(existing);
    const remove = vi.spyOn(CustomObjectsApi.prototype, "deleteNamespacedCustomObject");

    await expect(provisioner().provision(input, new AbortController().signal)).rejects.toThrow(/connections-digest/);
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

  it("rejects immediately when a watched claim reports Ready=False", async () => {
    vi.useFakeTimers();
    let deleted = false;
    vi.spyOn(CustomObjectsApi.prototype, "getNamespacedCustomObject").mockImplementation(async () => {
      if (deleted) throw { code: 404 };
      return claim();
    });
    vi.spyOn(CustomObjectsApi.prototype, "deleteNamespacedCustomObject").mockImplementation(async () => {
      deleted = true;
      return {};
    });
    let onEvent: ((phase: string, object: unknown) => void) | undefined;
    const watchController = new AbortController();
    vi.spyOn(Watch.prototype, "watch").mockImplementation(async (_path, _query, event) => {
      onEvent = event;
      return watchController;
    });

    const result = provisioner(10_000).provision(input, new AbortController().signal);
    await Promise.resolve();
    await Promise.resolve();
    const rejected = claim();
    rejected.status = {
      conditions: [{
        type: "Ready",
        status: "False",
        lastTransitionTime: "2026-07-17T12:00:01.000Z",
        reason: "ReconcilerError",
        message: "required sidecar is missing",
      }],
    };
    onEvent!("MODIFIED", rejected);

    await expect(result).rejects.toThrow(/was rejected: ReconcilerError: required sidecar is missing$/);
    expect(watchController.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("throws SandboxClaimCleanupError when readiness fails and deleting the claim fails", async () => {
    vi.spyOn(CustomObjectsApi.prototype, "getNamespacedCustomObject").mockResolvedValue(claim());
    let onEvent: ((phase: string, object: unknown) => void) | undefined;
    vi.spyOn(Watch.prototype, "watch").mockImplementation(async (_path, _query, event) => {
      onEvent = event;
      return new AbortController();
    });
    const cleanupFailure = new Error("claim deletion failed");
    vi.spyOn(CustomObjectsApi.prototype, "deleteNamespacedCustomObject").mockRejectedValue(cleanupFailure);

    const result = provisioner().provision(input, new AbortController().signal);
    await vi.waitFor(() => expect(onEvent).toBeDefined());
    const rejected = claim();
    rejected.status = {
      conditions: [{
        type: "Ready",
        status: "False",
        lastTransitionTime: "2026-07-17T12:00:01.000Z",
        reason: "ReconcilerError",
        message: "required sidecar is missing",
      }],
    };
    onEvent!("MODIFIED", rejected);

    const error = await result.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SandboxClaimCleanupError);
    expect((error as Error).cause).toBe(cleanupFailure);
  });

  it("ignores transient Ready=False and resolves when the claim later becomes ready", async () => {
    vi.useFakeTimers();
    vi.spyOn(CustomObjectsApi.prototype, "getNamespacedCustomObject").mockResolvedValue(claim());
    let onEvent: ((phase: string, object: unknown) => void) | undefined;
    const watchController = new AbortController();
    vi.spyOn(Watch.prototype, "watch").mockImplementation(async (_path, _query, event) => {
      onEvent = event;
      return watchController;
    });

    const result = provisioner(10_000).provision(input, new AbortController().signal);
    await Promise.resolve();
    await Promise.resolve();
    const pending = claim();
    pending.status = {
      conditions: [{
        type: "Ready",
        status: "False",
        lastTransitionTime: "2026-07-17T12:00:01.000Z",
        reason: "SandboxNotReady",
        message: "sandbox is still starting",
      }],
    };
    onEvent!("MODIFIED", pending);
    expect(watchController.signal.aborted).toBe(false);

    onEvent!("MODIFIED", claim(true));

    await expect(result).resolves.toMatchObject({ host: `sandbox-1.${NAMESPACE}.svc` });
    expect(watchController.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts a readiness wait and closes its watch", async () => {
    let deleted = false;
    vi.spyOn(CustomObjectsApi.prototype, "getNamespacedCustomObject").mockImplementation(async () => {
      if (deleted) throw { code: 404 };
      return claim();
    });
    vi.spyOn(CustomObjectsApi.prototype, "deleteNamespacedCustomObject").mockImplementation(async () => {
      deleted = true;
      return {};
    });
    const watchController = new AbortController();
    vi.spyOn(Watch.prototype, "watch").mockResolvedValue(watchController);
    const controller = new AbortController();
    const result = provisioner().provision(input, controller.signal);
    await flush();

    controller.abort();

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(watchController.signal.aborted).toBe(true);
  });

  it("throws SandboxClaimCleanupError when readiness is aborted and deleting the claim fails", async () => {
    vi.spyOn(CustomObjectsApi.prototype, "getNamespacedCustomObject").mockResolvedValue(claim());
    vi.spyOn(Watch.prototype, "watch").mockResolvedValue(new AbortController());
    const cleanupFailure = new Error("claim deletion failed");
    const remove = vi.spyOn(CustomObjectsApi.prototype, "deleteNamespacedCustomObject").mockRejectedValue(cleanupFailure);
    const controller = new AbortController();
    const result = provisioner().provision(input, controller.signal);
    await flush();

    controller.abort();

    const error = await result.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SandboxClaimCleanupError);
    expect((error as Error).cause).toBe(cleanupFailure);
    expect(remove).toHaveBeenCalledOnce();
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

  it("releases a cancelled execution claim using only cancellation ownership metadata", async () => {
    const cancellationClaim = claim(true);
    cancellationClaim.metadata.annotations = {
      "agentbay.dev/tenant-id": input.tenantId,
      "agentbay.dev/execution-id": input.executionId,
      "agentbay.dev/attempt": String(input.attempt),
    };
    cancellationClaim.metadata.uid = "claim-uid";
    const remove = vi.spyOn(CustomObjectsApi.prototype, "deleteNamespacedCustomObject").mockResolvedValue({});
    vi.spyOn(CustomObjectsApi.prototype, "getNamespacedCustomObject")
      .mockResolvedValueOnce(cancellationClaim)
      .mockRejectedValue({ code: 404 });

    await provisioner().releaseCancelledExecution({
      attempt: input.attempt,
      executionId: input.executionId,
      tenantId: input.tenantId,
      workloadName: claimNameForExecutionAttempt(input.executionId, input.attempt),
    }, new AbortController().signal);

    expect(remove).toHaveBeenCalledWith(expect.objectContaining({
      body: { preconditions: { uid: "claim-uid" } },
      name: claimNameForExecutionAttempt(input.executionId, input.attempt),
      propagationPolicy: "Foreground",
    }));
  });

  it("derives and releases the deterministic claim when a cancellation attempt has no workload name", async () => {
    const cancellationClaim = claim(true);
    cancellationClaim.metadata.uid = "claim-uid";
    const remove = vi.spyOn(CustomObjectsApi.prototype, "deleteNamespacedCustomObject").mockResolvedValue({});
    vi.spyOn(CustomObjectsApi.prototype, "getNamespacedCustomObject")
      .mockResolvedValueOnce(cancellationClaim)
      .mockRejectedValue({ code: 404 });

    await provisioner().releaseCancelledExecution({
      attempt: input.attempt,
      executionId: input.executionId,
      tenantId: input.tenantId,
      workloadName: null,
    }, new AbortController().signal);

    expect(remove).toHaveBeenCalledWith(expect.objectContaining({
      body: { preconditions: { uid: "claim-uid" } },
      name: claimNameForExecutionAttempt(input.executionId, input.attempt),
      propagationPolicy: "Foreground",
    }));
  });

  it("deletes a claim that appears after an initial missing read and waits for quiescence", async () => {
    const lateClaim = claim(true);
    lateClaim.metadata.uid = "late-uid";
    const get = vi.spyOn(CustomObjectsApi.prototype, "getNamespacedCustomObject")
      .mockRejectedValueOnce({ code: 404 })
      .mockResolvedValueOnce(lateClaim)
      .mockRejectedValue({ code: 404 });
    const remove = vi.spyOn(CustomObjectsApi.prototype, "deleteNamespacedCustomObject").mockResolvedValue({});

    await expect(provisioner(500).releaseCancelledExecution({
      attempt: input.attempt,
      executionId: input.executionId,
      tenantId: input.tenantId,
      workloadName: null,
    }, new AbortController().signal)).resolves.toBeUndefined();

    expect(get.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(remove).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith(expect.objectContaining({
      body: { preconditions: { uid: "late-uid" } },
    }));
  });

  it("deletes a replacement claim that appears after deleting the original", async () => {
    const original = claim(true);
    original.metadata.uid = "original-uid";
    const replacement = claim(true);
    replacement.metadata.uid = "replacement-uid";
    const get = vi.spyOn(CustomObjectsApi.prototype, "getNamespacedCustomObject")
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(replacement)
      .mockRejectedValue({ code: 404 });
    const remove = vi.spyOn(CustomObjectsApi.prototype, "deleteNamespacedCustomObject").mockResolvedValue({});

    await expect(provisioner(500).releaseCancelledExecution({
      attempt: input.attempt,
      executionId: input.executionId,
      tenantId: input.tenantId,
      workloadName: null,
    }, new AbortController().signal)).resolves.toBeUndefined();

    expect(get.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(remove).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenNthCalledWith(1, expect.objectContaining({
      body: { preconditions: { uid: "original-uid" } },
    }));
    expect(remove).toHaveBeenNthCalledWith(2, expect.objectContaining({
      body: { preconditions: { uid: "replacement-uid" } },
    }));
  });

  it("rejects quickly when deleting a persistent claim fails", async () => {
    const persistentClaim = claim(true);
    persistentClaim.metadata.uid = "persistent-uid";
    vi.spyOn(CustomObjectsApi.prototype, "getNamespacedCustomObject").mockResolvedValue(persistentClaim);
    const deletionFailure = new Error("claim deletion failed");
    const remove = vi.spyOn(CustomObjectsApi.prototype, "deleteNamespacedCustomObject").mockRejectedValue(deletionFailure);
    const startedAt = Date.now();

    await expect(provisioner(500).releaseCancelledExecution({
      attempt: input.attempt,
      executionId: input.executionId,
      tenantId: input.tenantId,
      workloadName: null,
    }, new AbortController().signal)).rejects.toBe(deletionFailure);

    expect(Date.now() - startedAt).toBeLessThan(300);
    expect(remove).toHaveBeenCalledOnce();
  });

  it("rejects a cancellation workload that is not the deterministic attempt claim", async () => {
    const get = vi.spyOn(CustomObjectsApi.prototype, "getNamespacedCustomObject");

    await expect(provisioner().releaseCancelledExecution({
      attempt: input.attempt,
      executionId: input.executionId,
      tenantId: input.tenantId,
      workloadName: "wrong-claim",
    }, new AbortController().signal)).rejects.toThrow("does not match expected claim");

    expect(get).not.toHaveBeenCalled();
  });

  it("does nothing for a cancelled execution without a workload", async () => {
    const get = vi.spyOn(CustomObjectsApi.prototype, "getNamespacedCustomObject");

    await expect(provisioner().releaseCancelledExecution({
      attempt: null,
      executionId: input.executionId,
      tenantId: input.tenantId,
      workloadName: null,
    }, new AbortController().signal)).resolves.toBeUndefined();

    expect(get).not.toHaveBeenCalled();
  });
});
