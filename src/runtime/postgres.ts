import path from "node:path";
import { and, asc, eq, type InferSelectModel } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import type { ThreadState } from "../types.js";
import type { AgentProfile, Bot, OpencodeConfigRecord, SandboxProfile } from "./types.js";
import {
  hashConfig,
  resolveRuntime,
  type RuntimeStore,
  type RuntimeStoreSnapshot,
  type UpsertOpencodeConfigInput,
} from "./store.js";
import * as schema from "./schema.js";
import { agentProfiles, botAgentProfiles, bots, opencodeConfigs, sandboxProfiles } from "./schema.js";
import {
  validateBotAdapters,
  validateEnvVarRefs,
  assertOpencodeAgentExists,
  assertOpencodeConfigSupportsProfiles,
  validateRuntimeID,
  validateRuntimeSlug,
} from "./validation.js";

const { Pool } = pg;

type RuntimeDatabase = NodePgDatabase<typeof schema>;

export type PostgresRuntimeStoreOptions = {
  connectionString?: string;
  database?: string;
  host?: string;
  migrationsFolder?: string;
  password?: string;
  port?: number;
  runMigrations?: boolean;
  ssl: boolean;
  user?: string;
};

export async function createPostgresRuntimeStore(options: PostgresRuntimeStoreOptions): Promise<PostgresRuntimeStore> {
  const pool = new Pool({
    connectionString: options.connectionString,
    database: options.database,
    host: options.host,
    password: options.password,
    port: options.port,
    ssl: options.ssl ? { rejectUnauthorized: false } : undefined,
    user: options.user,
  });
  const db = drizzle(pool, { schema });
  const store = new PostgresRuntimeStore(pool, db, options.migrationsFolder ?? path.resolve(process.cwd(), "drizzle"));
  if (options.runMigrations) await store.initialize();
  return store;
}

export async function migratePostgresRuntimeStore(options: PostgresRuntimeStoreOptions): Promise<void> {
  const store = await createPostgresRuntimeStore({ ...options, runMigrations: false });
  try {
    await store.initialize();
  } finally {
    await store.close();
  }
}

