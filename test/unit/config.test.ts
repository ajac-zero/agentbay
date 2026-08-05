import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";

describe("loadConfig", () => {
  it("rejects matching concrete API and metrics ports", () => {
    expect(() => loadConfig({ PORT: "3000", AGENTBAY_METRICS_PORT: "3000" }))
      .toThrow(/PORT.*AGENTBAY_METRICS_PORT/i);
  });

  it("rejects a collision with the default metrics port", () => {
    expect(() => loadConfig({ PORT: "9090" }))
      .toThrow(/PORT.*AGENTBAY_METRICS_PORT/i);
  });

  it("allows ephemeral ports for both listeners", () => {
    expect(loadConfig({ PORT: "0", AGENTBAY_METRICS_PORT: "0" }))
      .toMatchObject({ port: 0, metricsPort: 0 });
  });
});
