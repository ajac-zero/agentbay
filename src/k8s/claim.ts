import { createHash } from "node:crypto";
import { Watch } from "@kubernetes/client-node";
import { config } from "../config.ts";
import {
  NamespacedCustomResourceClient,
  getKubernetesClients,
  getSandboxClaimClient,
  getSandboxClaimWatchPath,
  type SandboxClaim,
} from "./client.ts";

const THREAD_ID_HASH_LABEL = "agentbay.io/thread-id-hash";
const THREAD_ID_ANNOTATION = "agentbay.io/thread-id";
const OPENCODE_SERVER_PASSWORD_ENV = "OPENCODE_SERVER_PASSWORD";
const CLAIM_NAME_PREFIX = "ab-";
const TERMINAL_CONDITION_TYPES = new Set(["Failed", "Finished"]);

let cachedReadinessGate: SandboxClaimReadinessGate | null = null;

type SandboxClaimApi = Pick<
  NamespacedCustomResourceClient<SandboxClaim>,
  "get" | "create" | "patch"
>;

type ClaimWaiter = {
  resolve: (claim: SandboxClaim) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type ClaimWatchEntry = {
  claimName: string;
  latestClaim: SandboxClaim;
  waiters: Set<ClaimWaiter>;
  stop?: () => void;
  startPromise?: Promise<void>;
  closed: boolean;
};

export interface EnsureClaimResult {
  claim: SandboxClaim;
  claimName: string;
  podIP: string;
  password: string;
}

export interface EnsureClaimOptions {
  client?: SandboxClaimApi;
  now?: Date;
  readyTimeoutMs?: number;
  readinessGate?: SandboxClaimReadinessGate;
}

export interface WaitForSandboxClaimReadyOptions {
  timeoutMs?: number;
  readinessGate?: SandboxClaimReadinessGate;
}

export interface SandboxClaimWatchSource {
  start(options: {
    claimName: string;
    resourceVersion?: string;
    onEvent: (claim: SandboxClaim) => void;
    onDelete: (claim: SandboxClaim) => void;
    onError: (error: unknown) => void;
  }): Promise<() => void>;
}

export class KubernetesSandboxClaimWatchSource implements SandboxClaimWatchSource {
  private readonly watch?: Watch;
  private readonly namespace?: string;

  constructor(options: { watch?: Watch; namespace?: string } = {}) {
    this.watch = options.watch;
    this.namespace = options.namespace;
  }

  async start(options: {
    claimName: string;
    resourceVersion?: string;
    onEvent: (claim: SandboxClaim) => void;
    onDelete: (claim: SandboxClaim) => void;
    onError: (error: unknown) => void;
  }) {
    const watch = this.watch ?? getKubernetesClients().watch;
    const namespace = this.namespace ?? getKubernetesClients().namespace;
    const path = getSandboxClaimWatchPath(namespace);
    const fieldSelector = `metadata.name=${options.claimName}`;
    let resourceVersion = options.resourceVersion;
    let abortController: AbortController | null = null;
    let stopped = false;

    const connect = async (): Promise<void> => {
      if (stopped) {
        return;
      }

      try {
        abortController = await watch.watch(
          path,
          {
            fieldSelector,
            resourceVersion,
          },
          (phase: string, apiObject: unknown) => {
            if (!isSandboxClaim(apiObject) || apiObject.metadata?.name !== options.claimName) {
              return;
            }

            resourceVersion = apiObject.metadata?.resourceVersion ?? resourceVersion;

            if (phase === "DELETED") {
              options.onDelete(apiObject);
              return;
            }

            if (phase === "ERROR") {
              options.onError(
                new Error(`SandboxClaim watch reported an error for ${options.claimName}`),
              );
              return;
            }

            options.onEvent(apiObject);
          },
          (error: unknown) => {
            abortController = null;

            if (stopped) {
              return;
            }

            if (error === undefined || error === null || error === Watch.SERVER_SIDE_CLOSE) {
              void connect().catch(options.onError);
              return;
            }

            options.onError(error);
          },
        );
      } catch (error: unknown) {
        if (stopped) {
          return;
        }

        options.onError(error);
      }
    };

    await connect();

    return () => {
      stopped = true;
      abortController?.abort();
      abortController = null;
    };
  }
}

export class SandboxClaimReadinessGate {
  private readonly watchSource: SandboxClaimWatchSource;
  private readonly entries = new Map<string, ClaimWatchEntry>();

  constructor(watchSource: SandboxClaimWatchSource = new KubernetesSandboxClaimWatchSource()) {
    this.watchSource = watchSource;
  }

  async waitForReady(claim: SandboxClaim, options: WaitForSandboxClaimReadyOptions = {}) {
    const claimName = claim.metadata?.name;
    if (claimName === undefined || claimName.length === 0) {
      throw new Error("SandboxClaim metadata.name is required");
    }

    const evaluation = evaluateSandboxClaim(claim);
    if (evaluation.type === "ready") {
      return evaluation.claim;
    }

    if (evaluation.type === "terminal") {
      throw evaluation.error;
    }

    const timeoutMs = options.timeoutMs ?? config.sandbox.readyTimeoutSeconds * 1_000;
    const entry = this.getOrCreateEntry(claimName, claim);

    return new Promise<SandboxClaim>((resolve, reject) => {
      const waiter: ClaimWaiter = {
        resolve: (readyClaim) => {
          clearTimeout(waiter.timeout);
          resolve(readyClaim);
        },
        reject: (error) => {
          clearTimeout(waiter.timeout);
          reject(error);
        },
        timeout: setTimeout(() => {
          this.removeWaiter(entry, waiter);
          reject(new Error(`SandboxClaim ${claimName} did not become ready within ${timeoutMs}ms`));
        }, timeoutMs),
      };

      entry.waiters.add(waiter);
      entry.latestClaim = claim;

      this.evaluateEntry(entry);
      void this.ensureWatchStarted(entry);
    });
  }

  private getOrCreateEntry(claimName: string, claim: SandboxClaim) {
    let entry = this.entries.get(claimName);

    if (entry !== undefined) {
      return entry;
    }

    entry = {
      claimName,
      latestClaim: claim,
      waiters: new Set(),
      closed: false,
    } satisfies ClaimWatchEntry;

    this.entries.set(claimName, entry);
    return entry;
  }

  private async ensureWatchStarted(entry: ClaimWatchEntry) {
    if (entry.closed || entry.startPromise !== undefined) {
      return;
    }

    entry.startPromise = this.watchSource
      .start({
        claimName: entry.claimName,
        resourceVersion: entry.latestClaim.metadata?.resourceVersion,
        onEvent: (claim) => {
          entry.latestClaim = claim;
          this.evaluateEntry(entry);
        },
        onDelete: (claim) => {
          this.rejectEntry(
            entry,
            new Error(
              `SandboxClaim ${claim.metadata?.name ?? entry.claimName} was deleted before it became ready`,
            ),
          );
        },
        onError: (error) => {
          this.rejectEntry(
            entry,
            toError(error, `SandboxClaim watch failed for ${entry.claimName}`),
          );
        },
      })
      .then((stop) => {
        if (entry.closed) {
          stop();
          return;
        }

        entry.stop = stop;
      })
      .catch((error: unknown) => {
        this.rejectEntry(entry, toError(error, `SandboxClaim watch failed for ${entry.claimName}`));
      });

    await entry.startPromise;
  }

  private evaluateEntry(entry: ClaimWatchEntry) {
    if (entry.closed) {
      return;
    }

    const evaluation = evaluateSandboxClaim(entry.latestClaim);
    if (evaluation.type === "ready") {
      this.resolveEntry(entry, evaluation.claim);
      return;
    }

    if (evaluation.type === "terminal") {
      this.rejectEntry(entry, evaluation.error);
    }
  }

  private resolveEntry(entry: ClaimWatchEntry, claim: SandboxClaim) {
    if (entry.closed) {
      return;
    }

    const waiters = [...entry.waiters];
    this.closeEntry(entry);

    for (const waiter of waiters) {
      waiter.resolve(claim);
    }
  }

  private rejectEntry(entry: ClaimWatchEntry, error: Error) {
    if (entry.closed) {
      return;
    }

    const waiters = [...entry.waiters];
    this.closeEntry(entry);

    for (const waiter of waiters) {
      waiter.reject(error);
    }
  }

  private removeWaiter(entry: ClaimWatchEntry, waiter: ClaimWaiter) {
    if (entry.closed) {
      return;
    }

    entry.waiters.delete(waiter);

    if (entry.waiters.size === 0) {
      this.closeEntry(entry);
    }
  }

  private closeEntry(entry: ClaimWatchEntry) {
    if (entry.closed) {
      return;
    }

    entry.closed = true;
    this.entries.delete(entry.claimName);

    for (const waiter of entry.waiters) {
      clearTimeout(waiter.timeout);
    }

    entry.waiters.clear();
    entry.stop?.();
    entry.stop = undefined;
  }
}

export function getSandboxClaimReadinessGate() {
  cachedReadinessGate ??= new SandboxClaimReadinessGate();
  return cachedReadinessGate;
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
    .update(`agentbay:${config.kubernetes.namespace}:${config.sandbox.templateName}:${threadId}`)
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

export function getSandboxClaimTerminalCondition(claim: SandboxClaim) {
  return claim.status?.conditions?.find(
    (condition) =>
      condition.type !== undefined &&
      TERMINAL_CONDITION_TYPES.has(condition.type) &&
      condition.status === "True",
  );
}

export function isSandboxClaimReady(claim: SandboxClaim) {
  const readyCondition = claim.status?.conditions?.find((condition) => condition.type === "Ready");
  return readyCondition?.status === "True" && getSandboxClaimPodIP(claim) !== undefined;
}

export async function waitForSandboxClaimReady(
  claim: SandboxClaim,
  options: WaitForSandboxClaimReadyOptions = {},
) {
  return (options.readinessGate ?? getSandboxClaimReadinessGate()).waitForReady(claim, {
    timeoutMs: options.timeoutMs,
  });
}

export async function ensureClaim(threadId: string, options: EnsureClaimOptions = {}) {
  const client = options.client ?? getSandboxClaimClient();
  const readinessGate = options.readinessGate ?? getSandboxClaimReadinessGate();
  const claimName = getClaimName(threadId);
  const password = getClaimPassword(threadId);
  const readyTimeoutMs = options.readyTimeoutMs ?? config.sandbox.readyTimeoutSeconds * 1_000;

  let claim: SandboxClaim;
  let shouldRefreshShutdownTime = false;

  try {
    claim = await client.get(claimName);
    shouldRefreshShutdownTime = true;
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
      shouldRefreshShutdownTime = true;
    }
  }

  if (shouldRefreshShutdownTime) {
    claim = await refreshSandboxClaimShutdownTime(client, claimName, options.now);
  }

  claim = await readinessGate.waitForReady(claim, { timeoutMs: readyTimeoutMs });

  const podIP = getSandboxClaimPodIP(claim);
  if (podIP === undefined) {
    throw new Error(`SandboxClaim ${claimName} became ready without a pod IP`);
  }

  return {
    claim,
    claimName,
    podIP,
    password,
  } satisfies EnsureClaimResult;
}

async function refreshSandboxClaimShutdownTime(
  client: SandboxClaimApi,
  claimName: string,
  now = new Date(),
) {
  return await client.patch({
    apiVersion: "extensions.agents.x-k8s.io/v1alpha1",
    kind: "SandboxClaim",
    metadata: {
      name: claimName,
      namespace: config.kubernetes.namespace,
    },
    spec: {
      lifecycle: {
        shutdownPolicy: "Delete",
        shutdownTime: getSandboxShutdownTime(now),
      },
    },
  } as SandboxClaim);
}

function evaluateSandboxClaim(claim: SandboxClaim) {
  const podIP = getSandboxClaimPodIP(claim);
  if (isSandboxClaimReady(claim) && podIP !== undefined) {
    return {
      type: "ready" as const,
      claim,
      podIP,
    };
  }

  const terminalCondition = getSandboxClaimTerminalCondition(claim);
  if (terminalCondition !== undefined) {
    const conditionDescription = [
      terminalCondition.type,
      terminalCondition.reason,
      terminalCondition.message,
    ]
      .filter((value) => value !== undefined && value.length > 0)
      .join(": ");

    return {
      type: "terminal" as const,
      error: new Error(
        conditionDescription.length === 0
          ? `SandboxClaim ${claim.metadata?.name ?? "(unnamed)"} entered a terminal state`
          : `SandboxClaim ${claim.metadata?.name ?? "(unnamed)"} entered a terminal state: ${conditionDescription}`,
      ),
    };
  }

  return {
    type: "pending" as const,
  };
}

function validateThreadId(threadId: string) {
  if (threadId.trim().length === 0) {
    throw new Error("threadId must not be empty");
  }
}

function isKubernetesApiErrorCode(error: unknown, code: number) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function isSandboxClaim(value: unknown): value is SandboxClaim {
  return (
    typeof value === "object" &&
    value !== null &&
    "apiVersion" in value &&
    "kind" in value &&
    value.apiVersion === "extensions.agents.x-k8s.io/v1alpha1" &&
    value.kind === "SandboxClaim"
  );
}

function toError(error: unknown, fallbackMessage: string) {
  if (error instanceof Error) {
    return error;
  }

  if (typeof error === "string" && error.length > 0) {
    return new Error(error);
  }

  return new Error(fallbackMessage);
}

export {
  CLAIM_NAME_PREFIX,
  OPENCODE_SERVER_PASSWORD_ENV,
  TERMINAL_CONDITION_TYPES,
  THREAD_ID_ANNOTATION,
  THREAD_ID_HASH_LABEL,
};
