import { createHash } from "node:crypto";
import { readBoolean, readNumber } from "../util.js";
import type { ThreadState } from "../types.js";
import type { PostgresRuntimeStoreOptions } from "./postgres.js";
import type { ExecutionStore } from "../execution/store.js";
import type { OutboxStore } from "../outbox/types.js";
import type { DispatcherExecutionStore } from "../dispatch/store.js";
import type {
  AgentProfile,
  Bot,
  BotAgentProfile,
  OpencodeConfig,
  OpencodeConfigRecord,
  ResolvedRuntime,
  SandboxProfile,
} from "./types.js";
import { assertOpencodeAgentExists } from "./validation.js";

export type RuntimeStoreSnapshot = {
  bots: Bot[];
  sandboxProfiles: SandboxProfile[];
  opencodeConfigs: OpencodeConfigRecord[];
  agentProfiles: AgentProfile[];
  botAgentProfiles: BotAgentProfile[];
};

export type RuntimeStore = {
  close?: () => Promise<void>;
  addBotAgentProfile: (entry: BotAgentProfile) => Promise<BotAgentProfile>;
  deleteAgentProfile: (id: string) => Promise<boolean>;
  deleteBot: (id: string) => Promise<boolean>;
  deleteBotAgentProfile: (botID: string, agentProfileID: string) => Promise<boolean>;
  deleteOpencodeConfig: (id: string) => Promise<boolean>;
  deleteSandboxProfile: (id: string) => Promise<boolean>;
  getAgentProfile: (id: string) => Promise<AgentProfile | undefined>;
  getBot: (id: string) => Promise<Bot | undefined>;
  getOpencodeConfig: (id: string) => Promise<OpencodeConfigRecord | undefined>;
  getSandboxProfile: (id: string) => Promise<SandboxProfile | undefined>;
  listAgentProfiles: () => Promise<AgentProfile[]>;
  listBotAgentProfiles: () => Promise<BotAgentProfile[]>;
  listBots: () => Promise<Bot[]>;
  listOpencodeConfigs: () => Promise<OpencodeConfigRecord[]>;
  listSandboxProfiles: () => Promise<SandboxProfile[]>;
  botBySlug: (slug: string) => Promise<Bot | undefined>;
  resolveByBotSlug: (slug: string) => Promise<ResolvedRuntime>;
  resolveByThreadState: (state: ThreadState) => Promise<ResolvedRuntime>;
  upsertAgentProfile: (profile: AgentProfile) => Promise<AgentProfile>;
  upsertBot: (bot: Bot) => Promise<Bot>;
  upsertOpencodeConfig: (config: UpsertOpencodeConfigInput) => Promise<OpencodeConfigRecord>;
  upsertSandboxProfile: (profile: SandboxProfile) => Promise<SandboxProfile>;
};

export type UpsertOpencodeConfigInput = Omit<OpencodeConfigRecord, "configHash" | "updatedAt"> & {
  updatedAt?: string;
};

export async function createRuntimeStore(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RuntimeStore & ExecutionStore & OutboxStore & DispatcherExecutionStore> {
  const { createPostgresRuntimeStore } = await import("./postgres.js");
  return createPostgresRuntimeStore(readPostgresRuntimeStoreOptions(env));
}

export async function runRuntimeMigrations(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const { migratePostgresRuntimeStore } = await import("./postgres.js");
  await migratePostgresRuntimeStore(readPostgresRuntimeStoreOptions(env));
}

function readPostgresRuntimeStoreOptions(env: NodeJS.ProcessEnv): PostgresRuntimeStoreOptions {
  const connectionString = env.AGENTBAY_DATABASE_URL ?? env.DATABASE_URL;
  const host = env.AGENTBAY_DATABASE_HOST;
  if (!connectionString && !host) {
    throw new Error("AGENTBAY_DATABASE_URL, DATABASE_URL, or AGENTBAY_DATABASE_HOST must be set");
  }

  return {
    database: env.AGENTBAY_DATABASE_NAME,
    host,
    migrationsFolder: env.AGENTBAY_DATABASE_MIGRATIONS_FOLDER,
    password: env.AGENTBAY_DATABASE_PASSWORD,
    port: readNumber(env.AGENTBAY_DATABASE_PORT, 5432),
    user: env.AGENTBAY_DATABASE_USER,
    ...(connectionString ? { connectionString } : {}),
    ssl: readBoolean(env.AGENTBAY_DATABASE_SSL, false),
    sslRejectUnauthorized: readBoolean(env.AGENTBAY_DATABASE_SSL_REJECT_UNAUTHORIZED, false),
  };
}

export function resolveRuntime(snapshot: RuntimeStoreSnapshot, bot: Bot, agentProfileID: string): ResolvedRuntime {
  const sandboxProfile = snapshot.sandboxProfiles.find((profile) => profile.id === bot.sandboxProfileID);
  if (!sandboxProfile || !sandboxProfile.enabled) {
    throw new Error(`Unknown or disabled sandbox profile for bot ${bot.slug}: ${bot.sandboxProfileID}`);
  }

  const agentProfile = snapshot.agentProfiles.find((profile) => profile.id === agentProfileID);
  if (!agentProfile || !agentProfile.enabled) {
    throw new Error(`Unknown or disabled agent profile for bot ${bot.slug}: ${agentProfileID}`);
  }

  const allowed = snapshot.botAgentProfiles.some((entry) => entry.botID === bot.id && entry.agentProfileID === agentProfile.id);
  if (!allowed) throw new Error(`Agent profile ${agentProfile.id} is not allowed for bot ${bot.slug}`);

  const opencodeConfig = snapshot.opencodeConfigs.find((config) => config.id === agentProfile.opencodeConfigID);
  if (!opencodeConfig || !opencodeConfig.enabled) {
    throw new Error(`Unknown or disabled opencode config for agent profile ${agentProfile.id}: ${agentProfile.opencodeConfigID}`);
  }
  assertOpencodeAgentExists(opencodeConfig.config, agentProfile.opencodeAgentName, opencodeConfig.id);

  return {
    agentProfile,
    bot,
    opencodeAgentName: agentProfile.opencodeAgentName,
    opencodeConfig,
    sandboxProfile,
  };
}

export function agentProfileHash(profile: AgentProfile): string {
  return createHash("sha256")
    .update(stableStringify({
      claimEnv: profile.claimEnv,
      id: profile.id,
      opencodeAgentName: profile.opencodeAgentName,
      opencodeConfigID: profile.opencodeConfigID,
      slug: profile.slug,
    }))
    .digest("hex");
}

export function botAdaptersHash(bot: Bot): string {
  return createHash("sha256")
    .update(stableStringify({
      adapters: bot.adapters,
      id: bot.id,
      slug: bot.slug,
    }))
    .digest("hex");
}

export function hashConfig(config: OpencodeConfig): string {
  return createHash("sha256").update(stableStringify(config)).digest("hex");
}

export function sandboxProfileHash(profile: SandboxProfile): string {
  return createHash("sha256")
    .update(stableStringify({
      id: profile.id,
      slug: profile.slug,
      templateName: profile.templateName,
      warmpool: profile.warmpool,
    }))
    .digest("hex");
}


function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (!isRecord(value)) return JSON.stringify(value);

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
