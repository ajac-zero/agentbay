import { randomUUID } from "node:crypto";
import { createOpencodeClient as createSdkClient, type OpencodeClient } from "@opencode-ai/sdk/v2";
import { config } from "../config.ts";
import {
  getSandboxClaimClient,
  getSandboxClient,
  type NamespacedCustomResourceClient,
  type Sandbox,
  type SandboxClaim,
} from "../k8s/client.ts";

const DEFAULT_SCHEME = "http";
const EVENT_PATH_SUFFIXES = ["/event", "/global/event"];

export type SandboxAccessMode = "direct" | "router";

type SandboxClaimReader = Pick<NamespacedCustomResourceClient<SandboxClaim>, "get">;
type SandboxReader = Pick<NamespacedCustomResourceClient<Sandbox>, "get">;
type OpenCodeFetch = typeof fetch;

export interface CreateOpenCodeClientOptions {
  claimName: string;
  password: string;
  accessMode?: SandboxAccessMode;
  claimClient?: SandboxClaimReader;
  sandboxClient?: SandboxReader;
  routerUrl?: URL;
  fetchImplementation?: OpenCodeFetch;
  requestIdFactory?: () => string;
}

export interface ResolvedOpenCodeConnection {
  accessMode: SandboxAccessMode;
  baseUrl: string;
  namespace: string;
  port: number;
  sandboxName: string;
  serviceName: string | null;
  serviceFQDN: string | null;
}

export async function createOpenCodeClient(
  options: CreateOpenCodeClientOptions,
): Promise<OpencodeClient> {
  const connection = await resolveOpenCodeConnection(options);
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const requestIdFactory = options.requestIdFactory ?? randomUUID;

  return createSdkClient({
    baseUrl: connection.baseUrl,
    fetch: createTransportFetch({
      connection,
      password: options.password,
      fetchImplementation,
      requestIdFactory,
    }),
  });
}

export async function resolveOpenCodeConnection(
  options: CreateOpenCodeClientOptions,
): Promise<ResolvedOpenCodeConnection> {
  const accessMode = options.accessMode ?? config.sandbox.accessMode;
  const claimClient = options.claimClient ?? getSandboxClaimClient();
  const claim = await claimClient.get(options.claimName);
  const sandboxName = claim.status?.sandbox?.name;

  if (sandboxName === undefined || sandboxName.length === 0) {
    throw new Error(
      `SandboxClaim ${options.claimName} does not expose status.sandbox.name; cannot resolve OpenCode target`,
    );
  }

  const namespace = claim.metadata?.namespace ?? config.kubernetes.namespace;
  const port = config.sandbox.port;

  if (accessMode === "router") {
    const routerUrl = options.routerUrl ?? config.sandbox.routerUrl;
    if (routerUrl === null) {
      throw new Error("sandbox router URL is required when SANDBOX_ACCESS_MODE=router");
    }

    return {
      accessMode,
      baseUrl: formatBaseUrl(routerUrl),
      namespace,
      port,
      sandboxName,
      serviceName: null,
      serviceFQDN: null,
    };
  }

  const sandboxClient = options.sandboxClient ?? getSandboxClient();
  const sandbox = await sandboxClient.get(sandboxName);
  const sandboxNamespace = sandbox.metadata?.namespace ?? namespace;
  const serviceName = sandbox.status?.service ?? sandbox.metadata?.name ?? sandboxName;
  const serviceFQDN =
    sandbox.status?.serviceFQDN ??
    `${serviceName}.${sandboxNamespace}.svc.${config.kubernetes.clusterDomain}`;

  return {
    accessMode,
    baseUrl: `${DEFAULT_SCHEME}://${serviceFQDN}:${port}`,
    namespace: sandboxNamespace,
    port,
    sandboxName,
    serviceName,
    serviceFQDN,
  };
}

type CreateTransportFetchOptions = {
  connection: ResolvedOpenCodeConnection;
  password: string;
  fetchImplementation: OpenCodeFetch;
  requestIdFactory: () => string;
};

function createTransportFetch(options: CreateTransportFetchOptions): OpenCodeFetch {
  return async function transportFetch(input: Request | URL | string, init?: RequestInit) {
    const originalRequest = input instanceof Request ? input : new Request(input, init);
    const nextRequest = new Request(originalRequest);
    const url = new URL(nextRequest.url);

    nextRequest.headers.set("Authorization", buildOpenCodeAuthorizationHeader(options.password));

    if (isSseRequest(url)) {
      url.searchParams.set("auth_token", options.password);
    }

    if (options.connection.accessMode === "router") {
      nextRequest.headers.set("X-Sandbox-ID", options.connection.sandboxName);
      nextRequest.headers.set("X-Sandbox-Namespace", options.connection.namespace);
      nextRequest.headers.set("X-Sandbox-Port", String(options.connection.port));
      nextRequest.headers.set("X-Request-ID", options.requestIdFactory());
    }

    return options.fetchImplementation(new Request(url, nextRequest));
  };
}

export function buildOpenCodeAuthorizationHeader(password: string) {
  return `Basic ${Buffer.from(`:${password}`).toString("base64")}`;
}

function isSseRequest(url: URL) {
  return EVENT_PATH_SUFFIXES.some((suffix) => url.pathname.endsWith(suffix));
}

function formatBaseUrl(url: URL) {
  return url.toString().replace(/\/+$/, "");
}
