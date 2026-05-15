import { randomUUID } from "node:crypto";
import type { Lock, QueueEntry, StateAdapter } from "chat";

type StoredValue = {
  expiresAt?: number;
  value: unknown;
};

export class MemoryStateAdapter implements StateAdapter {
  private readonly lists = new Map<string, StoredValue>();
  private readonly locks = new Map<string, Lock>();
  private readonly queues = new Map<string, QueueEntry[]>();
  private readonly subscriptions = new Set<string>();
  private readonly values = new Map<string, StoredValue>();

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {
    this.lists.clear();
    this.locks.clear();
    this.queues.clear();
    this.subscriptions.clear();
    this.values.clear();
  }

  async subscribe(threadId: string): Promise<void> {
    this.subscriptions.add(threadId);
  }

  async unsubscribe(threadId: string): Promise<void> {
    this.subscriptions.delete(threadId);
  }

  async isSubscribed(threadId: string): Promise<boolean> {
    return this.subscriptions.has(threadId);
  }

  async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
    const existing = this.locks.get(threadId);
    if (existing && existing.expiresAt > Date.now()) return null;

    const lock = { expiresAt: Date.now() + ttlMs, threadId, token: randomUUID() };
    this.locks.set(threadId, lock);
    return lock;
  }

  async releaseLock(lock: Lock): Promise<void> {
    const existing = this.locks.get(lock.threadId);
    if (existing?.token === lock.token) this.locks.delete(lock.threadId);
  }

  async extendLock(lock: Lock, ttlMs: number): Promise<boolean> {
    const existing = this.locks.get(lock.threadId);
    if (existing?.token !== lock.token) return false;
    existing.expiresAt = Date.now() + ttlMs;
    return true;
  }

  async forceReleaseLock(threadId: string): Promise<void> {
    this.locks.delete(threadId);
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const stored = this.values.get(key);
    if (!stored || isExpired(stored)) {
      this.values.delete(key);
      return null;
    }
    return stored.value as T;
  }

  async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    this.values.set(key, { value, expiresAt: ttlMs ? Date.now() + ttlMs : undefined });
  }

  async setIfNotExists(key: string, value: unknown, ttlMs?: number): Promise<boolean> {
    const stored = this.values.get(key);
    if (stored && !isExpired(stored)) return false;

    this.values.set(key, { value, expiresAt: ttlMs ? Date.now() + ttlMs : undefined });
    return true;
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
    this.lists.delete(key);
  }

  async appendToList(key: string, value: unknown, options?: { maxLength?: number; ttlMs?: number }): Promise<void> {
    const list = await this.getList<unknown>(key);
    list.push(value);
    const trimmed = options?.maxLength ? list.slice(-options.maxLength) : list;
    this.lists.set(key, {
      value: trimmed,
      expiresAt: options?.ttlMs ? Date.now() + options.ttlMs : undefined,
    });
  }

  async getList<T = unknown>(key: string): Promise<T[]> {
    const stored = this.lists.get(key);
    if (!stored || isExpired(stored)) {
      this.lists.delete(key);
      return [];
    }
    return stored.value as T[];
  }

  async enqueue(threadId: string, entry: QueueEntry, maxSize: number): Promise<number> {
    const queue = this.queues.get(threadId) ?? [];
    queue.push(entry);
    const trimmed = queue.slice(-maxSize);
    this.queues.set(threadId, trimmed);
    return trimmed.length;
  }

  async dequeue(threadId: string): Promise<QueueEntry | null> {
    const queue = this.queues.get(threadId) ?? [];
    const entry = queue.shift() ?? null;
    if (queue.length === 0) this.queues.delete(threadId);
    return entry;
  }

  async queueDepth(threadId: string): Promise<number> {
    return this.queues.get(threadId)?.length ?? 0;
  }
}

export function createMemoryState(): MemoryStateAdapter {
  return new MemoryStateAdapter();
}

function isExpired(stored: StoredValue): boolean {
  return stored.expiresAt !== undefined && stored.expiresAt <= Date.now();
}
