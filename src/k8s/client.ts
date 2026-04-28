import { existsSync } from "node:fs";
import {
  KubeConfig,
  KubernetesObjectApi,
  PatchStrategy,
  type KubernetesListObject,
  type KubernetesObject,
  type V1ObjectMeta,
} from "@kubernetes/client-node";
import { config } from "../config.ts";

const SANDBOX_CLAIM_API_VERSION = "extensions.agents.x-k8s.io/v1alpha1";
const SANDBOX_CLAIM_KIND = "SandboxClaim";
const SERVICE_ACCOUNT_TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token";

type KubeConfigSource = "in-cluster" | "kubeconfig";

type ListOptions = {
  fieldSelector?: string;
  labelSelector?: string;
  limit?: number;
  continueToken?: string;
};

type ResourceMetadata = {
  name: string;
  namespace?: string;
};

type ResourceHeader<T extends KubernetesObject> = Pick<T, "apiVersion" | "kind"> & {
  metadata: ResourceMetadata;
};

export interface SandboxClaim extends KubernetesObject {
  apiVersion: typeof SANDBOX_CLAIM_API_VERSION;
  kind: typeof SANDBOX_CLAIM_KIND;
  metadata?: V1ObjectMeta;
  spec?: {
    sandboxTemplateRef?: {
      name?: string;
    };
    env?: Array<{
      name: string;
      value?: string;
      valueFrom?: unknown;
    }>;
    lifecycle?: {
      shutdownPolicy?: "Delete" | "DeleteForeground" | "Retain";
      shutdownTime?: string;
    };
    warmpool?: string;
    [key: string]: unknown;
  };
  status?: {
    conditions?: Array<{
      type?: string;
      status?: string;
      reason?: string;
      message?: string;
      lastTransitionTime?: string;
    }>;
    sandbox?: {
      name?: string;
      namespace?: string;
      podIPs?: string[];
    };
    [key: string]: unknown;
  };
}

export interface KubernetesClients {
  kubeConfig: KubeConfig;
  objectApi: KubernetesObjectApi;
  namespace: string;
  source: KubeConfigSource;
}

export class NamespacedCustomResourceClient<T extends KubernetesObject> {
  private readonly objectApi: KubernetesObjectApi;
  private readonly apiVersion: string;
  private readonly kind: string;
  private readonly namespace: string;

  constructor(objectApi: KubernetesObjectApi, apiVersion: string, kind: string, namespace: string) {
    this.objectApi = objectApi;
    this.apiVersion = apiVersion;
    this.kind = kind;
    this.namespace = namespace;
  }

  async list(options: ListOptions = {}) {
    return this.objectApi.list<T>(
      this.apiVersion,
      this.kind,
      this.namespace,
      undefined,
      undefined,
      undefined,
      options.fieldSelector,
      options.labelSelector,
      options.limit,
      options.continueToken,
    );
  }

  async get(name: string) {
    return this.objectApi.read<T>(this.resourceMetadata(name));
  }

  async create(resource: T) {
    return this.objectApi.create<T>(this.withResourceDefaults(resource));
  }

  async patch(resource: T, fieldManager = "wolfgang") {
    return this.objectApi.patch<T>(
      this.withResourceDefaults(resource),
      undefined,
      undefined,
      fieldManager,
      undefined,
      PatchStrategy.MergePatch,
    );
  }

  async delete(name: string) {
    return this.objectApi.delete(this.resourceMetadata(name));
  }

  private resourceMetadata(name: string): ResourceHeader<T> {
    return {
      apiVersion: this.apiVersion as T["apiVersion"],
      kind: this.kind as T["kind"],
      metadata: {
        name,
        namespace: this.namespace,
      },
    };
  }

  private withResourceDefaults(resource: T) {
    return {
      ...resource,
      apiVersion: this.apiVersion,
      kind: this.kind,
      metadata: Object.assign({}, resource.metadata, {
        namespace: resource.metadata?.namespace ?? this.namespace,
      }),
    } as T;
  }
}

let cachedClients: KubernetesClients | null = null;
let cachedSandboxClaimClient: NamespacedCustomResourceClient<SandboxClaim> | null = null;

function isInClusterEnvironment() {
  return (
    process.env.KUBERNETES_SERVICE_HOST !== undefined &&
    process.env.KUBERNETES_SERVICE_PORT !== undefined &&
    existsSync(SERVICE_ACCOUNT_TOKEN_PATH)
  );
}

function loadKubeConfig() {
  const kubeConfig = new KubeConfig();

  if (isInClusterEnvironment()) {
    kubeConfig.loadFromCluster();
    return { kubeConfig, source: "in-cluster" as const };
  }

  kubeConfig.loadFromDefault();
  return { kubeConfig, source: "kubeconfig" as const };
}

function createKubernetesClients(): KubernetesClients {
  const { kubeConfig, source } = loadKubeConfig();

  return {
    kubeConfig,
    objectApi: KubernetesObjectApi.makeApiClient(kubeConfig),
    namespace: config.kubernetes.namespace,
    source,
  };
}

export function getKubernetesClients() {
  cachedClients ??= createKubernetesClients();
  return cachedClients;
}

export function getSandboxClaimClient() {
  cachedSandboxClaimClient ??= new NamespacedCustomResourceClient<SandboxClaim>(
    getKubernetesClients().objectApi,
    SANDBOX_CLAIM_API_VERSION,
    SANDBOX_CLAIM_KIND,
    getKubernetesClients().namespace,
  );

  return cachedSandboxClaimClient;
}

export async function listSandboxClaims(options: ListOptions = {}) {
  return getSandboxClaimClient().list(options);
}

export async function getSandboxClaim(name: string) {
  return getSandboxClaimClient().get(name);
}

export type SandboxClaimList = KubernetesListObject<SandboxClaim>;
export { SANDBOX_CLAIM_API_VERSION, SANDBOX_CLAIM_KIND };
