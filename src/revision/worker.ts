import { logger } from "../logger.js";
import type { RevisionResolutionStore } from "./types.js";
import type { GitHubAppRevisionResolver } from "./github.js";

export class RevisionResolutionWorker {
  constructor(private readonly options: {
    store: RevisionResolutionStore;
    resolver: GitHubAppRevisionResolver;
    workerId: string;
    leaseDurationMs: number;
    idlePollMs: number;
    retryDelayMs: number;
    maxAttempts: number;
    requestTimeoutMs: number;
  }) {
    if (options.requestTimeoutMs >= options.leaseDurationMs) {
      throw new RangeError("requestTimeoutMs must be less than leaseDurationMs");
    }
  }

  async runOne(signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    const claimed = await this.options.store.claimRevisionResolution({
      leaseOwner: this.options.workerId,
      leaseDurationMs: this.options.leaseDurationMs,
    });
    if (!claimed) return false;
    try {
      const requestSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(this.options.requestTimeoutMs)])
        : AbortSignal.timeout(this.options.requestTimeoutMs);
      const commit = await this.options.resolver.resolve(claimed, requestSignal);
      await this.options.store.completeRevisionResolution({
        eventId: claimed.eventId,
        tenantId: claimed.tenantId,
        leaseOwner: claimed.leaseOwner,
        leaseToken: claimed.leaseToken,
        commit,
        resolvedAt: new Date().toISOString(),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      const failedAt = new Date();
      await this.options.store.failRevisionResolution({
        eventId: claimed.eventId,
        tenantId: claimed.tenantId,
        leaseOwner: claimed.leaseOwner,
        leaseToken: claimed.leaseToken,
        error: String(error).slice(0, 2_048),
        failedAt: failedAt.toISOString(),
        retryAt: new Date(failedAt.getTime() + this.options.retryDelayMs).toISOString(),
        maxAttempts: this.options.maxAttempts,
      });
    }
    return true;
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let worked = false;
      try {
        worked = await this.runOne(signal);
      } catch (error) {
        if (signal.aborted) break;
        logger.error("revision resolution worker iteration failed", { error: String(error) });
      }
      if (!worked && !signal.aborted) await delay(this.options.idlePollMs, signal);
    }
  }
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
