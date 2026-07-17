import { randomUUID } from "node:crypto";
import pg from "pg";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IdempotencyConflictError } from "../../src/execution/types.js";
import { createPostgresRuntimeStore, type PostgresRuntimeStore } from "../../src/runtime/postgres.js";

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

  it("atomically publishes a profile and queues an idempotent execution", async () => {
    const createdAt = new Date().toISOString();
    const profile = await store.publishProfileVersion({
      createdAt,
      definition: {
        runtime: { type: "opencode", agent: "coder", opencodeConfig: { agent: { coder: { prompt: "Test" } } } },
        timeoutSeconds: 3_600,
      },
      id: randomUUID(),
      profileId: "coder",
      tenantId: "default",
      version: 1,
    });
    expect(await store.getProfileVersion("default", "coder", 1)).toEqual(profile);

    const command = executionCommand(createdAt);
    const first = await store.createExecution(command);
    const replay = await store.createExecution({
      ...command,
      id: randomUUID(),
      event: { ...command.event, id: randomUUID() },
    });

    expect(first).toMatchObject({ replayed: false, execution: { state: "QUEUED", profile: { id: "coder", version: 1 } } });
    expect(replay).toEqual({ execution: first.execution, replayed: true });
    expect(await store.getExecution("default", first.execution.id)).toEqual(first.execution);

    const transitions = await pool.query(
      "select sequence, from_state, to_state from agentbay_execution_transitions where execution_id = $1 order by sequence",
      [first.execution.id],
    );
    expect(transitions.rows).toEqual([
      { sequence: 1, from_state: null, to_state: "RECEIVED" },
      { sequence: 2, from_state: "RECEIVED", to_state: "PLANNED" },
      { sequence: 3, from_state: "PLANNED", to_state: "QUEUED" },
    ]);

    const outbox = await pool.query(
      "select topic, aggregate_type, aggregate_id, payload, publish_attempts, published_at from agentbay_outbox where aggregate_id = $1",
      [first.execution.id],
    );
    expect(outbox.rows).toEqual([
      {
        aggregate_id: first.execution.id,
        aggregate_type: "execution",
        payload: { schemaVersion: 1, tenantId: "default", executionId: first.execution.id },
        publish_attempts: 0,
        published_at: null,
        topic: "execution.requested",
      },
    ]);
    expect((await pool.query("select count(*)::int as count from agentbay_events")).rows[0]).toEqual({ count: 1 });
  });

  it("rejects conflicting idempotency without persisting another event", async () => {
    const existing = (await pool.query("select id, idempotency_key from agentbay_executions limit 1")).rows[0] as {
      id: string;
      idempotency_key: string;
    };
    const before = (await pool.query("select count(*)::int as count from agentbay_events")).rows[0].count as number;

    await expect(store.createExecution({
      ...executionCommand(new Date().toISOString()),
      idempotencyKey: existing.idempotency_key,
      requestHash: "different-request",
    })).rejects.toBeInstanceOf(IdempotencyConflictError);

    expect((await pool.query("select count(*)::int as count from agentbay_events")).rows[0]).toEqual({ count: before });
    expect((await pool.query("select count(*)::int as count from agentbay_executions where id = $1", [existing.id])).rows[0]).toEqual({ count: 1 });
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

function executionCommand(createdAt: string) {
  const id = randomUUID();
  return {
    createdAt,
    event: {
      data: { profile: { id: "coder", version: 1 }, input: { text: "Review this" }, workspace: { type: "empty" } } as const,
      id: randomUUID(),
      source: "/v1/executions",
      time: createdAt,
      type: "dev.agentbay.execution.submitted",
    },
    id,
    idempotencyKey: "execution-persistence-test",
    input: { text: "Review this" },
    profile: { id: "coder", version: 1 },
    requestHash: "same-request",
    tenantId: "default",
    workspace: { type: "empty" as const },
  };
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
