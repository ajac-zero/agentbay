import { AsyncLocalStorage } from "node:async_hooks";

const botSlugContext = new AsyncLocalStorage<string>();

export function runWithBotSlug<T>(botSlug: string, run: () => T): T {
  return botSlugContext.run(botSlug, run);
}

export function currentBotSlug(): string | undefined {
  return botSlugContext.getStore();
}
