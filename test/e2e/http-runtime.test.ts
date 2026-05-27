import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import type { Adapter, Chat, Message, StateAdapter, Thread } from "chat";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterEach, describe, expect, it } from "vitest";
import { registerHandlers } from "../../src/chat/handlers.js";
import { mountWebhooks } from "../../src/chat/webhooks.js";
import type { Config } from "../../src/config.js";
import { createOpenApiApp } from "../../src/openapi.js";
import { mountRuntimeAdmin } from "../../src/runtime/admin.js";
import { createPostgresRuntimeStore, type PostgresRuntimeStore } from "../../src/runtime/postgres.js";
import type { ResolvedRuntime } from "../../src/runtime/types.js";
import type { SandboxManager } from "../../src/sandbox/manager.js";
import type { ClaimedSandbox } from "../../src/sandbox/types.js";
import { createMemoryState } from "../../src/state/memory.js";
import type { ThreadState } from "../../src/types.js";
import { FakeThread } from "./fake-thread.js";

describe("HTTP runtime e2e", () => {
  let postgres: StartedTestContainer | undefined;
  let runtimeStore: PostgresRuntimeStore | undefined;
  let opencode: FakeOpencodeServer | undefined;

  afterEach(async () => {
    await runtimeStore?.close();
    runtimeStore = undefined;
    await opencode?.stop();
    opencode = undefined;
    await postgres?.stop();
    postgres = undefined;
  });

  it("uses admin-created Postgres runtime records when handling a webhook", async () => {
    postgres = await startPostgres();
    runtimeStore = await createPostgresRuntimeStore({
      connectionString: postgresConnectionString(postgres),
      runMigrations: true,
      ssl: false,
      sslRejectUnauthorized: false,
    });
    opencode = await startFakeOpencodeServer();

    const config = testConfig(opencode.port);
    const chat = new HttpWebhookFakeChat();
    const sandboxManager = new FakeSandboxManager(opencode.endpoint("claim-http-thread"));
    const state = createMemoryState();
    const app = createOpenApiApp();

    registerHandlers(chat.asChat(), {
      config,
      runtimeStore,
      sandboxManager: sandboxManager.asSandboxManager(),
      state,
    });
    mountRuntimeAdmin(app, config, runtimeStore);
    mountWebhooks(app, chat.asChat(), runtimeStore);

    const missingBot = await app.request("/agents/httpbot/webhooks/slack", { method: "POST" });
    expect(missingBot.status).toBe(404);

    await expectAdminCreated(app, "/admin/runtime/opencode-configs", {
      config: {
        agent: {
          reviewer: { prompt: "review from http postgres runtime" },
        },
        default_agent: "reviewer",
      },
      displayName: "HTTP Config",
      enabled: true,
      id: "opencode-config-http",
      slug: "http-config",
    });
    await expectAdminCreated(app, "/admin/runtime/sandbox-profiles", {
      enabled: true,
      id: "sandbox-profile-http",
      slug: "http-sandbox",
      templateName: "http-template",
      warmpool: "http-pool",
    });
    await expectAdminCreated(app, "/admin/runtime/agent-profiles", {
      displayName: "Reviewer",
      enabled: true,
      id: "agent-profile-reviewer",
      opencodeAgentName: "reviewer",
      opencodeConfigID: "opencode-config-http",
      slug: "reviewer",
    });
    await expectAdminCreated(app, "/admin/runtime/bots", {
      defaultAgentProfileID: "agent-profile-reviewer",
      displayName: "HTTP Bot",
      enabled: true,
      id: "bot-http",
      sandboxProfileID: "sandbox-profile-http",
      slug: "httpbot",
    });

    const disabledAdapter = await app.request("/agents/httpbot/webhooks/telegram", { method: "POST" });
    expect(disabledAdapter.status).toBe(404);
    expect(await disabledAdapter.text()).toContain("telegram adapter is not enabled for bot httpbot");

    const response = await requestJSON(app, "POST", "/agents/httpbot/webhooks/slack", {
      messageId: "message-http",
      text: "review this from webhook",
      threadId: "thread-http",
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      posts: ["Spinning up an isolated opencode sandbox...", "Hello from HTTP fake opencode"],
      state: {
        agentProfileID: "agent-profile-reviewer",
        botID: "bot-http",
        claimName: "claim-http-thread",
        opencodeAgentName: "reviewer",
        opencodeConfigID: "opencode-config-http",
        sandboxProfileID: "sandbox-profile-http",
        sessionID: "session-http-e2e",
      },
    });
    expect(sandboxManager.claims).toEqual([
      {
        agentProfileID: "agent-profile-reviewer",
        botID: "bot-http",
        sandboxProfileID: "sandbox-profile-http",
        threadId: "thread-http",
      },
    ]);
    expect(opencode.sessionBodies).toEqual([{ title: "httpbot/reviewer thread-http: review this from webhook" }]);
    expect(opencode.promptBodies).toEqual([
      {
        agent: "reviewer",
        parts: [{ text: "review this from webhook", type: "text" }],
      },
    ]);
  });

  it("updates seeded Postgres runtime fields on repeated admin upsert", async () => {
    postgres = await startPostgres();
    runtimeStore = await createPostgresRuntimeStore({
      connectionString: postgresConnectionString(postgres),
      runMigrations: true,
      ssl: false,
      sslRejectUnauthorized: false,
    });

    const app = createOpenApiApp();
    mountRuntimeAdmin(app, testConfig(4096), runtimeStore);

    await expectAdminCreated(app, "/admin/runtime/opencode-configs", {
      config: { agent: { agentbay: { prompt: "test prompt" } }, default_agent: "agentbay" },
      displayName: "Default",
      enabled: true,
      id: "opencode-config-default",
      slug: "default",
    });
    await expectAdminCreated(app, "/admin/runtime/sandbox-profiles", {
      enabled: true,
      id: "sandbox-profile-default",
      slug: "default",
      templateName: "opencode-template",
      warmpool: "none",
    });
    await expectAdminCreated(app, "/admin/runtime/agent-profiles", {
      claimEnv: [],
      displayName: "agentbay",
      enabled: true,
      id: "agent-profile-agentbay",
      opencodeAgentName: "agentbay",
      opencodeConfigID: "opencode-config-default",
      slug: "agentbay",
    });
    await expectAdminCreated(app, "/admin/runtime/bots", {
      adapters: { telegram: { botTokenEnv: "TELEGRAM_BOT_TOKEN_AGENTBAY" } },
      defaultAgentProfileID: "agent-profile-agentbay",
      displayName: "agentbay",
      enabled: true,
      id: "bot-agentbay",
      sandboxProfileID: "sandbox-profile-default",
      slug: "agentbay",
    });

    const agent = await requestJSON(
      app,
      "PUT",
      "/admin/runtime/agent-profiles/agent-profile-agentbay",
      {
        claimEnv: [{ name: "ANTHROPIC_API_KEY", valueFromEnv: "ANTHROPIC_API_KEY" }],
        displayName: "agentbay",
        enabled: true,
        id: "agent-profile-agentbay",
        opencodeAgentName: "agentbay",
        opencodeConfigID: "opencode-config-default",
        slug: "agentbay",
      },
      true,
    );
    expect(agent.status).toBe(200);
    expect(agent.body).toMatchObject({ claimEnv: [{ name: "ANTHROPIC_API_KEY", valueFromEnv: "ANTHROPIC_API_KEY" }] });

    const bot = await requestJSON(
      app,
      "PUT",
      "/admin/runtime/bots/bot-agentbay",
      {
        adapters: { telegram: { botTokenEnv: "TELEGRAM_BOT_TOKEN" } },
        defaultAgentProfileID: "agent-profile-agentbay",
        displayName: "agentbay",
        enabled: true,
        id: "bot-agentbay",
        sandboxProfileID: "sandbox-profile-default",
        slug: "agentbay",
      },
      true,
    );
    expect(bot.status).toBe(200);
    expect(bot.body).toMatchObject({ adapters: { telegram: { botTokenEnv: "TELEGRAM_BOT_TOKEN" } } });
  });
});

