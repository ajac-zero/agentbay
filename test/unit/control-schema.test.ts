import { describe, expect, it } from "vitest";
import { bindingDefinitionSchema, publishedBindingVersionSchema } from "../../src/control/binding.js";
import { triggerSchema } from "../../src/control/trigger.js";

const validDefinition = {
  schemaVersion: 1,
  eventTypes: ["com.example.change.created"],
  filter: { all: [{ path: "/state", op: "eq", value: "open" }] },
  prompt: { literal: "Review this change.", includeEvent: "data" },
  workspace: { type: "empty" },
} as const;

const validBinding = {
  id: "binding-version-internal-2",
  bindingId: "change-review",
  version: 2,
  tenantId: "acme",
  triggerId: "webhook",
  profile: { id: "reviewer", version: 4 },
  definition: validDefinition,
  enabled: true,
  createdAt: "2026-07-18T10:00:00Z",
  disabledAt: null,
} as const;

describe("triggerSchema", () => {
  it("accepts the exact non-versioned CloudEvents HTTP trigger", () => {
    const trigger = {
      id: "webhook",
      tenantId: "acme",
      type: "cloudevents.http",
      config: { schemaVersion: 1 },
      enabled: true,
      createdAt: "2026-07-18T10:00:00Z",
      disabledAt: null,
    } as const;
    expect(triggerSchema.parse(trigger)).toEqual(trigger);
    expect(triggerSchema.safeParse({ ...trigger, version: 1 }).success).toBe(false);
    expect(triggerSchema.safeParse({ ...trigger, config: { schemaVersion: 2 } }).success).toBe(false);
  });
});

describe("binding schemas", () => {
  it("keeps trigger and exact profile on the published record, not in definition", () => {
    expect(publishedBindingVersionSchema.parse(validBinding)).toEqual(validBinding);
    expect(bindingDefinitionSchema.safeParse({ ...validDefinition, trigger: { id: "webhook" } }).success).toBe(false);
    expect(bindingDefinitionSchema.safeParse({ ...validDefinition, profile: { id: "reviewer", version: 4 } }).success).toBe(false);
  });

  it("requires 1..32 exact event types", () => {
    expect(bindingDefinitionSchema.safeParse({ ...validDefinition, eventTypes: [] }).success).toBe(false);
    expect(bindingDefinitionSchema.safeParse({ ...validDefinition, eventTypes: Array(33).fill("event") }).success).toBe(false);
    expect(bindingDefinitionSchema.safeParse({ ...validDefinition, eventTypes: ["com.example.*"] }).success).toBe(true);
  });

  it("supports positive and negative existence checks against data pointers", () => {
    expect(
      bindingDefinitionSchema.safeParse({
        ...validDefinition,
        filter: { all: [{ path: "/active", op: "exists", value: true }, { path: "/missing", op: "exists", value: false }] },
      }).success,
    ).toBe(true);
    expect(bindingDefinitionSchema.safeParse({ ...validDefinition, filter: { all: [{ path: "/active", op: "exists" }] } }).success).toBe(false);
    expect(bindingDefinitionSchema.safeParse({ ...validDefinition, filter: { all: Array(17).fill({ path: "", op: "exists", value: true }) } }).success).toBe(false);
    expect(bindingDefinitionSchema.safeParse({ ...validDefinition, filter: { all: [{ path: "/bad~2path", op: "exists", value: true }] } }).success).toBe(false);
  });

  it("preserves prompt byte and workspace bounds", () => {
    expect(bindingDefinitionSchema.safeParse({ ...validDefinition, prompt: { literal: "é".repeat(8_192), includeEvent: "none" } }).success).toBe(true);
    expect(bindingDefinitionSchema.safeParse({ ...validDefinition, prompt: { literal: `é${"x".repeat(16_383)}`, includeEvent: "none" } }).success).toBe(false);
    expect(bindingDefinitionSchema.safeParse({ ...validDefinition, workspace: { type: "git" } }).success).toBe(false);
  });
});
