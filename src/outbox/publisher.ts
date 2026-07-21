import { randomUUID } from "node:crypto";
import type { ClaimedOutboxMessage, OutboxEnvelope, OutboxStore, OutboxTransport } from "./types.js";
import { outboxAttempts, outboxPublishDuration } from "../observability/metrics.js";

export type PublishAccounting = {
  claimed: number;
  published: number;
  failed: number;
  lostClaims: number;
};

export type OutboxPublisherOptions = {
  store: OutboxStore;
  transport: OutboxTransport;
  batchSize: number;
  leaseDurationMs: number;
  transportTimeoutMs: number;
  baseRetryDelayMs: number;
  maxRetryDelayMs: number;
  topics?: readonly string[];
  maxErrorLength?: number;
  random?: () => number;
  uuid?: () => string;
};

export class OutboxPublisher {
  readonly #store: OutboxStore;
  readonly #transport: OutboxTransport;
  readonly #batchSize: number;
  readonly #leaseDurationMs: number;
  readonly #transportTimeoutMs: number;
  readonly #baseRetryDelayMs: number;
  readonly #maxRetryDelayMs: number;
  readonly #maxErrorLength: number;
  readonly #topics?: readonly string[];
  readonly #random: () => number;
  readonly #uuid: () => string;

  constructor(options: OutboxPublisherOptions) {
    requirePositiveInteger("batchSize", options.batchSize);
    if (options.batchSize !== 1) throw new RangeError("batchSize must be 1 until outbox leases support renewal");
    requirePositiveInteger("leaseDurationMs", options.leaseDurationMs);
    requirePositiveInteger("transportTimeoutMs", options.transportTimeoutMs);
    requirePositiveInteger("baseRetryDelayMs", options.baseRetryDelayMs);
    requirePositiveInteger("maxRetryDelayMs", options.maxRetryDelayMs);
    if (options.transportTimeoutMs >= options.leaseDurationMs) {
      throw new RangeError("transportTimeoutMs must be shorter than leaseDurationMs");
    }
    if (options.baseRetryDelayMs > options.maxRetryDelayMs) {
      throw new RangeError("baseRetryDelayMs must not exceed maxRetryDelayMs");
    }

    const maxErrorLength = options.maxErrorLength ?? 1_024;
    requirePositiveInteger("maxErrorLength", maxErrorLength);

    this.#store = options.store;
    this.#transport = options.transport;
    this.#batchSize = options.batchSize;
    this.#leaseDurationMs = options.leaseDurationMs;
    this.#transportTimeoutMs = options.transportTimeoutMs;
    this.#baseRetryDelayMs = options.baseRetryDelayMs;
    this.#maxRetryDelayMs = options.maxRetryDelayMs;
    this.#maxErrorLength = maxErrorLength;
    this.#topics = options.topics;
    this.#random = options.random ?? Math.random;
    this.#uuid = options.uuid ?? randomUUID;
  }

  async publishAvailable(signal?: AbortSignal): Promise<PublishAccounting> {
    signal?.throwIfAborted();
    const claimToken = this.#uuid();
    const messages = await this.#store.claimAvailable({
      claimToken,
      limit: this.#batchSize,
      leaseDurationMs: this.#leaseDurationMs,
      ...(this.#topics === undefined ? {} : { topics: this.#topics }),
      ...(signal === undefined ? {} : { signal }),
    });
    const accounting: PublishAccounting = { claimed: messages.length, published: 0, failed: 0, lostClaims: 0 };

    for (const message of messages) {
      signal?.throwIfAborted();
      const startedAt = process.hrtime.bigint();
      try {
        await this.#publishWithTimeout(toEnvelope(message), signal);
      } catch (error) {
        if (signal?.aborted) signal.throwIfAborted();
        const marked = await this.#store.markFailed({
          id: message.id,
          claimToken,
          error: sanitizeError(error, this.#maxErrorLength),
          retryDelayMs: this.#retryDelay(message.publishAttempts),
        });
        const result = marked ? "failed" : "lost_claim";
        outboxAttempts.inc({ topic: message.topic, result });
        outboxPublishDuration.observe({ topic: message.topic, result }, elapsedSeconds(startedAt));
        if (marked) accounting.failed += 1;
        else accounting.lostClaims += 1;
        continue;
      }

      const marked = await this.#store.markPublished({ id: message.id, claimToken });
      const result = marked ? "published" : "lost_claim";
      outboxAttempts.inc({ topic: message.topic, result });
      outboxPublishDuration.observe({ topic: message.topic, result }, elapsedSeconds(startedAt));
      if (marked) accounting.published += 1;
      else accounting.lostClaims += 1;
    }

    return accounting;
  }

  async #publishWithTimeout(envelope: OutboxEnvelope, signal?: AbortSignal): Promise<void> {
    const timeoutController = new AbortController();
    const transportSignal = signal === undefined
      ? timeoutController.signal
      : AbortSignal.any([signal, timeoutController.signal]);
    let timeout: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const timeoutError = new DOMException(
      `Transport publish timed out after ${this.#transportTimeoutMs}ms`,
      "TimeoutError",
    );
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        reject(timeoutError);
        timeoutController.abort(timeoutError);
      }, this.#transportTimeoutMs);
    });
    const abortPromise = new Promise<never>((_, reject) => {
      if (signal === undefined) return;
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    });

    try {
      await Promise.race([
        this.#transport.publish(envelope, { signal: transportSignal }),
        timeoutPromise,
        abortPromise,
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
    }
  }

  #retryDelay(publishAttempts: number): number {
    const exponent = Math.max(0, Math.min(52, publishAttempts - 1));
    const cappedDelay = Math.min(this.#maxRetryDelayMs, this.#baseRetryDelayMs * 2 ** exponent);
    const random = Math.max(0, Math.min(1, this.#random()));
    return Math.floor(cappedDelay / 2 + random * cappedDelay / 2);
  }
}

function elapsedSeconds(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
}

function toEnvelope(message: ClaimedOutboxMessage): OutboxEnvelope {
  return {
    id: message.id,
    tenantId: message.tenantId,
    topic: message.topic,
    aggregateType: message.aggregateType,
    aggregateId: message.aggregateId,
    payload: message.payload,
    headers: message.headers,
    createdAt: message.createdAt.toISOString(),
  };
}

function sanitizeError(error: unknown, maxLength: number): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const sanitized = raw.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim() || "Unknown publish error";
  return sanitized.slice(0, maxLength);
}

function requirePositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
}
