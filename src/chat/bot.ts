import { createDiscordAdapter } from "@chat-adapter/discord";
import { createGoogleChatAdapter } from "@chat-adapter/gchat";
import { createGitHubAdapter } from "@chat-adapter/github";
import { createLinearAdapter } from "@chat-adapter/linear";
import { createMessengerAdapter } from "@chat-adapter/messenger";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createTeamsAdapter } from "@chat-adapter/teams";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { createWhatsAppAdapter } from "@chat-adapter/whatsapp";
import { Chat, type Adapter } from "chat";
import type { Config } from "../config.js";
import { logger } from "../logger.js";
import type { RuntimeStore } from "../runtime/store.js";
import { botAdaptersHash } from "../runtime/store.js";
import type { Bot } from "../runtime/types.js";
import type { SandboxManager } from "../sandbox/manager.js";
import { createStateAdapter } from "../state/adapter.js";
import type { ThreadState } from "../types.js";
import { registerHandlers } from "./handlers.js";

export type BotChatRegistry = {
  chatForBot: (bot: Bot) => Promise<Chat<Record<string, Adapter>, ThreadState>>;
  shutdown: () => Promise<void>;
};

export function createBot(
  config: Config,
  sandboxManager: SandboxManager,
  runtimeStore: RuntimeStore,
): Chat<Record<string, Adapter>, ThreadState> {
  return createBotChat(config, sandboxManager, runtimeStore);
}

export function createBotRegistry(
  config: Config,
  sandboxManager: SandboxManager,
  runtimeStore: RuntimeStore,
): BotChatRegistry {
  const chats = new Map<string, { chat: Chat<Record<string, Adapter>, ThreadState>; hash: string }>();

  return {
    async chatForBot(bot) {
      const hash = botAdaptersHash(bot);
      const cached = chats.get(bot.slug);
      if (cached?.hash === hash) return cached.chat;

      if (cached) {
        logger.info("recycling bot chat (adapter config changed)", { botSlug: bot.slug });
        await cached.chat.shutdown();
      } else {
        logger.info("creating bot chat", { botSlug: bot.slug });
      }

      const chat = createBotChat(config, sandboxManager, runtimeStore, bot);
      chats.set(bot.slug, { chat, hash });
      return chat;
    },
    async shutdown() {
      await Promise.all([...chats.values()].map(({ chat }) => chat.shutdown()));
      chats.clear();
    },
  };
}

function createBotChat(
  config: Config,
  sandboxManager: SandboxManager,
  runtimeStore: RuntimeStore,
  bot?: Bot,
): Chat<Record<string, Adapter>, ThreadState> {
  const adapters: Record<string, Adapter> = {};
  const state = createStateAdapter(config);

  if (config.slack.enabled) {
    adapters.slack = createSlackAdapter({ userName: config.botUserName });
  }

  if (config.teams.enabled) {
    adapters.teams = createTeamsAdapter({ userName: config.botUserName });
  }

  if (config.gchat.enabled) {
    adapters.gchat = createGoogleChatAdapter({ userName: config.botUserName });
  }

  if (config.discord.enabled) {
    adapters.discord = createDiscordAdapter({ userName: config.botUserName });
  }

  if (config.telegram.enabled || bot?.adapters.telegram) {
    const telegram = bot?.adapters.telegram;
    if (!telegram?.botTokenEnv && !process.env.TELEGRAM_BOT_TOKEN) {
      throw new Error(
        `Telegram is enabled, but ${bot ? `bot ${bot.slug} does not configure adapters.telegram.botTokenEnv and ` : ""}TELEGRAM_BOT_TOKEN is unset`,
      );
    }

    adapters.telegram = createTelegramAdapter({
      ...(telegram?.botTokenEnv ? { botToken: readSecret(telegram.botTokenEnv, bot) } : {}),
      ...(telegram?.secretTokenEnv ? { secretToken: readSecret(telegram.secretTokenEnv, bot) } : {}),
      userName: telegram?.userName ?? config.botUserName,
    });
  }

  if (config.github.enabled) {
    adapters.github = createGitHubAdapter({ userName: config.botUserName });
  }

  if (config.linear.enabled) {
    adapters.linear = createLinearAdapter({ userName: config.botUserName });
  }

  if (config.whatsapp.enabled) {
    adapters.whatsapp = createWhatsAppAdapter({ userName: config.botUserName });
  }

  if (config.messenger.enabled) {
    adapters.messenger = createMessengerAdapter({ userName: config.botUserName });
  }

  const chat = new Chat<Record<string, Adapter>, ThreadState>({
    adapters,
    concurrency: "concurrent",
    fallbackStreamingPlaceholderText: "Working...",
    state,
    streamingUpdateIntervalMs: 750,
    userName: config.botUserName,
  });

  registerHandlers(chat, { config, runtimeStore, sandboxManager, state });
  return chat;
}

function readSecret(envName: string, bot: Bot | undefined): string {
  const value = process.env[envName];
  if (!value) throw new Error(`Missing environment variable ${envName}${bot ? ` for bot ${bot.slug}` : ""}`);
  return value;
}
