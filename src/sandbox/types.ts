import type { EnvVar } from "../types.js";

export type SandboxClaimCondition = {
  lastTransitionTime?: string;
  message?: string;
  reason?: string;
  status: "True" | "False" | "Unknown";
  type: string;
};

export type SandboxClaim = {
  apiVersion: "extensions.agents.x-k8s.io/v1alpha1";
  kind: "SandboxClaim";
  metadata: {
    annotations?: Record<string, string>;
    labels?: Record<string, string>;
    name: string;
    namespace?: string;
  };
  spec?: {
    additionalPodMetadata?: {
      annotations?: Record<string, string>;
      labels?: Record<string, string>;
    };
    env?: EnvVar[];
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
      podFQDN?: string;
      podIPs?: string[];
      serviceFQDN?: string;
    };
    serviceFQDN?: string;
  };
};

export type ClaimedSandbox = {
  claimName: string;
  password: string;
  podFQDN: string;
};
