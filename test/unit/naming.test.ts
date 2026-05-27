import { describe, expect, it } from "vitest";
import { claimNameForThread } from "../../src/sandbox/naming.js";

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
