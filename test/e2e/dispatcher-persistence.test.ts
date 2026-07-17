import { randomUUID } from "node:crypto";
import pg from "pg";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresRuntimeStore, type PostgresRuntimeStore } from "../../src/runtime/postgres.js";

const { Pool } = pg;

describe("dispatcher persistence", () => {
  let postgres: StartedTestContainer;
  let store: PostgresRuntimeStore;
  let pool: pg.Pool;
  let profileId: string;

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
    profileId = `profile-${randomUUID()}`;
    await store.publishProfileVersion({
      createdAt: new Date().toISOString(),
      definition: {
        runtime: { type: "opencode", agent: "coder", opencodeConfig: { agent: { coder: { prompt: "Test" } } } },
        timeoutSeconds: 3_600,
      },
      id: randomUUID(),
      profileId,
      tenantId: "default",
      version: 1,
    });
  });

  afterAll(async () => {
    await pool?.end();
    await store?.close();
    await postgres?.stop();
  });

  it("atomically claims a queued execution and creates its first fenced attempt", async () => {
    const executionId = await queueExecution();
    const claimed = await store.claimNextQueuedExecution({ leaseOwner: "dispatcher-a", leaseDurationMs: 60_000 });

    expect(claimed).toMatchObject({
      executionId,
      lease: { attempt: 1, leaseOwner: "dispatcher-a" },
      profileVersion: { profileId, version: 1 },
    });
    expect(claimed?.lease.fencingToken).toBeTruthy();

    const persisted = await executionSnapshot(executionId);
    expect(persisted.execution.state).toBe("PROVISIONING");
    expect(persisted.attempts).toEqual([expect.objectContaining({
      attempt: 1,
      fencing_token: claimed?.lease.fencingToken,
      lease_owner: "dispatcher-a",
      state: "LEASED",
    })]);
    expect(persisted.transitions.at(-1)).toMatchObject({
      attempt: 1,
      from_state: "QUEUED",
      sequence: 4,
      to_state: "PROVISIONING",
    });
  });

  it("allows only one dispatcher to claim one queued execution", async () => {
    const executionId = await queueExecution();
    const [first, second] = await Promise.all([
      store.claimNextQueuedExecution({ leaseOwner: "dispatcher-a", leaseDurationMs: 60_000 }),
      store.claimNextQueuedExecution({ leaseOwner: "dispatcher-b", leaseDurationMs: 60_000 }),
    ]);
    const claims = [first, second].filter((claim) => claim?.executionId === executionId);

    expect(claims).toHaveLength(1);
    expect((await pool.query(
      "select count(*)::int as count from agentbay_execution_attempts where execution_id = $1",
      [executionId],
    )).rows[0]).toEqual({ count: 1 });
    expect((await pool.query(
      "select count(*)::int as count from agentbay_execution_transitions where execution_id = $1 and to_state = 'PROVISIONING'",
      [executionId],
    )).rows[0]).toEqual({ count: 1 });
  });

  it("renews only the current unexpired execution lease", async () => {
    const executionId = await queueExecution();
    const claimed = await store.claimNextQueuedExecution({ leaseOwner: "dispatcher-a", leaseDurationMs: 60_000 });
    if (!claimed) throw new Error("Expected execution to be claimed");

    expect(await store.renewExecutionLease({
      executionId,
      tenantId: "default",
      attempt: claimed.lease.attempt,
      fencingToken: claimed.lease.fencingToken,
      leaseOwner: claimed.lease.leaseOwner,
      leaseDurationMs: 120_000,
    })).toBe(true);
    expect(await store.renewExecutionLease({
      executionId,
      tenantId: "default",
      attempt: claimed.lease.attempt,
      fencingToken: "stale-token",
      leaseOwner: claimed.lease.leaseOwner,
      leaseDurationMs: 120_000,
    })).toBe(false);

    await pool.query(
      "update agentbay_execution_attempts set lease_expires_at = now() - interval '1 second' where execution_id = $1",
      [executionId],
    );
    expect(await store.renewExecutionLease({
      executionId,
      tenantId: "default",
      attempt: claimed.lease.attempt,
      fencingToken: claimed.lease.fencingToken,
      leaseOwner: claimed.lease.leaseOwner,
      leaseDurationMs: 120_000,
    })).toBe(false);
    await pool.query(
      "update agentbay_execution_attempts set lease_expires_at = now() + interval '1 hour' where execution_id = $1",
      [executionId],
    );
  });

  it("starts and succeeds an execution under the active fence", async () => {
    const executionId = await queueExecution();
    const claimed = await store.claimNextQueuedExecution({ leaseOwner: "dispatcher-a", leaseDurationMs: 60_000 });
    if (!claimed) throw new Error("Expected execution to be claimed");
    const lease = claimed.lease;

    await expect(store.transitionLeasedExecution({
      executionId,
      tenantId: "default",
      attempt: lease.attempt,
      fencingToken: lease.fencingToken,
      leaseOwner: lease.leaseOwner,
      expectedExecutionState: "PROVISIONING",
      expectedAttemptState: "LEASED",
      targetExecutionState: "RUNNING",
      targetAttemptState: "RUNNING",
      actor: "dispatcher-a",
      reason: "sandbox ready",
      workloadName: "execution-attempt-1",
      opencodeSessionId: "session-1",
    })).resolves.toEqual({ applied: true, executionState: "RUNNING", attemptState: "RUNNING" });

    await expect(store.transitionLeasedExecution({
      executionId,
      tenantId: "default",
      attempt: lease.attempt,
      fencingToken: lease.fencingToken,
      leaseOwner: lease.leaseOwner,
      expectedExecutionState: "RUNNING",
      expectedAttemptState: "RUNNING",
      targetExecutionState: "SUCCEEDED",
      targetAttemptState: "SUCCEEDED",
      actor: "dispatcher-a",
      reason: "agent completed",
      result: { output: "ok" },
    })).resolves.toEqual({ applied: true, executionState: "SUCCEEDED", attemptState: "SUCCEEDED" });

    const persisted = await executionSnapshot(executionId);
    expect(persisted.execution).toMatchObject({ state: "SUCCEEDED", result: { output: "ok" }, completed_at: null });
    expect(persisted.attempts[0]).toMatchObject({
      state: "SUCCEEDED",
      lease_owner: null,
      lease_expires_at: null,
      workload_name: "execution-attempt-1",
      opencode_session_id: "session-1",
    });
    expect(persisted.transitions.map((transition) => transition.to_state)).toEqual([
      "RECEIVED", "PLANNED", "QUEUED", "PROVISIONING", "RUNNING", "SUCCEEDED",
    ]);
  });

  it("rejects a stale fence without mutating execution history", async () => {
    const executionId = await queueExecution();
    const claimed = await store.claimNextQueuedExecution({ leaseOwner: "dispatcher-a", leaseDurationMs: 60_000 });
    if (!claimed) throw new Error("Expected execution to be claimed");
    const before = await executionSnapshot(executionId);

    await expect(store.transitionLeasedExecution({
      executionId,
      tenantId: "default",
      attempt: claimed.lease.attempt,
      fencingToken: "stale-token",
      leaseOwner: claimed.lease.leaseOwner,
      expectedExecutionState: "PROVISIONING",
      expectedAttemptState: "LEASED",
      targetExecutionState: "RUNNING",
      targetAttemptState: "RUNNING",
      actor: "stale-worker",
      reason: "late result",
    })).resolves.toEqual({ applied: false, reason: "LEASE_MISMATCH" });
    expect(await executionSnapshot(executionId)).toEqual(before);
  });

  it("recovers an expired lease and creates a newly fenced retry attempt", async () => {
    const executionId = await queueExecution();
    const first = await store.claimNextQueuedExecution({ leaseOwner: "dispatcher-stale", leaseDurationMs: 60_000 });
    if (!first) throw new Error("Expected first execution attempt");
    await pool.query(
      "update agentbay_execution_attempts set lease_expires_at = now() - interval '1 second' where execution_id = $1",
      [executionId],
    );

    expect(await store.recoverExpiredExecutionLeases({ limit: 10, maxAttempts: 3, retryDelayMs: 60_000 })).toEqual([
      expect.objectContaining({ attempt: 1, executionId, executionState: "RETRY_WAIT" }),
    ]);
    let persisted = await executionSnapshot(executionId);
    expect(persisted.execution).toMatchObject({ state: "RETRY_WAIT", completed_at: null });
    expect(persisted.attempts[0]).toMatchObject({
      attempt: 1,
      state: "FAILED",
      lease_owner: null,
      lease_expires_at: null,
    });
    expect(persisted.attempts[0]?.finished_at).toBeInstanceOf(Date);

    expect(await store.promoteDueExecutionRetries({ limit: 10 })).toEqual([]);
    await pool.query(
      "update agentbay_executions set available_at = now() - interval '1 second' where id = $1",
      [executionId],
    );
    expect(await store.promoteDueExecutionRetries({ limit: 10 })).toEqual([
      expect.objectContaining({ executionId }),
    ]);

    const second = await store.claimNextQueuedExecution({ leaseOwner: "dispatcher-current", leaseDurationMs: 60_000 });
    expect(second).toMatchObject({ executionId, lease: { attempt: 2, leaseOwner: "dispatcher-current" } });
    expect(second?.lease.fencingToken).not.toBe(first.lease.fencingToken);

    const beforeStaleWrite = await executionSnapshot(executionId);
    await expect(store.transitionLeasedExecution({
      executionId,
      tenantId: "default",
      attempt: 1,
      fencingToken: first.lease.fencingToken,
      leaseOwner: first.lease.leaseOwner,
      expectedExecutionState: "PROVISIONING",
      expectedAttemptState: "LEASED",
      targetExecutionState: "RUNNING",
      targetAttemptState: "RUNNING",
      actor: "dispatcher-stale",
      reason: "late attempt result",
    })).resolves.toEqual({ applied: false, reason: "LEASE_MISMATCH" });
    expect(await executionSnapshot(executionId)).toEqual(beforeStaleWrite);

    persisted = await executionSnapshot(executionId);
    expect(persisted.transitions.map((transition) => ({
      attempt: transition.attempt,
      from: transition.from_state,
      to: transition.to_state,
    }))).toEqual([
      { attempt: null, from: null, to: "RECEIVED" },
      { attempt: null, from: "RECEIVED", to: "PLANNED" },
      { attempt: null, from: "PLANNED", to: "QUEUED" },
      { attempt: 1, from: "QUEUED", to: "PROVISIONING" },
      { attempt: 1, from: "PROVISIONING", to: "RETRY_WAIT" },
      { attempt: null, from: "RETRY_WAIT", to: "QUEUED" },
      { attempt: 2, from: "QUEUED", to: "PROVISIONING" },
    ]);
  });

  it("fails an execution when its expired lease exhausts attempts", async () => {
    const executionId = await queueExecution();
    const claimed = await store.claimNextQueuedExecution({ leaseOwner: "dispatcher-a", leaseDurationMs: 60_000 });
    if (!claimed) throw new Error("Expected execution attempt");
    await pool.query(
      "update agentbay_execution_attempts set lease_expires_at = now() - interval '1 second' where execution_id = $1",
      [executionId],
    );

    expect(await store.recoverExpiredExecutionLeases({ limit: 10, maxAttempts: 1, retryDelayMs: 0 })).toEqual([
      expect.objectContaining({ attempt: 1, executionId, executionState: "FAILED" }),
    ]);
    const persisted = await executionSnapshot(executionId);
    expect(persisted.execution.state).toBe("FAILED");
    expect(persisted.execution.completed_at).toBeInstanceOf(Date);
    expect(persisted.attempts[0]).toMatchObject({ state: "FAILED", lease_owner: null, lease_expires_at: null });
    expect(persisted.transitions.at(-1)).toMatchObject({
      attempt: 1,
      from_state: "PROVISIONING",
      to_state: "FAILED",
    });
    expect(await store.promoteDueExecutionRetries({ limit: 10 })).toEqual([]);
  });

  it("does not recover a renewed unexpired lease", async () => {
    const executionId = await queueExecution();
    const claimed = await store.claimNextQueuedExecution({ leaseOwner: "dispatcher-a", leaseDurationMs: 60_000 });
    if (!claimed) throw new Error("Expected execution attempt");
    expect(await store.renewExecutionLease({
      executionId,
      tenantId: "default",
      attempt: claimed.lease.attempt,
      fencingToken: claimed.lease.fencingToken,
      leaseOwner: claimed.lease.leaseOwner,
      leaseDurationMs: 120_000,
    })).toBe(true);
    const before = await executionSnapshot(executionId);

    expect(await store.recoverExpiredExecutionLeases({ limit: 10, maxAttempts: 3, retryDelayMs: 0 })).toEqual([]);
    expect(await executionSnapshot(executionId)).toEqual(before);
  });

  it("times out a retry whose execution deadline elapsed while waiting", async () => {
    const executionId = await queueExecution();
    const claimed = await store.claimNextQueuedExecution({ leaseOwner: "dispatcher-a", leaseDurationMs: 60_000 });
    if (!claimed) throw new Error("Expected execution attempt");
    await pool.query(
      "update agentbay_execution_attempts set lease_expires_at = now() - interval '1 second' where execution_id = $1",
      [executionId],
    );
    await store.recoverExpiredExecutionLeases({ limit: 10, maxAttempts: 3, retryDelayMs: 60_000 });
    await pool.query(
      "update agentbay_executions set timeout_at = now() - interval '1 second' where id = $1",
      [executionId],
    );

    expect(await store.promoteDueExecutionRetries({ limit: 10 })).toEqual([
      expect.objectContaining({ executionId, executionState: "TIMED_OUT" }),
    ]);
    const persisted = await executionSnapshot(executionId);
    expect(persisted.execution.state).toBe("TIMED_OUT");
    expect(persisted.execution.completed_at).toBeInstanceOf(Date);
    expect(persisted.transitions.at(-1)).toMatchObject({
      attempt: null,
      from_state: "RETRY_WAIT",
      to_state: "TIMED_OUT",
    });
  });

  async function queueExecution(): Promise<string> {
    const createdAt = new Date().toISOString();
    const id = randomUUID();
    await store.createExecution({
      createdAt,
      event: {
        data: { profile: { id: profileId, version: 1 }, input: { text: "Run" }, workspace: { type: "empty" } },
        id: randomUUID(),
        source: "/test/dispatcher",
        time: createdAt,
        type: "dev.agentbay.execution.submitted",
      },
      id,
      idempotencyKey: randomUUID(),
      input: { text: "Run" },
      profile: { id: profileId, version: 1 },
      requestHash: randomUUID(),
      tenantId: "default",
      workspace: { type: "empty" },
    });
    return id;
  }

  async function executionSnapshot(executionId: string) {
    const execution = (await pool.query(
      "select state, result, completed_at, available_at from agentbay_executions where id = $1",
      [executionId],
    )).rows[0];
    const attempts = (await pool.query(
      "select attempt, state, fencing_token, lease_owner, lease_expires_at, started_at, finished_at, workload_name, opencode_session_id from agentbay_execution_attempts where execution_id = $1 order by attempt",
      [executionId],
    )).rows;
    const transitions = (await pool.query(
      "select sequence, attempt, from_state, to_state from agentbay_execution_transitions where execution_id = $1 order by sequence",
      [executionId],
    )).rows;
    return { attempts, execution, transitions };
  }
});

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
