import type { Adapter, Chat, Lock, Message, StateAdapter, Thread } from "chat";
import type { Config } from "../config.js";
import { createAgentClient, waitForOpencodeReady } from "../agent/client.js";
import { logger, toErrCtx } from "../logger.js";
import { createSession, runPrompt } from "../agent/runner.js";
import { resolveInitialRuntime, resolveThreadRuntime } from "../runtime/resolver.js";
import { agentProfileHash, sandboxProfileHash, type RuntimeStore } from "../runtime/store.js";
import type { ResolvedRuntime } from "../runtime/types.js";
import type { SandboxManager } from "../sandbox/manager.js";
import type { ThreadState } from "../types.js";

export type HandlerDeps = {
  config: Config;
  runtimeStore: RuntimeStore;
  sandboxManager: SandboxManager;
  state: StateAdapter;
};

const PROMPT_LOCK_TTL_MS = 60_000;
const PROMPT_LOCK_POLL_MS = 1_000;

export function registerHandlers(chat: Chat<Record<string, Adapter>, ThreadState>, deps: HandlerDeps): void {
  chat.onNewMention(async (thread, message) => {
    await thread.subscribe();
    await enqueuePrompt(thread, message, deps);
  });

  chat.onDirectMessage(async (thread, message) => {
    await thread.subscribe();
    await enqueuePrompt(thread, message, deps);
  });

  chat.onSubscribedMessage(async (thread, message) => {
    await enqueuePrompt(thread, message, deps);
  });
}

async function enqueuePrompt(thread: Thread<ThreadState>, message: Message, deps: HandlerDeps): Promise<void> {
  await withPromptLock(deps.state, thread.id, () => handlePrompt(thread, message, deps));
}

async function withPromptLock(state: StateAdapter, threadId: string, run: () => Promise<void>): Promise<void> {
  const lockKey = `agentbay:prompt:${threadId}`;
  const lock = await waitForPromptLock(state, lockKey);
  const heartbeat = setInterval(() => {
    void state.extendLock(lock, PROMPT_LOCK_TTL_MS);
  }, PROMPT_LOCK_TTL_MS / 3);

  try {
    await run();
  } finally {
    clearInterval(heartbeat);
    await state.releaseLock(lock);
  }
}

async function waitForPromptLock(state: StateAdapter, lockKey: string): Promise<Lock> {
  while (true) {
    const lock = await state.acquireLock(lockKey, PROMPT_LOCK_TTL_MS);
    if (lock) return lock;
    await sleep(PROMPT_LOCK_POLL_MS);
  }
}

async function handlePrompt(thread: Thread<ThreadState>, message: Message, deps: HandlerDeps): Promise<void> {
  const log = logger.child({ threadId: thread.id, messageId: message.id });
  log.info("prompt received");

  try {
    await thread.startTyping("Preparing sandbox");

    const state = await thread.state;
    if (isThreadState(state)) {
      const runtime = await resolveThreadRuntime(deps.runtimeStore, state);
      if (isStateExpired(state, deps.config)) {
        log.info("sandbox lifetime reached; restarting", { claimName: state.claimName });
        await restartSession(thread, message, deps, state, runtime, "Previous sandbox reached its configured lifetime; starting a fresh one...");
        return;
      }

      const sandbox = await deps.sandboxManager.currentReadyClaim(state.claimName, state.password);
      if (!sandbox) {
        log.info("sandbox claim no longer available; restarting", { claimName: state.claimName });
        await restartSession(thread, message, deps, state, runtime, "Previous sandbox is no longer available; starting a fresh one...");
        return;
      }

      log.info("continuing existing session", { claimName: state.claimName, sessionId: state.sessionID });
      await continueSession(thread, message, deps, { ...state, podFQDN: sandbox.podFQDN });
      return;
    }

    log.info("no existing state; starting new session");
    await startSession(thread, message, deps);
  } catch (error) {
    log.error("prompt handler failed", { err: toErrCtx(error) });
    await thread.post(`agentbay error: ${formatError(error)}`);
  }
}

async function startSession(thread: Thread<ThreadState>, message: Message, deps: HandlerDeps): Promise<void> {
  const runtime = await resolveInitialRuntime(deps.runtimeStore);
  await startSessionWithRuntime(thread, message, deps, runtime);
}

