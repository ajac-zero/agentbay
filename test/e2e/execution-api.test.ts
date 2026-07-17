import { describe, expect, it } from "vitest";
import type { Config } from "../../src/config.js";
import { mountExecutionApi } from "../../src/execution/api.js";
import type {
  CreateExecutionCommand,
  CreateExecutionResult,
  ExecutionStore,
  PublishProfileVersionCommand,
} from "../../src/execution/store.js";
import {
  IdempotencyConflictError,
  ProfileVersionAlreadyExistsError,
  ProfileVersionNotFoundError,
  type AgentProfileVersion,
  type Execution,
} from "../../src/execution/types.js";
import { createOpenApiApp } from "../../src/openapi.js";

describe("execution API", () => {
  it("requires the configured bearer token", async () => {
    const app = testApp();

    expect((await app.request("/v1/executions")).status).toBe(401);
    expect((await app.request("/v1/executions", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
  });

  it("publishes and reads an immutable profile version", async () => {
    const app = testApp();
    const published = await request(app, "POST", "/v1/agent-profiles/coder/versions", {
      version: 1,
      definition: profileDefinition("coder"),
    });

    expect(published.status).toBe(201);
    expect(published.body).toMatchObject({
      tenantId: "default",
      profile: { id: "coder", version: 1 },
      definition: profileDefinition("coder"),
    });

    const fetched = await request(app, "GET", "/v1/agent-profiles/coder/versions/1");
    expect(fetched.status).toBe(200);
    expect(fetched.body).toEqual(published.body);

    const duplicate = await request(app, "POST", "/v1/agent-profiles/coder/versions", {
      version: 1,
      definition: profileDefinition("other"),
    });
    expect(duplicate.status).toBe(409);
  });

  it("submits and reads an execution with a stable idempotent response", async () => {
    const app = testApp();
    await publishCoder(app);

    const body = {
      profile: { id: "coder", version: 1 },
      input: { text: "Implement this", context: { issue: 42 } },
      workspace: { type: "empty" },
    };
    const submitted = await request(app, "POST", "/v1/executions", body, { "Idempotency-Key": "request-1" });

    expect(submitted.status).toBe(202);
    expect(submitted.headers.get("location")).toBe(`/v1/executions/${String((submitted.body as Execution).id)}`);
    expect(submitted.body).toMatchObject({
      tenantId: "default",
      state: "QUEUED",
      profile: { id: "coder", version: 1 },
      input: body.input,
      workspace: { type: "empty" },
      eventId: expect.any(String),
      result: null,
    });

    const replay = await request(app, "POST", "/v1/executions", body, { "Idempotency-Key": "request-1" });
    expect(replay.status).toBe(202);
    expect(replay.body).toEqual(submitted.body);

    const fetched = await request(app, "GET", `/v1/executions/${String((submitted.body as Execution).id)}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body).toEqual(submitted.body);
  });

  it("rejects invalid and non-strict requests", async () => {
    const app = testApp();

    const badProfile = await request(app, "POST", "/v1/agent-profiles/not%20simple/versions", {
      version: 0,
      definition: [],
      extra: true,
    });
    expect(badProfile.status).toBe(400);

    const badExecution = await request(
      app,
      "POST",
      "/v1/executions",
      {
        profile: { id: "coder", version: 1 },
        input: { text: "", extra: true },
        workspace: { type: "empty", path: "/tmp" },
      },
      { "Idempotency-Key": "request-2" },
    );
    expect(badExecution.status).toBe(400);

    const missingKey = await request(app, "POST", "/v1/executions", {
      profile: { id: "coder", version: 1 },
      input: { text: "hello" },
      workspace: { type: "empty" },
    });
    expect(missingKey.status).toBe(400);

    const controlKey = await request(
      app,
      "POST",
      "/v1/executions",
      { profile: { id: "coder", version: 1 }, input: { text: "hello" }, workspace: { type: "empty" } },
      { "Idempotency-Key": "bad\u007fkey" },
    );
    expect(controlKey.status).toBe(400);

    const invalidProfile = await request(app, "POST", "/v1/agent-profiles/coder/versions", {
      version: 1,
      definition: { runtime: { type: "opencode" }, timeoutSeconds: 0 },
    });
    expect(invalidProfile.status).toBe(400);

    const missingAgent = await request(app, "POST", "/v1/agent-profiles/coder/versions", {
      version: 1,
      definition: {
        runtime: { type: "opencode", agent: "coder", opencodeConfig: { agent: {} } },
        timeoutSeconds: 3_600,
      },
    });
    expect(missingAgent.status).toBe(400);

    const oversizedProfile = await request(app, "POST", "/v1/agent-profiles/large/versions", {
      version: 1,
      definition: {
        ...profileDefinition("large"),
        runtime: { ...profileDefinition("large").runtime, opencodeConfig: { padding: "x".repeat(140_000) } },
      },
    });
    expect(oversizedProfile.status).toBe(413);
  });

  it("returns 404 for missing profile versions and executions", async () => {
    const app = testApp();
    const missingProfile = await request(
      app,
      "POST",
      "/v1/executions",
      { profile: { id: "missing", version: 1 }, input: { text: "hello" }, workspace: { type: "empty" } },
      { "Idempotency-Key": "request-3" },
    );
    expect(missingProfile.status).toBe(404);

    const missingExecution = await request(app, "GET", "/v1/executions/missing");
    expect(missingExecution.status).toBe(404);
  });

  it("returns 409 when an idempotency key is reused for another request", async () => {
    const app = testApp();
    await publishCoder(app);
    const base = { profile: { id: "coder", version: 1 }, workspace: { type: "empty" } };

    expect((await request(app, "POST", "/v1/executions", { ...base, input: { text: "first" } }, { "Idempotency-Key": "same" })).status).toBe(202);
    const conflict = await request(app, "POST", "/v1/executions", { ...base, input: { text: "second" } }, { "Idempotency-Key": "same" });

    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual({ error: "Idempotency-Key was already used for a different request" });
  });

  it("maps unexpected store failures to a non-leaking 500", async () => {
    const store = new FakeExecutionStore();
    store.failure = new Error("database password leaked");
    const app = testApp(store);

    const response = await request(app, "GET", "/v1/executions/failed");

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Internal server error" });
    expect(JSON.stringify(response.body)).not.toContain("password");
  });
});

class FakeExecutionStore implements ExecutionStore {
  readonly profiles = new Map<string, AgentProfileVersion>();
  readonly executions = new Map<string, Execution>();
  readonly idempotency = new Map<string, { hash: string; execution: Execution }>();
  failure?: Error;

  async publishProfileVersion(command: PublishProfileVersionCommand): Promise<AgentProfileVersion> {
    this.maybeFail();
    const key = profileKey(command.tenantId, command.profileId, command.version);
    if (this.profiles.has(key)) throw new ProfileVersionAlreadyExistsError(command.profileId, command.version);
    const profile = {
      id: command.id,
      tenantId: command.tenantId,
      profile: { id: command.profileId, version: command.version },
      definition: command.definition,
      createdAt: command.createdAt,
    };
    this.profiles.set(key, profile);
    return profile;
  }

  async getProfileVersion(tenantId: string, profileId: string, version: number): Promise<AgentProfileVersion | undefined> {
    this.maybeFail();
    return this.profiles.get(profileKey(tenantId, profileId, version));
  }

  async createExecution(command: CreateExecutionCommand): Promise<CreateExecutionResult> {
    this.maybeFail();
    const idempotencyKey = `${command.tenantId}:${command.idempotencyKey}`;
    const prior = this.idempotency.get(idempotencyKey);
    if (prior) {
      if (prior.hash !== command.requestHash) throw new IdempotencyConflictError();
      return { execution: prior.execution, replayed: true };
    }

    const profileVersion = await this.getProfileVersion(command.tenantId, command.profile.id, command.profile.version);
    if (!profileVersion) throw new ProfileVersionNotFoundError(command.profile.id, command.profile.version);

    const execution: Execution = {
      id: command.id,
      tenantId: command.tenantId,
      state: "QUEUED",
      profile: profileVersion.profile,
      input: command.input,
      workspace: command.workspace,
      eventId: command.event.id,
      createdAt: command.createdAt,
      updatedAt: command.createdAt,
      result: null,
    };
    this.executions.set(`${command.tenantId}:${command.id}`, execution);
    this.idempotency.set(idempotencyKey, { hash: command.requestHash, execution });
    return { execution, replayed: false };
  }

  async getExecution(tenantId: string, executionId: string): Promise<Execution | undefined> {
    this.maybeFail();
    return this.executions.get(`${tenantId}:${executionId}`);
  }

  private maybeFail(): void {
    if (this.failure) throw this.failure;
  }
}

async function publishCoder(app: ReturnType<typeof createOpenApiApp>): Promise<void> {
  const response = await request(app, "POST", "/v1/agent-profiles/coder/versions", { version: 1, definition: profileDefinition("coder") });
  expect(response.status).toBe(201);
}

function profileDefinition(agent: string) {
  return {
    runtime: {
      agent,
      opencodeConfig: { agent: { [agent]: { prompt: "Test agent" } } },
      type: "opencode",
    },
    timeoutSeconds: 3_600,
  };
}

function profileKey(tenantId: string, profileId: string, version: number): string {
  return `${tenantId}:${profileId}:${version}`;
}

function testApp(store: ExecutionStore = new FakeExecutionStore()) {
  const app = createOpenApiApp();
  mountExecutionApi(app, testConfig(), store);
  return app;
}

async function request(
  app: ReturnType<typeof createOpenApiApp>,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ body: unknown; headers: Headers; status: number }> {
  const response = await app.request(path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      authorization: "Bearer test-token",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
  });
  return { body: await response.json(), headers: response.headers, status: response.status };
}

function testConfig(): Config {
  const disabled = { enabled: false };
  return {
    adminToken: "test-token",
    botUserName: "agentbay",
    executionMaintenanceBatchSize: 100,
    executionMaintenanceEnabled: true,
    executionMaintenanceIntervalMs: 5_000,
    executionMaxAttempts: 3,
    executionRetryDelayMs: 30_000,
    claimReadyTimeoutMs: 5_000,
    claimShutdownHours: 1,
    claimTtlSecondsAfterFinished: 60,
    kubeNamespace: "unused",
    opencodeDirectory: "/workspace",
    opencodePort: 4096,
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
