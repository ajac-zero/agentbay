import { describe, expect, it } from "vitest";
import { startExecutionLeaseHeartbeat } from "../../src/dispatch/heartbeat.js";

describe("startExecutionLeaseHeartbeat().stop()", () => {
  it("does not leave a live timer on the event loop when renewal never started", async () => {
    const before = process.getActiveResourcesInfo().filter((k) => k === "Timeout").length;
    const heartbeat = startExecutionLeaseHeartbeat({
      execution: {
        executionId: "exec",
        tenantId: "t",
        lease: {
          attempt: 1,
          fencingToken: "f",
          leaseOwner: "w",
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      } as never,
      leaseDurationMs: 60_000,
      renewIntervalMs: 30_000, // ensures schedule()'s renewal timer never fires during the test
      store: {
        renewExecutionLease: () => {
          throw new Error("renewal must not run in this test");
        },
      } as never,
    });
    await heartbeat.stop();
    const after = process.getActiveResourcesInfo().filter((k) => k === "Timeout").length;
    expect(after).toBe(before);
  });
});
