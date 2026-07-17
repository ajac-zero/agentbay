import path from "node:path";
import { randomUUID } from "node:crypto";
import { and, asc, eq, type InferSelectModel } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import type { ThreadState } from "../types.js";
import type {
  CreateExecutionCommand,
  CreateExecutionResult,
  ExecutionStore,
  PublishProfileVersionCommand,
} from "../execution/store.js";
import type {
  ClaimedOutboxMessage,
  OutboxStore,
} from "../outbox/types.js";
import {
  IdempotencyConflictError,
  ProfileVersionAlreadyExistsError,
  ProfileVersionNotFoundError,
  type AgentProfileVersion,
  type Execution,
  type JsonObject,
} from "../execution/types.js";
import type { AgentProfile, Bot, OpencodeConfigRecord, SandboxProfile } from "./types.js";
import {
  hashConfig,
  resolveRuntime,
  type RuntimeStore,
  type RuntimeStoreSnapshot,
  type UpsertOpencodeConfigInput,
} from "./store.js";
import * as schema from "./schema.js";
import {
  agentProfiles,
  agentProfileVersions,
  botAgentProfiles,
  bots,
  events,
  executions,
  executionTransitions,
  opencodeConfigs,
  outboxEntries,
  sandboxProfiles,
} from "./schema.js";
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
  sslRejectUnauthorized: boolean;
  user?: string;
};

