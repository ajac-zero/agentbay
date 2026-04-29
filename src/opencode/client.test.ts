import { describe, expect, it, vi } from "vite-plus/test";
import type { Sandbox, SandboxClaim } from "../k8s/client.ts";

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

const modulePromise = import("./client.ts");

describe("createOpenCodeClient", () => {
  it("targets sandbox service DNS by default and sends basic auth without router headers", async () => {
    const { createOpenCodeClient, buildOpenCodeAuthorizationHeader } = await modulePromise;
    const requests: Request[] = [];

    const client = await createOpenCodeClient({
      claimName: "wf-claim",
      password: "super-secret",
      claimClient: {
        get: vi.fn(async () =>
          createSandboxClaim({
            claimName: "wf-claim",
            sandboxName: "sandbox-adopted",
          }),
        ),
      },
      sandboxClient: {
        get: vi.fn(async (name: string) =>
          createSandbox({
            sandboxName: name,
            serviceFQDN: "sandbox-adopted.agent-sandbox.svc.cluster.local",
          }),
        ),
      },
      fetchImplementation: async (request) => {
        requests.push(toRequest(request));
        return jsonResponse({ id: "session-123" });
      },
    });

    await client.session.get({ sessionID: "session-123" });

    expect(requests).toHaveLength(1);

    const request = requests[0];
    expect(request.url).toBe(
      "http://sandbox-adopted.agent-sandbox.svc.cluster.local:8888/session/session-123",
    );
    expect(request.headers.get("Authorization")).toBe(
      buildOpenCodeAuthorizationHeader("super-secret"),
    );
    expect(request.headers.get("X-Sandbox-ID")).toBeNull();
    expect(request.headers.get("X-Sandbox-Namespace")).toBeNull();
    expect(request.headers.get("X-Sandbox-Port")).toBeNull();
    expect(request.headers.get("X-Request-ID")).toBeNull();
  });

  it("supports router mode with routing headers and per-request IDs", async () => {
    const { createOpenCodeClient, buildOpenCodeAuthorizationHeader } = await modulePromise;
    const requests: Request[] = [];

    const client = await createOpenCodeClient({
      claimName: "wf-claim",
      password: "router-secret",
      accessMode: "router",
      routerUrl: new URL("http://sandbox-router.agent-sandbox.svc.cluster.local:8080"),
      requestIdFactory: () => "req-123",
      claimClient: {
        get: vi.fn(async () =>
          createSandboxClaim({
            claimName: "wf-claim",
            sandboxName: "sandbox-from-claim",
          }),
        ),
      },
      fetchImplementation: async (request) => {
        requests.push(toRequest(request));
        return jsonResponse({ id: "session-123" });
      },
    });

    await client.session.get({ sessionID: "session-123" });

    expect(requests).toHaveLength(1);

    const request = requests[0];
    expect(request.url).toBe(
      "http://sandbox-router.agent-sandbox.svc.cluster.local:8080/session/session-123",
    );
    expect(request.headers.get("Authorization")).toBe(
      buildOpenCodeAuthorizationHeader("router-secret"),
    );
    expect(request.headers.get("X-Sandbox-ID")).toBe("sandbox-from-claim");
    expect(request.headers.get("X-Sandbox-Namespace")).toBe("agent-sandbox");
    expect(request.headers.get("X-Sandbox-Port")).toBe("8888");
    expect(request.headers.get("X-Request-ID")).toBe("req-123");
  });

  it("adds auth_token to SSE requests", async () => {
    const { createOpenCodeClient } = await modulePromise;
    const requests: Request[] = [];

    const client = await createOpenCodeClient({
      claimName: "wf-claim",
      password: "stream-secret",
      claimClient: {
        get: vi.fn(async () =>
          createSandboxClaim({
            claimName: "wf-claim",
            sandboxName: "sandbox-stream",
          }),
        ),
      },
      sandboxClient: {
        get: vi.fn(async (name: string) =>
          createSandbox({
            sandboxName: name,
            serviceFQDN: "sandbox-stream.agent-sandbox.svc.cluster.local",
          }),
        ),
      },
      fetchImplementation: async (request) => {
        requests.push(toRequest(request));
        return sseResponse([JSON.stringify({ hello: "world" })]);
      },
    });

    const { stream } = await client.event.subscribe();
    const firstEvent = await stream.next();

    expect(firstEvent.done).toBe(false);
    expect(firstEvent.value).toEqual({ hello: "world" });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(
      "http://sandbox-stream.agent-sandbox.svc.cluster.local:8888/event?auth_token=stream-secret",
    );
  });

  it("re-resolves the current sandbox target when a claim points at a new sandbox", async () => {
    const { createOpenCodeClient } = await modulePromise;
    const requests: Request[] = [];
    let claimReadCount = 0;

    const claimClient = {
      get: vi.fn(async () => {
        claimReadCount += 1;

        return createSandboxClaim({
          claimName: "wf-claim",
          sandboxName: claimReadCount === 1 ? "sandbox-a" : "sandbox-b",
        });
      }),
    };

    const sandboxClient = {
      get: vi.fn(async (name: string) =>
        createSandbox({
          sandboxName: name,
          serviceFQDN: `${name}.agent-sandbox.svc.cluster.local`,
        }),
      ),
    };

    const clientA = await createOpenCodeClient({
      claimName: "wf-claim",
      password: "rotate-secret",
      claimClient,
      sandboxClient,
      fetchImplementation: async (request) => {
        requests.push(toRequest(request));
        return jsonResponse({ project: true });
      },
    });

    const clientB = await createOpenCodeClient({
      claimName: "wf-claim",
      password: "rotate-secret",
      claimClient,
      sandboxClient,
      fetchImplementation: async (request) => {
        requests.push(toRequest(request));
        return jsonResponse({ project: true });
      },
    });

    await clientA.project.current();
    await clientB.project.current();

    expect(requests).toHaveLength(2);
    expect(new URL(requests[0].url).host).toBe("sandbox-a.agent-sandbox.svc.cluster.local:8888");
    expect(new URL(requests[1].url).host).toBe("sandbox-b.agent-sandbox.svc.cluster.local:8888");
  });
});

function createSandboxClaim(options: {
  claimName: string;
  sandboxName: string;
  namespace?: string;
}): SandboxClaim {
  return {
    apiVersion: "extensions.agents.x-k8s.io/v1alpha1",
    kind: "SandboxClaim",
    metadata: {
      name: options.claimName,
      namespace: options.namespace ?? "agent-sandbox",
    },
    status: {
      sandbox: {
        name: options.sandboxName,
      },
    },
  };
}

function createSandbox(options: {
  sandboxName: string;
  namespace?: string;
  serviceName?: string;
  serviceFQDN?: string;
}): Sandbox {
  return {
    apiVersion: "agents.x-k8s.io/v1alpha1",
    kind: "Sandbox",
    metadata: {
      name: options.sandboxName,
      namespace: options.namespace ?? "agent-sandbox",
    },
    status: {
      service: options.serviceName ?? options.sandboxName,
      serviceFQDN: options.serviceFQDN,
    },
  };
}

function jsonResponse(data: unknown) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  });
}

function toRequest(input: Request | URL | string) {
  return input instanceof Request ? input : new Request(input);
}

function sseResponse(events: string[]) {
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(`data: ${event}\n\n`));
        }

        controller.close();
      },
    }),
    {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
      },
    },
  );
}
