import { randomBytes } from "node:crypto";
import type { CustomObjectsApi } from "@kubernetes/client-node";
import { buildOpencodeConfigContent } from "../agent/config.js";
import type { Config } from "../config.js";
import type { BotProfile, EnvVar } from "../types.js";
import { claimNameForThread } from "./naming.js";
import type { ClaimedSandbox, SandboxClaim } from "./types.js";

const GROUP = "extensions.agents.x-k8s.io";
const VERSION = "v1alpha1";
const PLURAL = "sandboxclaims";

export class SandboxManager {
  constructor(
    private readonly api: CustomObjectsApi,
    private readonly config: Config,
  ) {}

  async claimFor(threadId: string, profile: BotProfile): Promise<ClaimedSandbox> {
    const claimName = claimNameForThread(threadId);
    const existing = await this.getClaim(claimName);

    if (existing) {
      try {
        return await this.waitForReady(existing, this.passwordFromClaim(existing));
      } catch {
        await this.releaseClaim(claimName);
      }
    }

    const password = randomBytes(24).toString("base64url");
    const claim = this.buildClaim({ claimName, password, profile, threadId });
    const created = (await this.api.createNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: this.config.kubeNamespace,
      plural: PLURAL,
      body: claim,
    })) as SandboxClaim;

    try {
      return await this.waitForReady(created, password);
    } catch (error) {
      await this.releaseClaim(claimName);
      throw error;
    }
  }

  async releaseClaim(claimName: string): Promise<void> {
    try {
      await this.api.deleteNamespacedCustomObject({
        group: GROUP,
        version: VERSION,
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
        version: VERSION,
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
    profile: BotProfile;
    threadId: string;
  }): SandboxClaim {
    const shutdownTime = new Date(Date.now() + this.config.claimShutdownHours * 60 * 60 * 1_000).toISOString();
    const env: EnvVar[] = [
      { name: "OPENCODE_SERVER_USERNAME", value: "opencode" },
      { name: "OPENCODE_SERVER_PASSWORD", value: input.password },
      ...this.config.claimEnv,
    ];

    const opencodeConfigContent = buildOpencodeConfigContent(input.profile);
    if (opencodeConfigContent) {
      env.push({ name: "OPENCODE_CONFIG_CONTENT", value: opencodeConfigContent });
    }

    return {
      apiVersion: "extensions.agents.x-k8s.io/v1alpha1",
      kind: "SandboxClaim",
      metadata: {
        name: input.claimName,
        namespace: this.config.kubeNamespace,
        labels: {
          "app.kubernetes.io/managed-by": "agentbay",
          "agentbay.dev/profile": input.profile.id,
        },
        annotations: {
          "agentbay.dev/thread-id": input.threadId,
        },
      },
      spec: {
        sandboxTemplateRef: { name: input.profile.templateName },
        warmpool: input.profile.warmpool,
        lifecycle: {
          shutdownTime,
          shutdownPolicy: "Delete",
          ttlSecondsAfterFinished: this.config.claimTtlSecondsAfterFinished,
        },
        env,
        additionalPodMetadata: {
          labels: {
            "agentbay.dev/managed-by": "agentbay",
            "agentbay.dev/claim": input.claimName,
            "agentbay.dev/profile": input.profile.id,
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

  private async waitForReady(initial: SandboxClaim, password: string): Promise<ClaimedSandbox> {
    const deadline = Date.now() + this.config.claimReadyTimeoutMs;
    let claim = initial;

    while (Date.now() <= deadline) {
      if (isReady(claim)) {
        return {
          claimName: claim.metadata.name,
          password,
          podFQDN: this.podFQDN(claim),
        };
      }

      await sleep(this.config.claimPollIntervalMs);
      claim = (await this.api.getNamespacedCustomObject({
        group: GROUP,
        version: VERSION,
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