type Handler = (thread: Thread<ThreadState>, message: Message) => Promise<void>;

class HttpWebhookFakeChat {
  readonly threads = new Map<string, FakeThread>();
  private newMentionHandler?: Handler;
  private subscribedMessageHandler?: Handler;

  asChat(): Chat<Record<string, Adapter>, ThreadState> {
    const fakeChat = this;

    return {
      onDirectMessage: (handler: Handler) => {
        fakeChat.newMentionHandler = handler;
      },
      onNewMention: (handler: Handler) => {
        fakeChat.newMentionHandler = handler;
      },
      onSubscribedMessage: (handler: Handler) => {
        fakeChat.subscribedMessageHandler = handler;
      },
      webhooks: {
        slack: (request: Request) => fakeChat.handleWebhook(request),
      },
    } as unknown as Chat<Record<string, Adapter>, ThreadState>;
  }

  private async handleWebhook(request: Request): Promise<Response> {
    if (!this.newMentionHandler) throw new Error("new mention handler was not registered");

    const body = await request.json() as Record<string, unknown>;
    const threadId = readString(body, "threadId");
    const text = readString(body, "text");
    const id = readString(body, "messageId");
    const thread = this.threads.get(threadId) ?? new FakeThread(threadId);
    this.threads.set(threadId, thread);

    await this.newMentionHandler(thread.asThread(), { id, text, threadId } as Message);

    return Response.json({
      posts: thread.posts,
      state: thread.currentState,
      subscribed: thread.subscribed,
      typing: thread.typing,
    });
  }
}


class FakeSandboxManager {
  readonly claims: Array<{ agentProfileID: string; botID: string; sandboxProfileID: string; threadId: string }> = [];

