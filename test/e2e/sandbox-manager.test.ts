import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { K3sContainer, type StartedK3sContainer } from "@testcontainers/k3s";
import {
  ApiextensionsV1Api,
  AppsV1Api,
  CoreV1Api,
  CustomObjectsApi,
  KubernetesObjectApi,
  KubeConfig,
  PatchStrategy,
  loadAllYaml,
  type KubernetesObject,
} from "@kubernetes/client-node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAgentClient, waitForOpencodeReady } from "../../src/agent/client.js";
import { createSession, runPrompt } from "../../src/agent/runner.js";
import type { Config } from "../../src/config.js";
import { sandboxProfileHash } from "../../src/runtime/store.js";
import type { ResolvedRuntime } from "../../src/runtime/types.js";
import { SandboxManager } from "../../src/sandbox/manager.js";
import { claimNameForThread } from "../../src/sandbox/naming.js";
import type { SandboxClaim } from "../../src/sandbox/types.js";
import { runtimeSnapshot, TestRuntimeStore } from "./runtime-store-fixture.js";

type ManifestObject = KubernetesObject & {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
  };
  [key: string]: unknown;
};

const GROUP = "extensions.agents.x-k8s.io";
const VERSION = "v1alpha1";
const PLURAL = "sandboxclaims";
const CRD_NAME = `${PLURAL}.${GROUP}`;
const AGENT_SANDBOX_NAMESPACE = "agent-sandbox-system";
const AGENT_SANDBOX_CONTROLLER = "agent-sandbox-controller";
const NAMESPACE = "agentbay-e2e";
const K3S_IMAGE = process.env.AGENTBAY_E2E_K3S_IMAGE ?? "rancher/k3s:v1.31.2-k3s1";
const AGENT_SANDBOX_VERSION = "v0.4.6";
const AGENT_SANDBOX_MANIFEST_URLS = [
  `https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${AGENT_SANDBOX_VERSION}/manifest.yaml`,
  `https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${AGENT_SANDBOX_VERSION}/extensions.yaml`,
];

