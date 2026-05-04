import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { StreamChunk } from "../src/opencode/prompt.ts";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CLUSTER_NAME = process.env.CLUSTER_NAME ?? "agentbay-dev";
const KUBECTL_CONTEXT = process.env.KUBECTL_CONTEXT ?? `kind-${CLUSTER_NAME}`;
const NAMESPACE = process.env.NAMESPACE ?? "agent-sandbox";
const SANDBOX_TEMPLATE_NAME = process.env.SANDBOX_TEMPLATE_NAME ?? "opencode";
const SANDBOX_PORT = Number.parseInt(process.env.SANDBOX_PORT ?? "8888", 10);
const AGENTBAY_RELEASE = process.env.AGENTBAY_RELEASE ?? "agentbay";
const AGENTBAY_SERVICE_NAME = process.env.AGENTBAY_SERVICE_NAME ?? AGENTBAY_RELEASE;
const SANDBOX_ROUTER_SERVICE_NAME = process.env.SANDBOX_ROUTER_SERVICE_NAME ?? "sandbox-router";
const REDIS_SERVICE_NAME = process.env.REDIS_SERVICE_NAME ?? "redis";
const AGENTBAY_IMAGE = process.env.AGENTBAY_IMAGE ?? "agentbay:dev";
const AGENTBAY_IMAGE_REPOSITORY =
  process.env.AGENTBAY_IMAGE_REPOSITORY ?? AGENTBAY_IMAGE.split(":")[0] ?? "agentbay";
const AGENTBAY_IMAGE_TAG = process.env.AGENTBAY_IMAGE_TAG ?? AGENTBAY_IMAGE.split(":")[1] ?? "dev";
const STATE_BACKEND_URL_IN_CLUSTER =
  process.env.STATE_BACKEND_URL_IN_CLUSTER ??
  `redis://${REDIS_SERVICE_NAME}.${NAMESPACE}.svc.cluster.local:6379`;
const BUILD_AGENTBAY_IMAGE = process.env.BUILD_AGENTBAY_IMAGE !== "false";
const LOAD_AGENTBAY_IMAGE = process.env.LOAD_AGENTBAY_IMAGE !== "false";
const SKIP_CLUSTER_BOOTSTRAP = process.env.SKIP_CLUSTER_BOOTSTRAP === "true";
const SKIP_PROMPT = process.env.SKIP_PROMPT === "true";
const FIRST_PROMPT = process.env.E2E_FIRST_PROMPT ?? "Reply with exactly: AGENTBAY_E2E_OK";
const SECOND_PROMPT = process.env.E2E_SECOND_PROMPT ?? "Reply with exactly: AGENTBAY_E2E_FOLLOW_UP";
const EXPECTED_SUBSTRING = process.env.E2E_EXPECTED_SUBSTRING;
const HELM_TIMEOUT = process.env.HELM_TIMEOUT ?? "180s";

const childProcesses = new Set<ChildProcess>();