  constructor(private readonly sandbox: ClaimedSandbox) {}

  asSandboxManager(): SandboxManager {
    return {
      claimFor: async (threadId: string, runtime: ResolvedRuntime) => {
        this.claims.push({
          agentProfileID: runtime.agentProfile.id,
          botID: runtime.bot.id,
          sandboxProfileID: runtime.sandboxProfile.id,
          threadId,
        });
        return this.sandbox;
      },
      currentReadyClaim: async () => this.sandbox,
      releaseClaim: async () => {},
    } as unknown as SandboxManager;
  }
}

type FakeOpencodeServer = {
  password: string;
  port: number;
  promptBodies: unknown[];
  sessionBodies: unknown[];
  endpoint: (claimName: string) => ClaimedSandbox;
  stop: () => Promise<void>;
};

async function startFakeOpencodeServer(): Promise<FakeOpencodeServer> {
  const password = "http-runtime-secret";
  const clients = new Set<ServerResponse>();
  const promptBodies: unknown[] = [];
  const sessionBodies: unknown[] = [];
  const server = createServer((request, response) => {
    void handleOpencodeRequest({ clients, password, promptBodies, request, response, sessionBodies }).catch((error: unknown) => {
      response.writeHead(500);
      response.end(error instanceof Error ? error.message : String(error));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    endpoint: (claimName) => ({ claimName, password, podFQDN: "127.0.0.1" }),
    password,
    port,
    promptBodies,
    sessionBodies,
    stop: async () => {
      for (const response of clients) response.end();
      clients.clear();
      await closeServer(server);
    },
  };
}

async function handleOpencodeRequest(input: {
  clients: Set<ServerResponse>;
  password: string;
  promptBodies: unknown[];
  request: IncomingMessage;
  response: ServerResponse;
  sessionBodies: unknown[];
}): Promise<void> {
  const { clients, password, promptBodies, request, response, sessionBodies } = input;
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
    json(response, 200, { "session-http-e2e": { type: "idle" } });
    return;
  }

  if (request.method === "POST" && request.url?.startsWith("/session")) {
    const body = await readRequestJSON(request);
    if (request.url.includes("/prompt_async")) {
      promptBodies.push(body);
      response.writeHead(204);
      response.end();
      setTimeout(() => {
        sendEvent(clients, messagePart("Hello", "Hello"));
        sendEvent(clients, messagePart("Hello from HTTP fake opencode", " from HTTP fake opencode"));
        sendEvent(clients, { type: "session.idle", properties: { sessionID: "session-http-e2e" } });
      }, 20);
      return;
    }

    sessionBodies.push(body);
    json(response, 200, { id: "session-http-e2e" });
    return;
  }

  response.writeHead(404);
  response.end("not found");
}

async function expectAdminCreated(app: ReturnType<typeof createOpenApiApp>, path: string, body: Record<string, unknown>): Promise<void> {
  const response = await requestJSON(app, "POST", path, body, true);
  expect(response.status).toBe(201);
}

async function requestJSON(
  app: ReturnType<typeof createOpenApiApp>,
  method: string,
  path: string,
  body?: unknown,
  authorized = false,
): Promise<{ body: unknown; status: number }> {
  const response = await app.request(path, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      ...(authorized ? { authorization: "Bearer test-token" } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    method,
  });

  return { body: await response.json(), status: response.status };
}

async function startPostgres(): Promise<StartedTestContainer> {
  return new GenericContainer("postgres:16-alpine")
    .withEnvironment({
      POSTGRES_DB: "agentbay",
      POSTGRES_PASSWORD: "agentbay-password",
      POSTGRES_USER: "agentbay",
    })
    .withExposedPorts(5432)
    .withHealthCheck({
      interval: 1_000,
      retries: 30,
      test: ["CMD-SHELL", "pg_isready -U agentbay -d agentbay"],
      timeout: 5_000,
    })
    .withWaitStrategy(Wait.forHealthCheck())
    .start();
}

function postgresConnectionString(container: StartedTestContainer): string {
  return `postgresql://agentbay:agentbay-password@${container.getHost()}:${container.getMappedPort(5432)}/agentbay`;
}

function testConfig(opencodePort: number): Config {
  const disabled = { enabled: false };

  return {
    adminToken: "test-token",
    botUserName: "agentbay",
    claimPollIntervalMs: 10,
    claimReadyTimeoutMs: 5_000,
    claimShutdownHours: 1,
    claimTtlSecondsAfterFinished: 60,
    kubeNamespace: "unused",
    opencodeDirectory: "/workspace",
    opencodePort,
    port: 3000,
    sandboxClaimApiVersion: "v1alpha1",
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

function readString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be a non-empty string`);
  return value;
}

async function readRequestJSON(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
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
      part: { id: "part-1", messageID: "message-1", sessionID: "session-http-e2e", text, type: "text" },
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