describe("SandboxManager e2e", () => {
  let k3s: StartedK3sContainer | undefined;
  let rawKubeConfig: string;
  let coreApi: CoreV1Api;
  let customObjectsApi: CustomObjectsApi;
  let manager: SandboxManager;

  beforeAll(async () => {
    k3s = await new K3sContainer(K3S_IMAGE).start();
    rawKubeConfig = k3s.getKubeConfig();

    const kubeConfig = new KubeConfig();
    kubeConfig.loadFromString(rawKubeConfig);

    coreApi = kubeConfig.makeApiClient(CoreV1Api);
    const appsApi = kubeConfig.makeApiClient(AppsV1Api);
    const extensionsApi = kubeConfig.makeApiClient(ApiextensionsV1Api);
    const objectApi = KubernetesObjectApi.makeApiClient(kubeConfig);
    customObjectsApi = kubeConfig.makeApiClient(CustomObjectsApi);

    await installAgentSandbox(objectApi);
    await waitForCrdEstablished(extensionsApi, "sandboxes.agents.x-k8s.io");
    await waitForCrdEstablished(extensionsApi, CRD_NAME);
    await waitForCrdEstablished(extensionsApi, "sandboxtemplates.extensions.agents.x-k8s.io");
    await waitForDeploymentReady(appsApi, AGENT_SANDBOX_CONTROLLER, AGENT_SANDBOX_NAMESPACE);

    await coreApi.createNamespace({
      body: {
        metadata: { name: NAMESPACE },
      },
    });
    await applyObject(objectApi, sandboxTemplate());

    manager = new SandboxManager(customObjectsApi, testConfig(), {
      ANTHROPIC_API_KEY_CODER: "per-agent-anthropic-key",
      EXTRA_ENV_AGENT: "from-test",
    });
  });

  afterAll(async () => {
    await k3s?.stop();
  });

  it("provisions a real sandbox and connects to its opencode server", async () => {
    const threadId = `thread-${crypto.randomUUID()}`;
    const claimName = claimNameForThread(threadId);
    const runtime = await testRuntime();
    const claimPromise = manager.claimFor(threadId, runtime);

    const createdClaim = await waitForClaim(customObjectsApi, claimName);
    const password = createdClaim.spec?.env?.find((entry) => entry.name === "OPENCODE_SERVER_PASSWORD")?.value;

    expect(createdClaim.metadata.namespace).toBe(NAMESPACE);
    expect(createdClaim.metadata.labels).toMatchObject({
      "app.kubernetes.io/managed-by": "agentbay",
      "agentbay.dev/agent-profile": labelValue(runtime.agentProfile.id),
      "agentbay.dev/bot": labelValue(runtime.bot.id),
      "agentbay.dev/sandbox-profile": labelValue(runtime.sandboxProfile.id),
    });
    expect(createdClaim.metadata.annotations).toMatchObject({
      "agentbay.dev/agent-profile-id": runtime.agentProfile.id,
      "agentbay.dev/agent-profile-hash": expect.any(String),
      "agentbay.dev/bot-id": runtime.bot.id,
      "agentbay.dev/opencode-agent-name": "coder",
      "agentbay.dev/opencode-config-hash": runtime.opencodeConfig.configHash,
      "agentbay.dev/opencode-config-id": "opencode-config-default",
      "agentbay.dev/sandbox-profile-hash": sandboxProfileHash(runtime.sandboxProfile),
      "agentbay.dev/sandbox-profile-id": runtime.sandboxProfile.id,
      "agentbay.dev/thread-id": threadId,
    });
    expect(createdClaim.spec).toMatchObject({
      sandboxTemplateRef: { name: "opencode-template" },
      warmpool: "none",
      lifecycle: {
        shutdownPolicy: "Delete",
        ttlSecondsAfterFinished: 60,
      },
      additionalPodMetadata: {
        labels: {
          "agentbay.dev/managed-by": "agentbay",
          "agentbay.dev/agent-profile": labelValue(runtime.agentProfile.id),
          "agentbay.dev/bot": labelValue(runtime.bot.id),
          "agentbay.dev/claim": claimName,
          "agentbay.dev/sandbox-profile": labelValue(runtime.sandboxProfile.id),
        },
      },
    });
    expect(createdClaim.spec?.env).toEqual(
      expect.arrayContaining([
        { name: "OPENCODE_SERVER_USERNAME", value: "opencode" },
        { name: "ANTHROPIC_API_KEY", value: "per-agent-anthropic-key" },
        { name: "EXTRA_ENV", value: "from-test" },
        {
          name: "OPENCODE_CONFIG_CONTENT",
          value: JSON.stringify({
            permission: { "*": "allow" },
            agent: {
              coder: {
                prompt: "sandbox test prompt",
                model: "anthropic/claude-sonnet-4-5",
                tools: { bash: false },
              },
            },
            default_agent: "coder",
          }),
        },
      ]),
    );
    expect(password).toEqual(expect.any(String));

    const sandbox = await claimPromise;

    expect(sandbox).toMatchObject({ claimName, password });
    expect(sandbox.podFQDN).toEqual(expect.any(String));

    const podName = await waitForSandboxPod(coreApi, claimName);
    const portForward = await startPortForward(rawKubeConfig, podName);

    try {
      const portForwardedConfig = { ...testConfig(), opencodePort: portForward.localPort };
      const portForwardedSandbox = { ...sandbox, podFQDN: "127.0.0.1" };

      await waitForOpencodeReady(portForwardedSandbox, portForwardedConfig);

      const client = createAgentClient(portForwardedSandbox, portForwardedConfig);
      const sessionID = await createSession(client, "e2e session");
      const chunks: string[] = [];

      for await (const chunk of runPrompt({
        agentName: runtime.opencodeAgentName,
        client,
        sessionID,
        text: "stream a greeting",
      })) {
        chunks.push(chunk);
      }

      expect(sessionID).toBe("session-e2e");
      expect(chunks).toEqual(["Hello", " from runPrompt"]);

      await manager.releaseClaim(claimName);
      await expect(waitForClaimDeleted(customObjectsApi, claimName)).resolves.toBeUndefined();
    } finally {
      await portForward.stop();
    }
  });
});

function testConfig(): Config {
  const disabled = { enabled: false };

  return {
    botUserName: "agentbay",
    claimPollIntervalMs: 50,
    claimReadyTimeoutMs: 120_000,
    claimShutdownHours: 1,
    claimTtlSecondsAfterFinished: 60,
    kubeNamespace: NAMESPACE,
    opencodeDirectory: "/workspace",
    opencodePort: 4096,
    port: 3000,
    discord: disabled,
    gchat: disabled,
    github: disabled,
    linear: disabled,
    messenger: disabled,
    slack: disabled,
    teams: disabled,
    telegram: disabled,
    whatsapp: disabled,
  };
}

