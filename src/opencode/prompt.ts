import { randomUUID } from "node:crypto";

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

export type OpenCodeEvent =
  | {
      type: "message.updated";
      properties: {
        sessionID: string;
        info: {
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
        };
      };
    }
  | {
      type: "message.part.updated";
      properties: {
        sessionID: string;
        part: {
          id: string;
          messageID: string;
          type: string;
          text?: string;
        };
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

export interface PromptStreamOptions {
  userMessageIdFactory?: () => string;
}

export function promptStream(
  client: OpenCodePromptClient,
  sessionId: string,
  message: PromptMessage,
  options: PromptStreamOptions = {},
): AsyncIterable<string> {
  validatePromptMessage(message);
  const userMessageId = (options.userMessageIdFactory ?? randomUUID)();

  return (async function* () {
    const subscription = await client.event.subscribe();
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

    yield* streamAssistantResponse(subscription.stream, {
      sessionId,
      userMessageId,
    });
  })();
}

export async function* streamAssistantResponse(
  stream: AsyncIterable<OpenCodeEvent>,
  target: {
    sessionId: string;
    userMessageId: string;
  },
): AsyncIterable<string> {
  let assistantMessageId: string | null = null;
  const emittedLengths = new Map<string, number>();

  for await (const event of stream) {
    if (event.type === "message.updated") {
      if (event.properties.sessionID !== target.sessionId) {
        continue;
      }

      const info = event.properties.info;
      if (info.role !== "assistant" || info.parentID !== target.userMessageId) {
        continue;
      }

      assistantMessageId = info.id;

      if (info.error !== undefined) {
        throw new Error(formatEventError("OpenCode assistant message failed", info.error));
      }

      continue;
    }

    if (event.type === "message.part.delta") {
      if (
        assistantMessageId === null ||
        event.properties.sessionID !== target.sessionId ||
        event.properties.messageID !== assistantMessageId ||
        event.properties.field !== "text"
      ) {
        continue;
      }

      const previousLength = emittedLengths.get(event.properties.partID) ?? 0;
      emittedLengths.set(event.properties.partID, previousLength + event.properties.delta.length);
      yield event.properties.delta;
      continue;
    }

    if (event.type === "message.part.updated") {
      if (assistantMessageId === null || event.properties.sessionID !== target.sessionId) {
        continue;
      }

      const part = event.properties.part;
      if (
        part.type !== "text" ||
        part.messageID !== assistantMessageId ||
        part.text === undefined
      ) {
        continue;
      }

      const previousLength = emittedLengths.get(part.id) ?? 0;
      if (part.text.length <= previousLength) {
        continue;
      }

      emittedLengths.set(part.id, part.text.length);
      yield part.text.slice(previousLength);
      continue;
    }

    if (event.type === "session.error") {
      if (assistantMessageId !== null && event.properties.sessionID === target.sessionId) {
        throw new Error(formatEventError("OpenCode session failed", event.properties.error));
      }

      continue;
    }

    if (event.type === "session.idle") {
      if (assistantMessageId !== null && event.properties.sessionID === target.sessionId) {
        return;
      }
    }
  }
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
