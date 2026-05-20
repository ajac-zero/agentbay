import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import type { Adapter, Chat, Message, SentMessage, StateAdapter, Thread } from "chat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerHandlers } from "../../src/chat/handlers.js";
import type { Config } from "../../src/config.js";
import { runWithBotSlug } from "../../src/runtime/context.js";
import { agentProfileHash, hashConfig, resolveRuntime, sandboxProfileHash, type RuntimeStore } from "../../src/runtime/store.js";
import type { ResolvedRuntime } from "../../src/runtime/types.js";
import type { SandboxManager } from "../../src/sandbox/manager.js";
import { createMemoryState } from "../../src/state/memory.js";
import type { ClaimedSandbox } from "../../src/sandbox/types.js";
import type { ThreadState } from "../../src/types.js";
import { defaultRuntimeSnapshot, TestRuntimeStore } from "./runtime-store-fixture.js";

describe("chat handlers e2e", () => {
  let opencode: FakeOpencodeServer;
  let config: Config;
  let runtimeStore: RuntimeStore;
  let state: StateAdapter;

  beforeEach(async () => {
    opencode = await startFakeOpencodeServer();
    config = testConfig(opencode.port);
    runtimeStore = new TestRuntimeStore();
    state = createMemoryState();
  });

  afterEach(async () => {
    await opencode.stop();
  });

  it("starts a new sandbox-backed session and persists thread state", async () => {
    const chat = new FakeChat();
    const sandboxManager = new FakeSandboxManager(opencode.endpoint("claim-new"));
    const thread = new FakeThread("thread-new");

    registerHandlers(chat.asChat(), { config, runtimeStore, sandboxManager: sandboxManager.asSandboxManager(), state });
    await runWithBotSlug("agentbay", () => chat.newMention(thread, message("message-new", thread.id, "first prompt")));

    expect(thread.subscribed).toBe(true);
    expect(thread.typing).toEqual(["Preparing sandbox"]);
    expect(thread.posts).toEqual(["Spinning up an isolated opencode sandbox...", "Hello from fake opencode"]);
    expect(thread.currentState).toMatchObject({
      claimName: "claim-new",
      botID: "bot-default",
      agentProfileID: "agent-profile-default",
      opencodeAgentName: "agentbay",
      password: opencode.password,
      podFQDN: "127.0.0.1",
      sandboxProfileHash: expect.any(String),
      sandboxProfileID: "sandbox-profile-default",
      sessionID: "session-e2e",
    });
    expect(sandboxManager.claims).toEqual([{ agentProfileID: "agent-profile-default", botID: "bot-default", threadId: thread.id }]);
    expect(sandboxManager.currentReadyChecks).toEqual([]);
    expect(sandboxManager.releases).toEqual([]);
  });

  it("continues an existing ready session without creating a new claim", async () => {
    const chat = new FakeChat();
    const sandboxManager = new FakeSandboxManager(opencode.endpoint("unused"));
    const thread = new FakeThread("thread-existing", existingState("claim-existing"));

    registerHandlers(chat.asChat(), { config, runtimeStore, sandboxManager: sandboxManager.asSandboxManager(), state });
    await chat.subscribedMessage(thread, message("message-existing", thread.id, "continue prompt"));

    expect(thread.subscribed).toBe(false);
    expect(thread.posts).toEqual(["Hello from fake opencode"]);
    expect(thread.currentState).toMatchObject({ claimName: "claim-existing", sessionID: "session-e2e" });
    expect(sandboxManager.claims).toEqual([]);
    expect(sandboxManager.currentReadyChecks).toEqual([{ claimName: "claim-existing", password: opencode.password }]);
    expect(sandboxManager.releases).toEqual([]);
  });

  it("restarts when stored thread state is expired", async () => {
    const chat = new FakeChat();
    const sandboxManager = new FakeSandboxManager(opencode.endpoint("claim-restarted"));
    const thread = new FakeThread("thread-expired", {
      ...existingState("claim-expired"),
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1_000).toISOString(),
    });

    registerHandlers(chat.asChat(), { config, runtimeStore, sandboxManager: sandboxManager.asSandboxManager(), state });
    await chat.subscribedMessage(thread, message("message-expired", thread.id, "restart prompt"));

    expect(thread.posts).toEqual([
      "Previous sandbox reached its configured lifetime; starting a fresh one...",
      "Spinning up an isolated opencode sandbox...",
      "Hello from fake opencode",
    ]);
    expect(thread.currentState).toMatchObject({ claimName: "claim-restarted", sessionID: "session-e2e" });
    expect(sandboxManager.releases).toEqual(["claim-expired"]);
    expect(sandboxManager.claims).toEqual([{ agentProfileID: "agent-profile-default", botID: "bot-default", threadId: thread.id }]);
  });

  it("restarts when stored runtime fields drift from the resolved runtime", async () => {
    const chat = new FakeChat();
    const sandboxManager = new FakeSandboxManager(opencode.endpoint("claim-runtime-drift"));
    const thread = new FakeThread("thread-runtime-drift", existingState("claim-old-runtime"));
    const snapshot = defaultRuntimeSnapshot();
    snapshot.agentProfiles[0] = { ...snapshot.agentProfiles[0]!, opencodeAgentName: "reviewer" };
    const reviewerConfig = { ...snapshot.opencodeConfigs[0]!.config, agent: { reviewer: { prompt: "review prompt" } } };
    snapshot.opencodeConfigs[0] = {
      ...snapshot.opencodeConfigs[0]!,
      config: reviewerConfig,
      configHash: hashConfig(reviewerConfig),
    };

    registerHandlers(chat.asChat(), {
      config,
      runtimeStore: new TestRuntimeStore(snapshot),
      sandboxManager: sandboxManager.asSandboxManager(),
      state,
    });
    await chat.subscribedMessage(thread, message("message-runtime-drift", thread.id, "use updated runtime"));

    expect(thread.posts).toEqual([
      "Agent runtime changed; starting a fresh sandbox with the updated runtime...",
      "Spinning up an isolated opencode sandbox...",
      "Hello from fake opencode",
    ]);
    expect(thread.currentState).toMatchObject({
      claimName: "claim-runtime-drift",
      opencodeAgentName: "reviewer",
      sessionID: "session-e2e",
    });
    expect(sandboxManager.releases).toEqual(["claim-old-runtime"]);
  });

  it("restarts when sandbox profile contents change under the same id", async () => {
    const chat = new FakeChat();
    const sandboxManager = new FakeSandboxManager(opencode.endpoint("claim-sandbox-profile-drift"));
    const thread = new FakeThread("thread-sandbox-profile-drift", existingState("claim-old-sandbox-profile"));
    const snapshot = defaultRuntimeSnapshot();
    snapshot.sandboxProfiles[0] = { ...snapshot.sandboxProfiles[0]!, templateName: "new-opencode-template" };

    registerHandlers(chat.asChat(), {
      config,
      runtimeStore: new TestRuntimeStore(snapshot),
      sandboxManager: sandboxManager.asSandboxManager(),
      state,
    });
    await chat.subscribedMessage(thread, message("message-sandbox-profile-drift", thread.id, "use updated sandbox"));

    expect(thread.posts).toEqual([
      "Agent runtime changed; starting a fresh sandbox with the updated runtime...",
      "Spinning up an isolated opencode sandbox...",
      "Hello from fake opencode",
    ]);
    expect(thread.currentState).toMatchObject({
      claimName: "claim-sandbox-profile-drift",
      sandboxProfileHash: sandboxProfileHash(snapshot.sandboxProfiles[0]!),
      sessionID: "session-e2e",
    });
    expect(sandboxManager.releases).toEqual(["claim-old-sandbox-profile"]);
  });

  it("restarts when the stored sandbox claim is unavailable", async () => {
    const chat = new FakeChat();
    const sandboxManager = new FakeSandboxManager(opencode.endpoint("claim-after-missing"), { ready: false });
    const thread = new FakeThread("thread-missing", existingState("claim-missing"));

    registerHandlers(chat.asChat(), { config, runtimeStore, sandboxManager: sandboxManager.asSandboxManager(), state });
    await chat.subscribedMessage(thread, message("message-missing", thread.id, "recover prompt"));

    expect(thread.posts).toEqual([
      "Previous sandbox is no longer available; starting a fresh one...",
      "Spinning up an isolated opencode sandbox...",
      "Hello from fake opencode",
    ]);
    expect(thread.currentState).toMatchObject({ claimName: "claim-after-missing", sessionID: "session-e2e" });
    expect(sandboxManager.currentReadyChecks).toEqual([{ claimName: "claim-missing", password: opencode.password }]);
    expect(sandboxManager.releases).toEqual(["claim-missing"]);
    expect(sandboxManager.claims).toEqual([{ agentProfileID: "agent-profile-default", botID: "bot-default", threadId: thread.id }]);
  });
});

