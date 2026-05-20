import { boolean, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import type { OpencodeConfig } from "./types.js";

export const sandboxProfiles = pgTable("agentbay_sandbox_profiles", {
  enabled: boolean("enabled").notNull().default(true),
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  templateName: text("template_name").notNull(),
  warmpool: text("warmpool").notNull().default("none"),
});

export const opencodeConfigs = pgTable("agentbay_opencode_configs", {
  config: jsonb("config").$type<OpencodeConfig>().notNull().default({}),
  configHash: text("config_hash").notNull(),
  displayName: text("display_name").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agentProfiles = pgTable("agentbay_agent_profiles", {
  displayName: text("display_name").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  id: text("id").primaryKey(),
  opencodeAgentName: text("opencode_agent_name").notNull(),
  opencodeConfigID: text("opencode_config_id")
    .notNull()
    .references(() => opencodeConfigs.id),
  slug: text("slug").notNull().unique(),
});

export const bots = pgTable("agentbay_bots", {
  defaultAgentProfileID: text("default_agent_profile_id")
    .notNull()
    .references(() => agentProfiles.id),
  displayName: text("display_name").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  id: text("id").primaryKey(),
  sandboxProfileID: text("sandbox_profile_id")
    .notNull()
    .references(() => sandboxProfiles.id),
  slug: text("slug").notNull().unique(),
});

export const botAgentProfiles = pgTable(
  "agentbay_bot_agent_profiles",
  {
    agentProfileID: text("agent_profile_id")
      .notNull()
      .references(() => agentProfiles.id, { onDelete: "cascade" }),
    botID: text("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.botID, table.agentProfileID] })],
);
