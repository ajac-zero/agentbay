import { createHash, randomBytes } from "node:crypto";
import type { CustomObjectsApi } from "@kubernetes/client-node";
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
  constructor(
    private readonly api: CustomObjectsApi,
    private readonly config: Config,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

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

  private async waitForReady(initial: SandboxClaim, password: string, log: ReturnType<typeof logger.child>): Promise<ClaimedSandbox> {
    const deadline = Date.now() + this.config.claimReadyTimeoutMs;
    let claim = initial;

    while (Date.now() <= deadline) {
      if (isReady(claim)) {
        const podFQDN = this.podFQDN(claim);
        log.info("sandbox claim ready", { podFQDN });
        return { claimName: claim.metadata.name, password, podFQDN };
      }

      await sleep(this.config.claimPollIntervalMs);
      claim = (await this.api.getNamespacedCustomObject({
        group: GROUP,
        version: this.config.sandboxClaimApiVersion,
        namespace: this.config.kubeNamespace,
        plural: PLURAL,
        name: claim.metadata.name,
      })) as SandboxClaim;
    }

    const reason = claim.status?.conditions
      ?.map((condition) => {
        const details = [condition.reason, condition.message].filter(Boolean).join(": ");
        return `${condition.type}=${condition.status}${details ? ` (${details})` : ""}`;
      })
      .join(", ");
    throw new Error(`Timed out waiting for SandboxClaim ${claim.metadata.name} to become Ready${reason ? ` (${reason})` : ""}`);
  }

  private async waitForDeleted(claimName: string): Promise<void> {
    const deadline = Date.now() + this.config.claimReadyTimeoutMs;

    while (Date.now() <= deadline) {
      if (!(await this.getClaim(claimName))) return;
      await sleep(this.config.claimPollIntervalMs);
    }

    throw new Error(`Timed out waiting for SandboxClaim ${claimName} to be deleted`);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