async function testRuntime(): Promise<ResolvedRuntime> {
  return new TestRuntimeStore(
    runtimeSnapshot({
      agentClaimEnv: [
        { name: "ANTHROPIC_API_KEY", valueFromEnv: "ANTHROPIC_API_KEY_CODER" },
        { name: "EXTRA_ENV", valueFromEnv: "EXTRA_ENV_AGENT" },
      ],
      agentProfileID: "agent/profile/default:invalid-and-far-too-long-for-a-kubernetes-label-value",
      botID: "bot/default:invalid-and-far-too-long-for-a-kubernetes-label-value",
      botSlug: "agentbay",
      opencodeAgentName: "coder",
      opencodeConfigID: "opencode-config-default",
      opencodeConfigSlug: "default",
      opencodeConfig: {
        permission: { "*": "allow" },
        agent: {
          coder: {
            prompt: "sandbox test prompt",
            model: "anthropic/claude-sonnet-4-5",
            tools: { bash: false },
          },
        },
        default_agent: "coder",
      },
      sandboxProfileID: "sandbox/profile/default:invalid-and-far-too-long-for-a-kubernetes-label-value",
    }),
  ).resolveByBotSlug("agentbay");
}

function labelValue(value: string): string {
  if (value.length <= 63 && /^(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?$/.test(value)) return value;
  return `h-${createHash("sha256").update(value).digest("hex").slice(0, 61)}`;
}

async function installAgentSandbox(api: KubernetesObjectApi): Promise<void> {
  for (const object of await fetchAgentSandboxObjects()) {
    await applyObject(api, object);
  }
}

async function fetchAgentSandboxObjects(): Promise<ManifestObject[]> {
  const objects: ManifestObject[] = [];

  for (const url of AGENT_SANDBOX_MANIFEST_URLS) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);

    objects.push(
      ...loadAllYaml(nonEmptyYamlDocuments(await response.text())).filter(
        (object): object is ManifestObject =>
          Boolean(object?.apiVersion && object?.kind && object?.metadata?.name),
      ),
    );
  }

  return objects;
}

async function applyObject(api: KubernetesObjectApi, object: ManifestObject): Promise<void> {
  await api.patch(object, undefined, undefined, "agentbay-e2e", true, PatchStrategy.ServerSideApply);
}

function nonEmptyYamlDocuments(yaml: string): string {
  return yaml
    .split(/^---\s*$/m)
    .map((document) => document.trim())
    .filter(Boolean)
    .join("\n---\n");
}

async function waitForCrdEstablished(api: ApiextensionsV1Api, name: string): Promise<void> {
  const deadline = Date.now() + 30_000;

  while (Date.now() <= deadline) {
    const crd = await api.readCustomResourceDefinition({ name });
    if (crd.status?.conditions?.some((condition) => condition.type === "Established" && condition.status === "True")) return;
    await sleep(100);
  }

  throw new Error(`Timed out waiting for CRD ${name} to become Established`);
}

async function waitForDeploymentReady(api: AppsV1Api, name: string, namespace: string): Promise<void> {
  const deadline = Date.now() + 120_000;

  while (Date.now() <= deadline) {
    const deployment = await api.readNamespacedDeployment({ name, namespace });
    if (deployment.status?.readyReplicas === deployment.spec?.replicas) return;
    await sleep(1_000);
  }

  throw new Error(`Timed out waiting for Deployment ${namespace}/${name} to become Ready`);
}

async function waitForClaim(api: CustomObjectsApi, claimName: string): Promise<SandboxClaim> {
  const deadline = Date.now() + 10_000;

  while (Date.now() <= deadline) {
    try {
      return (await api.getNamespacedCustomObject({
        group: GROUP,
        version: VERSION,
        namespace: NAMESPACE,
        plural: PLURAL,
        name: claimName,
      })) as SandboxClaim;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }

    await sleep(50);
  }

  throw new Error(`Timed out waiting for SandboxClaim ${claimName} to be created`);
}

async function waitForClaimDeleted(api: CustomObjectsApi, claimName: string): Promise<void> {
  const deadline = Date.now() + 10_000;

  while (Date.now() <= deadline) {
    try {
      await api.getNamespacedCustomObject({
        group: GROUP,
        version: VERSION,
        namespace: NAMESPACE,
        plural: PLURAL,
        name: claimName,
      });
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }

    await sleep(50);
  }

  throw new Error(`Timed out waiting for SandboxClaim ${claimName} to be deleted`);
}

async function waitForSandboxPod(api: CoreV1Api, claimName: string): Promise<string> {
  const deadline = Date.now() + 60_000;

  while (Date.now() <= deadline) {
    const pods = await api.listNamespacedPod({
      namespace: NAMESPACE,
      labelSelector: `agentbay.dev/claim=${claimName}`,
    });
    const podName = pods.items.find((pod) => pod.status?.phase === "Running")?.metadata?.name;
    if (podName) return podName;

    await sleep(500);
  }

  throw new Error(`Timed out waiting for SandboxClaim ${claimName} Pod to run`);
}

