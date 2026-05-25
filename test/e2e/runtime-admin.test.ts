import { describe, expect, it } from "vitest";
import type { Config } from "../../src/config.js";
import { createOpenApiApp } from "../../src/openapi.js";
import { mountRuntimeAdmin } from "../../src/runtime/admin.js";
import { defaultRuntimeSnapshot, TestRuntimeStore } from "./runtime-store-fixture.js";

describe("runtime admin API", () => {
  it("is disabled when no admin token is configured", async () => {
    const app = createOpenApiApp();
    mountRuntimeAdmin(app, { ...testConfig(), adminToken: undefined }, new TestRuntimeStore());

    const response = await app.request("/admin/runtime/bots");

    expect(response.status).toBe(404);
  });

  it("requires bearer token auth", async () => {
    const app = createOpenApiApp();
    mountRuntimeAdmin(app, testConfig(), new TestRuntimeStore());

    const response = await app.request("/admin/runtime/bots");

    expect(response.status).toBe(401);
  });

  it("creates and reads runtime records through explicit CRUD endpoints", async () => {
    const app = createOpenApiApp();
    mountRuntimeAdmin(app, testConfig(), new TestRuntimeStore());

    const config = await requestJSON(app, "POST", "/admin/runtime/opencode-configs", {
      config: { agent: { coder: { prompt: "test prompt" } }, default_agent: "coder" },
      displayName: "Test Config",
      enabled: true,
      id: "opencode-config-test",
      slug: "test-config",
    });
    expect(config.status).toBe(201);
    expect(config.body).toMatchObject({ configHash: expect.any(String), id: "opencode-config-test" });

    const sandbox = await requestJSON(app, "POST", "/admin/runtime/sandbox-profiles", {
      enabled: true,
      id: "sandbox-profile-test",
      slug: "test-sandbox",
      templateName: "opencode-template",
      warmpool: "none",
    });
    expect(sandbox.status).toBe(201);

    const agent = await requestJSON(app, "POST", "/admin/runtime/agent-profiles", {
      claimEnv: [{ name: "ANTHROPIC_API_KEY", valueFromEnv: "ANTHROPIC_API_KEY_CODER" }],
      displayName: "Coder",
      enabled: true,
      id: "agent-profile-coder",
      opencodeAgentName: "coder",
      opencodeConfigID: "opencode-config-test",
      slug: "coder",
    });
    expect(agent.status).toBe(201);
    expect(agent.body).toMatchObject({ claimEnv: [{ name: "ANTHROPIC_API_KEY", valueFromEnv: "ANTHROPIC_API_KEY_CODER" }] });

    const bot = await requestJSON(app, "POST", "/admin/runtime/bots", {
      adapters: { telegram: { botTokenEnv: "TELEGRAM_BOT_TOKEN_CODER", userName: "coderbot" } },
      defaultAgentProfileID: "agent-profile-coder",
      displayName: "Cluster Bot",
      enabled: true,
      id: "bot-cluster",
      sandboxProfileID: "sandbox-profile-test",
      slug: "clusterbot",
    });
    expect(bot.status).toBe(201);
    expect(bot.body).toMatchObject({ adapters: { telegram: { botTokenEnv: "TELEGRAM_BOT_TOKEN_CODER", userName: "coderbot" } } });

    const fetched = await requestJSON(app, "GET", "/admin/runtime/bots/bot-cluster");
    expect(fetched.status).toBe(200);
    expect(fetched.body).toMatchObject({ adapters: { telegram: { botTokenEnv: "TELEGRAM_BOT_TOKEN_CODER" } }, id: "bot-cluster", slug: "clusterbot" });

    const allowList = await requestJSON(app, "GET", "/admin/runtime/bot-agent-profiles");
    expect(allowList.status).toBe(200);
    expect(allowList.body).toContainEqual({ agentProfileID: "agent-profile-coder", botID: "bot-cluster" });
  });

  it("rejects deleting a bot default agent-profile mapping", async () => {
    const app = createOpenApiApp();
    mountRuntimeAdmin(app, testConfig(), new TestRuntimeStore());

    const response = await requestJSON(app, "DELETE", "/admin/runtime/bot-agent-profiles/bot-default/agent-profile-default");

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: "Cannot delete default agent profile mapping for bot bot-default" });
  });

  it("rejects agent profiles whose opencode agent is missing from the selected config", async () => {
    const app = createOpenApiApp();
    mountRuntimeAdmin(app, testConfig(), new TestRuntimeStore());

    const response = await requestJSON(app, "POST", "/admin/runtime/agent-profiles", {
      displayName: "Reviewer",
      enabled: true,
      id: "agent-profile-reviewer",
      opencodeAgentName: "reviewer",
      opencodeConfigID: "opencode-config-default",
      slug: "reviewer",
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: "Agent profile references missing opencode agent reviewer in config opencode-config-default",
    });
  });

  it("rejects opencode config updates that remove agents used by existing profiles", async () => {
    const app = createOpenApiApp();
    mountRuntimeAdmin(app, testConfig(), new TestRuntimeStore());

    const response = await requestJSON(app, "PUT", "/admin/runtime/opencode-configs/opencode-config-default", {
      config: { agent: { coder: { prompt: "new prompt" } }, default_agent: "coder" },
      displayName: "Default Config",
      enabled: true,
      id: "opencode-config-default",
      slug: "default",
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: "Agent profile references missing opencode agent agentbay in config opencode-config-default",
    });
  });

  it("rejects invalid runtime ids and slugs before calling the store", async () => {
    const app = createOpenApiApp();
    mountRuntimeAdmin(app, testConfig(), new TestRuntimeStore());

    const invalidID = await requestJSON(app, "POST", "/admin/runtime/opencode-configs", {
      config: { agent: { coder: {} } },
      displayName: "Bad ID",
      enabled: true,
      id: "BadID",
      slug: "bad-id",
    });
    expect(invalidID.status).toBe(400);
    expect(invalidID.body).toMatchObject({ error: "id must be a lowercase DNS label with at most 63 characters" });

    const invalidSlug = await requestJSON(app, "POST", "/admin/runtime/opencode-configs", {
      config: { agent: { coder: {} } },
      displayName: "Bad Slug",
      enabled: true,
      id: "bad-slug",
      slug: "bad/slug",
    });
    expect(invalidSlug.status).toBe(400);
    expect(invalidSlug.body).toMatchObject({ error: "slug must be a lowercase DNS label with at most 63 characters" });

    const longID = await requestJSON(app, "POST", "/admin/runtime/opencode-configs", {
      config: { agent: { coder: {} } },
      displayName: "Long ID",
      enabled: true,
      id: "a".repeat(64),
      slug: "long-id",
    });
    expect(longID.status).toBe(400);
    expect(longID.body).toMatchObject({ error: "id must be a lowercase DNS label with at most 63 characters" });

    const invalidEnv = await requestJSON(app, "POST", "/admin/runtime/agent-profiles", {
      claimEnv: [{ name: "ANTHROPIC-API-KEY", valueFromEnv: "ANTHROPIC_API_KEY" }],
      displayName: "Bad Env",
      enabled: true,
      id: "bad-env",
      opencodeAgentName: "agentbay",
      opencodeConfigID: "opencode-config-default",
      slug: "bad-env",
    });
    expect(invalidEnv.status).toBe(400);
    expect(invalidEnv.body).toMatchObject({ error: "claimEnv[0].name must be a valid environment variable name" });
  });

  it("fails resolution clearly when stored runtime references a missing opencode agent", async () => {
    const snapshot = defaultRuntimeSnapshot();
    snapshot.agentProfiles[0] = { ...snapshot.agentProfiles[0]!, opencodeAgentName: "missing" };

    await expect(new TestRuntimeStore(snapshot).resolveByBotSlug("agentbay")).rejects.toThrow(
      "Agent profile references missing opencode agent missing in config opencode-config-default",
    );
  });
});

async function requestJSON(
  app: ReturnType<typeof createOpenApiApp>,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ body: Record<string, unknown> | unknown[]; status: number }> {
  const response = await app.request(path, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      authorization: "Bearer test-token",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    method,
  });

  return { body: (await response.json()) as Record<string, unknown> | unknown[], status: response.status };
}

function testConfig(): Config {
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
