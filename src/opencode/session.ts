import { getThreadStateStore, type ThreadStateStore } from "../state/thread.ts";

export interface OpenCodeSession {
  id: string;
}

export interface OpenCodeSessionClient {
  session: {
    get(parameters: { sessionID: string }): Promise<OpenCodeRequestResult<OpenCodeSession>>;
    create(parameters?: { title?: string }): Promise<OpenCodeRequestResult<OpenCodeSession>>;
  };
}

export interface OpenCodeRequestResult<TData> {
  data?: TData;
  error?: unknown;
  response?: Response;
}

export interface GetOrCreateSessionOptions {
  stateStore?: ThreadStateStore;
  title?: string;
}

const inflightSessions = new Map<string, Promise<string>>();

export async function getOrCreateSession(
  threadId: string,
  client: OpenCodeSessionClient,
  options: GetOrCreateSessionOptions = {},
) {
  validateThreadId(threadId);

  const existingPromise = inflightSessions.get(threadId);
  if (existingPromise !== undefined) {
    return existingPromise;
  }

  const promise = getOrCreateSessionInner(threadId, client, options);
  inflightSessions.set(threadId, promise);

  try {
    return await promise;
  } finally {
    if (inflightSessions.get(threadId) === promise) {
      inflightSessions.delete(threadId);
    }
  }
}

async function getOrCreateSessionInner(
  threadId: string,
  client: OpenCodeSessionClient,
  options: GetOrCreateSessionOptions,
) {
  const stateStore = options.stateStore ?? getThreadStateStore();
  const storedSessionId = await stateStore.getOpenCodeSessionId(threadId);

  if (storedSessionId !== null) {
    const existingSession = await getExistingSession(client, storedSessionId);
    if (existingSession !== null) {
      return existingSession.id;
    }
  }

  const nextSession = await createSession(client, options.title);
  await stateStore.setOpenCodeSessionId(threadId, nextSession.id);
  return nextSession.id;
}

async function getExistingSession(client: OpenCodeSessionClient, sessionId: string) {
  const result = await client.session.get({ sessionID: sessionId });

  if (result.response?.ok === true && result.data !== undefined) {
    return result.data;
  }

  if (result.response?.status === 404) {
    return null;
  }

  throw new Error(
    formatOpenCodeError(
      `Failed to load OpenCode session ${sessionId}`,
      result.response,
      result.error,
    ),
  );
}

async function createSession(client: OpenCodeSessionClient, title?: string) {
  const result = await client.session.create(title === undefined ? undefined : { title });

  if (result.response?.ok === true && result.data !== undefined) {
    return result.data;
  }

  throw new Error(
    formatOpenCodeError("Failed to create OpenCode session", result.response, result.error),
  );
}

function formatOpenCodeError(message: string, response?: Response, error?: unknown) {
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

  if (details.length === 0) {
    return message;
  }

  return `${message}: ${details.join(": ")}`;
}

function validateThreadId(threadId: string) {
  if (threadId.trim().length === 0) {
    throw new Error("threadId must not be empty");
  }
}
