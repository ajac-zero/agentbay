import { describe, expect, it, vi } from "vitest";
import { runExecutionMaintenanceLoop } from "../../src/dispatch/maintenance.js";
import type { Logger } from "../../src/logger.js";

function fakeLogger(): Logger {
  return {
    child: vi.fn(() => fakeLogger()),
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
}

describe("execution maintenance", () => {
  it("runs immediately and passes the configured retry policy", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const store = {
        recoverExpiredExecutionLeases: vi.fn().mockResolvedValue([]),
        promoteDueExecutionRetries: vi.fn().mockImplementation(async () => {
          controller.abort();
          return [];
        }),
      };

      await runExecutionMaintenanceLoop({
        batchSize: 25,
        intervalMs: 5_000,
        maxAttempts: 3,
        retryDelayMs: 30_000,
        signal: controller.signal,
        store,
      });
      expect(store.recoverExpiredExecutionLeases).toHaveBeenCalledWith({
        limit: 25,
        maxAttempts: 3,
        retryDelayMs: 30_000,
      });
      expect(store.promoteDueExecutionRetries).toHaveBeenCalledWith({ limit: 25 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not overlap cycles and stops an idle wait when aborted", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      let release: (() => void) | undefined;
      const firstRecovery = new Promise<never[]>((resolve) => { release = () => resolve([]); });
      const store = {
        recoverExpiredExecutionLeases: vi.fn().mockReturnValueOnce(firstRecovery).mockResolvedValue([]),
        promoteDueExecutionRetries: vi.fn().mockResolvedValue([]),
      };
      const loop = runExecutionMaintenanceLoop({
        batchSize: 1,
        intervalMs: 5_000,
        maxAttempts: 1,
        retryDelayMs: 0,
        signal: controller.signal,
        store,
      });

      await vi.advanceTimersByTimeAsync(20_000);
      expect(store.recoverExpiredExecutionLeases).toHaveBeenCalledTimes(1);
      release?.();
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await loop;
      expect(store.promoteDueExecutionRetries).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("isolates operation failures and continues the cycle", async () => {
    const controller = new AbortController();
    const log = fakeLogger();
    const store = {
      recoverExpiredExecutionLeases: vi.fn().mockRejectedValue(new Error("database unavailable")),
      promoteDueExecutionRetries: vi.fn().mockImplementation(async () => {
        controller.abort();
        return [];
      }),
    };

    await expect(runExecutionMaintenanceLoop({
      batchSize: 10,
      intervalMs: 5_000,
      maxAttempts: 3,
      retryDelayMs: 30_000,
      signal: controller.signal,
      store,
      log,
    })).resolves.toBeUndefined();
    expect(store.promoteDueExecutionRetries).toHaveBeenCalledOnce();
    expect(log.error).toHaveBeenCalledWith("expired execution lease recovery failed", expect.any(Object));
  });
});
