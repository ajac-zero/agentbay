import type { Event, OpencodeClient } from "@opencode-ai/sdk/client";
import { logger } from "../logger.js";

export async function createSession(client: OpencodeClient, title: string): Promise<string> {
  const { data } = await client.session.create({
    body: { title },
    throwOnError: true,
  });

  logger.info("opencode session created", { sessionId: data.id, title });
  return data.id;
}

export async function* runPrompt(input: {
  agentName: string;
  client: OpencodeClient;
  sessionID: string;
  text: string;
}): AsyncIterable<string> {
  const log = logger.child({ sessionId: input.sessionID, agentName: input.agentName });

  await assertSessionIdle(input.client, input.sessionID);

  const events = await input.client.event.subscribe({});
  await input.client.session.promptAsync({
    path: { id: input.sessionID },
    body: {
      agent: input.agentName,
      parts: [{ type: "text", text: input.text }],
    },
    throwOnError: true,
  });
  log.info("prompt submitted");

  for await (const event of events.stream) {
    if (!isSessionEvent(event, input.sessionID)) continue;

    const delta = textDelta(event, input.sessionID);
    if (delta) yield delta;

    if (event.type === "permission.updated") {
      log.debug("auto-approving tool permission", { permissionId: event.properties.id });
      await input.client.postSessionIdPermissionsPermissionId({
        path: { id: input.sessionID, permissionID: event.properties.id },
        body: { response: "always" },
        throwOnError: true,
      });
    }

    if (event.type === "session.error") {
      const msg = formatOpencodeError(event.properties.error);
      log.error("opencode session error", { error: msg });
      throw new Error(`opencode session ${input.sessionID} error: ${msg}`);
    }

    if (event.type === "session.idle") {
      log.info("opencode session completed");
      return;
    }
  }
}

function textDelta(event: Event, sessionID: string): string | undefined {
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
    return maybe.properties.sessionID === sessionID && maybe.properties.field === "text"
      ? maybe.properties.delta
      : undefined;
  }

  if (maybe.type === "message.part.updated") {
    return maybe.properties.part?.sessionID === sessionID && maybe.properties.part.type === "text"
      ? maybe.properties.delta
      : undefined;
  }
}

async function assertSessionIdle(client: OpencodeClient, sessionID: string): Promise<void> {
  const { data } = await client.session.status({ throwOnError: true });
  const status = data[sessionID];
  if (status && status.type !== "idle") {
    throw new Error(`opencode session ${sessionID} is not idle (${status.type})`);
  }
}

function isSessionEvent(event: Event, sessionID: string): boolean {
  switch (event.type) {
    case "message.part.updated":
      return "sessionID" in event.properties.part && event.properties.part.sessionID === sessionID;
    case "session.idle":
    case "session.status":
    case "session.error":
    case "session.compacted":
      return event.properties.sessionID === sessionID;
    case "permission.updated":
      return event.properties.sessionID === sessionID;
    default:
      return true;
  }
}

function formatOpencodeError(error: unknown): string {
  if (!error || typeof error !== "object") return "unknown error";

  const maybe = error as { data?: { message?: unknown }; name?: unknown };
  const name = typeof maybe.name === "string" ? maybe.name : "Error";
  const message = typeof maybe.data?.message === "string" ? maybe.data.message : JSON.stringify(error);
  return `${name}: ${message}`;
}