async function startPortForward(
  kubeConfig: string,
  podName: string,
): Promise<{ localPort: number; stop: () => Promise<void> }> {
  const localPort = await getFreePort();
  const directory = await mkdtemp(join(tmpdir(), "agentbay-e2e-"));
  const kubeConfigPath = join(directory, "kubeconfig.yaml");
  await writeFile(kubeConfigPath, kubeConfig);

  const child = spawn("kubectl", [
    "--kubeconfig",
    kubeConfigPath,
    "port-forward",
    "-n",
    NAMESPACE,
    `pod/${podName}`,
    `${localPort}:4096`,
  ]);

  try {
    await waitForPortForward(child);
  } catch (error) {
    child.kill();
    await rm(directory, { force: true, recursive: true });
    throw error;
  }

  return {
    localPort,
    stop: async () => {
      child.kill();
      await rm(directory, { force: true, recursive: true });
    },
  };
}

function waitForPortForward(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for kubectl port-forward")), 30_000);

    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`kubectl port-forward exited before becoming ready with code ${code ?? "unknown"}`));
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("Forwarding from")) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("Failed to allocate a local port"));
      });
    });
  });
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const maybe = error as { code?: number; response?: { statusCode?: number; status?: number } };
  return maybe.code === 404 || maybe.response?.statusCode === 404 || maybe.response?.status === 404;
}

function sandboxTemplate(): ManifestObject {
  return {
    apiVersion: "extensions.agents.x-k8s.io/v1alpha1",
    kind: "SandboxTemplate",
    metadata: {
      name: "opencode-template",
      namespace: NAMESPACE,
    },
    spec: {
      envVarsInjectionPolicy: "Allowed",
      networkPolicyManagement: "Unmanaged",
      service: true,
      podTemplate: {
        spec: {
          automountServiceAccountToken: false,
          restartPolicy: "Never",
          containers: [
            {
              name: "opencode",
              image: "node:25-alpine",
              imagePullPolicy: "IfNotPresent",
              command: ["node", "-e", fakeOpencodeServer()],
              ports: [{ containerPort: 4096, name: "http" }],
              readinessProbe: {
                httpGet: { path: "/global/health", port: 4096 },
                periodSeconds: 1,
              },
            },
          ],
        },
      },
    },
  };
}

function fakeOpencodeServer(): string {
  return `
const http = require("http");
const token = Buffer.from((process.env.OPENCODE_SERVER_USERNAME || "opencode") + ":" + process.env.OPENCODE_SERVER_PASSWORD).toString("base64");
const clients = new Set();

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function event(type, properties) {
  return { type, properties };
}

function sendEvent(payload) {
  for (const response of clients) {
    response.write("data: " + JSON.stringify(payload) + "\\n\\n");
  }
}

const server = http.createServer((request, response) => {
  if (request.url === "/global/health") {
    response.end("ok");
    return;
  }

  if (request.headers.authorization !== "Basic " + token) {
    response.writeHead(401);
    response.end("unauthorized");
    return;
  }

  if (request.method === "GET" && request.url?.startsWith("/event")) {
    response.writeHead(200, {
      "cache-control": "no-cache",
      "connection": "keep-alive",
      "content-type": "text/event-stream",
    });
    response.write("\\n");
    clients.add(response);
    request.on("close", () => clients.delete(response));
    return;
  }

  if (request.method === "GET" && request.url?.startsWith("/session/status")) {
    json(response, 200, { "session-e2e": { type: "idle" } });
    return;
  }

  if (request.method === "POST" && request.url?.startsWith("/session")) {
    if (request.url.includes("/prompt_async")) {
      request.resume();
      response.writeHead(204);
      response.end();
      setTimeout(() => {
        sendEvent(event("message.part.updated", {
          part: { id: "part-1", sessionID: "session-e2e", messageID: "message-1", type: "text", text: "Hello" },
          delta: "Hello",
        }));
        sendEvent(event("message.part.delta", {
          sessionID: "session-e2e",
          messageID: "message-1",
          partID: "part-1",
          field: "text",
          delta: " from runPrompt",
        }));
        sendEvent(event("session.idle", { sessionID: "session-e2e" }));
      }, 50);
      return;
    }

    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ id: "session-e2e" }));
    return;
  }

  response.writeHead(404);
  response.end("not found");
});
server.listen(4096, "0.0.0.0");
`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