async function main() {
  if (!SKIP_CLUSTER_BOOTSTRAP) {
    log("Bootstrapping kind cluster and SandboxTemplate");
    await run("bash", [resolve(ROOT_DIR, "scripts/dev-cluster.sh")], {
      env: {
        ...process.env,
        CLUSTER_NAME,
        KUBECTL_CONTEXT,
        NAMESPACE,
        SANDBOX_TEMPLATE_NAME,
      },
    });
  }

  log("Deploying Redis for thread/session state");
  await kubectl(["apply", "-f", resolve(ROOT_DIR, "deploy/dev/redis.yaml")]);
  await kubectl([
    "rollout",
    "status",
    `deployment/${REDIS_SERVICE_NAME}`,
    `--timeout=${HELM_TIMEOUT}`,
  ]);

  if (BUILD_AGENTBAY_IMAGE) {
    log(`Building Agentbay image ${AGENTBAY_IMAGE}`);
    await run("docker", ["build", "-t", AGENTBAY_IMAGE, ROOT_DIR]);
  }

  if (LOAD_AGENTBAY_IMAGE) {
    log(`Loading ${AGENTBAY_IMAGE} into kind cluster ${CLUSTER_NAME}`);
    await run("kind", ["load", "docker-image", AGENTBAY_IMAGE, "--name", CLUSTER_NAME]);
  }

  log("Deploying Agentbay via Helm");
  await run("helm", [
    "upgrade",
    "--install",
    AGENTBAY_RELEASE,
    resolve(ROOT_DIR, "deploy/helm/agentbay"),
    "--namespace",
    NAMESPACE,
    "--create-namespace",
    "--wait",
    `--timeout=${HELM_TIMEOUT}`,
    "--set",
    `image.repository=${AGENTBAY_IMAGE_REPOSITORY}`,
    "--set",
    `image.tag=${AGENTBAY_IMAGE_TAG}`,
    "--set",
    `config.namespace=${NAMESPACE}`,
    "--set",
    `config.sandboxTemplateName=${SANDBOX_TEMPLATE_NAME}`,
    "--set",
    `config.sandboxPort=${SANDBOX_PORT}`,
    "--set",
    `config.stateBackendUrl=${STATE_BACKEND_URL_IN_CLUSTER}`,
  ]);

  const agentbayPortForward = await startPortForward({
    resource: `service/${AGENTBAY_SERVICE_NAME}`,
    remotePort: 3000,
  });
  const routerPortForward = await startPortForward({
    resource: `service/${SANDBOX_ROUTER_SERVICE_NAME}`,
    remotePort: 8080,
  });
  const redisPortForward = await startPortForward({
    resource: `service/${REDIS_SERVICE_NAME}`,
    remotePort: 6379,
  });

  try {
    await verifyHealthz(`http://127.0.0.1:${agentbayPortForward.localPort}/healthz`);

    process.env.PORT = "3000";
    process.env.NAMESPACE = NAMESPACE;
    process.env.KUBERNETES_CLUSTER_DOMAIN ??= "cluster.local";
    process.env.SANDBOX_TEMPLATE_NAME = SANDBOX_TEMPLATE_NAME;
    process.env.SANDBOX_ACCESS_MODE = "direct";
    process.env.SANDBOX_ROUTER_URL = `http://127.0.0.1:${routerPortForward.localPort}`;
    process.env.SANDBOX_PORT = String(SANDBOX_PORT);
    process.env.SANDBOX_IDLE_TTL_MINUTES ??= "30";
    process.env.SANDBOX_READY_TIMEOUT_SECONDS ??= "60";
    process.env.STATE_BACKEND_URL = `redis://127.0.0.1:${redisPortForward.localPort}`;

    const [
      handlersModule,
      claimModule,
      clientModule,
      sessionModule,
      threadStateModule,
      k8sClientModule,
    ] = await Promise.all([
      import("../src/chat/handlers.ts"),
      import("../src/k8s/claim.ts"),
      import("../src/opencode/client.ts"),
      import("../src/opencode/session.ts"),
      import("../src/state/thread.ts"),
      import("../src/k8s/client.ts"),
    ]);

    const { onNewMention, onSubscribedMessage } = handlersModule;
    const { ensureClaim, getClaimName, getClaimPassword } = claimModule;
    const { createOpenCodeClient, resolveOpenCodeConnection } = clientModule;
    const { getOrCreateSession } = sessionModule;
    const { RedisThreadStateStore } = threadStateModule;
    const { getSandboxClaim } = k8sClientModule;

    const routerUrl = new URL(process.env.SANDBOX_ROUTER_URL);
    const stateStore = new RedisThreadStateStore({
      url: process.env.STATE_BACKEND_URL,
      namespace: NAMESPACE,
    });
    const threadId = `smoke:${new Date().toISOString()}:${Math.random().toString(36).slice(2, 10)}`;
    const thread = createSmokeThread(threadId, "Agentbay kind smoke");
    const firstEnsureNow = new Date("2026-01-01T00:00:00.000Z");
    const secondEnsureNow = new Date("2026-01-01T00:05:00.000Z");

    if (SKIP_PROMPT) {
      log("SKIP_PROMPT=true; validating claim/session lifecycle without prompt streaming");
      await ensureClaim(threadId, { now: firstEnsureNow });
    } else {
      log("Running first-message handler flow");
      await onNewMention(
        thread,
        { text: FIRST_PROMPT },
        {
          ensureClaim: (nextThreadId) => ensureClaim(nextThreadId, { now: firstEnsureNow }),
          createOpenCodeClient: (options) =>
            createOpenCodeClient({
              ...options,
              accessMode: "router",
              routerUrl,
            }),
          getOrCreateSession: (nextThreadId, client, options) =>
            getOrCreateSession(nextThreadId, client, {
              ...options,
              stateStore,
            }),
        },
      );

      assert.equal(thread.subscribeCount, 1, "expected first mention to subscribe the thread");
      assert.ok(
        thread.messages[0]?.trim().length,
        "expected first streamed response to be non-empty",
      );
      if (EXPECTED_SUBSTRING !== undefined) {
        assert.ok(
          thread.messages[0].includes(EXPECTED_SUBSTRING),
          `expected first streamed response to include ${EXPECTED_SUBSTRING}`,
        );
      }
    }

    const claimName = getClaimName(threadId);
    const password = getClaimPassword(threadId);
    const claimAfterFirst = await getSandboxClaim(claimName);
    const firstShutdownTime = claimAfterFirst.spec?.lifecycle?.shutdownTime;
    assert.ok(firstShutdownTime, "expected claim shutdownTime after first ensure");

    const directConnection = await resolveOpenCodeConnection({
      claimName,
      password,
      accessMode: "direct",
    });
    assert.ok(directConnection.serviceFQDN, "expected direct connection to expose serviceFQDN");
    assert.ok(
      directConnection.serviceFQDN.includes(".svc."),
      `expected serviceFQDN to look like cluster DNS, received ${directConnection.serviceFQDN}`,
    );

    const routerClient = await createOpenCodeClient({
      claimName,
      password,
      accessMode: "router",
      routerUrl,
    });
    const firstSessionId = await getOrCreateSession(threadId, routerClient, {
      title: "Agentbay kind smoke",
      stateStore,
    });
    const storedSessionId = await stateStore.getOpenCodeSessionId(threadId);
    assert.equal(storedSessionId, firstSessionId, "expected session id to persist in Redis");

    const sessionLookup = await routerClient.session.get({ sessionID: firstSessionId });
    assert.equal(sessionLookup.response?.ok, true, "expected OpenCode session lookup to succeed");

    log("Running follow-up handler flow to verify reuse + TTL refresh");
    if (SKIP_PROMPT) {
      await ensureClaim(threadId, { now: secondEnsureNow });
    } else {
      await onSubscribedMessage(
        thread,
        { text: SECOND_PROMPT },
        {
          ensureClaim: (nextThreadId) => ensureClaim(nextThreadId, { now: secondEnsureNow }),
          createOpenCodeClient: (options) =>
            createOpenCodeClient({
              ...options,
              accessMode: "router",
              routerUrl,
            }),
          getOrCreateSession: (nextThreadId, client, options) =>
            getOrCreateSession(nextThreadId, client, {
              ...options,
              stateStore,
            }),
        },
      );

      assert.equal(thread.subscribeCount, 1, "expected follow-up messages to skip subscribe()");
      assert.ok(
        thread.messages[1]?.trim().length,
        "expected follow-up streamed response to be non-empty",
      );
    }

    const secondSessionId = await stateStore.getOpenCodeSessionId(threadId);
    assert.equal(
      secondSessionId,
      firstSessionId,
      "expected follow-up to reuse the existing session",
    );

    const claimAfterSecond = await getSandboxClaim(claimName);
    const secondShutdownTime = claimAfterSecond.spec?.lifecycle?.shutdownTime;
    assert.ok(secondShutdownTime, "expected claim shutdownTime after second ensure");
    assert.ok(
      new Date(secondShutdownTime).getTime() > new Date(firstShutdownTime).getTime(),
      `expected shutdownTime to increase (${firstShutdownTime} -> ${secondShutdownTime})`,
    );

    console.log(
      JSON.stringify(
        {
          kindContext: KUBECTL_CONTEXT,
          namespace: NAMESPACE,
          agentbayUrl: `http://127.0.0.1:${agentbayPortForward.localPort}`,
          sandboxRouterUrl: routerUrl.toString(),
          threadId,
          claimName,
          sessionId: firstSessionId,
          directConnection,
          shutdownTime: {
            first: firstShutdownTime,
            second: secondShutdownTime,
          },
          streamedMessages: thread.messages,
        },
        null,
        2,
      ),
    );

    log("Kind smoke test passed");
  } finally {
    await Promise.all([
      agentbayPortForward.stop(),
      routerPortForward.stop(),
      redisPortForward.stop(),
    ]);
  }
}

