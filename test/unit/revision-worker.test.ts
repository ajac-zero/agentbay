import { describe, expect, it, vi } from "vitest";
import { RevisionResolutionWorker } from "../../src/revision/worker.js";

const claim = {
  attempt: 1, branch: "main", cloneUrl: "https://github.com/acme/widgets.git", eventId: "event-1",
  installationId: 44, leaseOwner: "worker-1", leaseToken: "lease-1", provider: "github" as const,
  repositoryFullName: "acme/widgets", repositoryId: 10, tenantId: "default",
};

describe("RevisionResolutionWorker", () => {
  it("completes a claimed resolution", async () => {
    const store = fakeStore();
    const resolver = { resolve: vi.fn(async () => "a".repeat(40)) };
    const worker = new RevisionResolutionWorker(options(store, resolver));
    await expect(worker.runOne()).resolves.toBe(true);
    expect(store.completeRevisionResolution).toHaveBeenCalledWith(expect.objectContaining({
      eventId: "event-1", leaseToken: "lease-1", commit: "a".repeat(40), resolvedAt: expect.any(String),
    }));
    expect(store.failRevisionResolution).not.toHaveBeenCalled();
  });

  it("schedules bounded retry metadata after resolution failure", async () => {
    const store = fakeStore();
    const resolver = { resolve: vi.fn(async () => { throw new Error("temporary failure"); }) };
    const worker = new RevisionResolutionWorker(options(store, resolver));
    await expect(worker.runOne()).resolves.toBe(true);
    expect(store.failRevisionResolution).toHaveBeenCalledWith(expect.objectContaining({
      eventId: "event-1", leaseToken: "lease-1", maxAttempts: 5, error: "Error: temporary failure",
      failedAt: expect.any(String), retryAt: expect.any(String),
    }));
    expect(store.completeRevisionResolution).not.toHaveBeenCalled();
  });
});

function fakeStore() {
  return {
    claimRevisionResolution: vi.fn(async () => claim),
    completeRevisionResolution: vi.fn(async () => undefined),
    failRevisionResolution: vi.fn(async () => true),
  };
}

function options(store: any, resolver: any) {
  return {
    store, resolver, workerId: "worker-1", leaseDurationMs: 60_000, idlePollMs: 10,
    retryDelayMs: 30_000, maxAttempts: 5, requestTimeoutMs: 30_000,
  };
}
