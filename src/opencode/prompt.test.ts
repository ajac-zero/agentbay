import { describe, expect, it, vi } from "vite-plus/test";
import type { OpenCodeEvent, OpenCodePromptClient } from "./prompt.ts";

const modulePromise = import("./prompt.ts");

describe("promptStream", () => {
  it("enqueues a prompt and streams text deltas until the session goes idle", async () => {
    const { promptStream } = await modulePromise;
    const events: OpenCodeEvent[] = [
      assistantMessageUpdated({
        sessionId: "session-1",
        assistantMessageId: "assistant-1",
        parentId: "user-1",
      }),
      textDelta({
        sessionId: "session-1",
        assistantMessageId: "assistant-1",
        partId: "part-1",
        delta: "Hello",
      }),
      textDelta({
        sessionId: "session-1",
        assistantMessageId: "assistant-1",
        partId: "part-1",
        delta: " world",
      }),
      sessionIdle("session-1"),
    ];
    const { client, promptAsyncMock } = createPromptClient(events);

    const chunks = await collect(
      promptStream(client, "session-1", { text: "Hi" }, { userMessageIdFactory: () => "user-1" }),
    );

    expect(chunks).toEqual(["Hello", " world"]);
    expect(promptAsyncMock).toHaveBeenCalledWith({
      sessionID: "session-1",
      messageID: "user-1",
      parts: [
        {
          type: "text",
          text: "Hi",
        },
      ],
    });
  });

  it("falls back to part snapshots when text deltas are not emitted", async () => {
    const { promptStream } = await modulePromise;
    const events: OpenCodeEvent[] = [
      assistantMessageUpdated({
        sessionId: "session-1",
        assistantMessageId: "assistant-1",
        parentId: "user-1",
      }),
      textPartUpdated({
        sessionId: "session-1",
        assistantMessageId: "assistant-1",
        partId: "part-1",
        text: "Hello",
      }),
      textPartUpdated({
        sessionId: "session-1",
        assistantMessageId: "assistant-1",
        partId: "part-1",
        text: "Hello world",
      }),
      sessionIdle("session-1"),
    ];
    const { client } = createPromptClient(events);

    const chunks = await collect(
      promptStream(client, "session-1", { text: "Hi" }, { userMessageIdFactory: () => "user-1" }),
    );

    expect(chunks).toEqual(["Hello", " world"]);
  });

  it("throws when prompt enqueue fails", async () => {
    const { promptStream } = await modulePromise;
    const { client } = createPromptClient([], {
      promptResult: {
        error: "queue unavailable",
        response: new Response("queue unavailable", {
          status: 503,
          statusText: "Service Unavailable",
        }),
      },
    });

    await expect(
      collect(
        promptStream(client, "session-1", { text: "Hi" }, { userMessageIdFactory: () => "user-1" }),
      ),
    ).rejects.toThrow(
      /Failed to enqueue OpenCode prompt: 503 Service Unavailable: queue unavailable/,
    );
  });

  it("throws when the assistant emits an error event", async () => {
    const { promptStream } = await modulePromise;
    const events: OpenCodeEvent[] = [
      assistantMessageUpdated({
        sessionId: "session-1",
        assistantMessageId: "assistant-1",
        parentId: "user-1",
        error: {
          name: "APIError",
          data: {
            message: "provider offline",
          },
        },
      }),
    ];
    const { client } = createPromptClient(events);

    await expect(
      collect(
        promptStream(client, "session-1", { text: "Hi" }, { userMessageIdFactory: () => "user-1" }),
      ),
    ).rejects.toThrow(/OpenCode assistant message failed: APIError: provider offline/);
  });
});

function createPromptClient(
  events: OpenCodeEvent[],
  options: {
    promptResult?: {
      error?: unknown;
      response?: Response;
    };
  } = {},
) {
  const promptAsyncMock = vi.fn(async () => ({
    response:
      options.promptResult?.response ??
      new Response(null, {
        status: 204,
      }),
    error: options.promptResult?.error,
  }));
  const client: OpenCodePromptClient = {
    session: {
      promptAsync: promptAsyncMock,
    },
    event: {
      subscribe: vi.fn(async () => ({
        stream: toAsyncIterable(events),
      })),
    },
  };

  return {
    client,
    promptAsyncMock,
  };
}

async function collect(stream: AsyncIterable<string>) {
  const chunks: string[] = [];

  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  return chunks;
}

async function* toAsyncIterable<T>(values: Iterable<T>) {
  for (const value of values) {
    yield value;
  }
}

function assistantMessageUpdated(options: {
  sessionId: string;
  assistantMessageId: string;
  parentId: string;
  error?: {
    name?: string;
    data?: {
      message?: string;
    };
  };
}): OpenCodeEvent {
  return {
    type: "message.updated",
    properties: {
      sessionID: options.sessionId,
      info: {
        id: options.assistantMessageId,
        role: "assistant",
        parentID: options.parentId,
        error: options.error,
      },
    },
  };
}

function textDelta(options: {
  sessionId: string;
  assistantMessageId: string;
  partId: string;
  delta: string;
}): OpenCodeEvent {
  return {
    type: "message.part.delta",
    properties: {
      sessionID: options.sessionId,
      messageID: options.assistantMessageId,
      partID: options.partId,
      field: "text",
      delta: options.delta,
    },
  };
}

function textPartUpdated(options: {
  sessionId: string;
  assistantMessageId: string;
  partId: string;
  text: string;
}): OpenCodeEvent {
  return {
    type: "message.part.updated",
    properties: {
      sessionID: options.sessionId,
      part: {
        id: options.partId,
        messageID: options.assistantMessageId,
        type: "text",
        text: options.text,
      },
    },
  };
}

function sessionIdle(sessionId: string): OpenCodeEvent {
  return {
    type: "session.idle",
    properties: {
      sessionID: sessionId,
    },
  };
}
