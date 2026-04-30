import { describe, expect, it, vi } from "vite-plus/test";

process.env.PORT ??= "3000";
process.env.NAMESPACE ??= "agent-sandbox";
process.env.KUBERNETES_CLUSTER_DOMAIN ??= "cluster.local";
process.env.SANDBOX_TEMPLATE_NAME ??= "opencode";
process.env.SANDBOX_ACCESS_MODE ??= "direct";
process.env.SANDBOX_ROUTER_URL ??= "http://sandbox-router.agent-sandbox.svc.cluster.local:8080";
process.env.SANDBOX_PORT ??= "8888";
process.env.SANDBOX_IDLE_TTL_MINUTES ??= "30";
process.env.SANDBOX_READY_TIMEOUT_SECONDS ??= "60";
process.env.STATE_BACKEND_URL ??= "redis://redis.default.svc.cluster.local:6379";

const modulePromise = import("./claim.ts");

describe("ensureClaim", () => {
  it("creates a new claim without refreshing lifecycle when it does not exist", async () => {
    const { ensureClaim, buildSandboxClaim, getClaimName, getClaimPassword } = await modulePromise;
    const threadId = "thread-new";
    const now = new Date("2026-01-01T00:00:00.000Z");
    const readyClaim = createReadyClaim(buildSandboxClaim(threadId, now), "10.0.0.10");
    const client = {
      get: vi.fn(async () => {
        const error = new Error("not found") as Error & { code: number };
        error.code = 404;
        throw error;
      }),
      create: vi.fn(async () => readyClaim),
      patch: vi.fn(async () => readyClaim),
    };
    const readinessGate = createReadinessGate(readyClaim);

    const result = await ensureClaim(threadId, {
      client: client as any,
      now,
      readinessGate: readinessGate as any,
      readyTimeoutMs: 10,
    });

    expect(client.create).toHaveBeenCalledWith(buildSandboxClaim(threadId, now));
    expect(client.patch).not.toHaveBeenCalled();
    expect(readinessGate.waitForReady).toHaveBeenCalledWith(readyClaim, { timeoutMs: 10 });
    expect(result).toEqual({
      claim: readyClaim,
      claimName: getClaimName(threadId),
      password: getClaimPassword(threadId),
      podIP: "10.0.0.10",
    });
  });

  it("refreshes shutdownTime on an existing claim before waiting for readiness", async () => {
    const { ensureClaim, buildSandboxClaim, getClaimName, getSandboxShutdownTime } =
      await modulePromise;
    const threadId = "thread-existing";
    const now = new Date("2026-01-01T00:05:00.000Z");
    const existingClaim = buildSandboxClaim(threadId, new Date("2026-01-01T00:00:00.000Z"));
    const refreshedClaim = createReadyClaim(existingClaim, "10.0.0.20", "2", {
      shutdownTime: getSandboxShutdownTime(now),
    });
    const client = {
      get: vi.fn(async () => existingClaim),
      create: vi.fn(async () => refreshedClaim),
      patch: vi.fn(async () => refreshedClaim),
    };
    const readinessGate = createReadinessGate(refreshedClaim);

    const result = await ensureClaim(threadId, {
      client: client as any,
      now,
      readinessGate: readinessGate as any,
      readyTimeoutMs: 25,
    });

    expect(client.create).not.toHaveBeenCalled();
    expect(client.patch).toHaveBeenCalledWith({
      apiVersion: "extensions.agents.x-k8s.io/v1alpha1",
      kind: "SandboxClaim",
      metadata: {
        name: getClaimName(threadId),
        namespace: "agent-sandbox",
      },
      spec: {
        lifecycle: {
          shutdownPolicy: "Delete",
          shutdownTime: getSandboxShutdownTime(now),
        },
      },
    });
    expect(readinessGate.waitForReady).toHaveBeenCalledWith(refreshedClaim, { timeoutMs: 25 });
    expect(result.claim.spec?.lifecycle?.shutdownTime).toBe(getSandboxShutdownTime(now));
  });
});

function createReadinessGate(claim: unknown) {
  return {
    waitForReady: vi.fn(async () => claim),
  };
}

function createReadyClaim(
  claim: Record<string, any>,
  podIP: string,
  resourceVersion = "1",
  options: {
    shutdownTime?: string;
  } = {},
) {
  return {
    ...structuredClone(claim),
    metadata: {
      ...structuredClone(claim.metadata),
      resourceVersion,
    },
    spec: {
      ...structuredClone(claim.spec),
      lifecycle: {
        ...structuredClone(claim.spec?.lifecycle),
        ...(options.shutdownTime === undefined ? {} : { shutdownTime: options.shutdownTime }),
      },
    },
    status: {
      conditions: [
        {
          type: "Ready",
          status: "True",
        },
      ],
      sandbox: {
        podIPs: [podIP],
      },
    },
  };
}
