import { describe, expect, it } from "vitest";
import { isCloudEvent, normalizeCloudEvent, normalizedCloudEventSchema, validateCloudEvent } from "../../src/execution/events.js";

const validEvent = {
  specversion: "1.0",
  id: "delivery-8d91f1",
  source: "https://events.example.test/acme",
  type: "com.example.change.created",
  subject: "change/482",
  time: "2026-07-17T10:14:00Z",
  datacontenttype: "application/json",
  dataschema: "https://schemas.example.test/change/v1",
  traceparent: "00-a1b2c3-01",
  data: { number: 482, labels: ["ready"] },
} as const;

describe("normalizedCloudEventSchema", () => {
  it("accepts a strict structured CloudEvents 1.0 JSON envelope", () => {
    expect(normalizedCloudEventSchema.parse(validEvent)).toEqual({ ...validEvent, time: "2026-07-17T10:14:00.000Z" });
    const result = validateCloudEvent(validEvent);
    expect(result.valid).toBe(true);
    expect(isCloudEvent(validEvent)).toBe(true);
  });

  it("defaults JSON content type and canonicalizes timestamps", () => {
    const normalized = normalizeCloudEvent({ ...validEvent, datacontenttype: undefined, time: "2026-07-17T12:14:00+02:00" });
    expect(normalized.datacontenttype).toBe("application/json");
    expect(normalized.time).toBe("2026-07-17T10:14:00.000Z");
  });

  it("rejects non-JSON content types for V1", () => {
    expect(normalizedCloudEventSchema.safeParse({ ...validEvent, datacontenttype: "text/plain" }).success).toBe(false);
    expect(normalizedCloudEventSchema.safeParse({ ...validEvent, datacontenttype: "application/json; charset=utf-8" }).success).toBe(false);
  });

  it("requires JSON data and rejects data_base64", () => {
    expect(normalizedCloudEventSchema.safeParse({ ...validEvent, data: undefined }).success).toBe(false);
    expect(normalizedCloudEventSchema.safeParse({ ...validEvent, data_base64: "aGVsbG8=" }).success).toBe(false);
  });

  it("rejects non-JSON data and malformed attributes", () => {
    expect(normalizedCloudEventSchema.safeParse({ ...validEvent, data: { bad: undefined } }).success).toBe(false);
    expect(normalizedCloudEventSchema.safeParse({ ...validEvent, specversion: "0.3" }).success).toBe(false);
    expect(normalizedCloudEventSchema.safeParse({ ...validEvent, source: "has whitespace" }).success).toBe(false);
    expect(normalizedCloudEventSchema.safeParse({ ...validEvent, time: "2026-07-17 10:14:00" }).success).toBe(false);
    expect(normalizedCloudEventSchema.safeParse({ ...validEvent, dataschema: "/relative" }).success).toBe(false);
  });

  it("bounds main attributes and JSON data by UTF-8 bytes", () => {
    expect(normalizedCloudEventSchema.safeParse({ ...validEvent, type: "x".repeat(256) }).success).toBe(false);
    expect(normalizedCloudEventSchema.safeParse({ ...validEvent, data: "x".repeat(128 * 1024) }).success).toBe(false);
    expect(normalizedCloudEventSchema.safeParse({ ...validEvent, data: "x".repeat(41 * 1024) }).success).toBe(false);
  });

  it("bounds and validates extension names, count, and scalar values", () => {
    expect(normalizedCloudEventSchema.safeParse({ ...validEvent, TenantID: "acme" }).success).toBe(false);
    expect(normalizedCloudEventSchema.safeParse({ ...validEvent, metadata: { unsafe: true } }).success).toBe(false);
    expect(normalizedCloudEventSchema.safeParse({ ...validEvent, extra: "x".repeat(1_025) }).success).toBe(false);
    const extensions = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`x${index}`, index]));
    expect(normalizedCloudEventSchema.safeParse({ ...validEvent, ...extensions }).success).toBe(false);
  });

  it.each(["tenantid", "agentbay"])("explicitly rejects the reserved %s extension", (name) => {
    const result = validateCloudEvent({ ...validEvent, [name]: "caller-supplied" });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.issues).toContainEqual({ attribute: name, message: `${name} is a reserved extension` });
  });

  it("returns stable validation issue paths", () => {
    const result = validateCloudEvent(null);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.issues[0]?.attribute).toBe("$");
  });
});
