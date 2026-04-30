import { randomUUID } from "node:crypto";

const DEFAULT_MAX_RECONNECT_ATTEMPTS = 2;
const DEFAULT_RECONNECT_DELAY_MS = 250;

export interface PromptMessage {
  text: string;
}

export interface OpenCodePromptResult<TData> {
  data?: TData;
  error?: unknown;
  response?: Response;
}

export interface OpenCodePromptClient {
  session: {
    promptAsync(parameters: {
      sessionID: string;
      messageID?: string;
      parts: Array<{
        type: "text";
        text: string;
      }>;
    }): Promise<OpenCodePromptResult<void>>;
  };
  event: {
    subscribe(): Promise<{
      stream: AsyncIterable<OpenCodeEvent>;
    }>;
  };
}

export interface OpenCodeMessageInfo {
  id: string;
  role: "user" | "assistant";
  parentID?: string;
  time?: {
    completed?: number;
  };
  error?: {
    name?: string;
    data?: {
      message?: string;
    };
  };
}

export interface OpenCodeTextPart {
  id: string;
  messageID: string;
  type: "text";
  text?: string;
}

export interface OpenCodeFilePart {
  id: string;
  messageID: string;
  type: "file";
  mime: string;
  filename?: string;
  url: string;
}

export type OpenCodeToolState =
  | {
      status: "pending";
      input: Record<string, unknown>;
      raw: string;
    }
  | {
      status: "running";
      input: Record<string, unknown>;
      title?: string;
      metadata?: Record<string, unknown>;
      time: {
        start: number;
      };
    }
  | {
      status: "completed";
      input: Record<string, unknown>;
      output: string;
      title: string;
      metadata: Record<string, unknown>;
      time: {
        start: number;
        end: number;
        compacted?: number;
      };
      attachments?: OpenCodeFilePart[];
    }
  | {
      status: "error";
      input: Record<string, unknown>;
      error: string;
      metadata?: Record<string, unknown>;
      time: {
        start: number;
        end: number;
      };
    };

export interface OpenCodeToolPart {
  id: string;
  messageID: string;
  type: "tool";
  callID: string;
  tool: string;
  state: OpenCodeToolState;
  metadata?: Record<string, unknown>;
}

export type OpenCodePart =
  | OpenCodeTextPart
  | OpenCodeToolPart
  | {
      id: string;
      messageID: string;
      type: string;
    };

export type OpenCodeEvent =
  | {
      type: "message.updated";
      properties: {
        sessionID: string;
        info: OpenCodeMessageInfo;
      };
    }
  | {
      type: "message.part.updated";
      properties: {
        sessionID: string;
        part: OpenCodePart;
      };
    }
  | {
      type: "message.part.delta";
      properties: {
        sessionID: string;
        messageID: string;
        partID: string;
        field: string;
        delta: string;
      };
    }
  | {
      type: "session.idle";
      properties: {
        sessionID: string;
      };
    }
  | {
      type: "session.error";
      properties: {
        sessionID?: string;
        error?: {
          name?: string;
          data?: {
            message?: string;
          };
        };
      };
    };

export interface StreamChunk {
  type: "task_update";
  id: string;
  tool: string;
  title: string;
  status: OpenCodeToolState["status"];
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
  metadata?: Record<string, unknown>;
  attachments?: Array<{
    url: string;
    filename?: string;
    mime?: string;
  }>;
}

export type PromptStreamChunk = string | StreamChunk;

export interface PromptStreamOptions {
  userMessageIdFactory?: () => string;
  signal?: AbortSignal;
  maxReconnectAttempts?: number;
  reconnectDelayMs?: number;
}

