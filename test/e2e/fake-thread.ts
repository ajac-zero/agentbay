import type { SentMessage, Thread } from "chat";
import type { ThreadState } from "../../src/types.js";

/**
 * Minimal in-memory Thread<ThreadState> double shared across e2e tests.
 * Collects posts, typing indicators, and subscription state for assertions.
 */
export class FakeThread {
  readonly posts: string[] = [];
  readonly typing: string[] = [];
  subscribed = false;

  constructor(
    readonly id: string,
    public currentState: ThreadState | null = null,
  ) {}

  asThread(): Thread<ThreadState> {
    const thisThread = this;

    return {
      get id() {
        return thisThread.id;
      },
      get state() {
        return Promise.resolve(thisThread.currentState);
      },
      post: async (content: string | AsyncIterable<string>) => {
        if (typeof content === "string") {
          thisThread.posts.push(content);
        } else if (isAsyncIterable(content)) {
          let streamed = "";
          for await (const chunk of content) streamed += chunk;
          thisThread.posts.push(streamed);
        }

        return {} as SentMessage;
      },
      setState: async (next: ThreadState) => {
        thisThread.currentState = next;
      },
      startTyping: async (message: string) => {
        thisThread.typing.push(message);
      },
      subscribe: async () => {
        thisThread.subscribed = true;
      },
    } as unknown as Thread<ThreadState>;
  }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<string> {
  return Boolean(value && typeof value === "object" && Symbol.asyncIterator in value);
}
