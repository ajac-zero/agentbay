import path from "node:path";
import { randomUUID } from "node:crypto";
import { and, eq, type InferSelectModel } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { isExecutionState, isTerminalExecutionState } from "../execution/states.js";
import { isAttemptState } from "../dispatch/states.js";
import {
  isValidTransitionLeasedExecutionCommand,
  type DispatcherExecutionStore,
} from "../dispatch/store.js";
import type {
  AcknowledgeLeasedExecutionCancellationCommand,
  AcknowledgeLeasedExecutionCancellationResult,
  ClaimedExecution,
  ExecutionLeaseRenewalResult,
  FinalizeRequestedExecutionCancellationCommand,
  FinalizedRequestedExecutionCancellation,
  PromotedExecutionRetry,
  RecoveredExecutionLease,
  RequestedCancellationCleanup,
  TransitionLeasedExecutionCommand,
  TransitionLeasedExecutionResult,
} from "../dispatch/types.js";
import type {
  EventAdmissionStore,
  ExecutionStore,
  PublishProfileVersionCommand,
} from "../execution/store.js";
import type {
  ClaimedOutboxMessage,
  OutboxStore,
} from "../outbox/types.js";
import {
  IdempotencyConflictError,
  ExecutionCancellationConflictError,
  ProfileVersionAlreadyExistsError,
  ProfileVersionNotFoundError,
  type AgentProfileVersion,
  type Execution,
  type ExecutionAttempt,
  type ExecutionDetail,
  type ExecutionStateTransition,
  type RequestExecutionCancellationCommand,
  type RequestExecutionCancellationResult,
} from "../execution/types.js";
import { planExecution, type AdmissionCommand, type AdmissionResult } from "../control/admission.js";
import {
  ConnectionAlreadyExistsError,
  ConnectionNotFoundError,
  type Connection,
  type ConnectionStore,
  parseConnection,
  type CreateConnectionCommand,
} from "../connection/index.js";
import { bindingDefinitionSchema, publishedBindingVersionSchema, BindingVersionAlreadyExistsError, type BindingStore, type PublishedBindingVersion } from "../control/binding.js";
import { triggerSchema, TriggerAlreadyExistsError, TriggerNotFoundError, type Trigger, type TriggerStore } from "../control/trigger.js";
import { agentProfileDefinitionSchema } from "../execution/api-schema.js";
import { hashCanonicalJson, type JsonValue } from "../json.js";
import { resolvedWorkspaceSchema } from "../workspace/schema.js";
import * as schema from "./schema.js";
import {
  agentProfileVersions,
  bindingVersions,
  events,
  executions,
  executionTransitions,
  outboxEntries,
  triggers,
} from "./schema.js";

const cancellationCleanupFence = Symbol("cancellationCleanupFence");
type CancellationCleanupCandidate = RequestedCancellationCleanup & {
  [cancellationCleanupFence]?: string | null;
};

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

export class PersistedExecutionCorruptionError extends Error {
  constructor(executionId: string, field: string, options?: ErrorOptions) {
    super(`Execution ${executionId} has an invalid persisted ${field}`, options);
    this.name = "PersistedExecutionCorruptionError";
  }
}

