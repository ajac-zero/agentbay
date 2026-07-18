import { describe, expect, it } from "vitest";
import {
  bindingExecutionIdempotencyKey,
  createIdempotencyKey,
  deliveryIdempotencyKey,
  eventIdempotencyKey,
  executionIdempotencyKey,
  sourceDeliveryIdempotencyKey,
  transitionIdempotencyKey,
} from "../../src/execution/idempotency.js";

describe("createIdempotencyKey", () => {
  it("is deterministic and namespaced", () => {
    const first = createIdempotencyKey("test", "alpha", 2, true);
    expect(first).toBe(createIdempotencyKey("test", "alpha", 2, true));
    expect(first).toMatch(/^test:[a-f0-9]{64}$/);
  });

  it("length-frames parts to avoid delimiter ambiguity", () => {
    expect(createIdempotencyKey("test", "a", "bc")).not.toBe(createIdempotencyKey("test", "ab", "c"));
    expect(createIdempotencyKey("test", "a:b", "c")).not.toBe(createIdempotencyKey("test", "a", "b:c"));
  });

  it("distinguishes types, order, namespace, and unicode byte lengths", () => {
    expect(createIdempotencyKey("test", 1)).not.toBe(createIdempotencyKey("test", "1"));
    expect(createIdempotencyKey("test", 1)).not.toBe(createIdempotencyKey("test", true));
    expect(createIdempotencyKey("test", "a", "b")).not.toBe(createIdempotencyKey("test", "b", "a"));
    expect(createIdempotencyKey("first", "same")).not.toBe(createIdempotencyKey("second", "same"));
    expect(createIdempotencyKey("test", "e")).not.toBe(createIdempotencyKey("test", "\u00e9"));
  });

  it("rejects invalid namespaces and empty input", () => {
    expect(() => createIdempotencyKey("Bad Namespace", "value")).toThrow(/namespace/);
    expect(() => createIdempotencyKey("empty")).toThrow(/at least one part/);
    expect(() => createIdempotencyKey("number", Number.NaN)).toThrow(/finite/);
  });
});

describe("domain idempotency keys", () => {
  it("derives stable keys for each effective-once boundary", () => {
    expect(sourceDeliveryIdempotencyKey("github-main", "delivery-1")).toMatch(/^source-delivery:/);
    expect(eventIdempotencyKey("github://acme/repo", "event-1")).toMatch(/^event:/);
    expect(executionIdempotencyKey("binding-1", "github://acme/repo", "event-1")).toMatch(/^execution:/);
    expect(transitionIdempotencyKey("execution-1", "command-1")).toMatch(/^transition:/);
    expect(deliveryIdempotencyKey("execution-1", "destination-1")).toMatch(/^delivery:/);
  });

  it("identifies binding admission by exact binding version and internal event", () => {
    const key = bindingExecutionIdempotencyKey("binding-version-internal-3", "internal-event-1");
    expect(key).toMatch(/^binding-execution:[a-f0-9]{64}$/);
    expect(key).not.toBe(bindingExecutionIdempotencyKey("binding-version-internal-4", "internal-event-1"));
    expect(key).not.toBe(bindingExecutionIdempotencyKey("binding-version-internal-3", "internal-event-2"));
  });

  it("changes when any identity component changes", () => {
    expect(executionIdempotencyKey("binding-1", "source", "event")).not.toBe(
      executionIdempotencyKey("binding-2", "source", "event"),
    );
    expect(deliveryIdempotencyKey("execution-1", "destination-1")).not.toBe(
      deliveryIdempotencyKey("execution-1", "destination-2"),
    );
  });
});
