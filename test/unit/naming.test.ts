import { describe, expect, it } from "vitest";
import { claimNameForExecutionAttempt, claimNameForThread } from "../../src/sandbox/naming.js";

describe("claimNameForThread", () => {
  it("always prefixes the name with agentbay-", () => {
    expect(claimNameForThread("thread-1")).toMatch(/^agentbay-/);
  });

  it("produces a name with exactly 25 characters (agentbay- + 16 hex chars)", () => {
    expect(claimNameForThread("any-thread-id")).toHaveLength(25);
  });

  it("is deterministic for the same input", () => {
    const id = "slack-C012AB3CD-1234567890.123456";
    expect(claimNameForThread(id)).toBe(claimNameForThread(id));
  });

  it("produces different names for different thread IDs", () => {
    expect(claimNameForThread("thread-a")).not.toBe(claimNameForThread("thread-b"));
  });

  it("produces a valid Kubernetes name (lowercase hex suffix)", () => {
    const name = claimNameForThread("some-thread");
    // Full name must be a valid DNS subdomain label
    expect(name).toMatch(/^[a-z0-9][-a-z0-9]*[a-z0-9]$/);
  });

  it("produces a stable known value for a fixed input", () => {
    // Pin a specific hash to catch accidental algorithm changes.
    // sha256("thread-1") first 16 hex chars: 4b0a5fefc328e6b9
    expect(claimNameForThread("thread-1")).toBe("agentbay-4b0a5fefc328e6b9");
  });
});

describe("claimNameForExecutionAttempt", () => {
  it("is deterministic and includes both execution identity and attempt", () => {
    const first = claimNameForExecutionAttempt("execution-123", 1);

    expect(first).toBe(claimNameForExecutionAttempt("execution-123", 1));
    expect(first).not.toBe(claimNameForExecutionAttempt("execution-123", 2));
    expect(first).not.toBe(claimNameForExecutionAttempt("execution-456", 1));
  });

  it("produces a DNS-safe name no longer than 63 characters", () => {
    const name = claimNameForExecutionAttempt("EXECUTION_/with unsafe characters/".repeat(4), 123);

    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toMatch(/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/);
  });

  it("uses a hash to distinguish IDs with the same normalized prefix", () => {
    const first = claimNameForExecutionAttempt(`${"a".repeat(100)}-first`, 1);
    const second = claimNameForExecutionAttempt(`${"a".repeat(100)}-second`, 1);

    expect(first).not.toBe(second);
  });

  it("rejects invalid attempt numbers", () => {
    expect(() => claimNameForExecutionAttempt("execution", 0)).toThrow("positive integer");
    expect(() => claimNameForExecutionAttempt("execution", 1.5)).toThrow("positive integer");
  });
});