export function promptStream(
  client: OpenCodePromptClient,
  sessionId: string,
  message: PromptMessage,
  options: PromptStreamOptions = {},
): AsyncIterable<PromptStreamChunk> {
  validatePromptMessage(message);
  const userMessageId = (options.userMessageIdFactory ?? randomUUID)();
  const maxReconnectAttempts = options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
  const reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;

  return (async function* () {
    if (options.signal?.aborted) {
      return;
    }

    let promptSent = false;
    let reconnectCount = 0;
    const state: StreamState = {
      assistantMessageId: null,
      emittedLengths: new Map(),
      emittedToolUpdates: new Map(),
    };

    while (true) {
      if (options.signal?.aborted) {
        return;
      }

      const subscription = await client.event.subscribe();
      const iterator = subscription.stream[Symbol.asyncIterator]();
      const initialNext = nextEvent(iterator, options.signal);

      let outcome: "completed" | "disconnected" | "aborted";

      try {
        if (!promptSent) {
          const promptResult = await client.session.promptAsync({
            sessionID: sessionId,
            messageID: userMessageId,
            parts: [
              {
                type: "text",
                text: message.text,
              },
            ],
          });

          if (promptResult.response?.ok !== true) {
            throw new Error(
              formatOpenCodePromptError(
                "Failed to enqueue OpenCode prompt",
                promptResult.response,
                promptResult.error,
              ),
            );
          }

          promptSent = true;
        }

        outcome = yield* streamAssistantResponseFromIterator(iterator, {
          sessionId,
          userMessageId,
          signal: options.signal,
          state,
          initialNext,
        });
      } finally {
        await iterator.return?.();
      }

      if (outcome !== "disconnected") {
        return;
      }

      if (reconnectCount >= maxReconnectAttempts) {
        throw new Error(
          `OpenCode event stream disconnected before session ${sessionId} became idle`,
        );
      }

      reconnectCount += 1;
      await delay(reconnectDelayMs, options.signal);
    }
  })();
}

type StreamState = {
  assistantMessageId: string | null;
  emittedLengths: Map<string, number>;
  emittedToolUpdates: Map<string, string>;
};

type StreamOutcome = "completed" | "disconnected" | "aborted";

type NextEventResult<T> =
  | {
      aborted: true;
      result?: undefined;
    }
  | {
      aborted: false;
      result: IteratorResult<T>;
    };

export async function* streamAssistantResponse(
  stream: AsyncIterable<OpenCodeEvent>,
  target: {
    sessionId: string;
    userMessageId: string;
    signal?: AbortSignal;
    state?: StreamState;
  },
): AsyncGenerator<PromptStreamChunk, StreamOutcome, void> {
  const iterator = stream[Symbol.asyncIterator]();

  try {
    return yield* streamAssistantResponseFromIterator(iterator, target);
  } finally {
    await iterator.return?.();
  }
}

async function* streamAssistantResponseFromIterator(
  iterator: AsyncIterator<OpenCodeEvent>,
  target: {
    sessionId: string;
    userMessageId: string;
    signal?: AbortSignal;
    state?: StreamState;
    initialNext?: Promise<NextEventResult<OpenCodeEvent>>;
  },
): AsyncGenerator<PromptStreamChunk, StreamOutcome, void> {
  const state =
    target.state ??
    ({
      assistantMessageId: null,
      emittedLengths: new Map<string, number>(),
      emittedToolUpdates: new Map<string, string>(),
    } satisfies StreamState);
  let nextResult = target.initialNext;

  while (true) {
    const next = await (nextResult ?? nextEvent(iterator, target.signal));
    nextResult = undefined;

    if (next.aborted) {
      return "aborted";
    }

    if (next.result.done) {
      return "disconnected";
    }

    const event = next.result.value;

    if (event.type === "message.updated") {
      if (event.properties.sessionID !== target.sessionId) {
        continue;
      }

      const info = event.properties.info;
      if (info.role !== "assistant" || info.parentID !== target.userMessageId) {
        continue;
      }

      state.assistantMessageId = info.id;

      if (info.error !== undefined) {
        throw new Error(formatEventError("OpenCode assistant message failed", info.error));
      }

      continue;
    }

    if (event.type === "message.part.delta") {
      if (
        state.assistantMessageId === null ||
        event.properties.sessionID !== target.sessionId ||
        event.properties.messageID !== state.assistantMessageId ||
        event.properties.field !== "text"
      ) {
        continue;
      }

      const previousLength = state.emittedLengths.get(event.properties.partID) ?? 0;
      state.emittedLengths.set(
        event.properties.partID,
        previousLength + event.properties.delta.length,
      );
      yield event.properties.delta;
      continue;
    }

    if (event.type === "message.part.updated") {
      if (state.assistantMessageId === null || event.properties.sessionID !== target.sessionId) {
        continue;
      }

      const part = event.properties.part;

      if (part.messageID !== state.assistantMessageId) {
        continue;
      }

      if (isTextPart(part)) {
        if (part.text === undefined) {
          continue;
        }

        const previousLength = state.emittedLengths.get(part.id) ?? 0;
        if (part.text.length <= previousLength) {
          continue;
        }

        state.emittedLengths.set(part.id, part.text.length);
        yield part.text.slice(previousLength);
        continue;
      }

      if (isToolPart(part)) {
        const update = toStreamChunk(part);
        const snapshot = JSON.stringify(update);
        const previousSnapshot = state.emittedToolUpdates.get(update.id);

        if (previousSnapshot === snapshot) {
          continue;
        }

        state.emittedToolUpdates.set(update.id, snapshot);
        yield update;
      }

      continue;
    }

    if (event.type === "session.error") {
      if (
        event.properties.sessionID === undefined ||
        event.properties.sessionID === target.sessionId
      ) {
        throw new Error(formatEventError("OpenCode session failed", event.properties.error));
      }

      continue;
    }

    if (event.type === "session.idle" && event.properties.sessionID === target.sessionId) {
      return "completed";
    }
  }
}

