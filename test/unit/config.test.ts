import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";

describe("loadConfig", () => {
  it("rejects a shared concrete application and metrics port", () => {
    expect(() => loadConfig({ PORT: "3000", DISPATCH_METRICS_PORT: "3000" })).toThrow(/metrics.*port|port.*metrics/i);
  });

  it("rejects an application port that matches the default metrics port", () => {
    expect(() => loadConfig({ PORT: "9090" })).toThrow(/metrics.*port|port.*metrics/i);
  });

  it("allows either listener to request an ephemeral port", () => {
    expect(() => loadConfig({ PORT: "0", DISPATCH_METRICS_PORT: "0" })).not.toThrow();
  });
});