export class PostgresRuntimeStore implements RuntimeStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly db: RuntimeDatabase,
    private readonly migrationsFolder: string,
  ) {}

  async initialize(): Promise<void> {
    await migrate(this.db, { migrationsFolder: this.migrationsFolder });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async addBotAgentProfile(entry: { botID: string; agentProfileID: string }): Promise<{ botID: string; agentProfileID: string }> {
    validateRuntimeID(entry.botID, "botID");
    validateRuntimeID(entry.agentProfileID, "agentProfileID");
    await this.db.insert(botAgentProfiles).values(entry).onConflictDoNothing();
    return entry;
  }

  async deleteAgentProfile(id: string): Promise<boolean> {
    const rows = await this.db.delete(agentProfiles).where(eq(agentProfiles.id, id)).returning({ id: agentProfiles.id });
    return rows.length > 0;
  }

  async deleteBot(id: string): Promise<boolean> {
    const rows = await this.db.delete(bots).where(eq(bots.id, id)).returning({ id: bots.id });
    return rows.length > 0;
  }

  async deleteBotAgentProfile(botID: string, agentProfileID: string): Promise<boolean> {
    const bot = await this.getBot(botID);
    if (bot?.defaultAgentProfileID === agentProfileID) {
      throw new Error(`Cannot delete default agent profile mapping for bot ${botID}`);
    }

    const rows = await this.db
      .delete(botAgentProfiles)
      .where(and(eq(botAgentProfiles.botID, botID), eq(botAgentProfiles.agentProfileID, agentProfileID)))
      .returning({ botID: botAgentProfiles.botID });
    return rows.length > 0;
  }

  async deleteOpencodeConfig(id: string): Promise<boolean> {
    const rows = await this.db.delete(opencodeConfigs).where(eq(opencodeConfigs.id, id)).returning({ id: opencodeConfigs.id });
    return rows.length > 0;
  }

  async deleteSandboxProfile(id: string): Promise<boolean> {
    const rows = await this.db.delete(sandboxProfiles).where(eq(sandboxProfiles.id, id)).returning({ id: sandboxProfiles.id });
    return rows.length > 0;
  }

  async getAgentProfile(id: string): Promise<AgentProfile | undefined> {
    const rows = await this.db.select().from(agentProfiles).where(eq(agentProfiles.id, id)).limit(1);
    return rows[0] ? agentProfileFromRow(rows[0]) : undefined;
  }

  async getBot(id: string): Promise<Bot | undefined> {
    const rows = await this.db.select().from(bots).where(eq(bots.id, id)).limit(1);
    return rows[0] ? botFromRow(rows[0]) : undefined;
  }

  async getOpencodeConfig(id: string): Promise<OpencodeConfigRecord | undefined> {
    const rows = await this.db.select().from(opencodeConfigs).where(eq(opencodeConfigs.id, id)).limit(1);
    return rows[0] ? opencodeConfigFromRow(rows[0]) : undefined;
  }

  async getSandboxProfile(id: string): Promise<SandboxProfile | undefined> {
    const rows = await this.db.select().from(sandboxProfiles).where(eq(sandboxProfiles.id, id)).limit(1);
    return rows[0] ? sandboxProfileFromRow(rows[0]) : undefined;
  }

  async listAgentProfiles(): Promise<AgentProfile[]> {
    const rows = await this.db.select().from(agentProfiles).orderBy(asc(agentProfiles.slug));
    return rows.map(agentProfileFromRow);
  }

  async listBotAgentProfiles(): Promise<Array<{ botID: string; agentProfileID: string }>> {
    return this.db
      .select()
      .from(botAgentProfiles)
      .orderBy(asc(botAgentProfiles.botID), asc(botAgentProfiles.agentProfileID));
  }

  async listBots(): Promise<Bot[]> {
    const rows = await this.db.select().from(bots).orderBy(asc(bots.slug));
    return rows.map(botFromRow);
  }

  async listOpencodeConfigs(): Promise<OpencodeConfigRecord[]> {
    const rows = await this.db.select().from(opencodeConfigs).orderBy(asc(opencodeConfigs.slug));
    return rows.map(opencodeConfigFromRow);
  }

  async listSandboxProfiles(): Promise<SandboxProfile[]> {
    const rows = await this.db.select().from(sandboxProfiles).orderBy(asc(sandboxProfiles.slug));
    return rows.map(sandboxProfileFromRow);
  }

  async botBySlug(slug: string): Promise<Bot | undefined> {
    const rows = await this.db.select().from(bots).where(eq(bots.slug, slug)).limit(1);
    return rows[0] ? botFromRow(rows[0]) : undefined;
  }

  async resolveByBotSlug(slug: string): Promise<ReturnType<typeof resolveRuntime>> {
    const snapshot = await this.snapshot();
    const bot = snapshot.bots.find((candidate) => candidate.slug === slug);
    if (!bot || !bot.enabled) throw new Error(`Unknown or disabled bot: ${slug}`);
    return resolveRuntime(snapshot, bot, bot.defaultAgentProfileID);
  }

  async resolveByThreadState(state: ThreadState): Promise<ReturnType<typeof resolveRuntime>> {
    const snapshot = await this.snapshot();
    const bot = snapshot.bots.find((candidate) => candidate.id === state.botID);
    if (!bot || !bot.enabled) throw new Error(`Unknown or disabled bot: ${state.botID}`);
    return resolveRuntime(snapshot, bot, state.agentProfileID);
  }

  async upsertAgentProfile(profile: AgentProfile): Promise<AgentProfile> {
    validateRuntimeID(profile.id, "id");
    validateRuntimeSlug(profile.slug, "slug");
    validateRuntimeID(profile.opencodeConfigID, "opencodeConfigID");
    validateEnvVarRefs(profile.claimEnv, "claimEnv");

    const opencodeConfig = await this.getOpencodeConfig(profile.opencodeConfigID);
    if (!opencodeConfig) throw new Error(`Unknown opencode config: ${profile.opencodeConfigID}`);
    assertOpencodeAgentExists(opencodeConfig.config, profile.opencodeAgentName, opencodeConfig.id);

    const rows = await this.db
      .insert(agentProfiles)
      .values(profile)
      .onConflictDoUpdate({
        set: {
          claimEnv: profile.claimEnv,
          displayName: profile.displayName,
          enabled: profile.enabled,
          opencodeAgentName: profile.opencodeAgentName,
          opencodeConfigID: profile.opencodeConfigID,
          slug: profile.slug,
        },
        target: agentProfiles.id,
      })
      .returning();
    return agentProfileFromRow(rows[0] ?? missingRow("agent profile", profile.id));
  }

  async upsertBot(bot: Bot): Promise<Bot> {
    validateRuntimeID(bot.id, "id");
    validateRuntimeSlug(bot.slug, "slug");
    validateRuntimeID(bot.defaultAgentProfileID, "defaultAgentProfileID");
    validateRuntimeID(bot.sandboxProfileID, "sandboxProfileID");
    validateBotAdapters(bot.adapters);

    return this.db.transaction(async (tx) => {
      const rows = await tx
        .insert(bots)
        .values(bot)
        .onConflictDoUpdate({
          set: {
            adapters: bot.adapters,
            defaultAgentProfileID: bot.defaultAgentProfileID,
            displayName: bot.displayName,
            enabled: bot.enabled,
            sandboxProfileID: bot.sandboxProfileID,
            slug: bot.slug,
          },
          target: bots.id,
        })
        .returning();
      await tx
        .insert(botAgentProfiles)
        .values({ agentProfileID: bot.defaultAgentProfileID, botID: bot.id })
        .onConflictDoNothing();
      return botFromRow(rows[0] ?? missingRow("bot", bot.id));
    });
  }

  async upsertOpencodeConfig(input: UpsertOpencodeConfigInput): Promise<OpencodeConfigRecord> {
    validateRuntimeID(input.id, "id");
    validateRuntimeSlug(input.slug, "slug");

    const updatedAt = input.updatedAt ? new Date(input.updatedAt) : new Date();
    const configHash = hashConfig(input.config);
    assertOpencodeConfigSupportsProfiles(
      { ...input, configHash, updatedAt: updatedAt.toISOString() },
      (await this.listAgentProfiles()).filter((profile) => profile.opencodeConfigID === input.id),
    );

    const rows = await this.db
      .insert(opencodeConfigs)
      .values({ ...input, configHash, updatedAt })
      .onConflictDoUpdate({
        set: {
          config: input.config,
          configHash,
          displayName: input.displayName,
          enabled: input.enabled,
          slug: input.slug,
          updatedAt,
        },
        target: opencodeConfigs.id,
      })
      .returning();
    return opencodeConfigFromRow(rows[0] ?? missingRow("opencode config", input.id));
  }

  async upsertSandboxProfile(profile: SandboxProfile): Promise<SandboxProfile> {
    validateRuntimeID(profile.id, "id");
    validateRuntimeSlug(profile.slug, "slug");

    const rows = await this.db
      .insert(sandboxProfiles)
      .values(profile)
      .onConflictDoUpdate({
        set: {
          enabled: profile.enabled,
          slug: profile.slug,
          templateName: profile.templateName,
          warmpool: profile.warmpool,
        },
        target: sandboxProfiles.id,
      })
      .returning();
    return sandboxProfileFromRow(rows[0] ?? missingRow("sandbox profile", profile.id));
  }

  private async snapshot(): Promise<RuntimeStoreSnapshot> {
    const [botRows, sandboxProfileRows, opencodeConfigRows, agentProfileRows, botAgentProfileRows] = await Promise.all([
      this.db.select().from(bots),
      this.db.select().from(sandboxProfiles),
      this.db.select().from(opencodeConfigs),
      this.db.select().from(agentProfiles),
      this.db.select().from(botAgentProfiles),
    ]);

    return {
      agentProfiles: agentProfileRows.map(agentProfileFromRow),
      botAgentProfiles: botAgentProfileRows,
      bots: botRows.map(botFromRow),
      opencodeConfigs: opencodeConfigRows.map(opencodeConfigFromRow),
      sandboxProfiles: sandboxProfileRows.map(sandboxProfileFromRow),
    };
  }
}

