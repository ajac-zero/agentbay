import pg from "pg";
import type { ThreadState } from "../types.js";
import type { AgentProfile, Bot, OpencodeConfig, OpencodeConfigRecord, SandboxProfile } from "./types.js";
import {
  hashConfig,
  resolveRuntime,
  type RuntimeStore,
  type RuntimeStoreSnapshot,
  type UpsertOpencodeConfigInput,
} from "./store.js";

const { Pool } = pg;

export type PostgresRuntimeStoreOptions = {
  connectionString?: string;
  database?: string;
  host?: string;
  password?: string;
  port?: number;
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
  const store = new PostgresRuntimeStore(pool);
  await store.initialize();
  return store;
}

export class PostgresRuntimeStore implements RuntimeStore {
  constructor(private readonly pool: pg.Pool) {}

  async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await createSchema(client);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async addBotAgentProfile(entry: { botID: string; agentProfileID: string }): Promise<{ botID: string; agentProfileID: string }> {
    await this.pool.query(
      `insert into agentbay_bot_agent_profiles (bot_id, agent_profile_id)
       values ($1, $2)
       on conflict do nothing`,
      [entry.botID, entry.agentProfileID],
    );
    return entry;
  }

  async deleteAgentProfile(id: string): Promise<boolean> {
    const result = await this.pool.query("delete from agentbay_agent_profiles where id = $1", [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async deleteBot(id: string): Promise<boolean> {
    const result = await this.pool.query("delete from agentbay_bots where id = $1", [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async deleteBotAgentProfile(botID: string, agentProfileID: string): Promise<boolean> {
    const bot = await this.getBot(botID);
    if (bot?.defaultAgentProfileID === agentProfileID) {
      throw new Error(`Cannot delete default agent profile mapping for bot ${botID}`);
    }

    const result = await this.pool.query("delete from agentbay_bot_agent_profiles where bot_id = $1 and agent_profile_id = $2", [
      botID,
      agentProfileID,
    ]);
    return (result.rowCount ?? 0) > 0;
  }

  async deleteOpencodeConfig(id: string): Promise<boolean> {
    const result = await this.pool.query("delete from agentbay_opencode_configs where id = $1", [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async deleteSandboxProfile(id: string): Promise<boolean> {
    const result = await this.pool.query("delete from agentbay_sandbox_profiles where id = $1", [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async getAgentProfile(id: string): Promise<AgentProfile | undefined> {
    const { rows } = await this.pool.query<AgentProfileRow>(
      "select id, slug, display_name, opencode_config_id, opencode_agent_name, enabled from agentbay_agent_profiles where id = $1",
      [id],
    );
    return rows[0] ? agentProfileFromRow(rows[0]) : undefined;
  }

  async getBot(id: string): Promise<Bot | undefined> {
    const { rows } = await this.pool.query<BotRow>(
      "select id, slug, display_name, sandbox_profile_id, default_agent_profile_id, enabled from agentbay_bots where id = $1",
      [id],
    );
    return rows[0] ? botFromRow(rows[0]) : undefined;
  }

  async getOpencodeConfig(id: string): Promise<OpencodeConfigRecord | undefined> {
    const { rows } = await this.pool.query<OpencodeConfigRow>(
      "select id, slug, display_name, config, updated_at, enabled from agentbay_opencode_configs where id = $1",
      [id],
    );
    return rows[0] ? opencodeConfigFromRow(rows[0]) : undefined;
  }

  async getSandboxProfile(id: string): Promise<SandboxProfile | undefined> {
    const { rows } = await this.pool.query<SandboxProfileRow>(
      "select id, slug, template_name, warmpool, enabled from agentbay_sandbox_profiles where id = $1",
      [id],
    );
    return rows[0] ? sandboxProfileFromRow(rows[0]) : undefined;
  }

  async listAgentProfiles(): Promise<AgentProfile[]> {
    const { rows } = await this.pool.query<AgentProfileRow>(
      "select id, slug, display_name, opencode_config_id, opencode_agent_name, enabled from agentbay_agent_profiles order by slug",
    );
    return rows.map(agentProfileFromRow);
  }

  async listBotAgentProfiles(): Promise<Array<{ botID: string; agentProfileID: string }>> {
    const { rows } = await this.pool.query<BotAgentProfileRow>(
      "select bot_id, agent_profile_id from agentbay_bot_agent_profiles order by bot_id, agent_profile_id",
    );
    return rows.map((row) => ({ agentProfileID: row.agent_profile_id, botID: row.bot_id }));
  }

  async listBots(): Promise<Bot[]> {
    const { rows } = await this.pool.query<BotRow>(
      "select id, slug, display_name, sandbox_profile_id, default_agent_profile_id, enabled from agentbay_bots order by slug",
    );
    return rows.map(botFromRow);
  }

  async listOpencodeConfigs(): Promise<OpencodeConfigRecord[]> {
    const { rows } = await this.pool.query<OpencodeConfigRow>(
      "select id, slug, display_name, config, updated_at, enabled from agentbay_opencode_configs order by slug",
    );
    return rows.map(opencodeConfigFromRow);
  }

  async listSandboxProfiles(): Promise<SandboxProfile[]> {
    const { rows } = await this.pool.query<SandboxProfileRow>(
      "select id, slug, template_name, warmpool, enabled from agentbay_sandbox_profiles order by slug",
    );
    return rows.map(sandboxProfileFromRow);
  }

  async botBySlug(slug: string): Promise<Bot | undefined> {
    const { rows } = await this.pool.query<BotRow>(
      "select id, slug, display_name, sandbox_profile_id, default_agent_profile_id, enabled from agentbay_bots where slug = $1",
      [slug],
    );
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
    const { rows } = await this.pool.query<AgentProfileRow>(
      `insert into agentbay_agent_profiles (id, slug, display_name, opencode_config_id, opencode_agent_name, enabled)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (id) do update set
         slug = excluded.slug,
         display_name = excluded.display_name,
         opencode_config_id = excluded.opencode_config_id,
         opencode_agent_name = excluded.opencode_agent_name,
         enabled = excluded.enabled
       returning id, slug, display_name, opencode_config_id, opencode_agent_name, enabled`,
      [profile.id, profile.slug, profile.displayName, profile.opencodeConfigID, profile.opencodeAgentName, profile.enabled],
    );
    return agentProfileFromRow(rows[0] ?? missingRow("agent profile", profile.id));
  }

  async upsertBot(bot: Bot): Promise<Bot> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const { rows } = await client.query<BotRow>(
        `insert into agentbay_bots (id, slug, display_name, sandbox_profile_id, default_agent_profile_id, enabled)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (id) do update set
           slug = excluded.slug,
           display_name = excluded.display_name,
           sandbox_profile_id = excluded.sandbox_profile_id,
           default_agent_profile_id = excluded.default_agent_profile_id,
           enabled = excluded.enabled
         returning id, slug, display_name, sandbox_profile_id, default_agent_profile_id, enabled`,
        [bot.id, bot.slug, bot.displayName, bot.sandboxProfileID, bot.defaultAgentProfileID, bot.enabled],
      );
      await client.query(
        `insert into agentbay_bot_agent_profiles (bot_id, agent_profile_id)
         values ($1, $2)
         on conflict do nothing`,
        [bot.id, bot.defaultAgentProfileID],
      );
      await client.query("commit");
      return botFromRow(rows[0] ?? missingRow("bot", bot.id));
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async upsertOpencodeConfig(input: UpsertOpencodeConfigInput): Promise<OpencodeConfigRecord> {
    const updatedAt = input.updatedAt ?? new Date().toISOString();
    const configHash = hashConfig(input.config);
    const { rows } = await this.pool.query<OpencodeConfigRow>(
      `insert into agentbay_opencode_configs (id, slug, display_name, config, config_hash, updated_at, enabled)
       values ($1, $2, $3, $4::jsonb, $5, $6, $7)
       on conflict (id) do update set
         slug = excluded.slug,
         display_name = excluded.display_name,
         config = excluded.config,
         config_hash = excluded.config_hash,
         updated_at = excluded.updated_at,
         enabled = excluded.enabled
       returning id, slug, display_name, config, updated_at, enabled`,
      [input.id, input.slug, input.displayName, JSON.stringify(input.config), configHash, updatedAt, input.enabled],
    );
    return opencodeConfigFromRow(rows[0] ?? missingRow("opencode config", input.id));
  }

  async upsertSandboxProfile(profile: SandboxProfile): Promise<SandboxProfile> {
    const { rows } = await this.pool.query<SandboxProfileRow>(
      `insert into agentbay_sandbox_profiles (id, slug, template_name, warmpool, enabled)
       values ($1, $2, $3, $4, $5)
       on conflict (id) do update set
         slug = excluded.slug,
         template_name = excluded.template_name,
         warmpool = excluded.warmpool,
         enabled = excluded.enabled
       returning id, slug, template_name, warmpool, enabled`,
      [profile.id, profile.slug, profile.templateName, profile.warmpool, profile.enabled],
    );
    return sandboxProfileFromRow(rows[0] ?? missingRow("sandbox profile", profile.id));
  }

  private async snapshot(): Promise<RuntimeStoreSnapshot> {
    const [bots, sandboxProfiles, opencodeConfigs, agentProfiles, botAgentProfiles] = await Promise.all([
      this.pool.query<BotRow>(
        "select id, slug, display_name, sandbox_profile_id, default_agent_profile_id, enabled from agentbay_bots",
      ),
      this.pool.query<SandboxProfileRow>("select id, slug, template_name, warmpool, enabled from agentbay_sandbox_profiles"),
      this.pool.query<OpencodeConfigRow>("select id, slug, display_name, config, updated_at, enabled from agentbay_opencode_configs"),
      this.pool.query<AgentProfileRow>(
        "select id, slug, display_name, opencode_config_id, opencode_agent_name, enabled from agentbay_agent_profiles",
      ),
      this.pool.query<BotAgentProfileRow>("select bot_id, agent_profile_id from agentbay_bot_agent_profiles"),
    ]);

    return {
      agentProfiles: agentProfiles.rows.map(agentProfileFromRow),
      botAgentProfiles: botAgentProfiles.rows.map((row) => ({ agentProfileID: row.agent_profile_id, botID: row.bot_id })),
      bots: bots.rows.map(botFromRow),
      opencodeConfigs: opencodeConfigs.rows.map(opencodeConfigFromRow),
      sandboxProfiles: sandboxProfiles.rows.map(sandboxProfileFromRow),
    };
  }
}

type BotRow = {
  id: string;
  slug: string;
  display_name: string;
  sandbox_profile_id: string;
  default_agent_profile_id: string;
  enabled: boolean;
};

type SandboxProfileRow = {
  id: string;
  slug: string;
  template_name: string;
  warmpool: string;
  enabled: boolean;
};

type OpencodeConfigRow = {
  id: string;
  slug: string;
  display_name: string;
  config: OpencodeConfig;
  updated_at: Date;
  enabled: boolean;
};

type AgentProfileRow = {
  id: string;
  slug: string;
  display_name: string;
  opencode_config_id: string;
  opencode_agent_name: string;
  enabled: boolean;
};

type BotAgentProfileRow = {
  bot_id: string;
  agent_profile_id: string;
};

async function createSchema(client: pg.PoolClient): Promise<void> {
  await client.query(`
    create table if not exists agentbay_sandbox_profiles (
      id text primary key,
      slug text not null unique,
      template_name text not null,
      warmpool text not null default 'none',
      enabled boolean not null default true
    )
  `);

  await client.query(`
    create table if not exists agentbay_opencode_configs (
      id text primary key,
      slug text not null unique,
      display_name text not null,
      config jsonb not null default '{}'::jsonb,
      config_hash text not null,
      updated_at timestamptz not null default now(),
      enabled boolean not null default true
    )
  `);

  await client.query(`
    create table if not exists agentbay_agent_profiles (
      id text primary key,
      slug text not null unique,
      display_name text not null,
      opencode_config_id text not null references agentbay_opencode_configs(id),
      opencode_agent_name text not null,
      enabled boolean not null default true
    )
  `);

  await client.query(`
    create table if not exists agentbay_bots (
      id text primary key,
      slug text not null unique,
      display_name text not null,
      sandbox_profile_id text not null references agentbay_sandbox_profiles(id),
      default_agent_profile_id text not null references agentbay_agent_profiles(id),
      enabled boolean not null default true
    )
  `);

  await client.query(`
    create table if not exists agentbay_bot_agent_profiles (
      bot_id text not null references agentbay_bots(id) on delete cascade,
      agent_profile_id text not null references agentbay_agent_profiles(id) on delete cascade,
      primary key (bot_id, agent_profile_id)
    )
  `);
}

function botFromRow(row: BotRow): Bot {
  return {
    defaultAgentProfileID: row.default_agent_profile_id,
    displayName: row.display_name,
    enabled: row.enabled,
    id: row.id,
    sandboxProfileID: row.sandbox_profile_id,
    slug: row.slug,
  };
}

function sandboxProfileFromRow(row: SandboxProfileRow): SandboxProfile {
  return {
    enabled: row.enabled,
    id: row.id,
    slug: row.slug,
    templateName: row.template_name,
    warmpool: row.warmpool,
  };
}

function opencodeConfigFromRow(row: OpencodeConfigRow): OpencodeConfigRecord {
  return {
    config: row.config,
    configHash: hashConfig(row.config),
    displayName: row.display_name,
    enabled: row.enabled,
    id: row.id,
    slug: row.slug,
    updatedAt: row.updated_at.toISOString(),
  };
}

function agentProfileFromRow(row: AgentProfileRow): AgentProfile {
  return {
    displayName: row.display_name,
    enabled: row.enabled,
    id: row.id,
    opencodeAgentName: row.opencode_agent_name,
    opencodeConfigID: row.opencode_config_id,
    slug: row.slug,
  };
}

function missingRow(kind: string, id: string): never {
  throw new Error(`Failed to return ${kind}: ${id}`);
}
