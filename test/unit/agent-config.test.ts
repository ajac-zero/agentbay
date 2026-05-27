import { describe, expect, it } from "vitest";
import { buildOpencodeConfigContent } from "../../src/agent/config.js";
import type { OpencodeConfigRecord } from "../../src/runtime/types.js";

function makeConfigRecord(config: Record<string, unknown>): OpencodeConfigRecord {
  return {
    config,
    configHash: "abc",
    displayName: "Test",
    enabled: true,
    id: "cfg-1",
    slug: "default",
    updatedAt: new Date(0).toISOString(),
  };
}

describe("buildOpencodeConfigContent", () => {
  it("returns undefined for an empty config object", () => {
    expect(buildOpencodeConfigContent(makeConfigRecord({}))).toBeUndefined();
  });

  it("returns a JSON string for a non-empty config", () => {
    const result = buildOpencodeConfigContent(makeConfigRecord({ model: "claude-3" }));
    expect(result).toBe(JSON.stringify({ model: "claude-3" }));
  });

  it("round-trips correctly through JSON.parse", () => {
    const config = { agent: { coder: { prompt: "help me" } }, default_agent: "coder" };
    const result = buildOpencodeConfigContent(makeConfigRecord(config));
    expect(JSON.parse(result!)).toEqual(config);
  });

  it("preserves nested structures", () => {
    const config = { a: { b: { c: [1, 2, 3] } } };
    const result = buildOpencodeConfigContent(makeConfigRecord(config));
    expect(JSON.parse(result!)).toEqual(config);
  });

  it("returns a non-empty string when config has at least one key", () => {
    const result = buildOpencodeConfigContent(makeConfigRecord({ key: "value" }));
    expect(result).toBeTruthy();
  });
});
