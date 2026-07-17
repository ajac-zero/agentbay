import { describe, expect, it } from "vitest";
import { parseExecutionAttemptProfile } from "../../src/dispatch/profile.js";
import type { ClaimedExecution } from "../../src/dispatch/types.js";

describe("parseExecutionAttemptProfile", () => {
  it("validates and normalizes the immutable profile definition", () => {
    const claimed = claimedExecution({
      schemaVersion: 1,
      runtime: { type: "opencode", agent: "coder", opencodeConfig: { agent: { coder: {} } } },
      sandbox: { templateName: "opencode" },
      permissions: { onRequest: "fail" },
      timeoutSeconds: 3_600,
      retention: {},
    });

    const profile = parseExecutionAttemptProfile(claimed);

    expect(profile.profileVersion.definition).toEqual({
      schemaVersion: 1,
      runtime: { type: "opencode", agent: "coder", opencodeConfig: { agent: { coder: {} } } },
      sandbox: { templateName: "opencode", warmPool: "none" },
      permissions: { onRequest: "fail" },
      timeoutSeconds: 3_600,
      retention: { sandboxSecondsAfterFinished: 0 },
    });
    expect(profile.resolvedPolicy).toEqual(profile.profileVersion.definition);
    expect(profile.timeoutAt).toBe(claimed.timeoutAt);
  });

  it("validates resolved policy independently", () => {
    const claimed = claimedExecution(validDefinition());
    claimed.resolvedPolicy = { unvalidated: true };

    expect(() => parseExecutionAttemptProfile(claimed)).toThrow();
  });

  it("rejects unknown fields and missing selected agents", () => {
    expect(() => parseExecutionAttemptProfile(claimedExecution({ ...validDefinition(), extra: true }))).toThrow();
    expect(() =>
      parseExecutionAttemptProfile(claimedExecution({
        ...validDefinition(),
        runtime: { type: "opencode", agent: "missing", opencodeConfig: { agent: { coder: {} } } },
      })),
    ).toThrow();
  });

  it("rejects invalid sandbox and retention bounds", () => {
    expect(() =>
      parseExecutionAttemptProfile(claimedExecution({ ...validDefinition(), sandbox: { templateName: "Not_DNS" } })),
    ).toThrow();
    expect(() =>
      parseExecutionAttemptProfile(claimedExecution({
        ...validDefinition(),
        retention: { sandboxSecondsAfterFinished: 86_401 },
      })),
    ).toThrow();
  });
});

function validDefinition() {
  return {
    schemaVersion: 1,
    runtime: { type: "opencode", agent: "coder", opencodeConfig: { agent: { coder: {} } } },
    sandbox: { templateName: "opencode" },
    permissions: { onRequest: "fail" },
    timeoutSeconds: 3_600,
  };
}

function claimedExecution(definition: Record<string, unknown>): ClaimedExecution {
  return {
    executionId: "execution-1",
    tenantId: "default",
    eventId: "event-1",
    profileVersion: { id: "profile-version-1", profileId: "coder", version: 1, definition },
    input: { text: "test" },
    workspace: { type: "empty" },
    resolvedPolicy: definition,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    timeoutAt: new Date("2026-01-01T01:00:00Z"),
    lease: {
      attempt: 1,
      fencingToken: "token",
      leaseOwner: "dispatcher",
      leaseExpiresAt: new Date("2026-01-01T00:01:00Z"),
    },
  } as ClaimedExecution;
}
