import type { ThreadState } from "../types.js";
import { currentBotSlug } from "./context.js";
import type { RuntimeStore } from "./store.js";
import type { ResolvedRuntime } from "./types.js";

export async function resolveInitialRuntime(store: RuntimeStore): Promise<ResolvedRuntime> {
  const botSlug = currentBotSlug();
  if (!botSlug) throw new Error("Webhook request did not include an agent bot slug");
  return store.resolveByBotSlug(botSlug);
}

export async function resolveThreadRuntime(store: RuntimeStore, state: ThreadState): Promise<ResolvedRuntime> {
  return store.resolveByThreadState(state);
}
