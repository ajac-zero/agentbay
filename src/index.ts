import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { mountControlApi } from "./control/api.js";
import { runExecutionMaintenanceLoop } from "./dispatch/maintenance.js";
import { DispatcherWorker, OpenCodeExecutionAttemptRunner } from "./dispatch/worker.js";
import { createOpenApiApp, mountHealthRoute, mountOpenApiDocs } from "./openapi.js";
import { createRuntimeStore } from "./runtime/store.js";
import { createKubeConfig } from "./sandbox/client.js";
import { SandboxClaimExecutionAttemptProvisioner } from "./sandbox/provisioner.js";

const config = loadConfig();
const runtimeStore = await createRuntimeStore();
const dispatcherController = new AbortController();
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
const dispatcherTask = config.dispatcherEnabled
  ? new DispatcherWorker({
      idlePollMs: config.dispatcherIdlePollMs,
      leaseDurationMs: config.dispatcherLeaseDurationMs,
      maxAttempts: config.executionMaxAttempts,
      provisioner: new SandboxClaimExecutionAttemptProvisioner(createKubeConfig(), config),
      renewIntervalMs: config.dispatcherRenewIntervalMs,
      retryDelayMs: config.executionRetryDelayMs,
      runner: new OpenCodeExecutionAttemptRunner({
        directory: config.opencodeDirectory,
        port: config.opencodePort,
        readyTimeoutMs: config.claimReadyTimeoutMs,
      }),
      store: runtimeStore,
      workerId: config.dispatcherWorkerId,
    }).run(dispatcherController.signal)
  : Promise.resolve();
const dispatcher = dispatcherTask.catch((error: unknown) => {
  logger.error("dispatcher worker stopped unexpectedly", { error });
});
const app = createOpenApiApp();

mountHealthRoute(app);
mountControlApi(app, config, runtimeStore);
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
  dispatcherController.abort();
  const serverClosed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await serverClosed;
  await Promise.all([maintenance, dispatcher]);
  await runtimeStore.close();
}

function handleSignal(signal: string): void {
  void shutdown(signal).catch((error: unknown) => {
    logger.error("shutdown failed", { error, signal });
    process.exitCode = 1;
  });
}

process.once("SIGINT", () => handleSignal("SIGINT"));
process.once("SIGTERM", () => handleSignal("SIGTERM"));
