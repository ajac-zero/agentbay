import { serve } from "@hono/node-server";
import { createBot } from "./chat/bot.js";
import { mountWebhooks } from "./chat/webhooks.js";
import { loadConfig } from "./config.js";
import { createOpenApiApp, mountHealthRoute, mountOpenApiDocs } from "./openapi.js";
import { mountRuntimeAdmin } from "./runtime/admin.js";
import { createRuntimeStore } from "./runtime/store.js";
import { createCustomObjectsApi } from "./sandbox/client.js";
import { SandboxManager } from "./sandbox/manager.js";

const config = loadConfig();
const runtimeStore = await createRuntimeStore();
const sandboxManager = new SandboxManager(createCustomObjectsApi(), config);
const chat = createBot(config, sandboxManager, runtimeStore);
const app = createOpenApiApp();

mountHealthRoute(app, config, runtimeStore);
mountWebhooks(app, chat, config, runtimeStore);
mountRuntimeAdmin(app, config, runtimeStore);
mountOpenApiDocs(app);

const server = serve({ fetch: (request) => app.fetch(request), port: config.port }, (info) => {
  console.log(`agentbay listening on http://0.0.0.0:${info.port}`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`received ${signal}, shutting down`);
  await chat.shutdown();
  await runtimeStore.close?.();
  server.close();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
