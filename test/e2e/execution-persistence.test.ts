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