type Handler = (thread: Thread<ThreadState>, message: Message) => Promise<void>;

class FakeChat {
  private newMentionHandler?: Handler;
  private subscribedMessageHandler?: Handler;

  asChat(): Chat<Record<string, Adapter>, ThreadState> {
    return {
      onDirectMessage: (handler: Handler) => {
        this.newMentionHandler = handler;
      },
      onNewMention: (handler: Handler) => {
        this.newMentionHandler = handler;
      },
      onSubscribedMessage: (handler: Handler) => {
        this.subscribedMessageHandler = handler;
      },
    } as unknown as Chat<Record<string, Adapter>, ThreadState>;
  }

  async newMention(thread: FakeThread, message: Message): Promise<void> {
    if (!this.newMentionHandler) throw new Error("new mention handler was not registered");
    await this.newMentionHandler(thread.asThread(), message);
  }

  async subscribedMessage(thread: FakeThread, message: Message): Promise<void> {
    if (!this.subscribedMessageHandler) throw new Error("subscribed message handler was not registered");
    await this.subscribedMessageHandler(thread.asThread(), message);
  }
}

class FakeThread {
  readonly posts: string[] = [];
  readonly typing: string[] = [];
  subscribed = false;

  constructor(
    readonly id: string,
    public currentState: ThreadState | null = null,
  ) {}

