import { createHash, randomBytes } from "node:crypto";
import { CustomObjectsApi, KubeConfig, Watch } from "@kubernetes/client-node";
import { buildOpencodeConfigContent } from "../agent/config.js";
import type { Config } from "../config.js";
import { logger } from "../logger.js";
import { agentProfileHash, sandboxProfileHash } from "../runtime/store.js";
import type { EnvVarRef, ResolvedRuntime } from "../runtime/types.js";
import type { EnvVar } from "../types.js";
import { claimNameForThread } from "./naming.js";
import type { ClaimedSandbox, SandboxClaim } from "./types.js";

const GROUP = "extensions.agents.x-k8s.io";
const PLURAL = "sandboxclaims";

export class SandboxManager {
  private readonly api: CustomObjectsApi;
  private readonly watch: Watch;

  constructor(
    kubeConfig: KubeConfig,
    private readonly config: Config,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.api = kubeConfig.makeApiClient(CustomObjectsApi);
    this.watch = new Watch(kubeConfig);
  }

  async claimFor(threadId: string, runtime: ResolvedRuntime): Promise<ClaimedSandbox> {
    const claimName = claimNameForThread(threadId);
    const log = logger.child({ threadId, claimName });
    log.info("claiming sandbox");

    const existing = await this.getClaim(claimName);

    if (existing) {
      if (!claimMatchesRuntime(existing, runtime)) {
        log.info("existing claim does not match current runtime; releasing");
        await this.releaseClaim(claimName);
      } else {
        log.info("reusing existing sandbox claim");
        try {
          return await this.waitForReady(existing, this.passwordFromClaim(existing), log);
        } catch {
          log.warn("existing claim failed readiness check; releasing");
          await this.releaseClaim(claimName);
        }
      }

      try {
        await this.waitForDeleted(claimName);
      } catch {}
    }

    log.info("creating new sandbox claim");
    const password = randomBytes(24).toString("base64url");
    const claim = this.buildClaim({ claimName, password, runtime, threadId });
    const created = (await this.api.createNamespacedCustomObject({
      group: GROUP,
      version: this.config.sandboxClaimApiVersion,
      namespace: this.config.kubeNamespace,
      plural: PLURAL,
      body: claim,
    })) as SandboxClaim;

    try {
      return await this.waitForReady(created, password, log);
    } catch (error) {
      await this.releaseClaim(claimName);
      throw error;
    }
  }

  async releaseClaim(claimName: string): Promise<void> {
    logger.info("releasing sandbox claim", { claimName });
    try {
      await this.api.deleteNamespacedCustomObject({
        group: GROUP,
        version: this.config.sandboxClaimApiVersion,
        namespace: this.config.kubeNamespace,
        plural: PLURAL,
        name: claimName,
        propagationPolicy: "Foreground",
      });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }

    await this.waitForDeleted(claimName);
  }

  async currentReadyClaim(claimName: string, password: string): Promise<ClaimedSandbox | null> {
    const claim = await this.getClaim(claimName);
    if (!claim || !isReady(claim)) return null;

    return {
      claimName: claim.metadata.name,
      password,
      podFQDN: this.podFQDN(claim),
    };
  }

