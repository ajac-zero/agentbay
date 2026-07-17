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

  it("provides execution maintenance defaults", () => {
    expect(loadConfig({})).toMatchObject({
      executionMaintenanceBatchSize: 100,
      executionMaintenanceEnabled: true,
      executionMaintenanceIntervalMs: 5_000,
      executionMaxAttempts: 3,
      executionRetryDelayMs: 30_000,
    });
  });

  it("reads execution maintenance overrides", () => {
    expect(loadConfig({
      AGENTBAY_EXECUTION_MAINTENANCE_BATCH_SIZE: "20",
      AGENTBAY_EXECUTION_MAINTENANCE_ENABLED: "false",
      AGENTBAY_EXECUTION_MAINTENANCE_INTERVAL_MS: "1000",
      AGENTBAY_EXECUTION_MAX_ATTEMPTS: "5",
      AGENTBAY_EXECUTION_RETRY_DELAY_MS: "0",
    })).toMatchObject({
      executionMaintenanceBatchSize: 20,
      executionMaintenanceEnabled: false,
      executionMaintenanceIntervalMs: 1_000,
      executionMaxAttempts: 5,
      executionRetryDelayMs: 0,
    });
  });

  it.each([
    ["AGENTBAY_EXECUTION_MAINTENANCE_BATCH_SIZE", "0"],
    ["AGENTBAY_EXECUTION_MAINTENANCE_INTERVAL_MS", "-1"],
    ["AGENTBAY_EXECUTION_MAINTENANCE_INTERVAL_MS", "2147483648"],
    ["AGENTBAY_EXECUTION_MAX_ATTEMPTS", "1.5"],
    ["AGENTBAY_EXECUTION_RETRY_DELAY_MS", "-1"],
    ["AGENTBAY_EXECUTION_RETRY_DELAY_MS", "Infinity"],
  ])("rejects invalid execution maintenance setting %s=%s", (name, value) => {
    expect(() => loadConfig({ [name]: value })).toThrow(/integer|timer delay/);
  });

  it("rejects an invalid execution maintenance boolean", () => {
    expect(() => loadConfig({ AGENTBAY_EXECUTION_MAINTENANCE_ENABLED: "treu" })).toThrow(/true or false/);
  });
});
