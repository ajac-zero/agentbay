import type { JsonObject } from "../execution/types.js";
import type { ResolvedWorkspace } from "../workspace/types.js";

export type SandboxEnvVar = {
  containerName?: string;
  name: string;
  value: string;
};

export type SandboxClaimAPIVersion = "v1alpha1" | "v1beta1";

export type SandboxClaimCondition = {
  lastTransitionTime: string;
  message: string;
  observedGeneration?: number;
  reason?: string;
  status: "True" | "False" | "Unknown";
  type: string;
};

export type SandboxClaim = {
  apiVersion: `extensions.agents.x-k8s.io/${SandboxClaimAPIVersion}`;
  kind: "SandboxClaim";
  metadata: {
    annotations?: Record<string, string>;
    labels?: Record<string, string>;
    name: string;
    namespace?: string;
    uid?: string;
  };
  spec?: {
    additionalPodMetadata?: {
      annotations?: Record<string, string>;
      labels?: Record<string, string>;
    };
    env?: SandboxEnvVar[];
    lifecycle?: {
      shutdownPolicy?: "Retain" | "Delete" | "DeleteForeground";
      shutdownTime?: string;
      ttlSecondsAfterFinished?: number;
    };
    sandboxTemplateRef: {
      name: string;
    };
    warmpool?: string;
  };
  status?: {
    conditions?: SandboxClaimCondition[];
    sandbox?: {
      name?: string;
      podIPs?: string[];
    };
  };
};

export type ExecutionAttemptProvisioningInput = {
  tenantId: string;
  executionId: string;
  attempt: number;
  profileVersion: {
    id: string;
    profileId: string;
    version: number;
  };
  sandboxTemplate: string;
  warmPool?: string;
  opencodeConfig: JsonObject;
  workspace: ResolvedWorkspace;
  timeoutAt: Date;
  ttlSecondsAfterFinished: number;
};

export type ExecutionAttemptIdentity = Pick<ExecutionAttemptProvisioningInput, "executionId" | "attempt">;

export type ExecutionAttemptEndpoint = {
  workloadName: string;
  host: string;
  password: string;
  release: ExecutionAttemptProvisioningInput;
};

export interface ExecutionAttemptProvisioner {
  provision(input: ExecutionAttemptProvisioningInput, signal: AbortSignal): Promise<ExecutionAttemptEndpoint>;
  release(input: ExecutionAttemptProvisioningInput, signal: AbortSignal): Promise<void>;
}