function createSmokeThread(id: string, title: string) {
  return {
    id,
    title,
    messages: [] as string[],
    subscribeCount: 0,
    async post(stream: AsyncIterable<string | StreamChunk>) {
      let message = "";
      for await (const chunk of stream) {
        if (typeof chunk === "string") {
          message += chunk;
        }
      }
      this.messages.push(message);
    },
    async subscribe() {
      this.subscribeCount += 1;
    },
  };
}

async function verifyHealthz(url: string) {
  log(`Verifying Agentbay health at ${url}`);
  const response = await fetch(url);
  assert.equal(response.status, 200, `expected ${url} to return 200`);
  assert.equal(await response.text(), "ok", `expected ${url} to return ok`);
}

async function kubectl(args: string[]) {
  await run("kubectl", ["--context", KUBECTL_CONTEXT, "--namespace", NAMESPACE, ...args]);
}

async function startPortForward(options: { resource: string; remotePort: number }) {
  const localPort = await getFreePort();
  const args = [
    "--context",
    KUBECTL_CONTEXT,
    "--namespace",
    NAMESPACE,
    "port-forward",
    options.resource,
    `${localPort}:${options.remotePort}`,
  ];
  const child = spawn("kubectl", args, {
    cwd: ROOT_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  childProcesses.add(child);

  let ready = false;
  const waitForReady = new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      const output = chunk.toString();
      process.stderr.write(output);
      if (!ready && output.includes("Forwarding from")) {
        ready = true;
        resolve();
      }
    };

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", (code, signal) => {
      if (!ready) {
        reject(
          new Error(
            `kubectl port-forward ${options.resource} exited before becoming ready (code=${code}, signal=${signal})`,
          ),
        );
      }
    });
    child.once("error", reject);
  });

  await waitForReady;

  return {
    localPort,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) {
        childProcesses.delete(child);
        return;
      }

      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), wait(2_000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
      childProcesses.delete(child);
    },
  };
}

async function getFreePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("failed to allocate a local TCP port");
  }

  const { port } = address;
  server.close();
  await once(server, "close");
  return port;
}

async function run(command: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}) {
  log(`$ ${command} ${args.join(" ")}`);
  const child = spawn(command, args, {
    cwd: ROOT_DIR,
    stdio: "inherit",
    env: options.env ?? process.env,
  });
  childProcesses.add(child);

  const [code, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
  childProcesses.delete(child);

  if (code === 0) {
    return;
  }

  throw new Error(`${command} ${args.join(" ")} failed (code=${code}, signal=${signal})`);
}

function log(message: string) {
  console.log(`[kind-e2e] ${message}`);
}

function wait(timeoutMs: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, timeoutMs);
  });
}

async function shutdown() {
  await Promise.all(
    [...childProcesses].map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        childProcesses.delete(child);
        return;
      }

      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), wait(2_000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
      childProcesses.delete(child);
    }),
  );
}

process.on("SIGINT", () => {
  void shutdown().finally(() => process.exit(130));
});
process.on("SIGTERM", () => {
  void shutdown().finally(() => process.exit(143));
});

main().catch((error: unknown) => {
  console.error("kind smoke test failed", error);
  void shutdown().finally(() => process.exit(1));
});
