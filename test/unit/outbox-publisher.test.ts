import { describe, expect, it, vi } from "vitest";
import { OutboxPublisher } from "../../src/outbox/publisher.js";
import type { ClaimedOutboxMessage, OutboxStore, OutboxTransport } from "../../src/outbox/types.js";

const now = new Date("2026-07-17T12:00:00.000Z");

function message(id: string, publishAttempts = 1): ClaimedOutboxMessage {
  return {
    id,
    tenantId: "tenant-1",
    topic: "execution.requested",
    aggregateType: "execution",
    aggregateId: `execution-${id}`,
    payload: { id },
    headers: { traceparent: "trace-1" },
    createdAt: new Date("2026-07-17T11:00:00.000Z"),
    availableAt: new Date("2026-07-17T11:30:00.000Z"),
    publishAttempts,
    claimToken: "claim-1",
    claimExpiresAt: new Date("2026-07-17T12:01:00.000Z"),
  };
}

function setup(messages: ClaimedOutboxMessage[], publish: OutboxTransport["publish"]) {
  const store: OutboxStore = {
    claimAvailable: vi.fn().mockResolvedValue(messages),
    markPublished: vi.fn().mockResolvedValue(true),
    markFailed: vi.fn().mockResolvedValue(true),
  };
  const publisher = new OutboxPublisher({
    store,
    transport: { publish },
    batchSize: 1,
    leaseDurationMs: 60_000,
    transportTimeoutMs: 10_000,
    baseRetryDelayMs: 1_000,
    maxRetryDelayMs: 8_000,
    maxErrorLength: 40,
    random: () => 0.5,
    uuid: () => "claim-1",
  });
  return { publisher, store };
}

describe("OutboxPublisher", () => {
  it("claims a batch and publishes stable envelopes before token-CAS completion", async () => {
    const publish = vi.fn<OutboxTransport["publish"]>().mockResolvedValue(undefined);
    const messages = [message("one"), message("two")];
    const { publisher, store } = setup(messages, publish);

    await expect(publisher.publishAvailable()).resolves.toEqual({ claimed: 2, published: 2, failed: 0, lostClaims: 0 });
    expect(store.claimAvailable).toHaveBeenCalledWith({
      claimToken: "claim-1",
      limit: 1,
      leaseDurationMs: 60_000,
    });
    expect(publish).toHaveBeenNthCalledWith(1, {
      id: "one",
      tenantId: "tenant-1",
      topic: "execution.requested",
      aggregateType: "execution",
      aggregateId: "execution-one",
      payload: { id: "one" },
      headers: { traceparent: "trace-1" },
      createdAt: "2026-07-17T11:00:00.000Z",
    }, { signal: expect.any(AbortSignal) });
    expect(store.markPublished).toHaveBeenNthCalledWith(2, {
      id: "two",
      claimToken: "claim-1",
    });
  });

  it("continues a batch after failure and schedules equal-jitter capped backoff", async () => {
    const publish = vi.fn<OutboxTransport["publish"]>()
      .mockRejectedValueOnce(new Error("bad\nresponse\u0000with a long explanation that is truncated"))
      .mockResolvedValueOnce(undefined);
    const { publisher, store } = setup([message("bad", 5), message("good")], publish);

    await expect(publisher.publishAvailable()).resolves.toEqual({ claimed: 2, published: 1, failed: 1, lostClaims: 0 });
    expect(store.markFailed).toHaveBeenCalledWith({
      id: "bad",
      claimToken: "claim-1",
      error: "Error: bad response with a long explanat",
      retryDelayMs: 6_000,
    });
    expect(store.markPublished).toHaveBeenCalledWith({ id: "good", claimToken: "claim-1" });
  });

  it("accounts for lost success and failure claims", async () => {
    const publish = vi.fn<OutboxTransport["publish"]>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce("unavailable");
    const { publisher, store } = setup([message("published"), message("failed")], publish);
    vi.mocked(store.markPublished).mockResolvedValue(false);
    vi.mocked(store.markFailed).mockResolvedValue(false);

    await expect(publisher.publishAvailable()).resolves.toEqual({ claimed: 2, published: 0, failed: 0, lostClaims: 2 });
  });

  it("times out transport work before the lease and records the failure", async () => {
    vi.useFakeTimers();
    try {
      const publish = vi.fn<OutboxTransport["publish"]>().mockImplementation(async (_envelope, options) => {
        await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }));
      });
      const { publisher, store } = setup([message("slow")], publish);
      const result = publisher.publishAvailable();
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(result).resolves.toEqual({ claimed: 1, published: 0, failed: 1, lostClaims: 0 });
      expect(store.markFailed).toHaveBeenCalledWith(expect.objectContaining({
        error: "TimeoutError: Transport publish timed ou",
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not turn caller cancellation into a retry", async () => {
    const controller = new AbortController();
    const reason = new DOMException("stopping", "AbortError");
    const publish = vi.fn<OutboxTransport["publish"]>().mockImplementation(async (_envelope, options) => {
      controller.abort(reason);
      options.signal.throwIfAborted();
    });
    const { publisher, store } = setup([message("one"), message("two")], publish);

    await expect(publisher.publishAvailable(controller.signal)).rejects.toBe(reason);
    expect(store.markFailed).not.toHaveBeenCalled();
    expect(store.markPublished).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("rejects timeout configurations that can outlive the lease", () => {
    const { store } = setup([], vi.fn<OutboxTransport["publish"]>());
    expect(() => new OutboxPublisher({
      store,
      transport: { publish: vi.fn() },
      batchSize: 1,
      leaseDurationMs: 1_000,
      transportTimeoutMs: 1_000,
      baseRetryDelayMs: 100,
      maxRetryDelayMs: 1_000,
    })).toThrow("transportTimeoutMs must be shorter than leaseDurationMs");
  });

  it("rejects batches that could outlive one shared lease", () => {
    const { store } = setup([], vi.fn<OutboxTransport["publish"]>());
    expect(() => new OutboxPublisher({
      store,
      transport: { publish: vi.fn() },
      batchSize: 2,
      leaseDurationMs: 60_000,
      transportTimeoutMs: 10_000,
      baseRetryDelayMs: 1_000,
      maxRetryDelayMs: 8_000,
    })).toThrow("batchSize must be 1 until outbox leases support renewal");
  });
});
