import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { config } from "../config.ts";
import {
  NamespacedCustomResourceClient,
  getSandboxClaimClient,
  type SandboxClaim,
} from "./client.ts";

const THREAD_ID_HASH_LABEL = "wolfgang.io/thread-id-hash";
const THREAD_ID_ANNOTATION = "wolfgang.io/thread-id";
const OPENCODE_SERVER_PASSWORD_ENV = "OPENCODE_SERVER_PASSWORD";
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const CLAIM_NAME_PREFIX = "wf-";

type SandboxClaimApi = Pick<NamespacedCustomResourceClient<SandboxClaim>, "get" | "create">;

export interface EnsureClaimResult {
  claim: SandboxClaim;
  claimName: string;
  podIP: string;
  password: string;
}

export interface EnsureClaimOptions {
  client?: SandboxClaimApi;
  now?: Date;
  pollIntervalMs?: number;
  readyTimeoutMs?: number;
  sleep?: (delay: number) => Promise<void>;
}

export function hashThreadId(threadId: string) {
  validateThreadId(threadId);
  return createHash("sha256").update(threadId).digest("hex");
}

export function getClaimName(threadId: string) {
  return `${CLAIM_NAME_PREFIX}${hashThreadId(threadId).slice(0, 12)}`;
}

export function getClaimPassword(threadId: string) {
  validateThreadId(threadId);

  return createHash("sha256")
    .update(`wolfgang:${config.kubernetes.namespace}:${config.sandbox.templateName}:${threadId}`)
    .digest("base64url")
    .slice(0, 32);
}

export function getSandboxShutdownTime(now = new Date()) {
  const shutdownAt = new Date(now);
  shutdownAt.setMinutes(shutdownAt.getMinutes() + config.sandbox.idleTtlMinutes);
  return shutdownAt.toISOString();
}

export function buildSandboxClaim(threadId: string, now = new Date()): SandboxClaim {
  const claimName = getClaimName(threadId);
  const threadIdHash = hashThreadId(threadId);
  const password = getClaimPassword(threadId);

  return {
    apiVersion: "extensions.agents.x-k8s.io/v1alpha1",
    kind: "SandboxClaim",
    metadata: {
      name: claimName,
      namespace: config.kubernetes.namespace,
      labels: {
        [THREAD_ID_HASH_LABEL]: threadIdHash,
      },
      annotations: {
        [THREAD_ID_ANNOTATION]: threadId,
      },
    },
    spec: {
      sandboxTemplateRef: {
        name: config.sandbox.templateName,
      },
      env: [
        {
          name: OPENCODE_SERVER_PASSWORD_ENV,
          value: password,
        },
      ],
      lifecycle: {
        shutdownPolicy: "Delete",
        shutdownTime: getSandboxShutdownTime(now),
      },
    },
  };
}

export function getSandboxClaimPodIP(claim: SandboxClaim) {
  return claim.status?.sandbox?.podIPs?.find((podIP) => podIP !== undefined && podIP.length > 0);
}

export function isSandboxClaimReady(claim: SandboxClaim) {
  const readyCondition = claim.status?.conditions?.find((condition) => condition.type === "Ready");
  return readyCondition?.status === "True" && getSandboxClaimPodIP(claim) !== undefined;
}

export async function ensureClaim(threadId: string, options: EnsureClaimOptions = {}) {
  const client = options.client ?? getSandboxClaimClient();
  const claimName = getClaimName(threadId);
  const password = getClaimPassword(threadId);
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const readyTimeoutMs = options.readyTimeoutMs ?? config.sandbox.readyTimeoutSeconds * 1_000;
  const sleepFn = options.sleep ?? sleep;

  let claim: SandboxClaim;

  try {
    claim = await client.get(claimName);
  } catch (error: unknown) {
    if (!isKubernetesApiErrorCode(error, 404)) {
      throw error;
    }

    try {
      claim = await client.create(buildSandboxClaim(threadId, options.now));
    } catch (createError: unknown) {
      if (!isKubernetesApiErrorCode(createError, 409)) {
        throw createError;
      }

      claim = await client.get(claimName);
    }
  }

  const deadline = Date.now() + readyTimeoutMs;

  while (true) {
    const podIP = getSandboxClaimPodIP(claim);
    if (isSandboxClaimReady(claim) && podIP !== undefined) {
      return {
        claim,
        claimName,
        podIP,
        password,
      } satisfies EnsureClaimResult;
    }

    if (Date.now() >= deadline) {
      throw new Error(`SandboxClaim ${claimName} did not become ready within ${readyTimeoutMs}ms`);
    }

    await sleepFn(pollIntervalMs);
    claim = await client.get(claimName);
  }
}

function validateThreadId(threadId: string) {
  if (threadId.trim().length === 0) {
    throw new Error("threadId must not be empty");
  }
}

function isKubernetesApiErrorCode(error: unknown, code: number) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export {
  CLAIM_NAME_PREFIX,
  DEFAULT_POLL_INTERVAL_MS,
  OPENCODE_SERVER_PASSWORD_ENV,
  THREAD_ID_ANNOTATION,
  THREAD_ID_HASH_LABEL,
};