  asThread(): Thread<ThreadState> {
    const thisThread = this;

    return {
      get id() {
        return thisThread.id;
      },
      get state() {
        return Promise.resolve(thisThread.currentState);
      },
      post: async (content: string | AsyncIterable<string>) => {
        if (typeof content === "string") {
          thisThread.posts.push(content);
        } else if (isAsyncIterable(content)) {
          let streamed = "";
          for await (const chunk of content) streamed += chunk;
          thisThread.posts.push(streamed);
        }

        return {} as SentMessage;
      },
      setState: async (next: ThreadState) => {
        thisThread.currentState = next;
      },
      startTyping: async (message: string) => {
        thisThread.typing.push(message);
      },
      subscribe: async () => {
        thisThread.subscribed = true;
      },
    } as unknown as Thread<ThreadState>;
  }
}

class FakeSandboxManager {
  readonly claims: Array<{ agentProfileID: string; botID: string; threadId: string }> = [];
  readonly currentReadyChecks: Array<{ claimName: string; password: string }> = [];
  readonly releases: string[] = [];

  constructor(
    private readonly sandbox: ClaimedSandbox,
    private readonly options: { ready: boolean } = { ready: true },
  ) {}

  asSandboxManager(): SandboxManager {
    return {
      claimFor: async (threadId: string, runtime: ResolvedRuntime) => {
        this.claims.push({ agentProfileID: runtime.agentProfile.id, botID: runtime.bot.id, threadId });
        return this.sandbox;
      },
      currentReadyClaim: async (claimName: string, password: string) => {
        this.currentReadyChecks.push({ claimName, password });
        return this.options.ready ? { ...this.sandbox, claimName, password } : null;
      },
      releaseClaim: async (claimName: string) => {
        this.releases.push(claimName);
      },
    } as unknown as SandboxManager;
  }
}

type FakeOpencodeServer = {
  password: string;
  port: number;
  endpoint: (claimName: string) => ClaimedSandbox;
  stop: () => Promise<void>;
};

