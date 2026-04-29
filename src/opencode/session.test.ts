import { describe, expect, it, vi } from "vite-plus/test";
import type { OpenCodeRequestResult, OpenCodeSessionClient } from "./session.ts";

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

const sessionModulePromise = import("./session.ts");
const stateModulePromise = import("../state/thread.ts");

describe("getOrCreateSession", () => {
  it("returns a stored session when it still exists", async () => {
    const [{ getOrCreateSession }, { InMemoryThreadStateStore }] = await Promise.all([
      sessionModulePromise,
      stateModulePromise,
    ]);
    const stateStore = new InMemoryThreadStateStore([["thread-1", "session-existing"]]);
    const { client, getMock, createMock } = createSessionClient({
      getResult: ok({ id: "session-existing" }),
      createResult: ok({ id: "session-created" }),
    });

    const sessionId = await getOrCreateSession("thread-1", client, { stateStore });

    expect(sessionId).toBe("session-existing");
    expect(getMock).toHaveBeenCalledWith({ sessionID: "session-existing" });
    expect(createMock).not.toHaveBeenCalled();
    await expect(stateStore.getOpenCodeSessionId("thread-1")).resolves.toBe("session-existing");
  });

  it("creates and stores a session when no session is persisted", async () => {
    const [{ getOrCreateSession }, { InMemoryThreadStateStore }] = await Promise.all([
      sessionModulePromise,
      stateModulePromise,
    ]);
    const stateStore = new InMemoryThreadStateStore();
    const { client, getMock, createMock } = createSessionClient({
      getResult: ok({ id: "unused" }),
      createResult: ok({ id: "session-created" }),
    });

    const sessionId = await getOrCreateSession("thread-1", client, {
      stateStore,
      title: "Thread 1",
    });

    expect(sessionId).toBe("session-created");
    expect(getMock).not.toHaveBeenCalled();
    expect(createMock).toHaveBeenCalledWith({ title: "Thread 1" });
    await expect(stateStore.getOpenCodeSessionId("thread-1")).resolves.toBe("session-created");
  });

  it("recreates and updates state when the stored session is stale", async () => {
    const [{ getOrCreateSession }, { InMemoryThreadStateStore }] = await Promise.all([
      sessionModulePromise,
      stateModulePromise,
    ]);
    const stateStore = new InMemoryThreadStateStore([["thread-1", "session-stale"]]);
    const { client, getMock, createMock } = createSessionClient({
      getResult: notFound(),
      createResult: ok({ id: "session-fresh" }),
    });

    const sessionId = await getOrCreateSession("thread-1", client, { stateStore });

    expect(sessionId).toBe("session-fresh");
    expect(getMock).toHaveBeenCalledWith({ sessionID: "session-stale" });
    expect(createMock).toHaveBeenCalledTimes(1);
    await expect(stateStore.getOpenCodeSessionId("thread-1")).resolves.toBe("session-fresh");
  });

  it("throws when session lookup fails for reasons other than 404", async () => {
    const [{ getOrCreateSession }, { InMemoryThreadStateStore }] = await Promise.all([
      sessionModulePromise,
      stateModulePromise,
    ]);
    const stateStore = new InMemoryThreadStateStore([["thread-1", "session-existing"]]);
    const { client, createMock } = createSessionClient({
      getResult: serverError("sandbox unavailable"),
      createResult: ok({ id: "session-created" }),
    });

    await expect(getOrCreateSession("thread-1", client, { stateStore })).rejects.toThrow(
      /Failed to load OpenCode session session-existing: 503 Service Unavailable: sandbox unavailable/,
    );
    expect(createMock).not.toHaveBeenCalled();
    await expect(stateStore.getOpenCodeSessionId("thread-1")).resolves.toBe("session-existing");
  });

  it("deduplicates concurrent calls for the same thread", async () => {
    const [{ getOrCreateSession }, { InMemoryThreadStateStore }] = await Promise.all([
      sessionModulePromise,
      stateModulePromise,
    ]);
    const stateStore = new InMemoryThreadStateStore();
    let resolveCreate: ((value: OpenCodeRequestResult<{ id: string }>) => void) | undefined;

    const getMock = vi.fn(async (_parameters: { sessionID: string }) => ok({ id: "unused" }));
    const createMock = vi.fn(
      async (_parameters?: { title?: string }) =>
        await new Promise<OpenCodeRequestResult<{ id: string }>>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const client: OpenCodeSessionClient = {
      session: {
        get: getMock,
        create: createMock,
      },
    };

    const pendingA = getOrCreateSession("thread-1", client, { stateStore });
    const pendingB = getOrCreateSession("thread-1", client, { stateStore });

    await Promise.resolve();
    await Promise.resolve();

    expect(createMock).toHaveBeenCalledTimes(1);

    if (resolveCreate === undefined) {
      throw new Error("expected create resolver to be set");
    }

    resolveCreate(ok({ id: "session-shared" }));

    await expect(Promise.all([pendingA, pendingB])).resolves.toEqual([
      "session-shared",
      "session-shared",
    ]);
    await expect(stateStore.getOpenCodeSessionId("thread-1")).resolves.toBe("session-shared");
  });
});

function createSessionClient(options: {
  getResult: OpenCodeRequestResult<{ id: string }>;
  createResult: OpenCodeRequestResult<{ id: string }>;
}) {
  const getMock = vi.fn(async (_parameters: { sessionID: string }) => options.getResult);
  const createMock = vi.fn(async (_parameters?: { title?: string }) => options.createResult);
  const client: OpenCodeSessionClient = {
    session: {
      get: getMock,
      create: createMock,
    },
  };

  return {
    client,
    getMock,
    createMock,
  };
}

function ok(data: { id: string }): OpenCodeRequestResult<{ id: string }> {
  return {
    data,
    response: new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    }),
  };
}

function notFound(): OpenCodeRequestResult<{ id: string }> {
  return {
    error: { message: "session not found" },
    response: new Response(JSON.stringify({ message: "session not found" }), {
      status: 404,
      statusText: "Not Found",
      headers: {
        "content-type": "application/json",
      },
    }),
  };
}

function serverError(message: string): OpenCodeRequestResult<{ id: string }> {
  return {
    error: message,
    response: new Response(JSON.stringify({ message }), {
      status: 503,
      statusText: "Service Unavailable",
      headers: {
        "content-type": "application/json",
      },
    }),
  };
}