export async function createPostgresRuntimeStore(options: PostgresRuntimeStoreOptions): Promise<PostgresRuntimeStore> {
  const pool = new Pool({
    connectionString: options.connectionString,
    database: options.database,
    host: options.host,
    password: options.password,
    port: options.port,
    ssl: options.ssl ? { rejectUnauthorized: options.sslRejectUnauthorized } : undefined,
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

export class PostgresRuntimeStore implements RuntimeStore, ExecutionStore, OutboxStore {
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

  async claimAvailable(options: {
    claimToken: string;
    limit: number;
    leaseDurationMs: number;
    signal?: AbortSignal;
  }): Promise<ClaimedOutboxMessage[]> {
    assertPositiveInteger(options.limit, "Outbox claim limit");
    assertPositiveInteger(options.leaseDurationMs, "Outbox lease duration");
    options.signal?.throwIfAborted();

    const result = await this.pool.query<ClaimedOutboxRow>({
      text: `
      WITH claim_clock AS MATERIALIZED (
        SELECT clock_timestamp() AS claimed_at
      ), candidates AS (
        SELECT outbox.id
        FROM agentbay_outbox AS outbox, claim_clock
        WHERE outbox.published_at IS NULL
          AND outbox.available_at <= claim_clock.claimed_at
          AND (outbox.lease_expires_at IS NULL OR outbox.lease_expires_at <= claim_clock.claimed_at)
        ORDER BY outbox.available_at, outbox.created_at, outbox.id
        FOR UPDATE OF outbox SKIP LOCKED
        LIMIT $1
      )
      UPDATE agentbay_outbox AS outbox
      SET lease_token = $2,
          lease_expires_at = claim_clock.claimed_at + ($3::double precision * interval '1 millisecond'),
          publish_attempts = outbox.publish_attempts + 1
      FROM candidates, claim_clock
      WHERE outbox.id = candidates.id
      RETURNING outbox.aggregate_id, outbox.aggregate_type, outbox.available_at, outbox.created_at,
                outbox.headers, outbox.id, outbox.lease_expires_at, outbox.lease_token,
                outbox.payload, outbox.publish_attempts, outbox.tenant_id, outbox.topic
      `,
      values: [options.limit, options.claimToken, options.leaseDurationMs],
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

    return result.rows.map(outboxMessageFromRow);
  }

  async markPublished(command: { id: string; claimToken: string }): Promise<boolean> {
    const result = await this.pool.query(`
      UPDATE agentbay_outbox
      SET published_at = clock_timestamp(), lease_token = NULL, lease_expires_at = NULL, last_error = NULL
      WHERE id = $1 AND published_at IS NULL AND lease_token = $2 AND lease_expires_at > clock_timestamp()
      RETURNING id
    `, [command.id, command.claimToken]);
    return result.rowCount === 1;
  }

  async markFailed(command: { id: string; claimToken: string; error: string; retryDelayMs: number }): Promise<boolean> {
    assertNonnegativeInteger(command.retryDelayMs, "Outbox retry delay");
    const result = await this.pool.query(`
      UPDATE agentbay_outbox
      SET available_at = clock_timestamp() + ($3::double precision * interval '1 millisecond'),
          lease_token = NULL, lease_expires_at = NULL, last_error = $4
      WHERE id = $1 AND published_at IS NULL AND lease_token = $2 AND lease_expires_at > clock_timestamp()
      RETURNING id
    `, [command.id, command.claimToken, command.retryDelayMs, command.error]);
    return result.rowCount === 1;
  }

  async publishProfileVersion(command: PublishProfileVersionCommand): Promise<AgentProfileVersion> {
    const rows = await this.db
      .insert(agentProfileVersions)
      .values({
        createdAt: new Date(command.createdAt),
        definition: command.definition,
        id: command.id,
        profileID: command.profileId,
        tenantID: command.tenantId,
        version: command.version,
      })
      .onConflictDoNothing()
      .returning();
    const row = rows[0];
    if (!row) throw new ProfileVersionAlreadyExistsError(command.profileId, command.version);
    return profileVersionFromRow(row);
  }

  async getProfileVersion(tenantId: string, profileId: string, version: number): Promise<AgentProfileVersion | undefined> {
    const rows = await this.db
      .select()
      .from(agentProfileVersions)
      .where(and(
        eq(agentProfileVersions.tenantID, tenantId),
        eq(agentProfileVersions.profileID, profileId),
        eq(agentProfileVersions.version, version),
      ))
      .limit(1);
    return rows[0] ? profileVersionFromRow(rows[0]) : undefined;
  }

  async createExecution(command: CreateExecutionCommand): Promise<CreateExecutionResult> {
    return this.db.transaction(async (tx) => {
      const existingRows = await tx
        .select()
        .from(executions)
        .where(and(eq(executions.tenantID, command.tenantId), eq(executions.idempotencyKey, command.idempotencyKey)))
        .limit(1);
      const existing = existingRows[0];
      if (existing) {
        if (existing.requestHash !== command.requestHash) throw new IdempotencyConflictError();
        return { execution: await executionFromRow(tx, existing), replayed: true };
      }

      const profileRows = await tx
        .select()
        .from(agentProfileVersions)
        .where(and(
          eq(agentProfileVersions.tenantID, command.tenantId),
          eq(agentProfileVersions.profileID, command.profile.id),
          eq(agentProfileVersions.version, command.profile.version),
        ))
        .limit(1);
      const profile = profileRows[0];
      if (!profile) throw new ProfileVersionNotFoundError(command.profile.id, command.profile.version);
      const timeoutSeconds = profileTimeoutSeconds(profile.definition);

      const createdAt = new Date(command.createdAt);
      await tx.insert(events).values({
        data: command.event.data,
        eventID: command.event.id,
        eventTime: new Date(command.event.time),
        id: command.event.id,
        source: command.event.source,
        tenantID: command.tenantId,
        type: command.event.type,
      });

      const inserted = await tx
        .insert(executions)
        .values({
          createdAt,
          eventID: command.event.id,
          id: command.id,
          idempotencyKey: command.idempotencyKey,
          input: command.input,
          profileVersionID: profile.id,
          requestHash: command.requestHash,
          resolvedPolicy: profile.definition,
          state: "QUEUED",
          tenantID: command.tenantId,
          timeoutAt: new Date(createdAt.getTime() + timeoutSeconds * 1_000),
          updatedAt: createdAt,
          workspace: command.workspace,
        })
        .onConflictDoNothing({ target: [executions.tenantID, executions.idempotencyKey] })
        .returning();

      const execution = inserted[0];
      if (!execution) {
        await tx.delete(events).where(eq(events.id, command.event.id));
        const winnerRows = await tx
          .select()
          .from(executions)
          .where(and(eq(executions.tenantID, command.tenantId), eq(executions.idempotencyKey, command.idempotencyKey)))
          .limit(1);
        const winner = winnerRows[0];
        if (!winner) throw new Error("Idempotent execution winner was not found");
        if (winner.requestHash !== command.requestHash) throw new IdempotencyConflictError();
        return { execution: await executionFromRow(tx, winner), replayed: true };
      }

      await tx.insert(executionTransitions).values([
        transition(command, 1, null, "RECEIVED", "execution request received"),
        transition(command, 2, "RECEIVED", "PLANNED", "profile version resolved"),
        transition(command, 3, "PLANNED", "QUEUED", "execution queued"),
      ]);
      await tx.insert(outboxEntries).values({
        aggregateID: command.id,
        aggregateType: "execution",
        availableAt: createdAt,
        createdAt,
        id: randomUUID(),
        payload: { schemaVersion: 1, tenantId: command.tenantId, executionId: command.id },
        tenantID: command.tenantId,
        topic: "execution.requested",
      });

      return { execution: executionRecord(execution, profile), replayed: false };
    });
  }

  async getExecution(tenantId: string, executionId: string): Promise<Execution | undefined> {
    const rows = await this.db
      .select()
      .from(executions)
      .where(and(eq(executions.tenantID, tenantId), eq(executions.id, executionId)))
      .limit(1);
    return rows[0] ? executionFromRow(this.db, rows[0]) : undefined;
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
type AgentProfileVersionRow = InferSelectModel<typeof agentProfileVersions>;
type ExecutionRow = InferSelectModel<typeof executions>;

type ClaimedOutboxRow = {
  aggregate_id: string;
  aggregate_type: string;
  available_at: Date;
  created_at: Date;
  headers: Record<string, string>;
  id: string;
  lease_expires_at: Date;
  lease_token: string;
  payload: unknown;
  publish_attempts: number;
  tenant_id: string;
  topic: string;
};

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
    configHash: row.configHash,
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

function outboxMessageFromRow(row: ClaimedOutboxRow): ClaimedOutboxMessage {
  return {
    aggregateId: row.aggregate_id,
    aggregateType: row.aggregate_type,
    availableAt: row.available_at,
    createdAt: row.created_at,
    headers: row.headers,
    id: row.id,
    claimExpiresAt: row.lease_expires_at,
    claimToken: row.lease_token,
    payload: row.payload,
    publishAttempts: row.publish_attempts,
    tenantId: row.tenant_id,
    topic: row.topic,
  };
}

function profileVersionFromRow(row: AgentProfileVersionRow): AgentProfileVersion {
  return {
    createdAt: row.createdAt.toISOString(),
    definition: row.definition as JsonObject,
    id: row.id,
    profile: { id: row.profileID, version: row.version },
    tenantId: row.tenantID,
  };
}

async function executionFromRow(
  db: Pick<RuntimeDatabase, "select">,
  row: ExecutionRow,
): Promise<Execution> {
  const profileRows = await db
    .select()
    .from(agentProfileVersions)
    .where(and(
      eq(agentProfileVersions.id, row.profileVersionID),
      eq(agentProfileVersions.tenantID, row.tenantID),
    ))
    .limit(1);
  const profile = profileRows[0];
  if (!profile) throw new Error(`Execution ${row.id} references missing profile version ${row.profileVersionID}`);
  return executionRecord(row, profile);
}

function executionRecord(row: ExecutionRow, profile: AgentProfileVersionRow): Execution {
  return {
    createdAt: row.createdAt.toISOString(),
    eventId: row.eventID,
    id: row.id,
    input: row.input as Execution["input"],
    profile: { id: profile.profileID, version: profile.version },
    result: (row.result as Execution["result"]) ?? null,
    state: row.state as Execution["state"],
    tenantId: row.tenantID,
    updatedAt: row.updatedAt.toISOString(),
    workspace: row.workspace as Execution["workspace"],
  };
}

function transition(
  command: CreateExecutionCommand,
  sequence: number,
  fromState: Execution["state"] | null,
  toState: Execution["state"],
  reason: string,
) {
  return {
    actor: "api",
    createdAt: new Date(command.createdAt),
    executionID: command.id,
    fromState,
    id: randomUUID(),
    reason,
    sequence,
    tenantID: command.tenantId,
    toState,
  };
}

function profileTimeoutSeconds(definition: Record<string, unknown>): number {
  const value = definition.timeoutSeconds;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 86_400) {
    throw new Error("Published profile has an invalid timeoutSeconds value");
  }
  return value as number;
}

function missingRow(kind: string, id: string): never {
  throw new Error(`Failed to return ${kind}: ${id}`);
}

function assertNonnegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a nonnegative safe integer`);
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
}
