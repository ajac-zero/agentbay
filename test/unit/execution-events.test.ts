import { describe, expect, it } from "vitest";
import { isCloudEvent, validateCloudEvent } from "../../src/execution/events.js";

const validEvent = {
  specversion: "1.0",
  id: "github-delivery-8d91f1",
  source: "github://acme/platform",
  type: "com.github.pull_request.opened",
  subject: "pull/482",
  time: "2026-07-17T10:14:00Z",
  datacontenttype: "application/json",
  dataschema: "https://schemas.example.test/github/pull-request/v1",
  tenantid: "acme",
  data: { number: 482 },
} as const;

describe("validateCloudEvent", () => {
  it("accepts a normalized CloudEvents 1.0 envelope", () => {
    const result = validateCloudEvent<{ number: number }>(validEvent);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.event.data?.number).toBe(482);
    expect(isCloudEvent(validEvent)).toBe(true);
  });

  it("accepts URI-reference sources and binary event data", () => {
    expect(
      validateCloudEvent({
        specversion: "1.0",
        id: "1",
        source: "/hooks/test",
        type: "dev.agentbay.test",
        data_base64: "aGVsbG8=",
      }).valid,
    ).toBe(true);
  });

  it("reports all missing or invalid required attributes", () => {
    const result = validateCloudEvent({ specversion: "0.3", id: "", source: 42 });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.issues.map((issue) => issue.attribute)).toEqual(["specversion", "id", "source", "type"]);
  });

  it("rejects malformed optional context attributes", () => {
    const result = validateCloudEvent({
      ...validEvent,
      time: "2026-07-17 10:14:00",
      dataschema: "/relative/schema",
      datacontenttype: "",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.map((issue) => issue.attribute)).toEqual(["time", "datacontenttype", "dataschema"]);
    }
  });

  it("rejects simultaneous data encodings and malformed base64", () => {
    const both = validateCloudEvent({ ...validEvent, data_base64: "aGVsbG8=" });
    expect(both.valid).toBe(false);
    const malformed = validateCloudEvent({ ...validEvent, data: undefined, data_base64: "not base64" });
    expect(malformed.valid).toBe(false);
  });

  it("enforces CloudEvents extension name and scalar value rules", () => {
    const result = validateCloudEvent({
      ...validEvent,
      TenantID: "acme",
      metadata: { unsafe: true },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.issues.map((issue) => issue.attribute)).toEqual(["TenantID", "metadata"]);
  });

  it("rejects non-object inputs", () => {
    expect(validateCloudEvent(null)).toEqual({ valid: false, issues: [{ attribute: "$", message: "must be an object" }] });
    expect(isCloudEvent([])).toBe(false);
  });
});
