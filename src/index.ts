import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createBot } from "./chat/bot.js";
import { mountWebhooks } from "./chat/webhooks.js";
import { loadConfig } from "./config.js";
import { createCustomObjectsApi } from "./sandbox/client.js";
import { SandboxManager } from "./sandbox/manager.js";

const config = loadConfig();
const sandboxManager = new SandboxManager(createCustomObjectsApi(), config);
const chat = createBot(config, sandboxManager);
const app = new Hono();

app.get("/healthz", (context) =>
  context.json({
    ok: true,
    service: "agentbay",
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

mountWebhooks(app, chat, config);

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`agentbay listening on http://0.0.0.0:${info.port}`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`received ${signal}, shutting down`);
  await chat.shutdown();
  server.close();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
