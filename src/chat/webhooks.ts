import type { Adapter, Chat } from "chat";
import type { Hono } from "hono";
import type { Config } from "../config.js";
import type { ThreadState } from "../types.js";

export function mountWebhooks(app: Hono, chat: Chat<Record<string, Adapter>, ThreadState>, config: Config): void {
  for (const adapterName of enabledWebhookAdapters(config)) {
    app.all(`/webhooks/${adapterName}`, (context) => {
      const handler = chat.webhooks[adapterName];
      if (!handler) return context.text(`${adapterName} adapter is not enabled`, 404);
      return handler(context.req.raw);
    });
  }
}

function enabledWebhookAdapters(config: Config): string[] {
  return [
    config.slack.enabled ? "slack" : undefined,
    config.teams.enabled ? "teams" : undefined,
    config.gchat.enabled ? "gchat" : undefined,
    config.discord.enabled ? "discord" : undefined,
    config.telegram.enabled ? "telegram" : undefined,
    config.github.enabled ? "github" : undefined,
    config.linear.enabled ? "linear" : undefined,
    config.whatsapp.enabled ? "whatsapp" : undefined,
    config.messenger.enabled ? "messenger" : undefined,
  ].filter((adapterName): adapterName is string => adapterName !== undefined);
}
