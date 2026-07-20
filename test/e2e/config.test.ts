import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";

describe("loadConfig", () => {
  it("defaults to the released agent-sandbox API version", () => {
    expect(loadConfig({}).sandboxClaimApiVersion).toBe("v1beta1");
  });

  it("allows deprecated alpha agent-sandbox API compatibility", () => {
    expect(loadConfig({ AGENTBAY_SANDBOX_CLAIM_API_VERSION: "v1alpha1" }).sandboxClaimApiVersion).toBe("v1alpha1");
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

  it("provides dispatcher defaults", () => {
    expect(loadConfig({ HOSTNAME: "worker-1" })).toMatchObject({
      dispatcherEnabled: true,
      dispatcherIdlePollMs: 500,
      dispatcherLeaseDurationMs: 60_000,
      dispatcherRenewIntervalMs: 20_000,
      dispatcherWorkerId: "worker-1",
    });
  });

  it("provides disabled revision resolver defaults and requires credentials when enabled", () => {
    expect(loadConfig({ HOSTNAME: "worker-1" })).toMatchObject({
      revisionResolverEnabled: false,
      revisionResolverIdlePollMs: 500,
      revisionResolverLeaseDurationMs: 60_000,
      revisionResolverMaxAttempts: 5,
      revisionResolverRequestTimeoutMs: 30_000,
      revisionResolverRetryDelayMs: 30_000,
      revisionResolverWorkerId: "worker-1",
    });
    expect(() => loadConfig({ AGENTBAY_REVISION_RESOLVER_ENABLED: "true" })).toThrow(/APP_ID_FILE/);
    expect(loadConfig({
      AGENTBAY_REVISION_RESOLVER_ENABLED: "true",
      AGENTBAY_GITHUB_APP_ID_FILE: "/app-id",
      AGENTBAY_GITHUB_PRIVATE_KEY_FILE: "/private-key",
    })).toMatchObject({
      revisionResolverEnabled: true,
      githubAppIdFile: "/app-id",
      githubAppPrivateKeyFile: "/private-key",
    });
  });

  it("provides disabled issue acknowledgment defaults and requires credentials when enabled", () => {
    expect(loadConfig({})).toMatchObject({
      githubIssueAcknowledgmentEnabled: false,
      githubIssueAcknowledgmentIdlePollMs: 250,
      githubIssueAcknowledgmentLeaseDurationMs: 60_000,
      githubIssueAcknowledgmentRequestTimeoutMs: 30_000,
      githubIssueAcknowledgmentRetryDelayMs: 5_000,
    });
    expect(() => loadConfig({ AGENTBAY_GITHUB_ISSUE_ACKNOWLEDGMENT_ENABLED: "true" })).toThrow(/APP_ID_FILE/);
    expect(loadConfig({
      AGENTBAY_GITHUB_ISSUE_ACKNOWLEDGMENT_ENABLED: "true",
      AGENTBAY_GITHUB_APP_ID_FILE: "/app-id",
      AGENTBAY_GITHUB_PRIVATE_KEY_FILE: "/private-key",
    })).toMatchObject({ githubIssueAcknowledgmentEnabled: true });
  });

  it("provides disabled schedule worker defaults", () => {
    expect(loadConfig({ HOSTNAME: "worker-1" })).toMatchObject({
      scheduleWorkerEnabled: false,
      scheduleWorkerIdlePollMs: 1_000,
      scheduleWorkerLeaseDurationMs: 60_000,
      scheduleWorkerRetryDelayMs: 30_000,
      scheduleWorkerMaxAttempts: 5,
      scheduleWorkerMaterializeBatchSize: 100,
      scheduleWorkerId: "worker-1",
    });
  });

  it("requires dispatcher renewal before lease expiry", () => {
    expect(() => loadConfig({
      AGENTBAY_DISPATCHER_LEASE_DURATION_MS: "1000",
      AGENTBAY_DISPATCHER_RENEW_INTERVAL_MS: "1000",
    })).toThrow(/must be less/);
  });

  it("requires revision requests to finish before lease expiry", () => {
    expect(() => loadConfig({
      AGENTBAY_REVISION_RESOLVER_LEASE_DURATION_MS: "1000",
      AGENTBAY_REVISION_RESOLVER_REQUEST_TIMEOUT_MS: "1000",
    })).toThrow(/must be less/);
  });

  it("requires issue acknowledgment requests to finish before lease expiry", () => {
    expect(() => loadConfig({
      AGENTBAY_GITHUB_ISSUE_ACKNOWLEDGMENT_LEASE_DURATION_MS: "1000",
      AGENTBAY_GITHUB_ISSUE_ACKNOWLEDGMENT_REQUEST_TIMEOUT_MS: "1000",
    })).toThrow(/must be less/);
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
