import { describe, expect, it, vi } from "vite-plus/test";
import type { StreamChunk } from "../opencode/prompt.ts";
import type { CoreHandlerDependencies } from "./handlers.ts";

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

const modulePromise = import("./handlers.ts");

describe("core chat handlers", () => {
  it("onNewMention provisions a sandbox, creates a client/session, streams the reply, and subscribes", async () => {
    const { onNewMention } = await modulePromise;
    const { thread, postedChunks, subscribe } = createThread("thread-1");
    const dependencies = createDependencies();

    await onNewMention(
      thread,
      { text: "Hello" },
      dependencies as unknown as CoreHandlerDependencies,
    );

    expect(dependencies.ensureClaim).toHaveBeenCalledWith("thread-1");
    expect(dependencies.createOpenCodeClient).toHaveBeenCalledWith({
      claimName: "claim-1",
      password: "password-1",
    });
    expect(dependencies.getOrCreateSession).toHaveBeenCalledWith("thread-1", dependencies.client, {
      title: "Thread 1",
    });
    expect(dependencies.promptStream).toHaveBeenCalledWith(dependencies.client, "session-1", {
      text: "Hello",
    });
    expect(postedChunks).toEqual(["Hello", " world"]);
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it("onSubscribedMessage reuses the same session flow without subscribing again", async () => {
    const { onSubscribedMessage } = await modulePromise;
    const { thread, postedChunks, subscribe } = createThread("thread-1");
    const dependencies = createDependencies();

    await onSubscribedMessage(
      thread,
      { text: "Follow-up" },
      dependencies as unknown as CoreHandlerDependencies,
    );

    expect(dependencies.getOrCreateSession).toHaveBeenCalledWith("thread-1", dependencies.client, {
      title: "Thread 1",
    });
    expect(postedChunks).toEqual(["Hello", " world"]);
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("onDirectMessage follows the same flow without thread subscription", async () => {
    const { onDirectMessage } = await modulePromise;
    const { thread, postedChunks, subscribe } = createThread("dm-1");
    const dependencies = createDependencies({
      ensureClaimResult: {
        claimName: "claim-dm",
        password: "password-dm",
      },
      sessionId: "session-dm",
    });

    await onDirectMessage(
      thread,
      { text: "Ping" },
      dependencies as unknown as CoreHandlerDependencies,
    );

    expect(dependencies.ensureClaim).toHaveBeenCalledWith("dm-1");
    expect(dependencies.createOpenCodeClient).toHaveBeenCalledWith({
      claimName: "claim-dm",
      password: "password-dm",
    });
    expect(dependencies.getOrCreateSession).toHaveBeenCalledWith("dm-1", dependencies.client, {
      title: "Thread 1",
    });
    expect(dependencies.promptStream).toHaveBeenCalledWith(dependencies.client, "session-dm", {
      text: "Ping",
    });
    expect(postedChunks).toEqual(["Hello", " world"]);
    expect(subscribe).not.toHaveBeenCalled();
  });
});

function createThread(id: string) {
  const postedChunks: string[] = [];
  const subscribe = vi.fn(async () => undefined);

  return {
    thread: {
      id,
      title: "Thread 1",
      post: async (stream: AsyncIterable<string | StreamChunk>) => {
        for await (const chunk of stream) {
          if (typeof chunk === "string") {
            postedChunks.push(chunk);
          }
        }
      },
      subscribe,
    },
    postedChunks,
    subscribe,
  };
}

function createDependencies(
  options: {
    ensureClaimResult?: {
      claimName: string;
      password: string;
    };
    sessionId?: string;
  } = {},
) {
  const client = {
    name: "opencode-client",
  };
  const ensureClaim = vi.fn(async () => ({
    claimName: options.ensureClaimResult?.claimName ?? "claim-1",
    password: options.ensureClaimResult?.password ?? "password-1",
  }));
  const createOpenCodeClient = vi.fn(async () => client);
  const getOrCreateSession = vi.fn(async () => options.sessionId ?? "session-1");
  const promptStream = vi.fn(() =>
    (async function* () {
      yield "Hello";
      yield " world";
    })(),
  );

  return {
    client,
    ensureClaim,
    createOpenCodeClient,
    getOrCreateSession,
    promptStream,
  };
}
