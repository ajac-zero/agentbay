import { logger, toErrCtx, type Logger } from "../logger.js";
import type { DispatcherExecutionStore } from "./store.js";

export type ExecutionMaintenanceOptions = {
  batchSize: number;
  intervalMs: number;
  maxAttempts: number;
  retryDelayMs: number;
  signal: AbortSignal;
  store: Pick<DispatcherExecutionStore, "promoteDueExecutionRetries" | "recoverExpiredExecutionLeases">;
  log?: Logger;
};

export async function runExecutionMaintenanceLoop(options: ExecutionMaintenanceOptions): Promise<void> {
  const log = options.log ?? logger.child({ component: "execution-maintenance" });

  while (!options.signal.aborted) {
    try {
      const recovered = await options.store.recoverExpiredExecutionLeases({
        limit: options.batchSize,
        maxAttempts: options.maxAttempts,
        retryDelayMs: options.retryDelayMs,
      });
      if (recovered.length > 0) log.info("expired execution leases recovered", { count: recovered.length });
    } catch (error) {
      log.error("expired execution lease recovery failed", { err: toErrCtx(error) });
    }

    if (options.signal.aborted) break;

    try {
      const promoted = await options.store.promoteDueExecutionRetries({ limit: options.batchSize });
      if (promoted.length > 0) log.info("due execution retries reconciled", { count: promoted.length });
    } catch (error) {
      log.error("execution retry promotion failed", { err: toErrCtx(error) });
    }

    if (options.signal.aborted) break;
    await abortableDelay(options.intervalMs, options.signal);
  }
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(finish, delayMs);
    signal.addEventListener("abort", finish, { once: true });

    function finish(): void {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}