async function startSessionWithRuntime(
  thread: Thread<ThreadState>,
  message: Message,
  deps: HandlerDeps,
  runtime: ResolvedRuntime,
): Promise<void> {
  await thread.post("Spinning up an isolated opencode sandbox...");

  let claimName: string | undefined;
  let statePersisted = false;
  const sandbox = await deps.sandboxManager.claimFor(thread.id, runtime);
  claimName = sandbox.claimName;

  try {
    const client = createAgentClient(sandbox, deps.config);
    await waitForOpencodeReady(sandbox, deps.config);

    const sessionID = await createSession(client, sessionTitle(thread, message, runtime));
    await thread.setState(
      {
        agentProfileID: runtime.agentProfile.id,
        agentProfileHash: agentProfileHash(runtime.agentProfile),
        botID: runtime.bot.id,
        claimName: sandbox.claimName,
        createdAt: new Date().toISOString(),
        opencodeAgentName: runtime.opencodeAgentName,
        opencodeConfigHash: runtime.opencodeConfig.configHash,
        opencodeConfigID: runtime.opencodeConfig.id,
        password: sandbox.password,
        podFQDN: sandbox.podFQDN,
        sandboxProfileHash: sandboxProfileHash(runtime.sandboxProfile),
        sandboxProfileID: runtime.sandboxProfile.id,
        sessionID,
      },
      { replace: true },
    );
    statePersisted = true;

    await thread.post(
      runPrompt({
        agentName: runtime.opencodeAgentName,
        client,
        sessionID,
        text: message.text,
      }),
    );
  } catch (error) {
    if (claimName && !statePersisted) {
      try {
        await deps.sandboxManager.releaseClaim(claimName);
      } catch (cleanupError) {
        throw new Error(`Failed to start sandbox (${formatError(error)}); cleanup failed (${formatError(cleanupError)})`);
      }
    }

    throw error;
  }
}

async function continueSession(
  thread: Thread<ThreadState>,
  message: Message,
  deps: HandlerDeps,
  state: ThreadState,
): Promise<void> {
  const log = logger.child({ threadId: thread.id, claimName: state.claimName, sessionId: state.sessionID });
  const runtime = await resolveThreadRuntime(deps.runtimeStore, state);
  if (hasRuntimeDrift(state, runtime)) {
    log.info("runtime drift detected; restarting sandbox");
    await restartSession(
      thread,
      message,
      deps,
      state,
      runtime,
      "Agent runtime changed; starting a fresh sandbox with the updated runtime...",
    );
    return;
  }

  const endpoint = { password: state.password, podFQDN: state.podFQDN };
  const client = createAgentClient(endpoint, deps.config);

  try {
    await waitForOpencodeReady(endpoint, deps.config);
  } catch {
    log.warn("opencode server unreachable; restarting sandbox");
    await restartSession(
      thread,
      message,
      deps,
      state,
      runtime,
      "Previous opencode server is no longer reachable; starting a fresh sandbox...",
    );
    return;
  }

  await thread.post(
    runPrompt({
      agentName: runtime.opencodeAgentName,
      client,
      sessionID: state.sessionID,
      text: message.text,
    }),
  );
}

async function restartSession(
  thread: Thread<ThreadState>,
  message: Message,
  deps: HandlerDeps,
  state: ThreadState,
  runtime: ResolvedRuntime,
  notice: string,
): Promise<void> {
  await deps.sandboxManager.releaseClaim(state.claimName);
  await thread.post(notice);
  await startSessionWithRuntime(thread, message, deps, runtime);
}

function sessionTitle(thread: Thread<ThreadState>, message: Message, runtime: ResolvedRuntime): string {
  const text = message.text.replace(/\s+/g, " ").trim().slice(0, 80);
  return `${runtime.bot.slug}/${runtime.agentProfile.slug} ${thread.id}${text ? `: ${text}` : ""}`;
}

function hasRuntimeDrift(state: ThreadState, runtime: ResolvedRuntime): boolean {
  return (
    state.botID !== runtime.bot.id ||
    state.sandboxProfileID !== runtime.sandboxProfile.id ||
    state.sandboxProfileHash !== sandboxProfileHash(runtime.sandboxProfile) ||
    state.agentProfileID !== runtime.agentProfile.id ||
    state.agentProfileHash !== agentProfileHash(runtime.agentProfile) ||
    state.opencodeConfigID !== runtime.opencodeConfig.id ||
    state.opencodeConfigHash !== runtime.opencodeConfig.configHash ||
    state.opencodeAgentName !== runtime.opencodeAgentName
  );
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isStateExpired(state: ThreadState, config: Config): boolean {
  const createdAt = Date.parse(state.createdAt);
  if (!Number.isFinite(createdAt)) return true;

  const maxAgeMs = config.claimShutdownHours * 60 * 60 * 1_000;
  return Date.now() - createdAt >= maxAgeMs;
}

function isThreadState(value: unknown): value is ThreadState {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;

  return (
    typeof state.claimName === "string" &&
    typeof state.botID === "string" &&
    typeof state.sandboxProfileID === "string" &&
    typeof state.sandboxProfileHash === "string" &&
    typeof state.agentProfileID === "string" &&
    typeof state.opencodeConfigID === "string" &&
    typeof state.opencodeConfigHash === "string" &&
    typeof state.opencodeAgentName === "string" &&
    typeof state.createdAt === "string" &&
    typeof state.password === "string" &&
    typeof state.podFQDN === "string" &&
    typeof state.sessionID === "string"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
