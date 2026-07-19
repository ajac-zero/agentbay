import type { SandboxClaimAPIVersion } from "./sandbox/types.js";
import { readNumber } from "./util.js";

export type Config = {
  adminToken?: string;
  dispatcherEnabled: boolean;
  dispatcherIdlePollMs: number;
  dispatcherLeaseDurationMs: number;
  dispatcherRenewIntervalMs: number;
  dispatcherWorkerId: string;
  claimReadyTimeoutMs: number;
  controlPlaneUrl?: string;
  kubeNamespace: string;
  opencodeDirectory: string;
  opencodePort: number;
  port: number;
  sandboxClaimApiVersion: SandboxClaimAPIVersion;
  executionMaintenanceBatchSize: number;
  executionMaintenanceEnabled: boolean;
  executionMaintenanceIntervalMs: number;
  executionMaxAttempts: number;
  executionRetryDelayMs: number;
  revisionResolverEnabled: boolean;
  revisionResolverIdlePollMs: number;
  revisionResolverLeaseDurationMs: number;
  revisionResolverMaxAttempts: number;
  revisionResolverRequestTimeoutMs: number;
  revisionResolverRetryDelayMs: number;
  revisionResolverWorkerId: string;
  githubAppIdFile?: string;
  githubAppPrivateKeyFile?: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const config = {
    adminToken: emptyToUndefined(env.AGENTBAY_ADMIN_TOKEN),
    claimReadyTimeoutMs: readTimerDelay(env.AGENTBAY_CLAIM_READY_TIMEOUT_MS, 180_000),
    controlPlaneUrl: readControlPlaneUrl(env.AGENTBAY_CONTROL_PLANE_URL),
    dispatcherEnabled: readStrictBoolean(env.AGENTBAY_DISPATCHER_ENABLED, true),
    dispatcherIdlePollMs: readTimerDelay(env.AGENTBAY_DISPATCHER_IDLE_POLL_MS, 500),
    dispatcherLeaseDurationMs: readPositiveInteger(env.AGENTBAY_DISPATCHER_LEASE_DURATION_MS, 60_000),
    dispatcherRenewIntervalMs: readTimerDelay(env.AGENTBAY_DISPATCHER_RENEW_INTERVAL_MS, 20_000),
    dispatcherWorkerId: env.AGENTBAY_DISPATCHER_WORKER_ID ?? env.HOSTNAME ?? `agentbay-${process.pid}`,
    executionMaintenanceBatchSize: readPositiveInteger(env.AGENTBAY_EXECUTION_MAINTENANCE_BATCH_SIZE, 100),
    executionMaintenanceEnabled: readStrictBoolean(env.AGENTBAY_EXECUTION_MAINTENANCE_ENABLED, true),
    executionMaintenanceIntervalMs: readTimerDelay(env.AGENTBAY_EXECUTION_MAINTENANCE_INTERVAL_MS, 5_000),
    executionMaxAttempts: readPositiveInteger(env.AGENTBAY_EXECUTION_MAX_ATTEMPTS, 3),
    executionRetryDelayMs: readNonnegativeInteger(env.AGENTBAY_EXECUTION_RETRY_DELAY_MS, 30_000),
    revisionResolverEnabled: readStrictBoolean(env.AGENTBAY_REVISION_RESOLVER_ENABLED, false),
    revisionResolverIdlePollMs: readTimerDelay(env.AGENTBAY_REVISION_RESOLVER_IDLE_POLL_MS, 500),
    revisionResolverLeaseDurationMs: readPositiveInteger(env.AGENTBAY_REVISION_RESOLVER_LEASE_DURATION_MS, 60_000),
    revisionResolverMaxAttempts: readPositiveInteger(env.AGENTBAY_REVISION_RESOLVER_MAX_ATTEMPTS, 5),
    revisionResolverRequestTimeoutMs: readTimerDelay(env.AGENTBAY_REVISION_RESOLVER_REQUEST_TIMEOUT_MS, 30_000),
    revisionResolverRetryDelayMs: readNonnegativeInteger(env.AGENTBAY_REVISION_RESOLVER_RETRY_DELAY_MS, 30_000),
    revisionResolverWorkerId: env.AGENTBAY_REVISION_RESOLVER_WORKER_ID ?? env.HOSTNAME ?? `agentbay-${process.pid}`,
    githubAppIdFile: emptyToUndefined(env.AGENTBAY_GITHUB_APP_ID_FILE),
    githubAppPrivateKeyFile: emptyToUndefined(env.AGENTBAY_GITHUB_PRIVATE_KEY_FILE),
    kubeNamespace: env.AGENTBAY_KUBE_NAMESPACE ?? env.POD_NAMESPACE ?? "agents",
    opencodeDirectory: env.AGENTBAY_OPENCODE_DIRECTORY ?? "/workspace",
    opencodePort: readNumber(env.AGENTBAY_OPENCODE_PORT, 4096),
    port: readNumber(env.PORT, 3000),
    sandboxClaimApiVersion: readSandboxClaimApiVersion(env.AGENTBAY_SANDBOX_CLAIM_API_VERSION),
  };
  if (config.dispatcherRenewIntervalMs >= config.dispatcherLeaseDurationMs) {
    throw new Error("AGENTBAY_DISPATCHER_RENEW_INTERVAL_MS must be less than AGENTBAY_DISPATCHER_LEASE_DURATION_MS");
  }
  if (config.revisionResolverEnabled && (!config.githubAppIdFile || !config.githubAppPrivateKeyFile)) {
    throw new Error("AGENTBAY_GITHUB_APP_ID_FILE and AGENTBAY_GITHUB_PRIVATE_KEY_FILE are required when revision resolution is enabled");
  }
  if (config.revisionResolverRequestTimeoutMs >= config.revisionResolverLeaseDurationMs) {
    throw new Error("AGENTBAY_REVISION_RESOLVER_REQUEST_TIMEOUT_MS must be less than AGENTBAY_REVISION_RESOLVER_LEASE_DURATION_MS");
  }
  return config;
}

function readSandboxClaimApiVersion(value: string | undefined): SandboxClaimAPIVersion {
  if (value === undefined || value === "") return "v1alpha1";
  if (value === "v1alpha1" || value === "v1beta1") return value;
  throw new Error(`Expected AGENTBAY_SANDBOX_CLAIM_API_VERSION to be v1alpha1 or v1beta1, got ${value}`);
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function readControlPlaneUrl(value: string | undefined): string | undefined {
  const configured = emptyToUndefined(value);
  if (!configured) return undefined;
  const url = new URL(configured);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("AGENTBAY_CONTROL_PLANE_URL must be an HTTP(S) URL without credentials, query, or fragment");
  return url.toString();
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = readInteger(value, fallback);
  if (parsed < 1) throw new Error(`Expected a positive integer, got ${value}`);
  return parsed;
}

function readNonnegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = readInteger(value, fallback);
  if (parsed < 0) throw new Error(`Expected a nonnegative integer, got ${value}`);
  return parsed;
}

function readInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Expected a safe integer, got ${value}`);
  return parsed;
}

function readTimerDelay(value: string | undefined, fallback: number): number {
  const parsed = readPositiveInteger(value, fallback);
  if (parsed > 2_147_483_647) throw new Error(`Expected a timer delay at most 2147483647, got ${value}`);
  return parsed;
}

function readStrictBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Expected true or false, got ${value}`);
}
