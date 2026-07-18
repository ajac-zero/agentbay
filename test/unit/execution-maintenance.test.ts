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
        listRequestedCancellationCleanups: vi.fn().mockResolvedValue([]),
        finalizeRequestedExecutionCancellation: vi.fn().mockResolvedValue(undefined),
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
        cancellationCleaner: { releaseCancelledExecution: vi.fn() },
        store,
      });
      expect(store.listRequestedCancellationCleanups).toHaveBeenCalledWith({ limit: 25 });
      expect(store.recoverExpiredExecutionLeases).toHaveBeenCalledWith({
        limit: 25,
        maxAttempts: 3,
        retryDelayMs: 30_000,
      });
      expect(store.promoteDueExecutionRetries).toHaveBeenCalledWith({ limit: 25 });
      expect(store.listRequestedCancellationCleanups.mock.invocationCallOrder[0]).toBeLessThan(
        store.recoverExpiredExecutionLeases.mock.invocationCallOrder[0]!,
      );
      expect(store.recoverExpiredExecutionLeases.mock.invocationCallOrder[0]).toBeLessThan(
        store.promoteDueExecutionRetries.mock.invocationCallOrder[0]!,
      );
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
        listRequestedCancellationCleanups: vi.fn().mockResolvedValue([]),
        finalizeRequestedExecutionCancellation: vi.fn().mockResolvedValue(undefined),
        recoverExpiredExecutionLeases: vi.fn().mockReturnValueOnce(firstRecovery).mockResolvedValue([]),
        promoteDueExecutionRetries: vi.fn().mockResolvedValue([]),
      };
      const loop = runExecutionMaintenanceLoop({
        batchSize: 1,
        intervalMs: 5_000,
        maxAttempts: 1,
        retryDelayMs: 0,
        signal: controller.signal,
        cancellationCleaner: { releaseCancelledExecution: vi.fn() },
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

  it("cleans each candidate before finalizing and does not starve the batch after a cleanup failure", async () => {
    const controller = new AbortController();
    const log = fakeLogger();
    const failed = {
      attempt: 1,
      executionId: "execution-1",
      tenantId: "tenant-1",
      workloadName: "claim-1",
    };
    const cleaned = {
      attempt: null,
      executionId: "execution-2",
      tenantId: "tenant-1",
      workloadName: null,
    };
    const cleaner = {
      releaseCancelledExecution: vi.fn()
        .mockRejectedValueOnce(new Error("claim unavailable"))
        .mockResolvedValueOnce(undefined),
    };
    const store = {
      listRequestedCancellationCleanups: vi.fn().mockResolvedValue([failed, cleaned]),
      finalizeRequestedExecutionCancellation: vi.fn().mockResolvedValue({ ...cleaned, finalizedAt: new Date() }),
      recoverExpiredExecutionLeases: vi.fn().mockResolvedValue([]),
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
      cancellationCleaner: cleaner,
      store,
      log,
    })).resolves.toBeUndefined();
    expect(cleaner.releaseCancelledExecution).toHaveBeenNthCalledWith(1, failed, controller.signal);
    expect(cleaner.releaseCancelledExecution).toHaveBeenNthCalledWith(2, cleaned, controller.signal);
    expect(store.finalizeRequestedExecutionCancellation).toHaveBeenCalledOnce();
    expect(store.finalizeRequestedExecutionCancellation).toHaveBeenCalledWith(cleaned);
    expect(cleaner.releaseCancelledExecution.mock.invocationCallOrder[1]).toBeLessThan(
      store.finalizeRequestedExecutionCancellation.mock.invocationCallOrder[0]!,
    );
    expect(store.promoteDueExecutionRetries).toHaveBeenCalledOnce();
    expect(store.recoverExpiredExecutionLeases).toHaveBeenCalledOnce();
    expect(log.error).toHaveBeenCalledWith("requested execution cancellation cleanup failed", expect.objectContaining({
      executionId: failed.executionId,
    }));
  });

  it("isolates cancellation listing failures from the rest of the cycle", async () => {
    const controller = new AbortController();
    const log = fakeLogger();
    const store = {
      listRequestedCancellationCleanups: vi.fn().mockRejectedValue(new Error("database unavailable")),
      finalizeRequestedExecutionCancellation: vi.fn(),
      recoverExpiredExecutionLeases: vi.fn().mockResolvedValue([]),
      promoteDueExecutionRetries: vi.fn().mockImplementation(async () => {
        controller.abort();
        return [];
      }),
    };

    await runExecutionMaintenanceLoop({
      batchSize: 10,
      intervalMs: 5_000,
      maxAttempts: 3,
      retryDelayMs: 30_000,
      signal: controller.signal,
      cancellationCleaner: { releaseCancelledExecution: vi.fn() },
      store,
      log,
    });

    expect(store.recoverExpiredExecutionLeases).toHaveBeenCalledOnce();
    expect(store.promoteDueExecutionRetries).toHaveBeenCalledOnce();
    expect(log.error).toHaveBeenCalledWith("requested execution cancellation listing failed", expect.any(Object));
  });
});
