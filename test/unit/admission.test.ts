import { describe, expect, it } from "vitest";
import { matchesBinding, matchesFilterClause, planAdmission, planExecution, projectWakeCorrelation, renderBindingInput, renderPromptInput, UNTRUSTED_EVENT_BEGIN, UNTRUSTED_EVENT_END } from "../../src/control/admission.js";
import type { PublishedBindingVersion, WakeBindingDefinition } from "../../src/control/binding.js";
import type { NormalizedCloudEvent } from "../../src/execution/events.js";

const event: NormalizedCloudEvent = {
  specversion: "1.0",
  id: "external-1",
  source: "https://events.example.test",
  type: "com.example.created",
  datacontenttype: "application/json",
  data: { state: "open", count: 2, active: false, nested: { z: 1, a: 2 } },
};

const binding: PublishedBindingVersion = {
  id: "binding-version-internal-2",
  bindingId: "b1",
  version: 2,
  tenantId: "acme",
  triggerId: "http",
  profile: { id: "reviewer", version: 3 },
  definition: {
    schemaVersion: 1,
    eventTypes: ["com.example.created"],
    filter: { all: [{ path: "/state", op: "eq", value: "open" }] },
    prompt: { literal: "Review it.", includeEvent: "data" },
    workspace: { type: "empty" },
  },
  enabled: true,
  createdAt: "2026-07-18T10:00:00.000Z",
  disabledAt: null,
};

const command = {
  tenantId: "acme",
  triggerId: "http",
  internalEventId: "internal-9",
  event,
  sourceDeduplicationKey: "delivery-9",
  admissionHash: "hash-9",
  admittedAt: "2026-07-18T10:01:00.000Z",
};

describe("binding matcher", () => {
  it("uses exact event types and resolves pointers against event.data only", () => {
    expect(matchesBinding(binding, event)).toBe(true);
    expect(matchesBinding({ ...binding, definition: { ...binding.definition, eventTypes: ["com.example.*"] } }, event)).toBe(false);
    expect(matchesFilterClause(event.data, { path: "/state", op: "eq", value: "open" })).toBe(true);
    expect(matchesFilterClause(event.data, { path: "/data/state", op: "eq", value: "open" })).toBe(false);
  });

  it("uses strict primitive comparisons and supports missing checks", () => {
    expect(matchesFilterClause(event.data, { path: "/count", op: "eq", value: 2 })).toBe(true);
    expect(matchesFilterClause(event.data, { path: "/count", op: "eq", value: "2" })).toBe(false);
    expect(matchesFilterClause(event.data, { path: "/active", op: "exists", value: true })).toBe(true);
    expect(matchesFilterClause(event.data, { path: "/missing", op: "exists", value: false })).toBe(true);
    expect(matchesFilterClause({ labels: ["difficulty:easy", "state:ready"] }, { path: "/labels", op: "contains", value: "state:ready" })).toBe(true);
    expect(matchesFilterClause({ labels: ["difficulty:easy"] }, { path: "/labels", op: "containsAny", values: ["difficulty:medium", "difficulty:easy"] })).toBe(true);
    expect(matchesFilterClause({ labels: ["difficulty:easy"] }, { path: "/labels", op: "contains", value: "state:ready" })).toBe(false);
    expect(matchesFilterClause({ labels: [{ name: "state:ready" }] }, { path: "/labels", op: "contains", value: "state:ready" })).toBe(false);
  });
});

describe("rendering and event-level planning", () => {
  it("renders canonical untrusted event data", () => {
    const input = renderBindingInput(binding, event);
    expect(input.text).toBe(
      `Review it.\n\n${UNTRUSTED_EVENT_BEGIN}\n{"active":false,"count":2,"nested":{"a":2,"z":1},"state":"open"}\n${UNTRUSTED_EVENT_END}`,
    );
    expect(input.context).toEqual({ event: event.data, includeEvent: "data" });
  });

  it("plans one execution using the internal binding version and event identities", () => {
    const execution = planExecution(binding, command);
    expect(execution?.id).toMatch(/^binding-execution:[a-f0-9]{64}$/);
    expect(execution?.binding).toEqual({ id: "b1", version: 2 });
    expect(execution?.eventId).toBe("internal-9");
    expect(execution).toEqual(planExecution(binding, command));
  });

  it("resolves Git selectors against event.data while planning", () => {
    const gitBinding: PublishedBindingVersion = {
      ...binding,
      definition: {
        ...binding.definition,
        workspace: {
          type: "git",
          repository: { url: { path: "/repository/url" } },
          revision: { commit: { path: "/revision" } },
        },
      },
    };
    const gitCommand = {
      ...command,
      event: {
        ...event,
        data: { state: "open", repository: { url: "https://git.example.test/acme/repo" }, revision: "A".repeat(40) },
      },
    };

    expect(planExecution(gitBinding, gitCommand)?.workspace).toEqual({
      type: "git",
      repository: { url: "https://git.example.test/acme/repo" },
      revision: { type: "commit", commit: "a".repeat(40) },
    });
  });

  it("returns the event summary, all matching executions, and replay status", () => {
    const nonmatch = { ...binding, id: "other-version", bindingId: "other", definition: { ...binding.definition, eventTypes: ["other"] } };
    const result = planAdmission(command, [binding, nonmatch], true);
    expect(result.event).toEqual({
      id: "internal-9",
      tenantId: "acme",
      triggerId: "http",
      source: event.source,
      eventId: event.id,
      type: event.type,
      sourceDeduplicationKey: "delivery-9",
      admissionHash: "hash-9",
      admittedAt: command.admittedAt,
    });
    expect(result.executions).toHaveLength(1);
    expect(result.wakes).toEqual([]);
    expect(result.replayed).toBe(true);
  });

  it("rejects disabled and cross-tenant binding candidates", () => {
    expect(planExecution({ ...binding, enabled: false }, command)).toBeUndefined();
    expect(planExecution({ ...binding, tenantId: "other" }, command)).toBeUndefined();
  });
});

describe("wake planning", () => {
  const definition: WakeBindingDefinition = {
    disposition: "wake",
    schemaVersion: 1,
    eventTypes: ["com.example.created"],
    filter: { all: [] },
    wake: {
      waitName: "review",
      correlation: [{ name: "count", path: "/count" }, { name: "active", path: "/active" }],
      action: { type: "continue", prompt: { literal: "Continue.", includeEvent: "data" } },
    },
  };

  it("projects exact bounded primitive correlation", () => {
    expect(projectWakeCorrelation(definition, event)).toEqual({ count: 2, active: false });
    expect(projectWakeCorrelation({ ...definition, wake: { ...definition.wake, correlation: [{ name: "bad", path: "/nested" }] } }, event)).toBeUndefined();
    expect(projectWakeCorrelation({ ...definition, wake: { ...definition.wake, correlation: [{ name: "bad", path: "/missing" }] } }, event)).toBeUndefined();
    expect(projectWakeCorrelation({ ...definition, wake: { ...definition.wake, correlation: [{ name: "bad", path: "/value" }] } }, {
      ...event, data: { value: "x".repeat(1_025) },
    })).toBeUndefined();
  });

  it("renders bounded continuation prompts using the admitted event", () => {
    const action = definition.wake.action;
    if (action.type !== "continue") throw new Error("Expected continuation action");
    expect(renderPromptInput(action.prompt, event)).toEqual({
      text: expect.stringContaining(`Continue.\n\n${UNTRUSTED_EVENT_BEGIN}`),
      context: { event: event.data, includeEvent: "data" },
    });
  });
});