type BotRow = InferSelectModel<typeof bots>;
type SandboxProfileRow = InferSelectModel<typeof sandboxProfiles>;
type OpencodeConfigRow = InferSelectModel<typeof opencodeConfigs>;
type AgentProfileRow = InferSelectModel<typeof agentProfiles>;

function botFromRow(row: BotRow): Bot {
  return {
    adapters: row.adapters,
    defaultAgentProfileID: row.defaultAgentProfileID,
    displayName: row.displayName,
    enabled: row.enabled,
    id: row.id,
    sandboxProfileID: row.sandboxProfileID,
    slug: row.slug,
  };
}

function sandboxProfileFromRow(row: SandboxProfileRow): SandboxProfile {
  return {
    enabled: row.enabled,
    id: row.id,
    slug: row.slug,
    templateName: row.templateName,
    warmpool: row.warmpool,
  };
}

function opencodeConfigFromRow(row: OpencodeConfigRow): OpencodeConfigRecord {
  return {
    config: row.config,
    configHash: hashConfig(row.config),
    displayName: row.displayName,
    enabled: row.enabled,
    id: row.id,
    slug: row.slug,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function agentProfileFromRow(row: AgentProfileRow): AgentProfile {
  return {
    claimEnv: row.claimEnv,
    displayName: row.displayName,
    enabled: row.enabled,
    id: row.id,
    opencodeAgentName: row.opencodeAgentName,
    opencodeConfigID: row.opencodeConfigID,
    slug: row.slug,
  };
}

function missingRow(kind: string, id: string): never {
  throw new Error(`Failed to return ${kind}: ${id}`);
}
