import { createClient } from "redis";
import { config } from "../config.ts";
import { hashThreadId } from "../k8s/claim.ts";

const OPEN_CODE_SESSION_ID_FIELD = "openCodeSessionId";
const THREAD_STATE_KEY_PREFIX = "wolfgang:thread-state";

type RedisClient = ReturnType<typeof createClient>;

export interface ThreadStateStore {
  getOpenCodeSessionId(threadId: string): Promise<string | null>;
  setOpenCodeSessionId(threadId: string, sessionId: string): Promise<void>;
}

export class InMemoryThreadStateStore implements ThreadStateStore {
  private readonly sessionIds = new Map<string, string>();

  constructor(entries: Iterable<[string, string]> = []) {
    for (const [threadId, sessionId] of entries) {
      this.set(threadId, sessionId);
    }
  }

  async getOpenCodeSessionId(threadId: string) {
    validateThreadId(threadId);
    return this.sessionIds.get(threadId) ?? null;
  }

  async setOpenCodeSessionId(threadId: string, sessionId: string) {
    this.set(threadId, sessionId);
  }

  private set(threadId: string, sessionId: string) {
    validateThreadId(threadId);
    validateSessionId(sessionId);
    this.sessionIds.set(threadId, sessionId);
  }
}

export class RedisThreadStateStore implements ThreadStateStore {
  private readonly url: string;
  private readonly namespace: string;
  private clientPromise?: Promise<RedisClient>;

  constructor(options: { url?: string; namespace?: string } = {}) {
    this.url = options.url ?? config.stateBackend.url.toString();
    this.namespace = options.namespace ?? config.kubernetes.namespace;
  }

  async getOpenCodeSessionId(threadId: string) {
    validateThreadId(threadId);
    const client = await this.getClient();
    return (
      (await client.hGet(this.getThreadStateKey(threadId), OPEN_CODE_SESSION_ID_FIELD)) ?? null
    );
  }

  async setOpenCodeSessionId(threadId: string, sessionId: string) {
    validateThreadId(threadId);
    validateSessionId(sessionId);

    const client = await this.getClient();
    await client.hSet(this.getThreadStateKey(threadId), {
      threadId,
      [OPEN_CODE_SESSION_ID_FIELD]: sessionId,
      updatedAt: new Date().toISOString(),
    });
  }

  private async getClient() {
    if (this.clientPromise === undefined) {
      this.clientPromise = connectRedis(this.url);
    }

    return await this.clientPromise;
  }

  private getThreadStateKey(threadId: string) {
    return [THREAD_STATE_KEY_PREFIX, this.namespace, hashThreadId(threadId)].join(":");
  }
}

let cachedThreadStateStore: ThreadStateStore | null = null;

export function getThreadStateStore() {
  cachedThreadStateStore ??= new RedisThreadStateStore();
  return cachedThreadStateStore;
}

async function connectRedis(url: string) {
  const client = createClient({ url });
  client.on("error", (error) => {
    console.error("Redis thread state client error", error);
  });
  await client.connect();
  return client;
}

function validateThreadId(threadId: string) {
  if (threadId.trim().length === 0) {
    throw new Error("threadId must not be empty");
  }
}

function validateSessionId(sessionId: string) {
  if (sessionId.trim().length === 0) {
    throw new Error("sessionId must not be empty");
  }
}

export { OPEN_CODE_SESSION_ID_FIELD, THREAD_STATE_KEY_PREFIX };
