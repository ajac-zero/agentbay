import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { mountControlApi } from "./control/api.js";
import { mountGitHubWebhookApi } from "./connectors/github/api.js";
import { runExecutionMaintenanceLoop } from "./dispatch/maintenance.js";
import { DispatcherWorker, OpenCodeExecutionAttemptRunner } from "./dispatch/worker.js";
import { createOpenApiApp, mountHealthRoute, mountOpenApiDocs } from "./openapi.js";
import { createRuntimeStore } from "./runtime/store.js";
import { createKubeConfig } from "./sandbox/client.js";
import { SandboxClaimExecutionAttemptProvisioner } from "./sandbox/provisioner.js";
import { GitHubAppRevisionResolver } from "./revision/github.js";
import { RevisionResolutionWorker } from "./revision/worker.js";

const config = loadConfig();
const runtimeStore = await createRuntimeStore();
const provisioner = config.executionMaintenanceEnabled || config.dispatcherEnabled
  ? new SandboxClaimExecutionAttemptProvisioner(createKubeConfig(), config)
  : undefined;
const dispatcherController = new AbortController();
const maintenanceController = new AbortController();
const revisionController = new AbortController();
const revisionTask = config.revisionResolverEnabled
  ? new RevisionResolutionWorker({
      store: runtimeStore,
      resolver: new GitHubAppRevisionResolver({
        appIdFile: config.githubAppIdFile!,
        privateKeyFile: config.githubAppPrivateKeyFile!,
      }),
      workerId: config.revisionResolverWorkerId,
      leaseDurationMs: config.revisionResolverLeaseDurationMs,
      idlePollMs: config.revisionResolverIdlePollMs,
      retryDelayMs: config.revisionResolverRetryDelayMs,
      maxAttempts: config.revisionResolverMaxAttempts,
      requestTimeoutMs: config.revisionResolverRequestTimeoutMs,
    }).run(revisionController.signal)
  : Promise.resolve();
const revisionResolver = revisionTask.catch((error: unknown) => {
  logger.error("revision resolution worker stopped unexpectedly", { error });
});
const maintenanceTask = config.executionMaintenanceEnabled
  ? runExecutionMaintenanceLoop({
      batchSize: config.executionMaintenanceBatchSize,
      intervalMs: config.executionMaintenanceIntervalMs,
      maxAttempts: config.executionMaxAttempts,
      retryDelayMs: config.executionRetryDelayMs,
      signal: maintenanceController.signal,
      cancellationCleaner: provisioner!,
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
      provisioner: provisioner!,
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
mountGitHubWebhookApi(app, runtimeStore);
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
  revisionController.abort();
  const serverClosed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await serverClosed;
  await Promise.all([maintenance, dispatcher, revisionResolver]);
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
