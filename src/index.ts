import { serve } from "@hono/node-server";
import { createBotRegistry } from "./chat/bot.js";
import { mountWebhooks } from "./chat/webhooks.js";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { createOpenApiApp, mountHealthRoute, mountOpenApiDocs } from "./openapi.js";
import { mountRuntimeAdmin } from "./runtime/admin.js";
import { createRuntimeStore } from "./runtime/store.js";
import { createCustomObjectsApi } from "./sandbox/client.js";
import { SandboxManager } from "./sandbox/manager.js";

const config = loadConfig();
const runtimeStore = await createRuntimeStore();
const sandboxManager = new SandboxManager(createCustomObjectsApi(), config);
const chats = createBotRegistry(config, sandboxManager, runtimeStore);
const app = createOpenApiApp();

mountHealthRoute(app, config, runtimeStore);
mountWebhooks(app, chats, runtimeStore);
mountRuntimeAdmin(app, config, runtimeStore);
mountOpenApiDocs(app);

const server = serve({ fetch: (request) => app.fetch(request), port: config.port }, (info) => {
  logger.info("agentbay listening", { port: info.port });
});

async function shutdown(signal: string): Promise<void> {
  logger.info("shutdown received", { signal });
  await chats.shutdown();
  await runtimeStore.close?.();
  server.close();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
