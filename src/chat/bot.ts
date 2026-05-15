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
import type { SandboxManager } from "../sandbox/manager.js";
import { createStateAdapter } from "../state/adapter.js";
import type { ThreadState } from "../types.js";
import { registerHandlers } from "./handlers.js";

export function createBot(config: Config, sandboxManager: SandboxManager): Chat<Record<string, Adapter>, ThreadState> {
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

  if (config.telegram.enabled) {
    adapters.telegram = createTelegramAdapter({ userName: config.botUserName });
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

  registerHandlers(chat, { config, sandboxManager, state });
  return chat;
}
