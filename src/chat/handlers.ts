import { ensureClaim } from "../k8s/claim.ts";
import { createOpenCodeClient } from "../opencode/client.ts";
import { promptStream, type OpenCodePromptClient, type PromptMessage } from "../opencode/prompt.ts";
import { getOrCreateSession, type OpenCodeSessionClient } from "../opencode/session.ts";

export interface ChatThread {
  id: string;
  title?: string;
  post(stream: AsyncIterable<string>): Promise<void>;
  subscribe(): Promise<void>;
}

export interface CoreHandlerDependencies {
  ensureClaim?: typeof ensureClaim;
  createOpenCodeClient?: typeof createOpenCodeClient;
  getOrCreateSession?: typeof getOrCreateSession;
  promptStream?: typeof promptStream;
}

export async function onNewMention(
  thread: ChatThread,
  message: PromptMessage,
  dependencies: CoreHandlerDependencies = {},
) {
  await handleThreadMessage(thread, message, {
    ...dependencies,
    subscribeThread: true,
  });
}

export async function onSubscribedMessage(
  thread: ChatThread,
  message: PromptMessage,
  dependencies: CoreHandlerDependencies = {},
) {
  await handleThreadMessage(thread, message, dependencies);
}

export async function onDirectMessage(
  thread: ChatThread,
  message: PromptMessage,
  dependencies: CoreHandlerDependencies = {},
) {
  await handleThreadMessage(thread, message, dependencies);
}

async function handleThreadMessage(
  thread: ChatThread,
  message: PromptMessage,
  dependencies: CoreHandlerDependencies & {
    subscribeThread?: boolean;
  },
) {
  const ensureClaimFn = dependencies.ensureClaim ?? ensureClaim;
  const createOpenCodeClientFn = dependencies.createOpenCodeClient ?? createOpenCodeClient;
  const getOrCreateSessionFn = dependencies.getOrCreateSession ?? getOrCreateSession;
  const promptStreamFn = dependencies.promptStream ?? promptStream;

  const { claimName, password } = await ensureClaimFn(thread.id);
  const client = (await createOpenCodeClientFn({ claimName, password })) as OpenCodePromptClient &
    OpenCodeSessionClient;
  const sessionId = await getOrCreateSessionFn(thread.id, client, {
    title: thread.title,
  });
  const stream = promptStreamFn(client, sessionId, message);

  await thread.post(stream);

  if (dependencies.subscribeThread) {
    await thread.subscribe();
  }
}
