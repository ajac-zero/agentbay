import { describe, expect, it, vi } from "vite-plus/test";
import type {
  OpenCodeEvent,
  OpenCodePromptClient,
  OpenCodeToolState,
  PromptStreamChunk,
} from "./prompt.ts";
import type { Sandbox, SandboxClaim } from "../k8s/client.ts";

process.env.PORT ??= "3000";
process.env.NAMESPACE ??= "agent-sandbox";
process.env.KUBERNETES_CLUSTER_DOMAIN ??= "cluster.local";
process.env.SANDBOX_TEMPLATE_NAME ??= "opencode";
process.env.SANDBOX_ACCESS_MODE ??= "direct";
process.env.SANDBOX_ROUTER_URL ??= "http://sandbox-router.agent-sandbox.svc.cluster.local:8080";
process.env.SANDBOX_PORT ??= "8888";
process.env.SANDBOX_IDLE_TTL_MINUTES ??= "30";
process.env.SANDBOX_READY_TIMEOUT_SECONDS ??= "60";
process.env.STATE_BACKEND_URL ??= "redis://redis.default.svc.cluster.local:6379";

const promptModulePromise = import("./prompt.ts");
const clientModulePromise = import("./client.ts");

describe("promptStream", () => {
  it("enqueues a prompt and streams text deltas until the session goes idle", async () => {
    const { promptStream } = await promptModulePromise;
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
    const { client, promptAsyncMock } = createPromptClient([events]);

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
    const { promptStream } = await promptModulePromise;
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
    const { client } = createPromptClient([events]);

    const chunks = await collect(
      promptStream(client, "session-1", { text: "Hi" }, { userMessageIdFactory: () => "user-1" }),
    );

    expect(chunks).toEqual(["Hello", " world"]);
  });

  it("emits tool lifecycle updates as task_update chunks", async () => {
    const { promptStream } = await promptModulePromise;
    const events: OpenCodeEvent[] = [
      assistantMessageUpdated({
        sessionId: "session-1",
        assistantMessageId: "assistant-1",
        parentId: "user-1",
      }),
      toolPartUpdated({
        sessionId: "session-1",
        assistantMessageId: "assistant-1",
        partId: "tool-part-1",
        callId: "call-1",
        tool: "bash",
        state: {
          status: "pending",
          input: { command: "echo hi" },
          raw: '{"command":"echo hi"}',
        },
      }),
      toolPartUpdated({
        sessionId: "session-1",
        assistantMessageId: "assistant-1",
        partId: "tool-part-1",
        callId: "call-1",
        tool: "bash",
        state: {
          status: "running",
          input: { command: "echo hi" },
          title: "Run bash",
          metadata: { cwd: "/tmp" },
          time: { start: 1 },
        },
      }),
      toolPartUpdated({
        sessionId: "session-1",
        assistantMessageId: "assistant-1",
        partId: "tool-part-1",
        callId: "call-1",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: "echo hi" },
          title: "Run bash",
          output: "hi\n",
          metadata: { exitCode: 0 },
          time: { start: 1, end: 2 },
        },
      }),
      sessionIdle("session-1"),
    ];
    const { client } = createPromptClient([events]);

    const chunks = await collect(
      promptStream(client, "session-1", { text: "Hi" }, { userMessageIdFactory: () => "user-1" }),
    );

    expect(chunks).toEqual([
      {
        type: "task_update",
        id: "call-1",
        tool: "bash",
        title: "bash",
        status: "pending",
        input: { command: "echo hi" },
        metadata: {},
      },
      {
        type: "task_update",
        id: "call-1",
        tool: "bash",
        title: "Run bash",
        status: "running",
        input: { command: "echo hi" },
        metadata: { cwd: "/tmp" },
      },
      {
        type: "task_update",
        id: "call-1",
        tool: "bash",
        title: "Run bash",
        status: "completed",
        input: { command: "echo hi" },
        output: "hi\n",
        metadata: { exitCode: 0 },
      },
    ]);
  });

  it("retries disconnected event streams with bounded reconnects and no duplicate text", async () => {
    const { promptStream } = await promptModulePromise;
    const firstStream: OpenCodeEvent[] = [
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
    ];
    const secondStream: OpenCodeEvent[] = [
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
    const { client, subscribeMock } = createPromptClient([firstStream, secondStream]);

    const chunks = await collect(
      promptStream(
        client,
        "session-1",
        { text: "Hi" },
        {
          userMessageIdFactory: () => "user-1",
          reconnectDelayMs: 0,
        },
      ),
    );

    expect(chunks).toEqual(["Hello", " world"]);
    expect(subscribeMock).toHaveBeenCalledTimes(2);
  });

  it("stops cleanly when aborted", async () => {
    const { promptStream } = await promptModulePromise;
    const abortController = new AbortController();
    const { client } = createPromptClient([
      createAbortableEventStream([
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
      ]),
    ]);

    const iterator = promptStream(
      client,
      "session-1",
      { text: "Hi" },
      {
        userMessageIdFactory: () => "user-1",
        signal: abortController.signal,
      },
    )[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({ done: false, value: "Hello" });

    const pendingNext = iterator.next();
    abortController.abort();

    await expect(pendingNext).resolves.toEqual({ done: true, value: undefined });
  });

  it("throws when prompt enqueue fails", async () => {
    const { promptStream } = await promptModulePromise;
    const { client } = createPromptClient([[]], {
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
    const { promptStream } = await promptModulePromise;
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
    const { client } = createPromptClient([events]);

    await expect(
      collect(
        promptStream(client, "session-1", { text: "Hi" }, { userMessageIdFactory: () => "user-1" }),
      ),
    ).rejects.toThrow(/OpenCode assistant message failed: APIError: provider offline/);
  });

  it("works against a fake SSE endpoint via the real OpenCode client", async () => {
    const [{ promptStream }, { createOpenCodeClient }] = await Promise.all([
      promptModulePromise,
      clientModulePromise,
    ]);
    const requests: Request[] = [];
    const eventResponses: OpenCodeEvent[][] = [
      [
        assistantMessageUpdated({
          sessionId: "session-1",
          assistantMessageId: "assistant-1",
          parentId: "user-1",
        }),
        toolPartUpdated({
          sessionId: "session-1",
          assistantMessageId: "assistant-1",
          partId: "tool-part-1",
          callId: "call-1",
          tool: "read",
          state: {
            status: "running",
            input: { path: "README.md" },
            title: "Read README",
            metadata: { path: "README.md" },
            time: { start: 1 },
          },
        }),
        textPartUpdated({
          sessionId: "session-1",
          assistantMessageId: "assistant-1",
          partId: "part-1",
          text: "Hello world",
        }),
        sessionIdle("session-1"),
      ],
    ];

    const client = await createOpenCodeClient({
      claimName: "ab-claim",
      password: "stream-secret",
      claimClient: {
        get: vi.fn(async () =>
          createSandboxClaim({
            claimName: "ab-claim",
            sandboxName: "sandbox-stream",
          }),
        ),
      },
      sandboxClient: {
        get: vi.fn(async (name: string) =>
          createSandbox({
            sandboxName: name,
            serviceFQDN: "sandbox-stream.agent-sandbox.svc.cluster.local",
          }),
        ),
      },
      fetchImplementation: async (input) => {
        const request = toRequest(input);
        requests.push(request);
        const url = new URL(request.url);

        if (url.pathname.endsWith("/event")) {
          const events = eventResponses.shift();
          if (events === undefined) {
            throw new Error("unexpected event subscription");
          }
          return sseResponse(events);
        }

        if (url.pathname.endsWith("/prompt_async")) {
          return new Response(null, { status: 204 });
        }

        throw new Error(`Unexpected request: ${request.method} ${request.url}`);
      },
    });

    const chunks = await collect(
      promptStream(
        client as unknown as OpenCodePromptClient,
        "session-1",
        { text: "Hi" },
        {
          userMessageIdFactory: () => "user-1",
        },
      ),
    );

    expect(chunks).toEqual([
      {
        type: "task_update",
        id: "call-1",
        tool: "read",
        title: "Read README",
        status: "running",
        input: { path: "README.md" },
        metadata: { path: "README.md" },
      },
      "Hello world",
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[0].url).toBe(
      "http://sandbox-stream.agent-sandbox.svc.cluster.local:8888/event?auth_token=stream-secret",
    );
    expect(requests[1].url).toBe(
      "http://sandbox-stream.agent-sandbox.svc.cluster.local:8888/session/session-1/prompt_async",
    );
  });
});

function createPromptClient(
  streams: Array<Iterable<OpenCodeEvent> | AsyncIterable<OpenCodeEvent>>,
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
  let subscriptionIndex = 0;
  const subscribeMock = vi.fn(async () => {
    const stream = streams[subscriptionIndex];
    subscriptionIndex += 1;

    if (stream === undefined) {
      throw new Error("unexpected event subscription");
    }

    return {
      stream: isAsyncIterable(stream) ? stream : toAsyncIterable(stream),
    };
  });
  const client: OpenCodePromptClient = {
    session: {
      promptAsync: promptAsyncMock,
    },
    event: {
      subscribe: subscribeMock,
    },
  };

  return {
    client,
    promptAsyncMock,
    subscribeMock,
  };
}

async function collect(stream: AsyncIterable<PromptStreamChunk>) {
  const chunks: PromptStreamChunk[] = [];

  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  return chunks;
}

function isAsyncIterable<T>(value: object): value is AsyncIterable<T> {
  return Symbol.asyncIterator in value;
}

async function* toAsyncIterable<T>(values: Iterable<T>) {
  for (const value of values) {
    yield value;
  }
}

function createAbortableEventStream(events: OpenCodeEvent[]): AsyncIterable<OpenCodeEvent> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      let done = false;
      let pendingResolve: ((result: IteratorResult<OpenCodeEvent>) => void) | undefined;

      return {
        async next(): Promise<IteratorResult<OpenCodeEvent>> {
          if (done) {
            return { done: true, value: undefined };
          }

          if (index < events.length) {
            return { done: false, value: events[index++] };
          }

          return await new Promise<IteratorResult<OpenCodeEvent>>((resolve) => {
            pendingResolve = resolve;
          });
        },
        async return(): Promise<IteratorResult<OpenCodeEvent>> {
          done = true;
          pendingResolve?.({ done: true, value: undefined });
          return { done: true, value: undefined };
        },
      };
    },
  };
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

function toolPartUpdated(options: {
  sessionId: string;
  assistantMessageId: string;
  partId: string;
  callId: string;
  tool: string;
  state: OpenCodeToolState;
  metadata?: Record<string, unknown>;
}): OpenCodeEvent {
  return {
    type: "message.part.updated",
    properties: {
      sessionID: options.sessionId,
      part: {
        id: options.partId,
        messageID: options.assistantMessageId,
        type: "tool",
        callID: options.callId,
        tool: options.tool,
        state: options.state,
        metadata: options.metadata,
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

function createSandboxClaim(options: {
  claimName: string;
  sandboxName: string;
  namespace?: string;
}): SandboxClaim {
  return {
    apiVersion: "extensions.agents.x-k8s.io/v1alpha1",
    kind: "SandboxClaim",
    metadata: {
      name: options.claimName,
      namespace: options.namespace ?? "agent-sandbox",
    },
    status: {
      sandbox: {
        name: options.sandboxName,
      },
    },
  };
}

function createSandbox(options: {
  sandboxName: string;
  namespace?: string;
  serviceName?: string;
  serviceFQDN?: string;
}): Sandbox {
  return {
    apiVersion: "agents.x-k8s.io/v1alpha1",
    kind: "Sandbox",
    metadata: {
      name: options.sandboxName,
      namespace: options.namespace ?? "agent-sandbox",
    },
    status: {
      service: options.serviceName ?? options.sandboxName,
      serviceFQDN: options.serviceFQDN,
    },
  };
}

function toRequest(input: Request | URL | string) {
  return input instanceof Request ? input : new Request(input);
}

function sseResponse(events: OpenCodeEvent[]) {
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }

        controller.close();
      },
    }),
    {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
      },
    },
  );
}