  private async getClaim(claimName: string): Promise<SandboxClaim | null> {
    try {
      return (await this.api.getNamespacedCustomObject({
        group: GROUP,
        version: this.config.sandboxClaimApiVersion,
        namespace: this.config.kubeNamespace,
        plural: PLURAL,
        name: claimName,
      })) as SandboxClaim;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  private buildClaim(input: {
    claimName: string;
    password: string;
    runtime: ResolvedRuntime;
    threadId: string;
  }): SandboxClaim {
    const shutdownTime = new Date(Date.now() + this.config.claimShutdownHours * 60 * 60 * 1_000).toISOString();
    const env: EnvVar[] = [
      { name: "OPENCODE_SERVER_USERNAME", value: "opencode" },
      { name: "OPENCODE_SERVER_PASSWORD", value: input.password },
      ...resolveEnvVarRefs(input.runtime.agentProfile.claimEnv, this.env),
    ];

    const opencodeConfigContent = buildOpencodeConfigContent(input.runtime.opencodeConfig);
    if (opencodeConfigContent) {
      env.push({ name: "OPENCODE_CONFIG_CONTENT", value: opencodeConfigContent });
    }

    return {
      apiVersion: `extensions.agents.x-k8s.io/${this.config.sandboxClaimApiVersion}`,
      kind: "SandboxClaim",
      metadata: {
        name: input.claimName,
        namespace: this.config.kubeNamespace,
        labels: {
          "app.kubernetes.io/managed-by": "agentbay",
          "agentbay.dev/agent-profile": labelValue(input.runtime.agentProfile.id),
          "agentbay.dev/bot": labelValue(input.runtime.bot.id),
          "agentbay.dev/sandbox-profile": labelValue(input.runtime.sandboxProfile.id),
        },
        annotations: {
          "agentbay.dev/agent-profile-id": input.runtime.agentProfile.id,
          "agentbay.dev/agent-profile-hash": agentProfileHash(input.runtime.agentProfile),
          "agentbay.dev/bot-id": input.runtime.bot.id,
          "agentbay.dev/opencode-agent-name": input.runtime.opencodeAgentName,
          "agentbay.dev/opencode-config-hash": input.runtime.opencodeConfig.configHash,
          "agentbay.dev/opencode-config-id": input.runtime.opencodeConfig.id,
          "agentbay.dev/sandbox-profile-hash": sandboxProfileHash(input.runtime.sandboxProfile),
          "agentbay.dev/sandbox-profile-id": input.runtime.sandboxProfile.id,
          "agentbay.dev/thread-id": input.threadId,
        },
      },
      spec: {
        sandboxTemplateRef: { name: input.runtime.sandboxProfile.templateName },
        warmpool: input.runtime.sandboxProfile.warmpool,
        lifecycle: {
          shutdownTime,
          shutdownPolicy: "Delete",
          ttlSecondsAfterFinished: this.config.claimTtlSecondsAfterFinished,
        },
        env,
        additionalPodMetadata: {
          labels: {
            "agentbay.dev/managed-by": "agentbay",
            "agentbay.dev/agent-profile": labelValue(input.runtime.agentProfile.id),
            "agentbay.dev/bot": labelValue(input.runtime.bot.id),
            "agentbay.dev/claim": input.claimName,
            "agentbay.dev/sandbox-profile": labelValue(input.runtime.sandboxProfile.id),
          },
        },
      },
    };
  }

  private passwordFromClaim(claim: SandboxClaim): string {
    const password = claim.spec?.env?.find((entry) => entry.name === "OPENCODE_SERVER_PASSWORD")?.value;
    if (!password) throw new Error(`Existing claim ${claim.metadata.name} is missing OPENCODE_SERVER_PASSWORD`);
    return password;
  }

  /**
   * Wait for the SandboxClaim to reach the Ready condition using a Kubernetes
   * watch stream instead of polling. The watch delivers an initial ADDED event
   * with the current object state, then subsequent MODIFIED events as the
   * controller updates the claim, so no periodic GET requests are needed.
   *
   * If the watch connection closes before the claim is ready (e.g. the API
   * server closes long-running watches), it is automatically re-opened until
   * the deadline is reached.
   */
  private waitForReady(
    initial: SandboxClaim,
    password: string,
    log: ReturnType<typeof logger.child>,
  ): Promise<ClaimedSandbox> {
    // Fast path: the claim object we already have is ready (common when reusing
    // an existing claim that the controller has already processed).
    if (isReady(initial)) {
      const podFQDN = this.podFQDN(initial);
      log.info("sandbox claim ready", { podFQDN });
      return Promise.resolve({ claimName: initial.metadata.name, password, podFQDN });
    }

    const claimName = initial.metadata.name;

    return new Promise<ClaimedSandbox>((resolve, reject) => {
      let settled = false;
      let abortCtrl: AbortController | undefined;
      let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

      const deadline = Date.now() + this.config.claimReadyTimeoutMs;

      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(reconnectTimer);
        clearTimeout(deadlineTimer);
        abortCtrl?.abort();
        fn();
      };

      deadlineTimer = setTimeout(
        () => settle(() => reject(new Error(`Timed out waiting for SandboxClaim ${claimName} to become Ready`))),
        this.config.claimReadyTimeoutMs,
      );

      const onEvent = (phase: string, obj: unknown): void => {
        const claim = obj as SandboxClaim;
        if (phase === "ADDED" || phase === "MODIFIED") {
          if (isReady(claim)) {
            try {
              const podFQDN = this.podFQDN(claim);
              log.info("sandbox claim ready", { podFQDN });
              settle(() => resolve({ claimName, password, podFQDN }));
            } catch (err) {
              settle(() => reject(err instanceof Error ? err : new Error(String(err))));
            }
          }
        } else if (phase === "DELETED") {
          settle(() => reject(new Error(`SandboxClaim ${claimName} was deleted before becoming Ready`)));
        }
      };

      const onDone = (err: unknown): void => {
        if (settled) return;
        if (err) log.debug("watch ended with error, will reconnect", { claim: claimName });
        const remaining = deadline - Date.now();
        if (remaining <= 0) return;
        reconnectTimer = setTimeout(() => void startWatch(), Math.min(1_000, remaining));
      };

      const startWatch = async (): Promise<void> => {
        if (settled) return;
        try {
          abortCtrl = await this.watch.watch(
            this.claimsWatchPath(),
            { fieldSelector: `metadata.name=${claimName}` },
            onEvent,
            onDone,
          );
          if (settled) abortCtrl.abort();
        } catch (err) {
          onDone(err);
        }
      };

      void startWatch();
    });
  }

  /**
   * Wait for the SandboxClaim to disappear using a Kubernetes watch stream.
   *
   * An initial GET is performed first so that an already-deleted claim is
   * detected immediately without opening a watch. When the watch closes
   * before a DELETED event is observed (e.g. the server closes the
   * connection), a GET re-checks whether the claim is gone before
   * reconnecting.
   */
  private waitForDeleted(claimName: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let abortCtrl: AbortController | undefined;
      let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

      const deadline = Date.now() + this.config.claimReadyTimeoutMs;

      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(reconnectTimer);
        clearTimeout(deadlineTimer);
        abortCtrl?.abort();
        fn();
      };

      deadlineTimer = setTimeout(
        () => settle(() => reject(new Error(`Timed out waiting for SandboxClaim ${claimName} to be deleted`))),
        this.config.claimReadyTimeoutMs,
      );

      const onEvent = (phase: string): void => {
        if (phase === "DELETED") settle(() => resolve());
      };

      // When the watch stream closes (normally or with error), verify current
      // state via GET before reconnecting. This handles the race where the
      // resource is deleted between the initial check and the watch starting,
      // and the case where the watch closes before the DELETED event arrives.
      const onDone = (err: unknown): void => {
        if (settled) return;
        void this.getClaim(claimName)
          .then((claim) => {
            if (!claim) {
              settle(() => resolve());
              return;
            }
            if (settled) return;
            const remaining = deadline - Date.now();
            if (remaining <= 0) return;
            reconnectTimer = setTimeout(() => void startWatch(), Math.min(1_000, remaining));
          })
          .catch(() => {
            if (settled) return;
            const remaining = deadline - Date.now();
            if (remaining <= 0) return;
            reconnectTimer = setTimeout(() => void startWatch(), Math.min(1_000, remaining));
          });
        if (err) logger.debug("watch ended with error while waiting for deletion", { claim: claimName });
      };

      const startWatch = async (): Promise<void> => {
        if (settled) return;
        try {
          abortCtrl = await this.watch.watch(
            this.claimsWatchPath(),
            { fieldSelector: `metadata.name=${claimName}` },
            onEvent,
            onDone,
          );
          if (settled) abortCtrl.abort();
        } catch (err) {
          onDone(err);
        }
      };

      // Initial check: if the claim is already gone, resolve immediately.
      void this.getClaim(claimName)
        .then((claim) => {
          if (!claim) {
            settle(() => resolve());
            return;
          }
          void startWatch();
        })
        .catch(() => {
          // GET failed for an unexpected reason; start the watch anyway and
          // let onDone's GET re-verify when the stream closes.
          void startWatch();
        });
    });
  }

  private claimsWatchPath(): string {
    return `/apis/${GROUP}/${this.config.sandboxClaimApiVersion}/namespaces/${this.config.kubeNamespace}/${PLURAL}`;
  }

  private podFQDN(claim: SandboxClaim): string {
    const podIP = claim.status?.sandbox?.podIPs?.[0];
    if (podIP) return podIP;

    const sandboxName = claim.status?.sandbox?.name;
    if (sandboxName) return `${sandboxName}.${this.config.kubeNamespace}.svc`;

    throw new Error(`Ready SandboxClaim ${claim.metadata.name} did not expose a service FQDN, sandbox name, or pod IP`);
  }
}

