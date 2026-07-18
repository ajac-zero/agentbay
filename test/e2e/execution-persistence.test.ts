import { randomUUID } from "node:crypto";
import pg from "pg";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BindingVersionAlreadyExistsError } from "../../src/control/binding.js";
import { TriggerAlreadyExistsError, TriggerNotFoundError } from "../../src/control/trigger.js";
import { bindingExecutionIdempotencyKey } from "../../src/execution/idempotency.js";
import { IdempotencyConflictError } from "../../src/execution/types.js";
import { hashCanonicalJson, type JsonValue } from "../../src/json.js";
import {
  createPostgresRuntimeStore,
  PersistedExecutionCorruptionError,
  type PostgresRuntimeStore,
} from "../../src/runtime/postgres.js";

const { Pool } = pg;

describe("execution persistence", () => {
  let postgres: StartedTestContainer;
  let store: PostgresRuntimeStore;
  let pool: pg.Pool;

  beforeAll(async () => {
    postgres = await startPostgres();
    const connectionString = postgresConnectionString(postgres);
    store = await createPostgresRuntimeStore({
      connectionString,
      runMigrations: true,
      ssl: false,
      sslRejectUnauthorized: false,
    });
    pool = new Pool({ connectionString });
  });

  afterAll(async () => {
    await pool?.end();
    await store?.close();
    await postgres?.stop();
  });

  it("atomically admits an event and queues matching executions", async () => {
    const createdAt = new Date().toISOString();
    const profile = await store.publishProfileVersion({
      createdAt,
      definition: {
        schemaVersion: 1,
        runtime: { type: "opencode", agent: "coder", opencodeConfig: { agent: { coder: { prompt: "Test" } } } },
        sandbox: { templateName: "opencode", warmPool: "none" },
        connections: [],
        permissions: { onRequest: "fail" },
        timeoutSeconds: 3_600,
      },
      id: randomUUID(),
      profileId: "coder",
      tenantId: "default",
      version: 1,
    });
    expect(await store.getProfileVersion("default", "coder", 1)).toEqual(profile);

    await setupTriggerAndBinding(store, profile.id, createdAt);
    expect(await store.getTrigger("default", "webhook")).toMatchObject({ enabled: true, id: "webhook" });
    expect(await store.getBindingVersion("default", "review", 1)).toMatchObject({
      enabled: true, profile: { id: "coder", version: 1 }, triggerId: "webhook",
    });
    expect(await store.listBindingCandidates("default", "webhook", "dev.agentbay.review.requested")).toHaveLength(1);
    const command = admissionCommand(createdAt);
    const first = await store.admitEvent(command);
    const replay = await store.admitEvent(command);
    const execution = first.executions[0]!;

    expect(first).toMatchObject({ replayed: false, executions: [{ state: "QUEUED", binding: { id: "review", version: 1 }, profile: { id: "coder", version: 1 } }] });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(await store.getExecution("default", execution.id)).toEqual(execution);

    const executionIdentity = (await pool.query(
      "select id, idempotency_key from agentbay_executions where id = $1",
      [execution.id],
    )).rows[0];
    expect(executionIdentity).toEqual({
      id: execution.id,
      idempotency_key: bindingExecutionIdempotencyKey("review-v1", command.internalEventId),
    });
    expect(execution.id).not.toBe(executionIdentity.idempotency_key);

    const transitions = await pool.query(
      "select sequence, from_state, to_state from agentbay_execution_transitions where execution_id = $1 order by sequence",
      [execution.id],
    );
    expect(transitions.rows).toEqual([
      { sequence: 1, from_state: null, to_state: "RECEIVED" },
      { sequence: 2, from_state: "RECEIVED", to_state: "PLANNED" },
      { sequence: 3, from_state: "PLANNED", to_state: "QUEUED" },
    ]);

    const outbox = await pool.query(
      "select topic, aggregate_type, aggregate_id, payload, publish_attempts, published_at from agentbay_outbox where aggregate_id = $1",
      [execution.id],
    );
    expect(outbox.rows).toEqual([
      {
        aggregate_id: execution.id,
        aggregate_type: "execution",
        payload: { schemaVersion: 1, tenantId: "default", executionId: execution.id },
        publish_attempts: 0,
        published_at: null,
        topic: "execution.requested",
      },
    ]);
    expect((await pool.query("select count(*)::int as count from agentbay_events")).rows[0]).toEqual({ count: 1 });
  });

  it("rejects conflicting event replay without rematching", async () => {
    const before = (await pool.query("select count(*)::int as count from agentbay_events")).rows[0].count as number;
    const original = admissionCommand(new Date().toISOString());
    const conflicting = withAdmissionHash({
      ...original,
      event: { ...original.event, data: { action: "different" } },
    });

    await expect(store.admitEvent(conflicting)).rejects.toBeInstanceOf(IdempotencyConflictError);

    expect((await pool.query("select count(*)::int as count from agentbay_events")).rows[0]).toEqual({ count: before });
  });

  it("rejects an invalid admission hash before starting persistence", async () => {
    const command = freshAdmissionCommand();
    await expect(store.admitEvent({ ...command, admissionHash: "caller-controlled" })).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect((await pool.query("select count(*)::int as count from agentbay_events where id = $1", [command.internalEventId])).rows[0]).toEqual({ count: 0 });
  });

  it.each([
    {},
    { type: "empty", unexpected: true },
    {
      type: "git",
      repository: { url: "https://Git.Example.test/repo" },
      revision: { type: "commit", commit: "A".repeat(40) },
    },
  ])("rejects malformed persisted execution workspaces on API reads", async (workspace) => {
    const admitted = await store.admitEvent(freshAdmissionCommand());
    const execution = admitted.executions[0]!;
    await pool.query("update agentbay_executions set workspace = $1 where id = $2", [workspace, execution.id]);

    await expect(store.getExecution("default", execution.id)).rejects.toBeInstanceOf(PersistedExecutionCorruptionError);
  });

  it("serializes concurrent replay by either event identity", async () => {
    const createdAt = new Date().toISOString();
    const base = admissionCommand(createdAt);
    const command = withAdmissionHash({
      ...base,
      internalEventId: randomUUID(),
      sourceDeduplicationKey: randomUUID(),
      event: { ...base.event, id: randomUUID() },
    });
    const [first, second] = await Promise.all([store.admitEvent(command), store.admitEvent(command)]);

    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    expect(first.executions).toEqual(second.executions);
    expect((await pool.query("select count(*)::int as count from agentbay_events where id = $1", [command.internalEventId])).rows[0]).toEqual({ count: 1 });
  });

  it("returns canonical publication lifecycle and rejects duplicate versions", async () => {
    const createdAt = new Date().toISOString();
    const requested = {
      ...(await store.getBindingVersion("default", "review", 1))!,
      bindingId: `canonical-${randomUUID()}`,
      createdAt,
      disabledAt: createdAt,
      enabled: false,
      id: randomUUID(),
      version: 2,
    };
    const published = await store.publishBindingVersion(requested);

    expect(published).toEqual({ ...requested, disabledAt: null, enabled: true });
    await expect(store.publishBindingVersion({ ...requested, id: randomUUID() })).rejects.toBeInstanceOf(BindingVersionAlreadyExistsError);
  });

  it("disables triggers and bindings idempotently while preserving the first timestamp", async () => {
    const createdAt = new Date().toISOString();
    const triggerId = `lifecycle-${randomUUID()}`;
    const bindingId = `lifecycle-${randomUUID()}`;
    const sourceBinding = (await store.getBindingVersion("default", "review", 1))!;
    await store.createTrigger({
      config: { schemaVersion: 1 }, createdAt, disabledAt: null, enabled: true,
      id: triggerId, tenantId: "default", type: "cloudevents.http",
    });
    await store.publishBindingVersion({
      ...sourceBinding, bindingId, createdAt, disabledAt: null, enabled: true, id: randomUUID(), triggerId, version: 1,
    });
    const firstDisabledAt = new Date(Date.now() - 2_000).toISOString();
    const laterDisabledAt = new Date().toISOString();
    const firstTrigger = await store.disableTrigger("default", triggerId, firstDisabledAt);
    const secondTrigger = await store.disableTrigger("default", triggerId, laterDisabledAt);
    const firstBinding = await store.disableBindingVersion("default", bindingId, 1, firstDisabledAt);
    const secondBinding = await store.disableBindingVersion("default", bindingId, 1, laterDisabledAt);

    expect(secondTrigger).toEqual(firstTrigger);
    expect(secondTrigger).toMatchObject({ disabledAt: firstDisabledAt, enabled: false });
    expect(secondBinding).toEqual(firstBinding);
    expect(secondBinding).toMatchObject({ disabledAt: firstDisabledAt, enabled: false });
  });

  it("uses typed trigger-not-found errors for publication and admission", async () => {
    const binding = (await store.getBindingVersion("default", "review", 1))!;
    await expect(store.publishBindingVersion({
      ...binding,
      bindingId: `missing-${randomUUID()}`,
      id: randomUUID(),
      triggerId: "missing-trigger",
      version: 1,
    })).rejects.toBeInstanceOf(TriggerNotFoundError);

    const command = withAdmissionHash({ ...freshAdmissionCommand(), triggerId: "missing-trigger" });
    await expect(store.admitEvent(command)).rejects.toBeInstanceOf(TriggerNotFoundError);
  });

  it("targets trigger identity conflicts", async () => {
    const trigger = (await store.getTrigger("default", "webhook"))!;
    await expect(store.createTrigger({ ...trigger, tenantId: `tenant-${randomUUID()}` })).rejects.toBeInstanceOf(TriggerAlreadyExistsError);
  });

  it("serializes publication and admission on the tenant trigger lock", async () => {
    const client = await pool.connect();
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", ["control-trigger:default:webhook"]);
    const command = freshAdmissionCommand();
    const binding = (await store.getBindingVersion("default", "review", 1))!;
    const admission = store.admitEvent(command);
    const publication = store.publishBindingVersion({
      ...binding,
      bindingId: `locked-${randomUUID()}`,
      createdAt: new Date().toISOString(),
      disabledAt: null,
      enabled: true,
      id: randomUUID(),
      version: 1,
    });
    const blocked = Symbol("blocked");

    expect(await Promise.race([admission.then(() => false), delay(100).then(() => blocked)])).toBe(blocked);
    expect(await Promise.race([publication.then(() => false), delay(100).then(() => blocked)])).toBe(blocked);
    await client.query("commit");
    client.release();

    await expect(admission).resolves.toMatchObject({ replayed: false });
    await expect(publication).resolves.toMatchObject({ enabled: true });
  });

  it("claims available outbox messages without overlapping concurrent publishers", async () => {
    await pool.query("delete from agentbay_outbox");
    const ready = await Promise.all(Array.from({ length: 4 }, () => insertOutbox(pool)));
    await insertOutbox(pool, { available: false });

    const [first, second] = await Promise.all([
      store.claimAvailable({ claimToken: "publisher-a", limit: 2, leaseDurationMs: 60_000 }),
      store.claimAvailable({ claimToken: "publisher-b", limit: 2, leaseDurationMs: 60_000 }),
    ]);
    const claimed = [...first, ...second];

    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    expect(new Set(claimed.map((entry) => entry.id))).toEqual(new Set(ready));
    expect(new Set(claimed.map((entry) => entry.claimToken))).toEqual(new Set(["publisher-a", "publisher-b"]));
    expect((await pool.query(
      "select count(*)::int as count from agentbay_outbox where publish_attempts = 1 and lease_expires_at > now()",
    )).rows[0]).toEqual({ count: 4 });
  });

  it("publishes and retries outbox messages through fenced leases", async () => {
    await pool.query("delete from agentbay_outbox");
    const publishedID = await insertOutbox(pool);
    const [published] = await store.claimAvailable({ claimToken: "publisher-success", limit: 1, leaseDurationMs: 60_000 });
    if (!published) throw new Error("Expected outbox message to be claimed");
    expect(published.id).toBe(publishedID);
    expect(await store.markPublished({ id: published.id, claimToken: published.claimToken })).toBe(true);
    expect(await store.claimAvailable({ claimToken: "publisher-other", limit: 1, leaseDurationMs: 60_000 })).toEqual([]);

    const failedID = await insertOutbox(pool);
    const [failed] = await store.claimAvailable({ claimToken: "publisher-failure", limit: 1, leaseDurationMs: 60_000 });
    if (!failed) throw new Error("Expected outbox message to be claimed");
    expect(failed.id).toBe(failedID);
    expect(await store.markFailed({
      id: failed.id,
      claimToken: failed.claimToken,
      error: "broker unavailable",
      retryDelayMs: 60_000,
    })).toBe(true);
    expect(await store.claimAvailable({ claimToken: "publisher-early", limit: 1, leaseDurationMs: 60_000 })).toEqual([]);

    await pool.query("update agentbay_outbox set available_at = now() - interval '1 second' where id = $1", [failedID]);
    const [retried] = await store.claimAvailable({ claimToken: "publisher-retry", limit: 1, leaseDurationMs: 60_000 });
    expect(retried).toMatchObject({ id: failedID, claimToken: "publisher-retry", publishAttempts: 2 });
  });

  it("reclaims expired outbox leases and rejects stale publishers", async () => {
    await pool.query("delete from agentbay_outbox");
    const id = await insertOutbox(pool);
    const [stale] = await store.claimAvailable({ claimToken: "publisher-stale", limit: 1, leaseDurationMs: 60_000 });
    if (!stale) throw new Error("Expected outbox message to be claimed");
    await pool.query("update agentbay_outbox set lease_expires_at = now() - interval '1 second' where id = $1", [id]);

    const [current] = await store.claimAvailable({ claimToken: "publisher-current", limit: 1, leaseDurationMs: 60_000 });
    if (!current) throw new Error("Expected expired outbox message to be reclaimed");
    expect(current).toMatchObject({ id, claimToken: "publisher-current", publishAttempts: 2 });
    expect(await store.markPublished({ id, claimToken: stale.claimToken })).toBe(false);
    expect(await store.markFailed({ id, claimToken: stale.claimToken, error: "late", retryDelayMs: 0 })).toBe(false);
    expect(await store.markPublished({ id, claimToken: current.claimToken })).toBe(true);
  });
});

