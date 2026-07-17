import { describe, expect, it } from "vitest";
import type { TransitionLeasedExecutionCommand } from "../../src/dispatch/types.js";
import { isValidTransitionLeasedExecutionCommand } from "../../src/dispatch/store.js";

function command(
  overrides: Partial<TransitionLeasedExecutionCommand> = {},
): TransitionLeasedExecutionCommand {
  return {
    executionId: "execution-1",
    tenantId: "tenant-1",
    attempt: 1,
    fencingToken: "fence-1",
    leaseOwner: "worker-1",
    expectedExecutionState: "PROVISIONING",
    expectedAttemptState: "LEASED",
    targetExecutionState: "RUNNING",
    targetAttemptState: "RUNNING",
    actor: "dispatcher",
    reason: "workload ready",
    workloadName: "execution-1-1",
    opencodeSessionId: "session-1",
    ...overrides,
  };
}

describe("transitionLeasedExecution command validation", () => {
  it("accepts a supported paired transition with optional worker records", () => {
    expect(isValidTransitionLeasedExecutionCommand(command())).toBe(true);
  });

  it("rejects independently valid states when their paired transition is inconsistent", () => {
    expect(isValidTransitionLeasedExecutionCommand(command({
      targetExecutionState: "FAILED",
      targetAttemptState: "RUNNING",
    }))).toBe(false);
  });

  it("rejects an execution transition outside the dispatcher domain", () => {
    expect(isValidTransitionLeasedExecutionCommand(command({
      expectedExecutionState: "SUCCEEDED",
      expectedAttemptState: "RUNNING",
      targetExecutionState: "COMPLETED",
      targetAttemptState: "SUCCEEDED",
    }))).toBe(false);
  });
});
