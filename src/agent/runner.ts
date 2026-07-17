import { Buffer } from "node:buffer";
import type { Event, OpencodeClient } from "@opencode-ai/sdk/client";
import { createAgentClient, type OpenCodeEndpoint, waitForOpencodeReady } from "./client.js";
import { logger } from "../logger.js";

export const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;

export type ExecutionAttemptInput = {
  agent: string;
  endpoint: OpenCodeEndpoint;
  maxOutputBytes?: number;
  prompt: string;
  signal?: AbortSignal;
  title: string;
  onSession?: (sessionId: string) => Promise<void>;
};

export type ExecutionAttemptResult = {
  output: string;
  sessionId: string;
};

export async function runExecutionAttempt(
  input: ExecutionAttemptInput,
  client?: OpencodeClient,
): Promise<ExecutionAttemptResult> {
  const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 0) {
    throw new Error("maxOutputBytes must be a nonnegative safe integer");
  }

  input.signal?.throwIfAborted();
  if (!client) {
    await waitForOpencodeReady(input.endpoint, input.endpoint, input.signal);
    client = createAgentClient(input.endpoint, input.endpoint);
  }

  const { data: session } = await client.session.create({
    body: { title: input.title },
    signal: input.signal,
    throwOnError: true,
  });
  const sessionId = session.id;
  const log = logger.child({ sessionId, agentName: input.agent });
  logger.info("opencode session created", { sessionId, title: input.title });
  await input.onSession?.(sessionId);

  let abortPromise: Promise<never> | undefined;
  let removeAbortListener: (() => void) | undefined;

  if (input.signal) {
    abortPromise = new Promise<never>((_resolve, reject) => {
      const abort = () => {
        void client.session.abort({ path: { id: sessionId } }).catch((error: unknown) => {
          log.warn("failed to abort opencode session", { error: String(error) });
        });
        reject(input.signal?.reason ?? new DOMException("The operation was aborted", "AbortError"));
      };
      removeAbortListener = () => input.signal?.removeEventListener("abort", abort);
      if (input.signal?.aborted) abort();
      else input.signal?.addEventListener("abort", abort, { once: true });
    });
  }

  let output = "";
  let outputBytes = 0;
  let events: Awaited<ReturnType<OpencodeClient["event"]["subscribe"]>> | undefined;

  try {
    const subscription = client.event.subscribe({ signal: input.signal });
    events = abortPromise ? await Promise.race([subscription, abortPromise]) : await subscription;
    await client.session.promptAsync({
      path: { id: sessionId },
      body: {
        agent: input.agent,
        parts: [{ type: "text", text: input.prompt }],
      },
      signal: input.signal,
      throwOnError: true,
    });
    log.info("prompt submitted");

    const iterator = events.stream[Symbol.asyncIterator]();
    while (true) {
      const next = abortPromise
        ? await Promise.race([iterator.next(), abortPromise])
        : await iterator.next();
      if (next.done) throw new Error(`opencode event stream ended before session ${sessionId} became idle`);

      const event = next.value;
      if (!isSessionEvent(event, sessionId)) continue;

      const delta = textDelta(event, sessionId);
      if (delta && outputBytes < maxOutputBytes) {
        const appended = appendWithinByteLimit(delta, maxOutputBytes - outputBytes);
        output += appended;
        outputBytes += Buffer.byteLength(appended);
      }

      if (event.type === "permission.updated") {
        await client.postSessionIdPermissionsPermissionId({
          path: { id: sessionId, permissionID: event.properties.id },
          body: { response: "reject" },
          throwOnError: true,
        });
        throw new Error(`opencode session ${sessionId} requested permission ${event.properties.id}`);
      }

      if (event.type === "session.error") {
        const message = formatOpencodeError(event.properties.error);
        throw new Error(`opencode session ${sessionId} error: ${message}`);
      }

      if (event.type === "session.idle") {
        log.info("opencode session completed");
        return { output, sessionId };
      }
    }
  } finally {
    removeAbortListener?.();
    if (events) void events.stream.return(undefined).catch(() => undefined);
  }
}

export async function createSession(client: OpencodeClient, title: string): Promise<string> {
  const { data } = await client.session.create({ body: { title }, throwOnError: true });
  return data.id;
}

export async function* runPrompt(input: {
  agentName: string;
  client: OpencodeClient;
  sessionID: string;
  text: string;
}): AsyncIterable<string> {
  const events = await input.client.event.subscribe({});
  await input.client.session.promptAsync({
    path: { id: input.sessionID },
    body: { agent: input.agentName, parts: [{ type: "text", text: input.text }] },
    throwOnError: true,
  });

  for await (const event of events.stream) {
    if (!isSessionEvent(event, input.sessionID)) continue;
    const delta = textDelta(event, input.sessionID);
    if (delta) yield delta;

    if (event.type === "permission.updated") {
      await input.client.postSessionIdPermissionsPermissionId({
        path: { id: input.sessionID, permissionID: event.properties.id },
        body: { response: "reject" },
        throwOnError: true,
      });
      throw new Error(`opencode session ${input.sessionID} requested permission ${event.properties.id}`);
    }
    if (event.type === "session.error") {
      throw new Error(`opencode session ${input.sessionID} error: ${formatOpencodeError(event.properties.error)}`);
    }
    if (event.type === "session.idle") return;
  }

  throw new Error(`opencode event stream ended before session ${input.sessionID} became idle`);
}

function appendWithinByteLimit(value: string, remainingBytes: number): string {
  if (Buffer.byteLength(value) <= remainingBytes) return value;

  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > remainingBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function textDelta(event: Event, sessionId: string): string | undefined {
  const maybe = event as {
    type: string;
    properties: {
      delta?: string;
      field?: string;
      sessionID?: string;
      part?: { sessionID?: string; type?: string };
    };
  };

  if (maybe.type === "message.part.delta") {
    return maybe.properties.sessionID === sessionId && maybe.properties.field === "text"
      ? maybe.properties.delta
      : undefined;
  }

  if (maybe.type === "message.part.updated") {
    return maybe.properties.part?.sessionID === sessionId && maybe.properties.part.type === "text"
      ? maybe.properties.delta
      : undefined;
  }
}

function isSessionEvent(event: Event, sessionId: string): boolean {
  switch (event.type) {
    case "message.part.updated":
      return event.properties.part.sessionID === sessionId;
    case "session.idle":
    case "session.status":
    case "session.error":
    case "session.compacted":
    case "permission.updated":
      return event.properties.sessionID === sessionId;
    default: {
      const maybe = event as { type: string; properties?: { sessionID?: string } };
      return maybe.type === "message.part.delta" && maybe.properties?.sessionID === sessionId;
    }
  }
}

function formatOpencodeError(error: unknown): string {
  if (!error || typeof error !== "object") return "unknown error";

  const maybe = error as { data?: { message?: unknown }; name?: unknown };
  const name = typeof maybe.name === "string" ? maybe.name : "Error";
  const message = typeof maybe.data?.message === "string" ? maybe.data.message : JSON.stringify(error);
  return `${name}: ${message}`;
}
