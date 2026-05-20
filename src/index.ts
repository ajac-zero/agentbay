import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createBotRegistry } from "./chat/bot.js";
import { mountWebhooks } from "./chat/webhooks.js";
import { loadConfig } from "./config.js";
import { mountRuntimeAdmin } from "./runtime/admin.js";
import { createRuntimeStore } from "./runtime/store.js";
import { createCustomObjectsApi } from "./sandbox/client.js";
import { SandboxManager } from "./sandbox/manager.js";

const config = loadConfig();
const runtimeStore = await createRuntimeStore();
const sandboxManager = new SandboxManager(createCustomObjectsApi(), config);
const chats = createBotRegistry(config, sandboxManager, runtimeStore);
const app = new Hono();

app.get("/healthz", async (context) =>
  context.json({
    ok: true,
    service: "agentbay",
    bots: (await runtimeStore.listBots()).map((bot) => ({ slug: bot.slug, enabled: bot.enabled })),
    adapters: {
      discord: config.discord.enabled,
      gchat: config.gchat.enabled,
      github: config.github.enabled,
      linear: config.linear.enabled,
      messenger: config.messenger.enabled,
      slack: config.slack.enabled,
      teams: config.teams.enabled,
      telegram: config.telegram.enabled,
      whatsapp: config.whatsapp.enabled,
    },
  }),
);

mountWebhooks(app, chats, config, runtimeStore);
mountRuntimeAdmin(app, config, runtimeStore);

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`agentbay listening on http://0.0.0.0:${info.port}`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`received ${signal}, shutting down`);
  await chats.shutdown();
  await runtimeStore.close?.();
  server.close();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
