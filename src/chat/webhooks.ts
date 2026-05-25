import type { Adapter, Chat } from "chat";
import type { Hono } from "hono";
import { runWithBotSlug } from "../runtime/context.js";
import type { RuntimeStore } from "../runtime/store.js";
import type { Bot } from "../runtime/types.js";
import type { ThreadState } from "../types.js";
import type { BotChatRegistry } from "./bot.js";

type ChatSource = Chat<Record<string, Adapter>, ThreadState> | BotChatRegistry;

export function mountWebhooks(
  app: Hono<any>,
  chat: ChatSource,
  runtimeStore: RuntimeStore,
): void {
  app.all("/agents/:botSlug/webhooks/:adapterName", async (context) => {
    const adapterName = context.req.param("adapterName");
    const botSlug = context.req.param("botSlug");
    const bot = await runtimeStore.botBySlug(botSlug);
    if (!bot || !bot.enabled) return context.text(`Unknown agent bot: ${botSlug}`, 404);

    const botChat = await chatForBot(chat, bot);
    const handler = botChat.webhooks[adapterName];
    if (!handler) return context.text(`${adapterName} adapter is not enabled for bot ${botSlug}`, 404);
    return runWithBotSlug(botSlug, () => handler(context.req.raw));
  });
}

async function chatForBot(chat: ChatSource, bot: Bot): Promise<Chat<Record<string, Adapter>, ThreadState>> {
  if ("chatForBot" in chat) return chat.chatForBot(bot);
  return chat;
}