function isReady(claim: SandboxClaim): boolean {
  return claim.status?.conditions?.some((condition) => condition.type === "Ready" && condition.status === "True") ?? false;
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const maybe = error as { code?: number; response?: { statusCode?: number; status?: number } };
  return maybe.code === 404 || maybe.response?.statusCode === 404 || maybe.response?.status === 404;
}

function claimMatchesRuntime(claim: SandboxClaim, runtime: ResolvedRuntime): boolean {
  const annotations = claim.metadata.annotations ?? {};
  return (
    annotations["agentbay.dev/agent-profile-id"] === runtime.agentProfile.id &&
    annotations["agentbay.dev/agent-profile-hash"] === agentProfileHash(runtime.agentProfile) &&
    annotations["agentbay.dev/bot-id"] === runtime.bot.id &&
    annotations["agentbay.dev/opencode-config-hash"] === runtime.opencodeConfig.configHash &&
    annotations["agentbay.dev/opencode-config-id"] === runtime.opencodeConfig.id &&
    annotations["agentbay.dev/sandbox-profile-hash"] === sandboxProfileHash(runtime.sandboxProfile) &&
    annotations["agentbay.dev/sandbox-profile-id"] === runtime.sandboxProfile.id
  );
}

function labelValue(value: string): string {
  if (value.length <= 63 && /^(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?$/.test(value)) return value;
  return `h-${createHash("sha256").update(value).digest("hex").slice(0, 61)}`;
}

function resolveEnvVarRefs(refs: EnvVarRef[], env: NodeJS.ProcessEnv): EnvVar[] {
  return refs.map((ref) => {
    const value = env[ref.valueFromEnv];
    if (!value) throw new Error(`Missing environment variable ${ref.valueFromEnv} for claim env ${ref.name}`);
    return { name: ref.name, value };
  });
}
