import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { Config } from "../../src/config.js";
import { mountRuntimeAdmin } from "../../src/runtime/admin.js";
import { TestRuntimeStore } from "./runtime-store-fixture.js";

describe("runtime admin API", () => {
  it("is disabled when no admin token is configured", async () => {
    const app = new Hono();
    mountRuntimeAdmin(app, { ...testConfig(), adminToken: undefined }, new TestRuntimeStore());

    const response = await app.request("/admin/runtime/bots");

    expect(response.status).toBe(404);
  });

  it("requires bearer token auth", async () => {
    const app = new Hono();
    mountRuntimeAdmin(app, testConfig(), new TestRuntimeStore());

    const response = await app.request("/admin/runtime/bots");

    expect(response.status).toBe(401);
  });

  it("creates and reads runtime records through explicit CRUD endpoints", async () => {
    const app = new Hono();
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
      displayName: "Coder",
      enabled: true,
      id: "agent-profile-coder",
      opencodeAgentName: "coder",
      opencodeConfigID: "opencode-config-test",
      slug: "coder",
    });
    expect(agent.status).toBe(201);

    const bot = await requestJSON(app, "POST", "/admin/runtime/bots", {
      defaultAgentProfileID: "agent-profile-coder",
      displayName: "Cluster Bot",
      enabled: true,
      id: "bot-cluster",
      sandboxProfileID: "sandbox-profile-test",
      slug: "clusterbot",
    });
    expect(bot.status).toBe(201);

    const fetched = await requestJSON(app, "GET", "/admin/runtime/bots/bot-cluster");
    expect(fetched.status).toBe(200);
    expect(fetched.body).toMatchObject({ id: "bot-cluster", slug: "clusterbot" });

    const allowList = await requestJSON(app, "GET", "/admin/runtime/bot-agent-profiles");
    expect(allowList.status).toBe(200);
    expect(allowList.body).toContainEqual({ agentProfileID: "agent-profile-coder", botID: "bot-cluster" });
  });

  it("rejects deleting a bot default agent-profile mapping", async () => {
    const app = new Hono();
    mountRuntimeAdmin(app, testConfig(), new TestRuntimeStore());

    const response = await requestJSON(app, "DELETE", "/admin/runtime/bot-agent-profiles/bot-default/agent-profile-default");

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: "Cannot delete default agent profile mapping for bot bot-default" });
  });
});

async function requestJSON(
  app: Hono,
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
    claimEnv: [],
    claimPollIntervalMs: 10,
    claimReadyTimeoutMs: 5_000,
    claimShutdownHours: 1,
    claimTtlSecondsAfterFinished: 60,
    kubeNamespace: "unused",
    opencodeDirectory: "/workspace",
    opencodePort: 4096,
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
