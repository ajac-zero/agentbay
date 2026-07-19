import { describe, expect, it } from "vitest";
import {
  ATTEMPT_STATES,
  isAttemptState,
  isValidAttemptTransition,
  isValidDispatcherExecutionTransition,
} from "../../src/dispatch/states.js";

describe("dispatcher attempt states", () => {
  it("recognizes every declared attempt state", () => {
    for (const state of ATTEMPT_STATES) expect(isAttemptState(state)).toBe(true);
    expect(isAttemptState("QUEUED")).toBe(false);
    expect(isAttemptState(undefined)).toBe(false);
  });

  it("allows only the initial dispatcher attempt path", () => {
    expect(isValidAttemptTransition("PENDING", "LEASED")).toBe(true);
    expect(isValidAttemptTransition("LEASED", "RUNNING")).toBe(true);
    expect(isValidAttemptTransition("LEASED", "FAILED")).toBe(true);
    expect(isValidAttemptTransition("RUNNING", "SUCCEEDED")).toBe(true);
    expect(isValidAttemptTransition("RUNNING", "FAILED")).toBe(true);
    expect(isValidAttemptTransition("FAILED", "LEASED")).toBe(false);
    expect(isValidAttemptTransition("RUNNING", "RUNNING")).toBe(false);
  });
});

describe("paired dispatcher transitions", () => {
  it.each([
    ["QUEUED", "PROVISIONING", "PENDING", "LEASED"],
    ["PROVISIONING", "RUNNING", "LEASED", "RUNNING"],
    ["PROVISIONING", "FAILED", "LEASED", "FAILED"],
    ["RUNNING", "FAILED", "RUNNING", "FAILED"],
  ] as const)("allows %s/%s -> %s/%s", (executionFrom, executionTo, attemptFrom, attemptTo) => {
    expect(isValidDispatcherExecutionTransition({
      execution: { from: executionFrom, to: executionTo },
      attempt: { from: attemptFrom, to: attemptTo },
    })).toBe(true);
  });

  it.each([
    ["QUEUED", "RUNNING", "PENDING", "LEASED"],
    ["PROVISIONING", "RUNNING", "LEASED", "FAILED"],
    ["PROVISIONING", "FAILED", "LEASED", "RUNNING"],
    ["RUNNING", "SUCCEEDED", "RUNNING", "FAILED"],
    ["RUNNING", "SUCCEEDED", "RUNNING", "SUCCEEDED"],
    ["RUNNING", "FAILED", "LEASED", "FAILED"],
  ] as const)("rejects %s/%s -> %s/%s", (executionFrom, executionTo, attemptFrom, attemptTo) => {
    expect(isValidDispatcherExecutionTransition({
      execution: { from: executionFrom, to: executionTo },
      attempt: { from: attemptFrom, to: attemptTo },
    })).toBe(false);
  });
});