export async function createPostgresRuntimeStore(options: PostgresRuntimeStoreOptions): Promise<PostgresRuntimeStore> {
  const pool = new Pool({
    connectionTimeoutMillis: 10_000,
    connectionString: options.connectionString,
    database: options.database,
    host: options.host,
    password: options.password,
    port: options.port,
    ssl: options.ssl ? { rejectUnauthorized: options.sslRejectUnauthorized } : undefined,
    statement_timeout: 30_000,
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

export class PostgresRuntimeStore implements ExecutionStore, TriggerStore, BindingStore, ConnectionStore, EventAdmissionStore, OutboxStore, DispatcherExecutionStore {
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
    const definition = agentProfileDefinitionSchema.parse(command.definition);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<AgentProfileVersionSqlRow>({
        text: `INSERT INTO agentbay_agent_profile_versions
          (id, tenant_id, profile_id, version, definition, created_at)
          VALUES ($1, $2, $3, $4, $5::jsonb, $6)
          ON CONFLICT DO NOTHING RETURNING *`,
        values: [command.id, command.tenantId, command.profileId, command.version, JSON.stringify(definition), new Date(command.createdAt)],
      });
      const row = inserted.rows[0];
      if (!row) throw new ProfileVersionAlreadyExistsError(command.profileId, command.version);

      for (const [ordinal, grant] of definition.connections.entries()) {
        const connection = await client.query<{ id: string }>(
          "SELECT id FROM agentbay_connections WHERE tenant_id = $1 AND connection_id = $2 FOR SHARE",
          [command.tenantId, grant.id],
        );
        if (!connection.rows[0]) throw new ConnectionNotFoundError(grant.id);
        await client.query(`INSERT INTO agentbay_agent_profile_version_connections
          (profile_version_id, tenant_id, connection_id, sidecar, ordinal)
          VALUES ($1, $2, $3, $4, $5)`,
        [command.id, command.tenantId, connection.rows[0].id, grant.sidecar, ordinal]);
      }

      await client.query("COMMIT");
      return profileVersionFromSqlRow(row);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
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

  async createConnection(command: CreateConnectionCommand): Promise<Connection> {
    command = parseConnection(command);
    const result = await this.pool.query<ConnectionRow>(`INSERT INTO agentbay_connections
      (id, tenant_id, connection_id, type, created_at)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT DO NOTHING RETURNING *`,
    [command.id, command.tenantId, command.connection.id, command.connection.type, new Date(command.createdAt)]);
    if (!result.rows[0]) throw new ConnectionAlreadyExistsError(command.connection.id);
    return connectionFromRow(result.rows[0]);
  }

  async getConnection(tenantId: string, connectionId: string): Promise<Connection | undefined> {
    const result = await this.pool.query<ConnectionRow>(
      "SELECT * FROM agentbay_connections WHERE tenant_id = $1 AND connection_id = $2",
      [tenantId, connectionId],
    );
    return result.rows[0] ? connectionFromRow(result.rows[0]) : undefined;
  }

  async createTrigger(value: Trigger): Promise<Trigger> {
    const trigger = triggerSchema.parse(value);
    const result = await this.pool.query<TriggerSqlRow>(`INSERT INTO agentbay_triggers
      (id, tenant_id, type, config, enabled, created_at, disabled_at)
      VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7) ON CONFLICT (id) DO NOTHING RETURNING *`,
    [trigger.id, trigger.tenantId, trigger.type, JSON.stringify(trigger.config), trigger.enabled, new Date(trigger.createdAt),
      trigger.disabledAt ? new Date(trigger.disabledAt) : null]);
    if (!result.rows[0]) throw new TriggerAlreadyExistsError(trigger.id);
    return triggerFromRow(result.rows[0]);
  }

  async getTrigger(tenantId: string, triggerId: string): Promise<Trigger | undefined> {
    const result = await this.pool.query<TriggerSqlRow>("SELECT * FROM agentbay_triggers WHERE tenant_id = $1 AND id = $2", [tenantId, triggerId]);
    return result.rows[0] ? triggerFromRow(result.rows[0]) : undefined;
  }

  async disableTrigger(tenantId: string, triggerId: string, disabledAt: string): Promise<Trigger | undefined> {
    const result = await this.pool.query<TriggerSqlRow>(`UPDATE agentbay_triggers
      SET enabled = false, disabled_at = COALESCE(disabled_at, $3)
      WHERE tenant_id = $1 AND id = $2 RETURNING *`, [tenantId, triggerId, new Date(disabledAt)]);
    return result.rows[0] ? triggerFromRow(result.rows[0]) : undefined;
  }

  async publishBindingVersion(value: PublishedBindingVersion): Promise<PublishedBindingVersion> {
    const binding = publishedBindingVersionSchema.parse(value);
    const definition = binding.definition;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [triggerControlLock(binding.tenantId, binding.triggerId)]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`binding:${binding.tenantId}:${binding.bindingId}`]);
      const trigger = await client.query("SELECT id FROM agentbay_triggers WHERE tenant_id = $1 AND id = $2", [binding.tenantId, binding.triggerId]);
      if (trigger.rowCount !== 1) throw new TriggerNotFoundError(binding.triggerId);
      const profile = await client.query<{ id: string }>(
        "SELECT id FROM agentbay_agent_profile_versions WHERE tenant_id = $1 AND profile_id = $2 AND version = $3",
        [binding.tenantId, binding.profile.id, binding.profile.version],
      );
      if (!profile.rows[0]) throw new ProfileVersionNotFoundError(binding.profile.id, binding.profile.version);
      const publishedAt = new Date(binding.createdAt);
      await client.query(
        "UPDATE agentbay_binding_versions SET enabled = false, disabled_at = $3 WHERE tenant_id = $1 AND binding_id = $2 AND enabled",
        [binding.tenantId, binding.bindingId, publishedAt],
      );
      const inserted = await client.query<{ id: string }>({
        text: `INSERT INTO agentbay_binding_versions
          (id, tenant_id, binding_id, version, trigger_id, profile_version_id, definition, event_types, enabled, disabled_at, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, true, NULL, $9)
          ON CONFLICT (tenant_id, binding_id, version) DO NOTHING RETURNING id`,
        values: [binding.id, binding.tenantId, binding.bindingId, binding.version, binding.triggerId, profile.rows[0].id,
          JSON.stringify({
            filter: definition.filter,
            prompt: definition.prompt,
            schemaVersion: definition.schemaVersion,
            workspace: definition.workspace,
          }), definition.eventTypes, publishedAt],
      });
      if (inserted.rowCount !== 1) throw new BindingVersionAlreadyExistsError(binding.bindingId, binding.version);
      const persisted = await client.query<BindingRow>(BINDING_SELECT + `
        WHERE binding.tenant_id = $1 AND binding.id = $2`, [binding.tenantId, inserted.rows[0]!.id]);
      await client.query("COMMIT");
      return bindingFromRow(persisted.rows[0]!);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getBindingVersion(tenantId: string, bindingId: string, version: number): Promise<PublishedBindingVersion | undefined> {
    const result = await this.pool.query<BindingRow>(BINDING_SELECT + `
      WHERE binding.tenant_id = $1 AND binding.binding_id = $2 AND binding.version = $3`, [tenantId, bindingId, version]);
    return result.rows[0] ? bindingFromRow(result.rows[0]) : undefined;
  }

  async disableBindingVersion(tenantId: string, bindingId: string, version: number, disabledAt: string): Promise<PublishedBindingVersion | undefined> {
    const result = await this.pool.query<{ id: string }>(`UPDATE agentbay_binding_versions
      SET enabled = false, disabled_at = COALESCE(disabled_at, $4)
      WHERE tenant_id = $1 AND binding_id = $2 AND version = $3 RETURNING id`, [tenantId, bindingId, version, new Date(disabledAt)]);
    return result.rows[0] ? this.getBindingVersion(tenantId, bindingId, version) : undefined;
  }

  async listBindingCandidates(tenantId: string, triggerId: string, eventType: string): Promise<readonly PublishedBindingVersion[]> {
    const result = await this.pool.query<BindingRow>(BINDING_SELECT + `
      WHERE binding.tenant_id = $1 AND binding.trigger_id = $2 AND binding.enabled AND $3 = ANY(binding.event_types)
      ORDER BY binding.binding_id, binding.version, binding.id`, [tenantId, triggerId, eventType]);
    return result.rows.map(bindingFromRow);
  }

  async admitEvent(command: AdmissionCommand): Promise<AdmissionResult> {
    const admissionHash = hashCanonicalJson({ schemaVersion: 1, triggerId: command.triggerId, event: command.event } as JsonValue);
    if (command.admissionHash !== admissionHash) throw new IdempotencyConflictError();

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [triggerControlLock(command.tenantId, command.triggerId)]);
      const lockKeys = [
        `event:${command.tenantId}:${command.triggerId}:${command.event.source}:${command.event.id}`,
        `dedup:${command.tenantId}:${command.triggerId}:${command.sourceDeduplicationKey}`,
      ].sort();
      for (const key of lockKeys) await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);

      const existing = await client.query<EventRow>(`SELECT * FROM agentbay_events WHERE tenant_id = $1 AND trigger_id = $2
        AND ((source = $3 AND event_id = $4) OR source_deduplication_key = $5) FOR UPDATE`,
      [command.tenantId, command.triggerId, command.event.source, command.event.id, command.sourceDeduplicationKey]);
      if (existing.rows.length > 0) {
        if (existing.rows.length !== 1 || existing.rows[0]!.admission_hash !== command.admissionHash) throw new IdempotencyConflictError();
        const persisted = await loadEventExecutions(client, command.tenantId, existing.rows[0]!.id);
        await client.query("COMMIT");
        return { event: eventSummary(existing.rows[0]!), executions: persisted, replayed: true };
      }

      const trigger = await client.query("SELECT id FROM agentbay_triggers WHERE tenant_id = $1 AND id = $2 AND enabled FOR SHARE",
        [command.tenantId, command.triggerId]);
       if (trigger.rowCount !== 1) throw new TriggerNotFoundError(command.triggerId);
      const candidates = await client.query<BindingProfileRow>(`SELECT binding.*, profile.definition AS profile_definition,
          profile.profile_id, profile.version AS profile_version
        FROM agentbay_binding_versions AS binding
        JOIN agentbay_agent_profile_versions AS profile ON profile.id = binding.profile_version_id AND profile.tenant_id = binding.tenant_id
        WHERE binding.tenant_id = $1 AND binding.trigger_id = $2 AND binding.enabled AND $3 = ANY(binding.event_types)
        ORDER BY binding.binding_id, binding.version, binding.id FOR SHARE OF binding, profile`,
      [command.tenantId, command.triggerId, command.event.type]);
      const extensions = eventExtensions(command.event);
      await client.query(`INSERT INTO agentbay_events
        (id, tenant_id, trigger_id, event_id, source, source_deduplication_key, admission_hash, type, subject, event_time,
         data_content_type, data_schema, data, extensions, raw_payload_ref, ingested_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15,$16)`, [
        command.internalEventId, command.tenantId, command.triggerId, command.event.id, command.event.source,
        command.sourceDeduplicationKey, command.admissionHash, command.event.type, command.event.subject ?? null,
        command.event.time ? new Date(command.event.time) : null, command.event.datacontenttype ?? "application/json",
        command.event.dataschema ?? null, JSON.stringify(command.event.data), JSON.stringify(extensions), null, new Date(command.admittedAt),
      ]);

      const created: Execution[] = [];
      for (const row of candidates.rows) {
        const binding = bindingFromRow(row);
        const planned = planExecution(binding, command);
        if (!planned) continue;
        const now = new Date(command.admittedAt);
        const executionId = randomUUID();
        const execution = await client.query<ExecutionJoinedRow>({
          text: `INSERT INTO agentbay_executions
            (id, tenant_id, event_id, binding_version_id, profile_version_id, idempotency_key, request_hash, input,
             workspace, resolved_policy, state, timeout_at, created_at, updated_at, available_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,'QUEUED',$11,$12,$12,$12)
            RETURNING *, $13::text AS binding_id, $14::integer AS binding_version,
              $15::text AS profile_id, $16::integer AS profile_version`,
          values: [executionId, command.tenantId, command.internalEventId, row.id, row.profile_version_id,
            planned.id, command.admissionHash, JSON.stringify(planned.input), JSON.stringify(planned.workspace),
            JSON.stringify(row.profile_definition), new Date(now.getTime() + profileTimeoutSeconds(row.profile_definition) * 1_000), now,
            row.binding_id, row.version, planned.profile.id, planned.profile.version],
        });
        await client.query(`INSERT INTO agentbay_execution_transitions
          (id, tenant_id, execution_id, sequence, from_state, to_state, actor, reason, created_at) VALUES
          ($1,$2,$3,1,NULL,'RECEIVED','event-admission','event admitted',$6),
          ($4,$2,$3,2,'RECEIVED','PLANNED','event-admission','binding and profile resolved',$6),
          ($5,$2,$3,3,'PLANNED','QUEUED','event-admission','execution queued',$6)`,
        [randomUUID(), command.tenantId, executionId, randomUUID(), randomUUID(), now]);
        await client.query(`INSERT INTO agentbay_outbox
          (id, tenant_id, topic, aggregate_type, aggregate_id, payload, available_at, created_at)
          VALUES ($1,$2,'execution.requested','execution',$3,$4::jsonb,$5,$5)`,
        [randomUUID(), command.tenantId, executionId, JSON.stringify({ schemaVersion: 1, tenantId: command.tenantId, executionId }), now]);
        created.push(executionRecordFromJoined(execution.rows[0]!));
      }
      await client.query("COMMIT");
      return {
        event: {
          admissionHash: command.admissionHash,
          admittedAt: command.admittedAt,
          eventId: command.event.id,
          id: command.internalEventId,
          source: command.event.source,
          sourceDeduplicationKey: command.sourceDeduplicationKey,
          tenantId: command.tenantId,
          triggerId: command.triggerId,
          type: command.event.type,
        },
        executions: created,
        replayed: false,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getExecution(tenantId: string, executionId: string): Promise<Execution | undefined> {
    const result = await this.pool.query<ExecutionJoinedRow>(EXECUTION_SELECT + " WHERE execution.tenant_id = $1 AND execution.id = $2", [tenantId, executionId]);
    return result.rows[0] ? executionRecordFromJoined(result.rows[0]) : undefined;
  }

  async getExecutionDetail(tenantId: string, executionId: string): Promise<ExecutionDetail | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const executionResult = await client.query<ExecutionJoinedRow>(
        EXECUTION_SELECT + " WHERE execution.tenant_id = $1 AND execution.id = $2",
        [tenantId, executionId],
      );
      const row = executionResult.rows[0];
      if (!row) {
        await client.query("COMMIT");
        return undefined;
      }
      const attemptsResult = await client.query<ExecutionAttemptRow>(`
        SELECT attempt, state, started_at, finished_at, lease_expires_at, opencode_session_id, workload_name
        FROM agentbay_execution_attempts
        WHERE tenant_id = $1 AND execution_id = $2
        ORDER BY attempt`, [tenantId, executionId]);
      const transitionsResult = await client.query<ExecutionTransitionRow>(`
        SELECT id, attempt, sequence, from_state, to_state, actor, reason, created_at, trace_context
        FROM agentbay_execution_transitions
        WHERE tenant_id = $1 AND execution_id = $2
        ORDER BY sequence`, [tenantId, executionId]);
      const detail = {
        ...executionRecordFromJoined(row),
        attempts: attemptsResult.rows.map((attempt) => executionAttemptFromRow(executionId, attempt)),
        transitions: transitionsResult.rows.map((transition) => executionTransitionFromRow(executionId, transition)),
      };
      await client.query("COMMIT");
      return detail;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async requestExecutionCancellation(
    command: RequestExecutionCancellationCommand,
  ): Promise<RequestExecutionCancellationResult | undefined> {
    const requestedAt = new Date(command.requestedAt);
    if (Number.isNaN(requestedAt.getTime())) throw new Error("Execution cancellation request time must be valid");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const executionResult = await client.query<{ id: string; state: string }>(
        "SELECT id, state FROM agentbay_executions WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
        [command.tenantId, command.executionId],
      );
      const execution = executionResult.rows[0];
      if (!execution) {
        await client.query("COMMIT");
        return undefined;
      }
      if (!isExecutionState(execution.state)) {
        throw new PersistedExecutionCorruptionError(command.executionId, "state");
      }
      if (execution.state === "CANCELLED") {
        await client.query("COMMIT");
        return { id: execution.id, outcome: "CANCELLED", state: "CANCELLED" };
      }
      if (execution.state === "CANCEL_REQUESTED") {
        await client.query("COMMIT");
        return { id: execution.id, outcome: "REQUESTED", state: "CANCEL_REQUESTED" };
      }
      if (execution.state !== "QUEUED" && execution.state !== "RETRY_WAIT" && execution.state !== "AWAITING_APPROVAL"
        && execution.state !== "PROVISIONING" && execution.state !== "RUNNING") {
        throw new ExecutionCancellationConflictError(command.executionId);
      }

      const immediate = execution.state === "QUEUED" || execution.state === "RETRY_WAIT"
        || execution.state === "AWAITING_APPROVAL";
      const transitionIds = immediate ? [command.transitionId, randomUUID()] : [command.transitionId];
      await client.query({
        text: `WITH cancellation_clock AS (SELECT $3::timestamptz AS requested_at),
          updated_execution AS (
            UPDATE agentbay_executions
            SET state = $4, updated_at = cancellation_clock.requested_at,
                completed_at = CASE WHEN $5 THEN cancellation_clock.requested_at ELSE completed_at END
            FROM cancellation_clock
            WHERE id = $1 AND tenant_id = $2 AND state = $6
            RETURNING id
          )
          INSERT INTO agentbay_execution_transitions
            (id, tenant_id, execution_id, attempt, sequence, from_state, to_state, actor, reason, created_at)
          SELECT transition.id, $2, $1, NULL,
            (SELECT COALESCE(MAX(sequence), 0) FROM agentbay_execution_transitions WHERE tenant_id = $2 AND execution_id = $1)
              + transition.ordinality::integer,
            transition.from_state, transition.to_state, $7, $8, cancellation_clock.requested_at
          FROM updated_execution, cancellation_clock,
            unnest($9::text[], $10::text[], $11::text[]) WITH ORDINALITY
              AS transition(id, from_state, to_state, ordinality)`,
        values: [command.executionId, command.tenantId, requestedAt, immediate ? "CANCELLED" : "CANCEL_REQUESTED",
          immediate, execution.state, command.actor, command.reason, transitionIds,
          immediate ? [execution.state, "CANCEL_REQUESTED"] : [execution.state],
          immediate ? ["CANCEL_REQUESTED", "CANCELLED"] : ["CANCEL_REQUESTED"]],
      });
      await client.query("COMMIT");
      return immediate
        ? { id: execution.id, outcome: "CANCELLED", state: "CANCELLED" }
        : { id: execution.id, outcome: "REQUESTED", state: "CANCEL_REQUESTED" };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async claimNextQueuedExecution(command: { leaseOwner: string; leaseDurationMs: number }): Promise<ClaimedExecution | undefined> {
    assertPositiveInteger(command.leaseDurationMs, "Execution lease duration");

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const claimed = await client.query<ClaimedExecutionRow>({
        text: `
          WITH claim_clock AS MATERIALIZED (
            SELECT clock_timestamp() AS claimed_at
          ), candidate AS (
            SELECT execution.id, execution.tenant_id
            FROM agentbay_executions AS execution, claim_clock
            WHERE execution.state = 'QUEUED'
              AND execution.available_at <= claim_clock.claimed_at
              AND execution.timeout_at > claim_clock.claimed_at
            ORDER BY execution.available_at, execution.created_at, execution.id
            FOR UPDATE OF execution SKIP LOCKED
            LIMIT 1
          ), next_attempt AS (
            SELECT candidate.id, candidate.tenant_id,
                   COALESCE(MAX(attempt.attempt), 0) + 1 AS attempt
            FROM candidate
            LEFT JOIN agentbay_execution_attempts AS attempt ON attempt.execution_id = candidate.id
            GROUP BY candidate.id, candidate.tenant_id
          ), inserted_attempt AS (
            INSERT INTO agentbay_execution_attempts
              (execution_id, tenant_id, attempt, fencing_token, state, lease_owner, lease_expires_at)
            SELECT id, tenant_id, attempt, $1, 'LEASED', $2,
                   claim_clock.claimed_at + ($3::double precision * interval '1 millisecond')
            FROM next_attempt, claim_clock
            RETURNING execution_id, tenant_id, attempt, fencing_token, state, lease_owner,
                      lease_expires_at
          ), updated_execution AS (
            UPDATE agentbay_executions AS execution
            SET state = 'PROVISIONING', updated_at = claim_clock.claimed_at
            FROM candidate, claim_clock
            WHERE execution.id = candidate.id
              AND execution.tenant_id = candidate.tenant_id
              AND execution.state = 'QUEUED'
            RETURNING execution.*
          ), inserted_transition AS (
            INSERT INTO agentbay_execution_transitions
              (id, tenant_id, execution_id, attempt, sequence, from_state, to_state, actor, reason, created_at)
            SELECT $4, execution.tenant_id, execution.id, attempt.attempt,
                   COALESCE((SELECT MAX(t.sequence) + 1
                             FROM agentbay_execution_transitions AS t
                             WHERE t.tenant_id = execution.tenant_id AND t.execution_id = execution.id), 4),
                   'QUEUED', 'PROVISIONING', $2, $5, claim_clock.claimed_at
            FROM updated_execution AS execution
            JOIN inserted_attempt AS attempt ON attempt.execution_id = execution.id,
                 claim_clock
            RETURNING execution_id
          )
          SELECT execution.id, execution.tenant_id, execution.state AS execution_state,
                 execution.event_id, execution.input, execution.workspace, execution.resolved_policy,
                 execution.created_at, execution.timeout_at,
                  profile.id AS profile_version_id, profile.profile_id, profile.version,
                  profile.definition AS definition,
                 attempt.attempt, attempt.fencing_token, attempt.state AS attempt_state,
                 attempt.lease_owner, attempt.lease_expires_at
          FROM updated_execution AS execution
          JOIN inserted_attempt AS attempt ON attempt.execution_id = execution.id
          JOIN inserted_transition AS transition ON transition.execution_id = execution.id
          JOIN agentbay_agent_profile_versions AS profile
            ON profile.id = execution.profile_version_id AND profile.tenant_id = execution.tenant_id
        `,
        values: [randomUUID(), command.leaseOwner, command.leaseDurationMs, randomUUID(), "execution claimed"],
      });
      const result = claimed.rows[0] ? claimedExecutionFromRow(claimed.rows[0]) : undefined;
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async renewExecutionLease(command: {
    executionId: string;
    tenantId: string;
    attempt: number;
    fencingToken: string;
    leaseOwner: string;
    leaseDurationMs: number;
  }): Promise<ExecutionLeaseRenewalResult> {
    assertPositiveInteger(command.leaseDurationMs, "Execution lease duration");
    const result = await this.pool.query<{ lease_expires_at: Date }>({
      text: `
        WITH lease_clock AS MATERIALIZED (SELECT clock_timestamp() AS renewed_at)
        UPDATE agentbay_execution_attempts AS attempt
        SET lease_expires_at = GREATEST(
          attempt.lease_expires_at,
          lease_clock.renewed_at + ($6::double precision * interval '1 millisecond')
        )
        FROM agentbay_executions AS execution, lease_clock
        WHERE attempt.execution_id = $1 AND attempt.tenant_id = $2
          AND attempt.attempt = $3 AND attempt.fencing_token = $4 AND attempt.lease_owner = $5
          AND attempt.state IN ('LEASED', 'RUNNING')
          AND attempt.lease_expires_at > lease_clock.renewed_at
          AND execution.id = attempt.execution_id AND execution.tenant_id = attempt.tenant_id
          AND execution.state IN ('PROVISIONING', 'RUNNING')
        RETURNING attempt.lease_expires_at
      `,
      values: [command.executionId, command.tenantId, command.attempt, command.fencingToken, command.leaseOwner, command.leaseDurationMs],
    });
    if (result.rowCount === 1) return "RENEWED";

    const cancellation = await this.pool.query<{ cancellation_requested: boolean }>({
      text: `
        SELECT EXISTS (
          SELECT 1
          FROM agentbay_execution_attempts AS attempt
          JOIN agentbay_executions AS execution
            ON execution.id = attempt.execution_id AND execution.tenant_id = attempt.tenant_id
          WHERE attempt.execution_id = $1 AND attempt.tenant_id = $2
            AND attempt.attempt = $3 AND attempt.fencing_token = $4 AND attempt.lease_owner = $5
            AND attempt.state IN ('LEASED', 'RUNNING')
            AND attempt.lease_expires_at > clock_timestamp()
            AND execution.state = 'CANCEL_REQUESTED'
        ) AS cancellation_requested
      `,
      values: [command.executionId, command.tenantId, command.attempt, command.fencingToken, command.leaseOwner],
    });
    return cancellation.rows[0]?.cancellation_requested ? "CANCEL_REQUESTED" : "LOST";
  }

  async acknowledgeLeasedExecutionCancellation(
    command: AcknowledgeLeasedExecutionCancellationCommand,
  ): Promise<AcknowledgeLeasedExecutionCancellationResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const executionResult = await client.query<{ state: string }>(
        "SELECT state FROM agentbay_executions WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
        [command.executionId, command.tenantId],
      );
      const execution = executionResult.rows[0];
      if (!execution) {
        await client.query("ROLLBACK");
        return { applied: false, reason: "NOT_FOUND" };
      }
      if (execution.state !== "CANCEL_REQUESTED") {
        await client.query("ROLLBACK");
        return { applied: false, reason: "STATE_MISMATCH" };
      }

      const attemptResult = await client.query<{ lease_expires_at: Date; state: string }>({
        text: `SELECT state, lease_expires_at
          FROM agentbay_execution_attempts
          WHERE execution_id = $1 AND tenant_id = $2 AND attempt = $3
            AND fencing_token = $4 AND lease_owner = $5
          FOR UPDATE`,
        values: [command.executionId, command.tenantId, command.attempt, command.fencingToken, command.leaseOwner],
      });
      const attempt = attemptResult.rows[0];
      if (!attempt) {
        const exists = await client.query<{ exists: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM agentbay_execution_attempts WHERE execution_id = $1 AND tenant_id = $2 AND attempt = $3) AS exists",
          [command.executionId, command.tenantId, command.attempt],
        );
        await client.query("ROLLBACK");
        return { applied: false, reason: exists.rows[0]?.exists ? "LEASE_MISMATCH" : "NOT_FOUND" };
      }
      if (attempt.state !== "LEASED" && attempt.state !== "RUNNING") {
        await client.query("ROLLBACK");
        return { applied: false, reason: "STATE_MISMATCH" };
      }
      const clock = await client.query<{ now: Date }>("SELECT clock_timestamp() AS now");
      const acknowledgedAt = clock.rows[0]!.now;
      if (attempt.lease_expires_at <= acknowledgedAt) {
        await client.query("ROLLBACK");
        return { applied: false, reason: "LEASE_EXPIRED" };
      }

      const updated = await client.query({
        text: `WITH updated_attempt AS (
            UPDATE agentbay_execution_attempts
            SET state = 'CANCELLED', finished_at = $6, lease_owner = NULL, lease_expires_at = NULL
            WHERE execution_id = $1 AND tenant_id = $2 AND attempt = $3
              AND fencing_token = $4 AND lease_owner = $5 AND state = $7
            RETURNING execution_id
          ), updated_execution AS (
            UPDATE agentbay_executions
            SET state = 'CANCELLED', completed_at = $6, updated_at = $6
            WHERE id = $1 AND tenant_id = $2 AND state = 'CANCEL_REQUESTED'
              AND EXISTS (SELECT 1 FROM updated_attempt)
            RETURNING id
          ), inserted_transition AS (
            INSERT INTO agentbay_execution_transitions
              (id, tenant_id, execution_id, attempt, sequence, from_state, to_state, actor, reason, created_at)
            SELECT $8, $2, id, $3,
              (SELECT COALESCE(MAX(sequence), 0) + 1 FROM agentbay_execution_transitions WHERE tenant_id = $2 AND execution_id = $1),
              'CANCEL_REQUESTED', 'CANCELLED', $9, $10, $6
            FROM updated_execution
            RETURNING execution_id
          )
          SELECT id FROM updated_execution WHERE EXISTS (SELECT 1 FROM inserted_transition)`,
        values: [command.executionId, command.tenantId, command.attempt, command.fencingToken, command.leaseOwner,
          acknowledgedAt, attempt.state, randomUUID(), command.actor, command.reason],
      });
      if (updated.rowCount !== 1) {
        await client.query("ROLLBACK");
        return { applied: false, reason: "STATE_MISMATCH" };
      }
      await client.query("COMMIT");
      return { applied: true };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listRequestedCancellationCleanups(command: {
    limit: number;
  }): Promise<RequestedCancellationCleanup[]> {
    assertPositiveInteger(command.limit, "Execution cancellation cleanup limit");
    const result = await this.pool.query<{
      attempt: number | null;
      execution_id: string;
      fencing_token: string | null;
      tenant_id: string;
      workload_name: string | null;
    }>({
      text: `WITH candidates AS (
          SELECT execution.id, execution.tenant_id
          FROM agentbay_executions AS execution
          LEFT JOIN LATERAL (
            SELECT candidate.attempt, candidate.lease_expires_at
            FROM agentbay_execution_attempts AS candidate
            WHERE candidate.execution_id = execution.id AND candidate.tenant_id = execution.tenant_id
              AND candidate.state IN ('LEASED', 'RUNNING')
            ORDER BY candidate.attempt DESC
            LIMIT 1
          ) AS active_attempt ON true
          WHERE execution.state = 'CANCEL_REQUESTED'
            AND (active_attempt.attempt IS NULL OR active_attempt.lease_expires_at <= clock_timestamp())
          ORDER BY execution.updated_at, execution.created_at, execution.id
          FOR UPDATE OF execution SKIP LOCKED
          LIMIT $1
        ), rotated AS (
          UPDATE agentbay_executions AS execution
          SET updated_at = clock_timestamp()
          FROM candidates
          WHERE execution.id = candidates.id AND execution.tenant_id = candidates.tenant_id
          RETURNING execution.id, execution.tenant_id
        )
        SELECT rotated.id AS execution_id, rotated.tenant_id,
          attempt.attempt, attempt.fencing_token, attempt.workload_name
        FROM rotated
        LEFT JOIN LATERAL (
          SELECT candidate.attempt, candidate.fencing_token, candidate.lease_expires_at, candidate.workload_name
          FROM agentbay_execution_attempts AS candidate
          WHERE candidate.execution_id = rotated.id AND candidate.tenant_id = rotated.tenant_id
            AND candidate.state IN ('LEASED', 'RUNNING')
          ORDER BY candidate.attempt DESC
          LIMIT 1
        ) AS attempt ON true
        ORDER BY rotated.id`,
      values: [command.limit],
    });
    return result.rows.map((row) => {
      const candidate: RequestedCancellationCleanup = {
        attempt: row.attempt,
        executionId: row.execution_id,
        tenantId: row.tenant_id,
        workloadName: row.workload_name,
      };
      Object.defineProperty(candidate, cancellationCleanupFence, { value: row.fencing_token });
      return candidate;
    });
  }

  async finalizeRequestedExecutionCancellation(
    command: FinalizeRequestedExecutionCancellationCommand,
  ): Promise<FinalizedRequestedExecutionCancellation | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const executionResult = await client.query<{ state: string }>(
        "SELECT state FROM agentbay_executions WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
        [command.executionId, command.tenantId],
      );
      if (executionResult.rows[0]?.state !== "CANCEL_REQUESTED") {
        await client.query("ROLLBACK");
        return undefined;
      }

      const fencingToken = (command as CancellationCleanupCandidate)[cancellationCleanupFence];
      const clock = await client.query<{ now: Date }>("SELECT clock_timestamp() AS now");
      const finalizedAt = clock.rows[0]!.now;
      if (command.attempt === null) {
        const activeAttempt = await client.query(`SELECT attempt
          FROM agentbay_execution_attempts
          WHERE execution_id = $1 AND tenant_id = $2 AND state IN ('LEASED', 'RUNNING')
          ORDER BY attempt DESC
          FOR UPDATE
          LIMIT 1`, [command.executionId, command.tenantId]);
        if (activeAttempt.rowCount !== 0 || fencingToken !== null) {
          await client.query("ROLLBACK");
          return undefined;
        }
      } else {
        const attemptResult = await client.query<{ fencing_token: string; lease_expires_at: Date; state: string }>({
          text: `SELECT state, fencing_token, lease_expires_at
            FROM agentbay_execution_attempts
            WHERE execution_id = $1 AND tenant_id = $2 AND attempt = $3
            FOR UPDATE`,
          values: [command.executionId, command.tenantId, command.attempt],
        });
        const attempt = attemptResult.rows[0];
        if (!attempt || fencingToken === undefined || attempt.fencing_token !== fencingToken
          || (attempt.state !== "LEASED" && attempt.state !== "RUNNING")
          || attempt.lease_expires_at > finalizedAt) {
          await client.query("ROLLBACK");
          return undefined;
        }
      }

      const result = await client.query({
        text: `WITH updated_attempt AS (
            UPDATE agentbay_execution_attempts
            SET state = 'CANCELLED', finished_at = $4, lease_owner = NULL, lease_expires_at = NULL
            WHERE execution_id = $1 AND tenant_id = $2 AND attempt = $3
              AND fencing_token = $5 AND state IN ('LEASED', 'RUNNING') AND lease_expires_at <= $4
            RETURNING execution_id
          ), updated_execution AS (
            UPDATE agentbay_executions
            SET state = 'CANCELLED', completed_at = $4, updated_at = $4
            WHERE id = $1 AND tenant_id = $2 AND state = 'CANCEL_REQUESTED'
              AND ($3::integer IS NULL OR EXISTS (SELECT 1 FROM updated_attempt))
            RETURNING id
          ), inserted_transition AS (
            INSERT INTO agentbay_execution_transitions
              (id, tenant_id, execution_id, attempt, sequence, from_state, to_state, actor, reason, created_at)
            SELECT $6, $2, id, $3,
              (SELECT COALESCE(MAX(sequence), 0) + 1 FROM agentbay_execution_transitions WHERE tenant_id = $2 AND execution_id = $1),
              'CANCEL_REQUESTED', 'CANCELLED', 'execution-reconciler', 'execution cancellation finalized', $4
            FROM updated_execution
            RETURNING execution_id
          )
          SELECT id FROM updated_execution WHERE EXISTS (SELECT 1 FROM inserted_transition)`,
        values: [command.executionId, command.tenantId, command.attempt, finalizedAt, fencingToken, randomUUID()],
      });
      if (result.rowCount !== 1) {
        await client.query("ROLLBACK");
        return undefined;
      }
      await client.query("COMMIT");
      return { ...command, finalizedAt };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async recoverExpiredExecutionLeases(command: {
    limit: number;
    maxAttempts: number;
    retryDelayMs: number;
  }): Promise<RecoveredExecutionLease[]> {
    assertPositiveInteger(command.limit, "Execution lease recovery limit");
    assertPositiveInteger(command.maxAttempts, "Execution maximum attempts");
    assertNonnegativeInteger(command.retryDelayMs, "Execution retry delay");

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const candidates = await client.query<RecoveryExecutionRow>({
        text: `
          WITH recovery_clock AS MATERIALIZED (SELECT clock_timestamp() AS recovered_at)
          SELECT execution.id, execution.tenant_id, execution.state, execution.timeout_at
          FROM agentbay_executions AS execution, recovery_clock
          WHERE execution.state IN ('PROVISIONING', 'RUNNING')
            AND EXISTS (
              SELECT 1
              FROM agentbay_execution_attempts AS attempt
              WHERE attempt.execution_id = execution.id
                AND attempt.tenant_id = execution.tenant_id
                AND attempt.state IN ('LEASED', 'RUNNING')
                AND attempt.lease_expires_at <= recovery_clock.recovered_at
            )
          ORDER BY execution.updated_at, execution.created_at, execution.id
          FOR UPDATE OF execution SKIP LOCKED
          LIMIT $1
        `,
        values: [command.limit],
      });

      const recovered: RecoveredExecutionLease[] = [];
      for (const execution of candidates.rows) {
        // Renewal locks only the attempt. Rechecking after this lock lets an in-flight
        // renewal win without introducing the execution/attempt lock-order cycle.
        const attemptResult = await client.query<ExpiredAttemptRow>({
          text: `
            WITH recovery_clock AS MATERIALIZED (SELECT clock_timestamp() AS recovered_at)
            SELECT attempt.attempt, attempt.state, recovery_clock.recovered_at
            FROM agentbay_execution_attempts AS attempt, recovery_clock
            WHERE attempt.execution_id = $1 AND attempt.tenant_id = $2
              AND attempt.state IN ('LEASED', 'RUNNING')
              AND attempt.lease_expires_at <= recovery_clock.recovered_at
            ORDER BY attempt.attempt DESC
            FOR UPDATE OF attempt
            LIMIT 1
          `,
          values: [execution.id, execution.tenant_id],
        });
        const attempt = attemptResult.rows[0];
        if (!attempt) continue;

        const updateResult = await client.query<RecoveredExecutionRow>({
          text: `
            WITH updated_attempt AS (
              UPDATE agentbay_execution_attempts
              SET state = CASE WHEN $4 >= $9 THEN 'TIMED_OUT' ELSE 'FAILED' END, finished_at = $4,
                  lease_owner = NULL, lease_expires_at = NULL
              WHERE execution_id = $1 AND tenant_id = $2 AND attempt = $3
                AND state IN ('LEASED', 'RUNNING') AND lease_expires_at <= $4
              RETURNING execution_id
            ), updated_execution AS (
              UPDATE agentbay_executions
               SET state = CASE
                     WHEN $4 >= timeout_at THEN 'TIMED_OUT'
                     WHEN $3 < $5 AND $4 + ($6::double precision * interval '1 millisecond') < timeout_at
                       THEN 'RETRY_WAIT'
                    ELSE 'FAILED'
                  END,
                  available_at = CASE
                    WHEN $3 < $5 AND $4 + ($6::double precision * interval '1 millisecond') < timeout_at
                      THEN $4 + ($6::double precision * interval '1 millisecond')
                    ELSE available_at
                  END,
                  completed_at = CASE
                    WHEN $3 < $5 AND $4 + ($6::double precision * interval '1 millisecond') < timeout_at
                      THEN NULL
                    ELSE $4
                  END,
                  updated_at = $4
              WHERE id = $1 AND tenant_id = $2 AND state = $7
                AND EXISTS (SELECT 1 FROM updated_attempt)
              RETURNING id, tenant_id, state
            ), inserted_transition AS (
              INSERT INTO agentbay_execution_transitions
                (id, tenant_id, execution_id, attempt, sequence, from_state, to_state, actor, reason, created_at)
              SELECT $8, tenant_id, id, $3,
                     (SELECT COALESCE(MAX(sequence), 0) + 1
                      FROM agentbay_execution_transitions
                      WHERE tenant_id = $2 AND execution_id = $1),
                     $7, state, 'execution-reconciler', 'execution lease expired', $4
              FROM updated_execution
              RETURNING execution_id
            )
            SELECT id, tenant_id, state, $4::timestamptz AS recovered_at
            FROM updated_execution
            WHERE EXISTS (SELECT 1 FROM inserted_transition)
          `,
          values: [
            execution.id,
            execution.tenant_id,
            attempt.attempt,
            attempt.recovered_at,
            command.maxAttempts,
            command.retryDelayMs,
             execution.state,
             randomUUID(),
             execution.timeout_at,
          ],
        });
        const row = updateResult.rows[0];
        if (!row) continue;
        recovered.push({
          attempt: attempt.attempt,
          executionId: row.id,
          executionState: row.state,
          recoveredAt: row.recovered_at,
          tenantId: row.tenant_id,
        });
      }

      await client.query("COMMIT");
      return recovered;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async promoteDueExecutionRetries(command: { limit: number }): Promise<PromotedExecutionRetry[]> {
    assertPositiveInteger(command.limit, "Execution retry promotion limit");

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<PromotedExecutionRow>({
        text: `
          WITH promotion_clock AS MATERIALIZED (SELECT clock_timestamp() AS promoted_at),
          candidates AS (
            SELECT execution.id, execution.tenant_id
            FROM agentbay_executions AS execution, promotion_clock
            WHERE execution.state = 'RETRY_WAIT'
              AND (execution.available_at <= promotion_clock.promoted_at
                OR execution.timeout_at <= promotion_clock.promoted_at)
            ORDER BY execution.available_at, execution.created_at, execution.id
            FOR UPDATE OF execution SKIP LOCKED
            LIMIT $1
          ), updated_execution AS (
            UPDATE agentbay_executions AS execution
            SET state = CASE
                  WHEN execution.timeout_at <= promotion_clock.promoted_at THEN 'TIMED_OUT'
                  ELSE 'QUEUED'
                END,
                completed_at = CASE
                  WHEN execution.timeout_at <= promotion_clock.promoted_at THEN promotion_clock.promoted_at
                  ELSE completed_at
                END,
                updated_at = promotion_clock.promoted_at
            FROM candidates, promotion_clock
            WHERE execution.id = candidates.id AND execution.tenant_id = candidates.tenant_id
              AND execution.state = 'RETRY_WAIT'
              AND (execution.available_at <= promotion_clock.promoted_at
                OR execution.timeout_at <= promotion_clock.promoted_at)
            RETURNING execution.id, execution.tenant_id, execution.state
          ), inserted_transition AS (
            INSERT INTO agentbay_execution_transitions
              (id, tenant_id, execution_id, attempt, sequence, from_state, to_state, actor, reason, created_at)
            SELECT ($2::text[])[(row_number() OVER ())::integer], execution.tenant_id, execution.id, NULL,
                   (SELECT COALESCE(MAX(sequence), 0) + 1
                    FROM agentbay_execution_transitions
                    WHERE tenant_id = execution.tenant_id AND execution_id = execution.id),
                   'RETRY_WAIT', execution.state, 'execution-reconciler',
                   CASE WHEN execution.state = 'TIMED_OUT' THEN 'execution deadline elapsed' ELSE 'execution retry became due' END,
                   promotion_clock.promoted_at
            FROM updated_execution AS execution, promotion_clock
            RETURNING execution_id
          )
          SELECT execution.id, execution.tenant_id, execution.state, promotion_clock.promoted_at
          FROM updated_execution AS execution, promotion_clock
          WHERE EXISTS (
            SELECT 1 FROM inserted_transition WHERE inserted_transition.execution_id = execution.id
          )
        `,
        values: [command.limit, Array.from({ length: command.limit }, () => randomUUID())],
      });
      await client.query("COMMIT");
      return result.rows.map((row) => ({
        executionId: row.id,
        executionState: row.state,
        promotedAt: row.promoted_at,
        tenantId: row.tenant_id,
      }));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async transitionLeasedExecution(command: TransitionLeasedExecutionCommand): Promise<TransitionLeasedExecutionResult> {
    if (!isValidTransitionLeasedExecutionCommand(command)) {
      throw new Error("Invalid leased execution transition");
    }
    assertNonnegativeInteger(command.retryDelayMs ?? 0, "Execution retry delay");

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const executionResult = await client.query<{ state: string }>({
        text: `SELECT state FROM agentbay_executions WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        values: [command.executionId, command.tenantId],
      });
      if (!executionResult.rows[0]) {
        await client.query("ROLLBACK");
        return { applied: false, reason: "NOT_FOUND" };
      }
      if (executionResult.rows[0].state !== command.expectedExecutionState) {
        await client.query("ROLLBACK");
        return { applied: false, reason: "STATE_MISMATCH" };
      }

      const attemptResult = await client.query<{ state: string; lease_expires_at: Date }>({
        text: `
          SELECT state, lease_expires_at
          FROM agentbay_execution_attempts
          WHERE execution_id = $1 AND tenant_id = $2 AND attempt = $3
            AND fencing_token = $4 AND lease_owner = $5
          FOR UPDATE
        `,
        values: [command.executionId, command.tenantId, command.attempt, command.fencingToken, command.leaseOwner],
      });
      const attempt = attemptResult.rows[0];
      if (!attempt) {
        const existsResult = await client.query<{ exists: boolean }>({
          text: `
            SELECT EXISTS (
              SELECT 1 FROM agentbay_execution_attempts
              WHERE execution_id = $1 AND tenant_id = $2 AND attempt = $3
            ) AS exists
          `,
          values: [command.executionId, command.tenantId, command.attempt],
        });
        await client.query("ROLLBACK");
        return { applied: false, reason: existsResult.rows[0]?.exists ? "LEASE_MISMATCH" : "NOT_FOUND" };
      }
      if (attempt.state !== command.expectedAttemptState) {
        await client.query("ROLLBACK");
        return { applied: false, reason: "STATE_MISMATCH" };
      }
      const clockResult = await client.query<{ now: Date }>("SELECT clock_timestamp() AS now");
      const now = clockResult.rows[0]?.now;
      if (!now || attempt.lease_expires_at <= now) {
        await client.query("ROLLBACK");
        return { applied: false, reason: "LEASE_EXPIRED" };
      }

      const terminalAttempt = TERMINAL_ATTEMPT_STATES.has(command.targetAttemptState);
      const terminalExecution = isTerminalExecutionState(command.targetExecutionState);
      const updated = await client.query<{ updated_at: Date }>({
        text: `
          WITH updated_attempt AS (
            UPDATE agentbay_execution_attempts
            SET state = $6,
                started_at = CASE WHEN $6 = 'RUNNING' THEN COALESCE(started_at, $7) ELSE started_at END,
                finished_at = CASE WHEN $8 THEN $7 ELSE NULL END,
                lease_owner = CASE WHEN $8 THEN NULL ELSE lease_owner END,
                lease_expires_at = CASE WHEN $8 THEN NULL ELSE lease_expires_at END,
                workload_name = COALESCE($18, workload_name),
                opencode_session_id = COALESCE($19, opencode_session_id)
            WHERE execution_id = $1 AND tenant_id = $2 AND attempt = $3
              AND fencing_token = $4 AND lease_owner = $5 AND state = $9
            RETURNING execution_id
          ), updated_execution AS (
            UPDATE agentbay_executions
            SET state = $10, result = $11::jsonb,
                available_at = CASE WHEN $10 = 'RETRY_WAIT'
                  THEN $7 + ($20::double precision * interval '1 millisecond') ELSE available_at END,
                completed_at = CASE WHEN $12 THEN $7 ELSE NULL END,
                updated_at = $7
            WHERE id = $1 AND tenant_id = $2 AND state = $13
              AND EXISTS (SELECT 1 FROM updated_attempt)
            RETURNING id, updated_at
          ), inserted_transition AS (
            INSERT INTO agentbay_execution_transitions
              (id, tenant_id, execution_id, attempt, sequence, from_state, to_state, actor, reason, trace_context, created_at)
            SELECT $14, $2, id, $3,
                   (SELECT COALESCE(MAX(sequence), 0) + 1 FROM agentbay_execution_transitions WHERE tenant_id = $2 AND execution_id = $1),
                   $13, $10, $15, $16, $17::jsonb, $7
            FROM updated_execution
            RETURNING execution_id
          )
          SELECT updated_at FROM updated_execution
          WHERE EXISTS (SELECT 1 FROM inserted_transition)
        `,
        values: [
          command.executionId, command.tenantId, command.attempt, command.fencingToken, command.leaseOwner,
          command.targetAttemptState, now, terminalAttempt, command.expectedAttemptState, command.targetExecutionState,
          JSON.stringify(command.result ?? null), terminalExecution, command.expectedExecutionState, randomUUID(), command.actor,
          command.reason, JSON.stringify({}), command.workloadName ?? null, command.opencodeSessionId ?? null,
          command.retryDelayMs ?? 0,
        ],
      });
      if (updated.rowCount !== 1) {
        await client.query("ROLLBACK");
        return { applied: false, reason: "STATE_MISMATCH" };
      }
      await client.query("COMMIT");
      return {
        applied: true,
        attemptState: command.targetAttemptState,
        executionState: command.targetExecutionState,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

}

type AgentProfileVersionRow = InferSelectModel<typeof agentProfileVersions>;
type AgentProfileVersionSqlRow = {
  created_at: Date;
  definition: unknown;
  id: string;
  profile_id: string;
  tenant_id: string;
  version: number;
};
type ConnectionRow = {
  connection_id: string;
  created_at: Date;
  id: string;
  tenant_id: string;
  type: string;
};
type ExecutionRow = InferSelectModel<typeof executions>;
type BindingRow = {
  binding_id: string;
  created_at: Date;
  definition: unknown;
  disabled_at: Date | null;
  enabled: boolean;
  event_types: string[];
  id: string;
  profile_version_id: string;
  profile_id?: string;
  profile_version?: number;
  tenant_id: string;
  trigger_id: string;
  version: number;
};

type BindingProfileRow = BindingRow & { profile_definition: Record<string, unknown> };
type EventRow = {
  admission_hash: string;
  event_id: string;
  id: string;
  ingested_at: Date;
  source: string;
  source_deduplication_key: string;
  tenant_id: string;
  trigger_id: string;
  type: string;
};

type TriggerSqlRow = {
  config: unknown;
  created_at: Date;
  disabled_at: Date | null;
  enabled: boolean;
  id: string;
  tenant_id: string;
  type: string;
};

type ExecutionJoinedRow = {
  binding_id: string;
  binding_version: number;
  created_at: Date;
  event_id: string;
  id: string;
  input: unknown;
  profile_id: string;
  profile_version: number;
  result: unknown;
  state: string;
  tenant_id: string;
  updated_at: Date;
  workspace: unknown;
};

type ExecutionAttemptRow = {
  attempt: number;
  finished_at: Date | null;
  lease_expires_at: Date | null;
  opencode_session_id: string | null;
  started_at: Date | null;
  state: string;
  workload_name: string | null;
};

type ExecutionTransitionRow = {
  actor: string;
  attempt: number | null;
  created_at: Date;
  from_state: string | null;
  id: string;
  reason: string | null;
  sequence: number;
  to_state: string;
  trace_context: Record<string, string>;
};

type ClaimedExecutionRow = {
  attempt: number;
  attempt_state: string;
  created_at: Date;
  definition: Record<string, unknown>;
  event_id: string;
  execution_state: string;
  fencing_token: string;
  id: string;
  input: unknown;
  lease_expires_at: Date;
  lease_owner: string;
  profile_id: string;
  profile_version_id: string;
  resolved_policy: Record<string, unknown>;
  tenant_id: string;
  timeout_at: Date;
  version: number;
  workspace: Record<string, unknown>;
};

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

type RecoveryExecutionRow = {
  id: string;
  state: "PROVISIONING" | "RUNNING";
  tenant_id: string;
  timeout_at: Date;
};

type ExpiredAttemptRow = {
  attempt: number;
  recovered_at: Date;
  state: "LEASED" | "RUNNING";
};

type RecoveredExecutionRow = {
  id: string;
  recovered_at: Date;
  state: "RETRY_WAIT" | "FAILED" | "TIMED_OUT";
  tenant_id: string;
};

type PromotedExecutionRow = {
  id: string;
  promoted_at: Date;
  state: "QUEUED" | "TIMED_OUT";
  tenant_id: string;
};

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

const TERMINAL_ATTEMPT_STATES: ReadonlySet<string> = new Set(["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT"]);

function claimedExecutionFromRow(row: ClaimedExecutionRow): ClaimedExecution {
  if (!isExecutionState(row.execution_state) || !isAttemptState(row.attempt_state)) {
    throw new Error(`Claimed execution ${row.id} has an invalid persisted state`);
  }
  return {
    createdAt: row.created_at,
    eventId: row.event_id,
    executionId: row.id,
    input: row.input as ClaimedExecution["input"],
    lease: {
      attempt: row.attempt,
      fencingToken: row.fencing_token,
      leaseExpiresAt: row.lease_expires_at,
      leaseOwner: row.lease_owner,
    },
    profileVersion: {
      definition: row.definition as ClaimedExecution["profileVersion"]["definition"],
      id: row.profile_version_id,
      profileId: row.profile_id,
      version: row.version,
    },
    resolvedPolicy: row.resolved_policy as ClaimedExecution["resolvedPolicy"],
    tenantId: row.tenant_id,
    timeoutAt: row.timeout_at,
    workspace: persistedWorkspace(row.id, row.workspace),
  };
}

function profileVersionFromRow(row: AgentProfileVersionRow): AgentProfileVersion {
  return {
    createdAt: row.createdAt.toISOString(),
    definition: agentProfileDefinitionSchema.parse(row.definition),
    id: row.id,
    profile: { id: row.profileID, version: row.version },
    tenantId: row.tenantID,
  };
}

function profileVersionFromSqlRow(row: AgentProfileVersionSqlRow): AgentProfileVersion {
  return {
    createdAt: row.created_at.toISOString(),
    definition: agentProfileDefinitionSchema.parse(row.definition),
    id: row.id,
    profile: { id: row.profile_id, version: row.version },
    tenantId: row.tenant_id,
  };
}

function connectionFromRow(row: ConnectionRow): Connection {
  return parseConnection({
    connection: { id: row.connection_id, type: row.type },
    createdAt: row.created_at.toISOString(),
    id: row.id,
    tenantId: row.tenant_id,
  });
}

function triggerFromRow(row: TriggerSqlRow): Trigger {
  return triggerSchema.parse({
    config: row.config,
    createdAt: row.created_at.toISOString(),
    disabledAt: row.disabled_at?.toISOString() ?? null,
    enabled: row.enabled,
    id: row.id,
    tenantId: row.tenant_id,
    type: row.type,
  });
}

function bindingFromRow(row: BindingRow): PublishedBindingVersion {
  const persisted = row.definition as Record<string, unknown>;
  const definition = bindingDefinitionSchema.parse({
    filter: persisted.filter,
    prompt: persisted.prompt,
    schemaVersion: persisted.schemaVersion,
    workspace: persisted.workspace,
    eventTypes: row.event_types,
  });
  return {
    bindingId: row.binding_id,
    createdAt: row.created_at.toISOString(),
    definition,
    disabledAt: row.disabled_at?.toISOString() ?? null,
    enabled: row.enabled,
    id: row.id,
    profile: {
      id: row.profile_id!,
      version: row.profile_version!,
    },
    tenantId: row.tenant_id,
    triggerId: row.trigger_id,
    version: row.version,
  };
}

const BINDING_SELECT = `SELECT binding.*, profile.profile_id, profile.version AS profile_version
  FROM agentbay_binding_versions AS binding
  JOIN agentbay_agent_profile_versions AS profile
    ON profile.id = binding.profile_version_id AND profile.tenant_id = binding.tenant_id`;

function eventSummary(row: EventRow): AdmissionResult["event"] {
  return {
    admissionHash: row.admission_hash,
    admittedAt: row.ingested_at.toISOString(),
    eventId: row.event_id,
    id: row.id,
    source: row.source,
    sourceDeduplicationKey: row.source_deduplication_key,
    tenantId: row.tenant_id,
    triggerId: row.trigger_id,
    type: row.type,
  };
}

const EXECUTION_SELECT = `SELECT execution.*, binding.binding_id, binding.version AS binding_version,
  profile.profile_id, profile.version AS profile_version
  FROM agentbay_executions AS execution
  JOIN agentbay_binding_versions AS binding ON binding.id = execution.binding_version_id AND binding.tenant_id = execution.tenant_id
  JOIN agentbay_agent_profile_versions AS profile ON profile.id = execution.profile_version_id AND profile.tenant_id = execution.tenant_id`;

async function loadEventExecutions(client: pg.PoolClient, tenantId: string, eventId: string): Promise<Execution[]> {
  const result = await client.query<ExecutionJoinedRow>(EXECUTION_SELECT + ` WHERE execution.tenant_id = $1 AND execution.event_id = $2
    ORDER BY binding.binding_id, binding.version, execution.id`, [tenantId, eventId]);
  return result.rows.map(executionRecordFromJoined);
}

function executionRecordFromJoined(row: ExecutionJoinedRow): Execution {
  if (!isExecutionState(row.state)) throw new PersistedExecutionCorruptionError(row.id, "state");
  return {
    binding: { id: row.binding_id, version: row.binding_version },
    createdAt: row.created_at.toISOString(),
    eventId: row.event_id,
    id: row.id,
    input: row.input as Execution["input"],
    profile: { id: row.profile_id, version: row.profile_version },
    result: (row.result as Execution["result"]) ?? null,
    state: row.state,
    tenantId: row.tenant_id,
    updatedAt: row.updated_at.toISOString(),
    workspace: persistedWorkspace(row.id, row.workspace),
  };
}

function executionAttemptFromRow(executionId: string, row: ExecutionAttemptRow): ExecutionAttempt {
  if (!isAttemptState(row.state)) throw new PersistedExecutionCorruptionError(executionId, "attempt state");
  return {
    attempt: row.attempt,
    finishedAt: row.finished_at?.toISOString() ?? null,
    leaseExpiresAt: row.lease_expires_at?.toISOString() ?? null,
    opencodeSessionId: row.opencode_session_id,
    startedAt: row.started_at?.toISOString() ?? null,
    state: row.state,
    workloadName: row.workload_name,
  };
}

function executionTransitionFromRow(executionId: string, row: ExecutionTransitionRow): ExecutionStateTransition {
  if ((row.from_state !== null && !isExecutionState(row.from_state)) || !isExecutionState(row.to_state)) {
    throw new PersistedExecutionCorruptionError(executionId, "transition state");
  }
  return {
    actor: row.actor,
    attempt: row.attempt,
    createdAt: row.created_at.toISOString(),
    fromState: row.from_state,
    id: row.id,
    reason: row.reason,
    sequence: row.sequence,
    toState: row.to_state,
    traceContext: row.trace_context,
  };
}

function persistedWorkspace(executionId: string, value: unknown): Execution["workspace"] {
  const parsed = resolvedWorkspaceSchema.safeParse(value);
  if (!parsed.success) {
    throw new PersistedExecutionCorruptionError(executionId, "workspace", { cause: parsed.error });
  }
  return parsed.data;
}

function eventExtensions(event: AdmissionCommand["event"]): Record<string, unknown> {
  const core = new Set(["specversion", "id", "source", "type", "subject", "time", "datacontenttype", "dataschema", "data"]);
  return Object.fromEntries(Object.entries(event).filter(([key]) => !core.has(key)));
}

function triggerControlLock(tenantId: string, triggerId: string): string {
  return `control-trigger:${tenantId}:${triggerId}`;
}

function profileTimeoutSeconds(definition: Record<string, unknown>): number {
  const value = definition.timeoutSeconds;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 86_400) {
    throw new Error("Published profile has an invalid timeoutSeconds value");
  }
  return value as number;
}

function assertNonnegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a nonnegative safe integer`);
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
}