function admissionCommand(createdAt: string) {
  return withAdmissionHash({
    admittedAt: createdAt,
    event: {
      data: { action: "review" } as const,
      datacontenttype: "application/json",
      id: "event-1",
      source: "/test/events",
      specversion: "1.0" as const,
      time: createdAt,
      type: "dev.agentbay.review.requested",
    },
    internalEventId: "internal-event-1",
    sourceDeduplicationKey: "delivery-1",
    tenantId: "default",
    triggerId: "webhook",
  });
}

function freshAdmissionCommand() {
  const createdAt = new Date().toISOString();
  const command = admissionCommand(createdAt);
  return withAdmissionHash({
    ...command,
    event: { ...command.event, id: randomUUID() },
    internalEventId: randomUUID(),
    sourceDeduplicationKey: randomUUID(),
  });
}

function withAdmissionHash<T extends { triggerId: string; event: JsonValue }>(command: T): T & { admissionHash: string } {
  return { ...command, admissionHash: hashCanonicalJson({ schemaVersion: 1, triggerId: command.triggerId, event: command.event }) };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function setupTriggerAndBinding(store: PostgresRuntimeStore, profileVersionId: string, createdAt: string): Promise<void> {
  await store.createTrigger({
    config: { schemaVersion: 1 }, createdAt, disabledAt: null, enabled: true,
    id: "webhook", tenantId: "default", type: "cloudevents.http",
  });
  await store.publishBindingVersion({
    bindingId: "review", createdAt,
    definition: {
      eventTypes: ["dev.agentbay.review.requested"], filter: { all: [{ op: "eq", path: "/action", value: "review" }] },
      prompt: { includeEvent: "data", literal: "Review this" }, schemaVersion: 1, workspace: { type: "empty" },
    },
    disabledAt: null, enabled: true, id: "review-v1", profile: { id: "coder", version: 1 },
    tenantId: "default", triggerId: "webhook", version: 1,
  });
  expect(profileVersionId).toBeTruthy();
}

async function insertOutbox(pool: pg.Pool, options: { available?: boolean } = {}): Promise<string> {
  const id = randomUUID();
  const aggregateID = randomUUID();
  await pool.query(`
    insert into agentbay_outbox (
      id, tenant_id, topic, aggregate_type, aggregate_id, payload, headers, available_at, created_at
    ) values ($1, 'default', 'execution.requested', 'execution', $2, $3, '{}',
      case when $4 then now() - interval '1 minute' else now() + interval '1 hour' end,
      now() - interval '2 minutes')
  `, [id, aggregateID, { schemaVersion: 1, executionId: aggregateID }, options.available ?? true]);
  return id;
}

async function startPostgres(): Promise<StartedTestContainer> {
  return new GenericContainer("postgres:16-alpine")
    .withEnvironment({
      POSTGRES_DB: "agentbay",
      POSTGRES_PASSWORD: "agentbay-password",
      POSTGRES_USER: "agentbay",
    })
    .withExposedPorts(5432)
    .withHealthCheck({
      interval: 1_000,
      retries: 30,
      test: ["CMD-SHELL", "pg_isready -U agentbay -d agentbay"],
      timeout: 5_000,
    })
    .withWaitStrategy(Wait.forHealthCheck())
    .start();
}

function postgresConnectionString(container: StartedTestContainer): string {
  return `postgresql://agentbay:agentbay-password@${container.getHost()}:${container.getMappedPort(5432)}/agentbay`;
}
