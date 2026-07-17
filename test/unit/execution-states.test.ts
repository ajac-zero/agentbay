import { describe, expect, it } from "vitest";
import {
  EXECUTION_STATES,
  isExecutionState,
  isTerminalExecutionState,
  isValidExecutionTransition,
} from "../../src/execution/states.js";

describe("execution states", () => {
  it("recognizes every declared state and rejects arbitrary values", () => {
    for (const state of EXECUTION_STATES) expect(isExecutionState(state)).toBe(true);
    expect(isExecutionState("DONE")).toBe(false);
    expect(isExecutionState(null)).toBe(false);
  });

  it("identifies only final execution states as terminal", () => {
    expect(isTerminalExecutionState("COMPLETED")).toBe(true);
    expect(isTerminalExecutionState("CANCELLED")).toBe(true);
    expect(isTerminalExecutionState("TIMED_OUT")).toBe(true);
    expect(isTerminalExecutionState("FAILED")).toBe(true);
    expect(isTerminalExecutionState("DEAD_LETTERED")).toBe(true);
    expect(isTerminalExecutionState("SUCCEEDED")).toBe(false);
    expect(isTerminalExecutionState("CANCEL_REQUESTED")).toBe(false);
  });
});

describe("isValidExecutionTransition", () => {
  it("allows the main success path", () => {
    const path = ["RECEIVED", "PLANNED", "QUEUED", "PROVISIONING", "RUNNING", "SUCCEEDED", "DELIVERING", "COMPLETED"] as const;
    for (const [from, to] of path.slice(0, -1).map((state, index) => [state, path[index + 1]!] as const)) {
      expect(isValidExecutionTransition(from, to)).toBe(true);
    }
  });

  it("supports completion without result delivery", () => {
    expect(isValidExecutionTransition("SUCCEEDED", "COMPLETED")).toBe(true);
  });

  it("supports retry, approval, cancellation, and timeout control paths", () => {
    expect(isValidExecutionTransition("RUNNING", "RETRY_WAIT")).toBe(true);
    expect(isValidExecutionTransition("RETRY_WAIT", "QUEUED")).toBe(true);
    expect(isValidExecutionTransition("RUNNING", "AWAITING_APPROVAL")).toBe(true);
    expect(isValidExecutionTransition("AWAITING_APPROVAL", "RUNNING")).toBe(true);
    expect(isValidExecutionTransition("QUEUED", "CANCEL_REQUESTED")).toBe(true);
    expect(isValidExecutionTransition("CANCEL_REQUESTED", "CANCELLED")).toBe(true);
    expect(isValidExecutionTransition("PROVISIONING", "TIMED_OUT")).toBe(true);
  });

  it("rejects skips, self-transitions, and transitions out of terminal states", () => {
    expect(isValidExecutionTransition("RECEIVED", "RUNNING")).toBe(false);
    expect(isValidExecutionTransition("RUNNING", "RUNNING")).toBe(false);
    for (const state of EXECUTION_STATES) {
      expect(isValidExecutionTransition("COMPLETED", state)).toBe(false);
    }
  });
});
