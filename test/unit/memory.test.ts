import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueueEntry } from "chat";
import { MemoryStateAdapter } from "../../src/state/memory.js";

// The memory adapter stores QueueEntry objects without inspecting them.
// Use minimal casted objects so queue-ordering tests stay readable.
function entry(tag: string): QueueEntry {
  return { enqueuedAt: Date.now(), expiresAt: Date.now() + 60_000, tag } as unknown as QueueEntry;
}

describe("MemoryStateAdapter", () => {
  let adapter: MemoryStateAdapter;

  beforeEach(() => {
    adapter = new MemoryStateAdapter();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // connect / disconnect
  // -------------------------------------------------------------------------

  describe("connect / disconnect", () => {
    it("connect resolves without error", async () => {
      await expect(adapter.connect()).resolves.toBeUndefined();
    });

    it("disconnect clears all state", async () => {
      await adapter.set("key", "value");
      await adapter.subscribe("thread-1");
      await adapter.acquireLock("thread-1", 10_000);
      await adapter.appendToList("list-1", "item");
      await adapter.enqueue("thread-1", entry("e1"), 10);

      await adapter.disconnect();

      expect(await adapter.get("key")).toBeNull();
      expect(await adapter.isSubscribed("thread-1")).toBe(false);
      expect(await adapter.acquireLock("thread-1", 10_000)).not.toBeNull();
      expect(await adapter.getList("list-1")).toEqual([]);
      expect(await adapter.dequeue("thread-1")).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // get / set / delete
  // -------------------------------------------------------------------------

  describe("get / set / delete", () => {
    it("returns null for a key that has never been set", async () => {
      expect(await adapter.get("missing")).toBeNull();
    });

    it("returns the stored value", async () => {
      await adapter.set("key", { foo: "bar" });
      expect(await adapter.get("key")).toEqual({ foo: "bar" });
    });

    it("overwrites an existing value", async () => {
      await adapter.set("key", "first");
      await adapter.set("key", "second");
      expect(await adapter.get("key")).toBe("second");
    });

    it("delete removes the key", async () => {
      await adapter.set("key", "value");
      await adapter.delete("key");
      expect(await adapter.get("key")).toBeNull();
    });

    it("delete is a no-op for a missing key", async () => {
      await expect(adapter.delete("never-set")).resolves.toBeUndefined();
    });

    it("returns null for an expired key", async () => {
      vi.useFakeTimers();
      await adapter.set("key", "value", 100);
      vi.advanceTimersByTime(101);
      expect(await adapter.get("key")).toBeNull();
    });

    it("returns the value before it expires", async () => {
      vi.useFakeTimers();
      await adapter.set("key", "value", 500);
      vi.advanceTimersByTime(499);
      expect(await adapter.get("key")).toBe("value");
    });

    it("stores values without a TTL indefinitely", async () => {
      vi.useFakeTimers();
      await adapter.set("key", "forever");
      vi.advanceTimersByTime(1_000_000);
      expect(await adapter.get("key")).toBe("forever");
    });
  });

  // -------------------------------------------------------------------------
  // setIfNotExists
  // -------------------------------------------------------------------------

  describe("setIfNotExists", () => {
    it("sets the value when the key does not exist and returns true", async () => {
      const result = await adapter.setIfNotExists("key", "value");
      expect(result).toBe(true);
      expect(await adapter.get("key")).toBe("value");
    });

    it("does not overwrite an existing key and returns false", async () => {
      await adapter.set("key", "original");
      const result = await adapter.setIfNotExists("key", "new");
      expect(result).toBe(false);
      expect(await adapter.get("key")).toBe("original");
    });

    it("sets the value after the previous TTL expires", async () => {
      vi.useFakeTimers();
      await adapter.set("key", "old", 100);
      vi.advanceTimersByTime(101);
      const result = await adapter.setIfNotExists("key", "new");
      expect(result).toBe(true);
      expect(await adapter.get("key")).toBe("new");
    });
  });

  // -------------------------------------------------------------------------
  // subscribe / unsubscribe / isSubscribed
  // -------------------------------------------------------------------------

  describe("subscribe / unsubscribe / isSubscribed", () => {
    it("isSubscribed returns false before subscribing", async () => {
      expect(await adapter.isSubscribed("thread-1")).toBe(false);
    });

    it("isSubscribed returns true after subscribing", async () => {
      await adapter.subscribe("thread-1");
      expect(await adapter.isSubscribed("thread-1")).toBe(true);
    });

    it("isSubscribed returns false after unsubscribing", async () => {
      await adapter.subscribe("thread-1");
      await adapter.unsubscribe("thread-1");
      expect(await adapter.isSubscribed("thread-1")).toBe(false);
    });

    it("unsubscribe is a no-op for an unknown thread", async () => {
      await expect(adapter.unsubscribe("never-subscribed")).resolves.toBeUndefined();
    });

    it("tracks subscriptions for multiple threads independently", async () => {
      await adapter.subscribe("t1");
      await adapter.subscribe("t2");
      await adapter.unsubscribe("t1");
      expect(await adapter.isSubscribed("t1")).toBe(false);
      expect(await adapter.isSubscribed("t2")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // acquireLock / releaseLock / extendLock / forceReleaseLock
  // -------------------------------------------------------------------------

  describe("locks", () => {
    it("acquireLock returns a lock with the correct threadId", async () => {
      const lock = await adapter.acquireLock("thread-1", 10_000);
      expect(lock).not.toBeNull();
      expect(lock!.threadId).toBe("thread-1");
    });

    it("acquireLock fails when a live lock already exists", async () => {
      await adapter.acquireLock("thread-1", 10_000);
      expect(await adapter.acquireLock("thread-1", 10_000)).toBeNull();
    });

    it("acquireLock succeeds after the previous lock expires", async () => {
      vi.useFakeTimers();
      await adapter.acquireLock("thread-1", 100);
      vi.advanceTimersByTime(101);
      expect(await adapter.acquireLock("thread-1", 10_000)).not.toBeNull();
    });

    it("releaseLock allows re-acquiring", async () => {
      const lock = await adapter.acquireLock("thread-1", 10_000);
      await adapter.releaseLock(lock!);
      expect(await adapter.acquireLock("thread-1", 10_000)).not.toBeNull();
    });

    it("releaseLock is a no-op for a stale token", async () => {
      const lock1 = await adapter.acquireLock("thread-1", 10_000);
      // Simulate a stale reference by mutating a copy
      await adapter.releaseLock({ ...lock1!, token: "stale-token" });
      // Original lock should still hold
      expect(await adapter.acquireLock("thread-1", 10_000)).toBeNull();
    });

    it("extendLock updates the expiry and returns true", async () => {
      vi.useFakeTimers();
      const lock = await adapter.acquireLock("thread-1", 100);
      vi.advanceTimersByTime(50);
      expect(await adapter.extendLock(lock!, 1_000)).toBe(true);
      vi.advanceTimersByTime(150); // Would have expired with original TTL
      // Lock should still be held after extension
      expect(await adapter.acquireLock("thread-1", 1_000)).toBeNull();
    });

    it("extendLock returns false for a stale token", async () => {
      const lock = await adapter.acquireLock("thread-1", 10_000);
      expect(await adapter.extendLock({ ...lock!, token: "stale" }, 10_000)).toBe(false);
    });

    it("forceReleaseLock removes any lock regardless of token", async () => {
      await adapter.acquireLock("thread-1", 10_000);
      await adapter.forceReleaseLock("thread-1");
      expect(await adapter.acquireLock("thread-1", 10_000)).not.toBeNull();
    });

    it("forceReleaseLock is a no-op for a thread with no lock", async () => {
      await expect(adapter.forceReleaseLock("no-lock")).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // appendToList / getList
  // -------------------------------------------------------------------------

  describe("appendToList / getList", () => {
    it("getList returns an empty array for an unknown key", async () => {
      expect(await adapter.getList("missing")).toEqual([]);
    });

    it("appendToList adds items in order", async () => {
      await adapter.appendToList("list", "a");
      await adapter.appendToList("list", "b");
      await adapter.appendToList("list", "c");
      expect(await adapter.getList("list")).toEqual(["a", "b", "c"]);
    });

    it("trims the list to maxLength keeping the most recent items", async () => {
      for (let i = 1; i <= 5; i++) await adapter.appendToList("list", i, { maxLength: 3 });
      expect(await adapter.getList("list")).toEqual([3, 4, 5]);
    });

    it("returns an empty list after TTL expires", async () => {
      vi.useFakeTimers();
      await adapter.appendToList("list", "item", { ttlMs: 100 });
      vi.advanceTimersByTime(101);
      expect(await adapter.getList("list")).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // enqueue / dequeue / queueDepth
  // -------------------------------------------------------------------------

  describe("enqueue / dequeue / queueDepth", () => {
    it("queueDepth returns 0 for an empty queue", async () => {
      expect(await adapter.queueDepth("thread-1")).toBe(0);
    });

    it("enqueue returns the new queue depth", async () => {
      const depth = await adapter.enqueue("thread-1", entry("e1"), 10);
      expect(depth).toBe(1);
    });

    it("dequeue returns items in FIFO order", async () => {
      const e1 = entry("e1");
      const e2 = entry("e2");
      await adapter.enqueue("thread-1", e1, 10);
      await adapter.enqueue("thread-1", e2, 10);
      expect(await adapter.dequeue("thread-1")).toBe(e1);
      expect(await adapter.dequeue("thread-1")).toBe(e2);
    });

    it("dequeue returns null for an empty queue", async () => {
      expect(await adapter.dequeue("thread-1")).toBeNull();
    });

    it("queueDepth reflects enqueue and dequeue", async () => {
      await adapter.enqueue("thread-1", entry("e1"), 10);
      await adapter.enqueue("thread-1", entry("e2"), 10);
      expect(await adapter.queueDepth("thread-1")).toBe(2);
      await adapter.dequeue("thread-1");
      expect(await adapter.queueDepth("thread-1")).toBe(1);
    });

    it("trims the queue to maxSize keeping the most recent entries", async () => {
      const entries = Array.from({ length: 5 }, (_, i) => entry(`e${i + 1}`));
      for (const e of entries) await adapter.enqueue("thread-1", e, 3);
      expect(await adapter.queueDepth("thread-1")).toBe(3);
      expect(await adapter.dequeue("thread-1")).toBe(entries[2]);
    });

    it("queues are independent per thread", async () => {
      const a = entry("a");
      const b = entry("b");
      await adapter.enqueue("t1", a, 10);
      await adapter.enqueue("t2", b, 10);
      expect(await adapter.dequeue("t1")).toBe(a);
      expect(await adapter.dequeue("t2")).toBe(b);
    });
  });
});