async function startFakeOpencodeServer(): Promise<FakeOpencodeServer> {
  const password = "handler-secret";
  const clients = new Set<ServerResponse>();
  const server = createServer((request, response) => {
    if (request.url === "/global/health") {
      response.end("ok");
      return;
    }

    if (!isAuthorized(request, password)) {
      response.writeHead(401);
      response.end("unauthorized");
      return;
    }

    if (request.method === "GET" && request.url?.startsWith("/event")) {
      response.writeHead(200, {
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": "text/event-stream",
      });
      response.write("\n");
      clients.add(response);
      request.on("close", () => clients.delete(response));
      return;
    }

    if (request.method === "GET" && request.url?.startsWith("/session/status")) {
      json(response, 200, { "session-e2e": { type: "idle" } });
      return;
    }

    if (request.method === "POST" && request.url?.startsWith("/session")) {
      if (request.url.includes("/prompt_async")) {
        request.resume();
        response.writeHead(204);
        response.end();
        setTimeout(() => {
          sendEvent(clients, messagePart("Hello", "Hello"));
          sendEvent(clients, messagePart("Hello from fake opencode", " from fake opencode"));
          sendEvent(clients, { type: "session.idle", properties: { sessionID: "session-e2e" } });
        }, 20);
        return;
      }

      json(response, 200, { id: "session-e2e" });
      return;
    }

    response.writeHead(404);
    response.end("not found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    password,
    port,
    endpoint: (claimName) => ({ claimName, password, podFQDN: "127.0.0.1" }),
    stop: async () => {
      for (const response of clients) response.end();
      clients.clear();
      await closeServer(server);
    },
  };
}

function testConfig(opencodePort: number): Config {
  const disabled = { enabled: false };

  return {
    botUserName: "agentbay",
    claimPollIntervalMs: 10,
    claimReadyTimeoutMs: 5_000,
    claimShutdownHours: 1,
    claimTtlSecondsAfterFinished: 60,
    kubeNamespace: "unused",
    opencodeDirectory: "/workspace",
    opencodePort,
    port: 3000,
    discord: disabled,
    gchat: disabled,
    github: disabled,
    linear: disabled,
    messenger: disabled,
    slack: disabled,
    teams: disabled,
    telegram: disabled,
    whatsapp: disabled,
  };
}

function existingState(claimName: string): ThreadState {
  const runtime = defaultRuntime();
  return {
    agentProfileID: runtime.agentProfile.id,
    agentProfileHash: agentProfileHash(runtime.agentProfile),
    botID: runtime.bot.id,
    claimName,
    createdAt: new Date().toISOString(),
    opencodeAgentName: runtime.opencodeAgentName,
    opencodeConfigHash: runtime.opencodeConfig.configHash,
    opencodeConfigID: runtime.opencodeConfig.id,
    password: "handler-secret",
    podFQDN: "127.0.0.1",
    sandboxProfileHash: sandboxProfileHash(runtime.sandboxProfile),
    sandboxProfileID: runtime.sandboxProfile.id,
    sessionID: "session-e2e",
  };
}

function defaultRuntime(): ResolvedRuntime {
  const snapshot = defaultRuntimeSnapshot();
  const bot = snapshot.bots[0];
  if (!bot) throw new Error("seed runtime snapshot did not include a bot");
  return resolveRuntime(snapshot, bot, bot.defaultAgentProfileID);
}

function message(id: string, threadId: string, text: string): Message {
  return { id, text, threadId } as Message;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<string> {
  return Boolean(value && typeof value === "object" && Symbol.asyncIterator in value);
}

function isAuthorized(request: IncomingMessage, password: string): boolean {
  return request.headers.authorization === `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function messagePart(text: string, delta: string): unknown {
  return {
    type: "message.part.updated",
    properties: {
      delta,
      part: { id: "part-1", messageID: "message-1", sessionID: "session-e2e", text, type: "text" },
    },
  };
}

function sendEvent(clients: Set<ServerResponse>, payload: unknown): void {
  for (const response of clients) {
    response.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
