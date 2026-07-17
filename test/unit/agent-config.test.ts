import { describe, expect, it } from "vitest";
import { buildOpencodeConfigContent } from "../../src/agent/config.js";

describe("buildOpencodeConfigContent", () => {
  it("returns undefined for an empty config object", () => {
    expect(buildOpencodeConfigContent({})).toBeUndefined();
  });

  it("returns a JSON string for a non-empty config", () => {
    const result = buildOpencodeConfigContent({ model: "claude-3" });
    expect(result).toBe(JSON.stringify({ model: "claude-3" }));
  });

  it("round-trips correctly through JSON.parse", () => {
    const config = { agent: { coder: { prompt: "help me" } }, default_agent: "coder" };
    const result = buildOpencodeConfigContent(config);
    expect(JSON.parse(result!)).toEqual(config);
  });

  it("preserves nested structures", () => {
    const config = { a: { b: { c: [1, 2, 3] } } };
    const result = buildOpencodeConfigContent(config);
    expect(JSON.parse(result!)).toEqual(config);
  });

  it("returns a non-empty string when config has at least one key", () => {
    const result = buildOpencodeConfigContent({ key: "value" });
    expect(result).toBeTruthy();
  });
});
