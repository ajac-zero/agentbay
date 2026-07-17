import { serve } from "@hono/node-server";
import { createBotRegistry } from "./chat/bot.js";
import { mountWebhooks } from "./chat/webhooks.js";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { mountExecutionApi } from "./execution/api.js";
import { runExecutionMaintenanceLoop } from "./dispatch/maintenance.js";
import { createOpenApiApp, mountHealthRoute, mountOpenApiDocs } from "./openapi.js";
import { mountRuntimeAdmin } from "./runtime/admin.js";
import { createRuntimeStore } from "./runtime/store.js";
import { createKubeConfig } from "./sandbox/client.js";
import { SandboxManager } from "./sandbox/manager.js";

const config = loadConfig();
const runtimeStore = await createRuntimeStore();
const sandboxManager = new SandboxManager(createKubeConfig(), config);
const chats = createBotRegistry(config, sandboxManager, runtimeStore);
const maintenanceController = new AbortController();
const maintenanceTask = config.executionMaintenanceEnabled
  ? runExecutionMaintenanceLoop({
      batchSize: config.executionMaintenanceBatchSize,
      intervalMs: config.executionMaintenanceIntervalMs,
      maxAttempts: config.executionMaxAttempts,
      retryDelayMs: config.executionRetryDelayMs,
      signal: maintenanceController.signal,
      store: runtimeStore,
    })
  : Promise.resolve();
const maintenance = maintenanceTask.catch((error: unknown) => {
  logger.error("execution maintenance loop stopped unexpectedly", { error });
});
const app = createOpenApiApp();

mountHealthRoute(app, config, runtimeStore);
mountWebhooks(app, chats, runtimeStore);
mountRuntimeAdmin(app, config, runtimeStore);
mountExecutionApi(app, config, runtimeStore);
mountOpenApiDocs(app);

const server = serve({ fetch: (request) => app.fetch(request), port: config.port }, (info) => {
  logger.info("agentbay listening", { port: info.port });
});

let shutdownPromise: Promise<void> | undefined;

function shutdown(signal: string): Promise<void> {
  shutdownPromise ??= performShutdown(signal);
  return shutdownPromise;
}

async function performShutdown(signal: string): Promise<void> {
  logger.info("shutdown received", { signal });
  maintenanceController.abort();
  const serverClosed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await Promise.all([serverClosed, chats.shutdown()]);
  await maintenance;
  await runtimeStore.close?.();
}

function handleSignal(signal: string): void {
  void shutdown(signal).catch((error: unknown) => {
    logger.error("shutdown failed", { error, signal });
    process.exitCode = 1;
  });
}

process.once("SIGINT", () => handleSignal("SIGINT"));
process.once("SIGTERM", () => handleSignal("SIGTERM"));
