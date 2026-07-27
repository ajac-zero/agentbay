import { describe, expect, it } from "vitest";
import { executionDetailSchema } from "../../src/execution/api-schema.js";

const baseExecutionDetail = {
  id: "e1",
  tenantId: "default",
  binding: { id: "b1", version: 1 },
  profile: { id: "p1", version: 1 },
  state: "WAITING",
  input: { text: "hi" },
  workspace: { type: "empty" },
  eventId: "evt-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  result: null,
  attempts: [],
  transitions: [],
} as const;

const baseWait = {
  id: "w1",
  attempt: 1,
  name: "developer-pr-lifecycle",
  correlation: { repositoryId: 7 },
  deadlineAt: "2026-01-01T00:10:00.000Z",
  activatedAt: "2026-01-01T00:00:00.000Z",
  endedAt: null,
} as const;

describe("executionDetailSchema waits[].state", () => {
  it("accepts every state the server can actually return, including PENDING_CONTEXT", () => {
    for (const state of ["PENDING_CONTEXT", "ACTIVE", "CANCELLED", "EXPIRED", "CONSUMED"] as const) {
      const sample = { ...baseExecutionDetail, waits: [{ ...baseWait, state }] };
      const result = executionDetailSchema.safeParse(sample);
      expect(result.success).toBe(true);
    }
  });

  it("rejects unknown wait states", () => {
    const sample = { ...baseExecutionDetail, waits: [{ ...baseWait, state: "BOGUS" }] };
    expect(executionDetailSchema.safeParse(sample).success).toBe(false);
  });
});
