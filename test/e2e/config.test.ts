import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";

describe("loadConfig", () => {
  it("defaults to the released agent-sandbox API version", () => {
    expect(loadConfig({}).sandboxClaimApiVersion).toBe("v1alpha1");
  });

  it("allows beta agent-sandbox API version opt-in", () => {
    expect(loadConfig({ AGENTBAY_SANDBOX_CLAIM_API_VERSION: "v1beta1" }).sandboxClaimApiVersion).toBe("v1beta1");
  });

  it("rejects unsupported agent-sandbox API versions", () => {
    expect(() => loadConfig({ AGENTBAY_SANDBOX_CLAIM_API_VERSION: "v2" })).toThrow(/v1alpha1 or v1beta1/);
  });
});
