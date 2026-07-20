/**
 * Reconciler entrypoint.
 *
 * Lists all SandboxClaims managed by agentbay (label
 * app.kubernetes.io/managed-by=agentbay) and deletes any whose
 * spec.lifecycle.shutdownTime has passed the configured grace period.
 *
 * Intended to run as a Kubernetes CronJob every 30 minutes.
 * Exit 0 on success, exit 1 on any error.
 */

import { createCustomObjectsApi } from "./sandbox/client.js";
import type { SandboxClaim, SandboxClaimAPIVersion } from "./sandbox/types.js";
import { logger, toErrCtx } from "./logger.js";
import { readNumber } from "./util.js";

const GROUP = "extensions.agents.x-k8s.io";
const PLURAL = "sandboxclaims";
const LABEL_SELECTOR = "app.kubernetes.io/managed-by=agentbay";

export function readApiVersion(value: string | undefined): SandboxClaimAPIVersion {
  if (value === undefined || value === "") return "v1beta1";
  if (value === "v1alpha1" || value === "v1beta1") return value;
  throw new Error(
    `Expected AGENTBAY_SANDBOX_CLAIM_API_VERSION to be v1alpha1 or v1beta1, got ${value}`,
  );
}

export function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const maybe = error as { code?: number; response?: { statusCode?: number; status?: number } };
  return maybe.code === 404 || maybe.response?.statusCode === 404 || maybe.response?.status === 404;
}

/** Minimal API surface required by reconcileOnce; satisfied by CustomObjectsApi. */
type ReconcileApi = {
  listNamespacedCustomObject(opts: {
    group: string;
    version: string;
    namespace: string;
    plural: string;
    labelSelector?: string;
  }): Promise<unknown>;
  deleteNamespacedCustomObject(opts: {
    group: string;
    version: string;
    namespace: string;
    plural: string;
    name: string;
    propagationPolicy?: string;
  }): Promise<unknown>;
};

export type ReconcileOpts = {
  namespace: string;
  apiVersion: SandboxClaimAPIVersion;
  graceMinutes: number;
  /** Millisecond timestamp used as "now"; pass Date.now() in production. */
  now: number;
};

export type ReconcileResult = {
  deleted: number;
  errors: number;
  total: number;
};

/**
 * Core reconciliation logic.  Exported for unit testing; the reconcile()
 * entrypoint below wires this up with the real Kubernetes API and env vars.
 */
export async function reconcileOnce(api: ReconcileApi, opts: ReconcileOpts): Promise<ReconcileResult> {
  const { namespace, apiVersion, graceMinutes, now } = opts;
  const graceMs = graceMinutes * 60 * 1_000;

  const log = logger.child({ namespace, apiVersion, graceMinutes });
  log.info("reconciler starting");

  const response = (await api.listNamespacedCustomObject({
    group: GROUP,
    version: apiVersion,
    namespace,
    plural: PLURAL,
    labelSelector: LABEL_SELECTOR,
  })) as { items?: SandboxClaim[] };

  const claims = response.items ?? [];
  log.info("listed sandbox claims", { count: claims.length });

  let deleted = 0;
  let errors = 0;

  for (const claim of claims) {
    const name = claim.metadata.name;
    const shutdownTime = claim.spec?.lifecycle?.shutdownTime;

    if (!shutdownTime) {
      log.debug("claim has no shutdownTime, skipping", { claim: name });
      continue;
    }

    const shutdownMs = new Date(shutdownTime).getTime();
    const deadline = shutdownMs + graceMs;

    if (now < deadline) {
      log.debug("claim is within grace period, skipping", {
        claim: name,
        shutdownTime,
        remainingMs: deadline - now,
      });
      continue;
    }

    log.info("deleting expired claim", { claim: name, shutdownTime });

    try {
      await api.deleteNamespacedCustomObject({
        group: GROUP,
        version: apiVersion,
        namespace,
        plural: PLURAL,
        name,
        propagationPolicy: "Foreground",
      });
      deleted++;
      log.info("deleted expired claim", { claim: name });
    } catch (error) {
      if (isNotFound(error)) {
        log.debug("claim already gone", { claim: name });
      } else {
        log.error("failed to delete claim", { claim: name, err: toErrCtx(error) });
        errors++;
      }
    }
  }

  log.info("reconciler finished", { deleted, errors, total: claims.length });
  return { deleted, errors, total: claims.length };
}

async function reconcile(): Promise<void> {
  const namespace = process.env.AGENTBAY_KUBE_NAMESPACE ?? process.env.POD_NAMESPACE ?? "agents";
  const apiVersion = readApiVersion(process.env.AGENTBAY_SANDBOX_CLAIM_API_VERSION);
  const graceMinutes = readNumber(process.env.AGENTBAY_RECONCILER_GRACE_MINUTES, 30);

  const api = createCustomObjectsApi();
  const result = await reconcileOnce(api, { namespace, apiVersion, graceMinutes, now: Date.now() });

  if (result.errors > 0) {
    process.exit(1);
  }
}

reconcile().catch((error) => {
  logger.error("reconciler fatal error", { err: toErrCtx(error) });
  process.exit(1);
});