function isTextPart(part: OpenCodePart): part is OpenCodeTextPart {
  return part.type === "text" && "text" in part;
}

function isToolPart(part: OpenCodePart): part is OpenCodeToolPart {
  return part.type === "tool" && "callID" in part && "tool" in part && "state" in part;
}

function toStreamChunk(part: OpenCodeToolPart): StreamChunk {
  const title =
    ("title" in part.state ? part.state.title : undefined) ??
    part.metadata?.title?.toString() ??
    part.tool;
  const base = {
    type: "task_update" as const,
    id: part.callID,
    tool: part.tool,
    title,
    status: part.state.status,
    input: part.state.input,
    metadata: {
      ...part.metadata,
      ...("metadata" in part.state ? (part.state.metadata ?? {}) : {}),
    },
  };

  if (part.state.status === "completed") {
    return {
      ...base,
      output: part.state.output,
      attachments: part.state.attachments?.map((attachment) => ({
        url: attachment.url,
        filename: attachment.filename,
        mime: attachment.mime,
      })),
    };
  }

  if (part.state.status === "error") {
    return {
      ...base,
      error: part.state.error,
    };
  }

  return base;
}

async function nextEvent<T>(
  iterator: AsyncIterator<T>,
  signal?: AbortSignal,
): Promise<NextEventResult<T>> {
  if (signal === undefined) {
    return {
      aborted: false,
      result: await iterator.next(),
    };
  }

  if (signal.aborted) {
    await iterator.return?.();
    return { aborted: true };
  }

  let abortHandler: (() => void) | undefined;
  const abortPromise = new Promise<"aborted">((resolve) => {
    abortHandler = () => {
      resolve("aborted");
    };
    signal.addEventListener("abort", abortHandler, { once: true });
  });

  try {
    const result = await Promise.race([iterator.next(), abortPromise]);

    if (result === "aborted") {
      await iterator.return?.();
      return { aborted: true };
    }

    return {
      aborted: false,
      result,
    };
  } finally {
    if (abortHandler !== undefined) {
      signal.removeEventListener("abort", abortHandler);
    }
  }
}

async function delay(milliseconds: number, signal?: AbortSignal) {
  if (milliseconds <= 0) {
    return;
  }

  if (signal?.aborted) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (abortHandler !== undefined) {
        signal?.removeEventListener("abort", abortHandler);
      }
      resolve();
    }, milliseconds);

    let abortHandler: (() => void) | undefined;

    if (signal !== undefined) {
      abortHandler = () => {
        clearTimeout(timeout);
        resolve();
      };
      signal.addEventListener("abort", abortHandler, { once: true });
    }
  });
}

function formatOpenCodePromptError(message: string, response?: Response, error?: unknown) {
  const details: string[] = [];

  if (response !== undefined) {
    details.push(`${response.status} ${response.statusText}`.trim());
  }

  if (error instanceof Error) {
    details.push(error.message);
  } else if (typeof error === "string" && error.length > 0) {
    details.push(error);
  } else if (error !== undefined) {
    details.push(JSON.stringify(error));
  }

  return details.length === 0 ? message : `${message}: ${details.join(": ")}`;
}

function formatEventError(
  message: string,
  error?: {
    name?: string;
    data?: {
      message?: string;
    };
  },
) {
  const details = [error?.name, error?.data?.message].filter(
    (value): value is string => value !== undefined && value.length > 0,
  );

  return details.length === 0 ? message : `${message}: ${details.join(": ")}`;
}

function validatePromptMessage(message: PromptMessage) {
  if (message.text.trim().length === 0) {
    throw new Error("message.text must not be empty");
  }
}
