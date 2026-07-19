import { randomUUID } from "node:crypto";
import pg from "pg";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashCanonicalJson, type JsonValue } from "../../src/json.js";
import type { BindingWorkspace } from "../../src/workspace/types.js";
import { WorkspaceResolutionError } from "../../src/workspace/resolver.js";
import { createPostgresRuntimeStore, type PostgresRuntimeStore } from "../../src/runtime/postgres.js";

const { Pool } = pg;

describe("wake admission persistence", () => {
  let postgres: StartedTestContainer;
  let store: PostgresRuntimeStore;
  let pool: pg.Pool;
  let profileId: string;

  beforeAll(async () => {
    postgres = await new GenericContainer("postgres:16-alpine")
      .withEnvironment({ POSTGRES_DB: "agentbay", POSTGRES_PASSWORD: "agentbay-password", POSTGRES_USER: "agentbay" })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
      .start();
    const connectionString = `postgresql://agentbay:agentbay-password@${postgres.getHost()}:${postgres.getMappedPort(5432)}/agentbay`;
    store = await createPostgresRuntimeStore({ connectionString, runMigrations: true, ssl: false, sslRejectUnauthorized: false });
    pool = new Pool({ connectionString });
    profileId = randomUUID();
    const createdAt = new Date().toISOString();
    await store.publishProfileVersion({
      createdAt, id: profileId, profileId: "developer", tenantId: "default", version: 1,
      definition: {
        schemaVersion: 1, runtime: { type: "opencode", agent: "developer", opencodeConfig: { agent: { developer: {} } } },
        sandbox: { templateName: "developer", warmPool: "none" }, connections: [], permissions: { onRequest: "fail" }, timeoutSeconds: 3600,
      },
    });
    await store.createTrigger({ config: { schemaVersion: 1 }, createdAt, disabledAt: null, enabled: true, id: "events", tenantId: "default", type: "cloudevents.http" });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await store?.close();
    await postgres?.stop();
  });

  it("atomically consumes a wait, queues immutable continuation input, and replays the wake result", async () => {
    const correlation = randomUUID();
    const executionId = await createWaitingExecution(correlation);
    await publishWakeBinding("continue", "work.continue", {
      type: "continue", prompt: { literal: "Continue after review.", includeEvent: "data" },
    });
    const command = admissionCommand("work.continue", { key: correlation, review: "changes requested" });

    const first = await store.admitEvent(command);
    const replay = await store.admitEvent(command);

    expect(first).toMatchObject({
      replayed: false,
      executions: [],
      wakes: [{ executionId, action: "CONTINUED", inputSequence: 2, state: "QUEUED", binding: { id: "continue", version: 1 } }],
    });
    expect(replay).toEqual({ ...first, replayed: true });
    const wait = (await pool.query("select state, ended_at from agentbay_event_waits where execution_id = $1", [executionId])).rows[0];
    expect(wait).toMatchObject({ state: "CONSUMED", ended_at: expect.any(Date) });
    expect((await pool.query("select kind, sequence, input from agentbay_execution_inputs where execution_id = $1 order by sequence", [executionId])).rows).toEqual([
      expect.objectContaining({ kind: "INITIAL", sequence: 1 }),
      {
        kind: "WAKE", sequence: 2,
        input: expect.objectContaining({ text: expect.stringContaining("Continue after review."), context: { event: { key: correlation, review: "changes requested" }, includeEvent: "data" } }),
      },
    ]);
    expect((await pool.query("select count(*)::int as count from agentbay_event_wakes where execution_id = $1", [executionId])).rows[0]).toEqual({ count: 1 });
    expect((await pool.query("select count(*)::int as count from agentbay_outbox where aggregate_type = 'event-wake' and payload->>'executionId' = $1", [executionId])).rows[0]).toEqual({ count: 1 });
    expect(await store.getExecution("default", executionId)).toMatchObject({
      input: { text: expect.stringContaining("Continue after review.") }, state: "QUEUED",
    });
    const timeout = (await pool.query<{ timeout_at: Date }>("select timeout_at from agentbay_executions where id = $1", [executionId])).rows[0]!.timeout_at;
    expect(timeout.getTime()).toBeGreaterThan(Date.now() + 3_500_000);
    expect(timeout.getTime()).toBeLessThan(Date.now() + 3_700_000);

    const claimed = await store.claimNextQueuedExecution({ leaseOwner: "continuation-worker", leaseDurationMs: 60_000 });
    expect(claimed).toMatchObject({ executionId, input: { text: expect.stringContaining("Continue after review.") }, lease: { attempt: 2 } });
  });

  it("pins a continuation and all retries to the wake event workspace revision", async () => {
    const correlation = randomUUID();
    const initialCommit = "a".repeat(40);
    const updatedCommit = "b".repeat(40);
    const executionId = await createWaitingExecution(correlation, {
      type: "git", repository: { url: { path: "/repositoryUrl" } }, revision: { commit: { path: "/commit" } },
    }, { repositoryUrl: "https://github.com/acme/repo.git", commit: initialCommit });
    await publishWakeBinding(`revision-${correlation}`, "work.synchronize", {
      type: "continue",
      prompt: { literal: "Review updated revision.", includeEvent: "data" },
      workspace: { type: "git", repository: { url: { path: "/repositoryUrl" } }, revision: { commit: { path: "/commit" } } },
    });

    await store.admitEvent(admissionCommand("work.synchronize", {
      key: correlation, repositoryUrl: "https://github.com/acme/repo.git", commit: updatedCommit,
    }));

    const expectedWorkspace = {
      type: "git", repository: { url: "https://github.com/acme/repo.git" }, revision: { type: "commit", commit: updatedCommit },
    };
    expect(await store.getExecution("default", executionId)).toMatchObject({ workspace: expectedWorkspace });
    expect((await pool.query("select sequence, workspace from agentbay_execution_inputs where execution_id = $1 order by sequence", [executionId])).rows).toEqual([
      { sequence: 1, workspace: { ...expectedWorkspace, revision: { type: "commit", commit: initialCommit } } },
      { sequence: 2, workspace: expectedWorkspace },
    ]);
    const claimed = await store.claimNextQueuedExecution({ leaseOwner: `revision-worker-${correlation}`, leaseDurationMs: 60_000 });
    expect(claimed).toMatchObject({ executionId, workspace: expectedWorkspace, lease: { attempt: 2 } });
    await pool.query("update agentbay_execution_attempts set lease_expires_at = now() - interval '1 second' where execution_id = $1 and attempt = 2", [executionId]);
    await pool.query("update agentbay_executions set state = 'RUNNING' where id = $1", [executionId]);
    await pool.query(`update agentbay_execution_attempts set state = 'RUNNING', workload_name = 'sandbox', opencode_session_id = 'session'
      where execution_id = $1 and attempt = 2`, [executionId]);
    const retried = await store.claimExpiredRunningExecution({ leaseOwner: `retry-worker-${correlation}`, leaseDurationMs: 60_000 });
    expect(retried).toMatchObject({ executionId, workspace: expectedWorkspace, lease: { attempt: 2 } });
  });

  it("rolls back admission when a continuation workspace cannot be resolved", async () => {
    const correlation = randomUUID();
    const executionId = await createWaitingExecution(correlation);
    await publishWakeBinding(`invalid-revision-${correlation}`, "work.invalid-revision", {
      type: "continue",
      prompt: { literal: "Review updated revision.", includeEvent: "data" },
      workspace: { type: "git", repository: { url: { path: "/repositoryUrl" } }, revision: { commit: { path: "/commit" } } },
    });
    const command = admissionCommand("work.invalid-revision", {
      key: correlation, repositoryUrl: "https://github.com/acme/repo.git", commit: "mutable-branch",
    });

    await expect(store.admitEvent(command)).rejects.toBeInstanceOf(WorkspaceResolutionError);

    expect((await pool.query("select count(*)::int as count from agentbay_events where id = $1", [command.internalEventId])).rows[0]).toEqual({ count: 0 });
    expect((await pool.query("select state from agentbay_event_waits where execution_id = $1", [executionId])).rows[0]).toEqual({ state: "ACTIVE" });
    expect(await store.getExecution("default", executionId)).toMatchObject({ state: "WAITING" });
  });

  it("terminally completes a waiting execution without queueing another attempt", async () => {
    const correlation = randomUUID();
    const executionId = await createWaitingExecution(correlation);
    await publishWakeBinding(`complete-${correlation}`, "work.complete", { type: "complete" });
    const result = await store.admitEvent(admissionCommand("work.complete", { key: correlation }));

    expect(result.wakes).toEqual([expect.objectContaining({ executionId, action: "COMPLETED", inputSequence: null, state: "COMPLETED" })]);
    expect(await store.getExecution("default", executionId)).toMatchObject({ state: "COMPLETED" });
    expect((await pool.query("select count(*)::int as count from agentbay_execution_inputs where execution_id = $1", [executionId])).rows[0]).toEqual({ count: 1 });
    expect((await pool.query("select count(*)::int as count from agentbay_outbox where aggregate_type = 'event-wake' and payload->>'executionId' = $1", [executionId])).rows[0]).toEqual({ count: 0 });
  });

  it("uses stable binding order when multiple wake policies match one wait", async () => {
    const correlation = randomUUID();
    const executionId = await createWaitingExecution(correlation);
    await publishWakeBinding(`a-complete-${correlation}`, "work.overlap", { type: "complete" });
    await publishWakeBinding(`z-continue-${correlation}`, "work.overlap", {
      type: "continue", prompt: { literal: "Deterministic winner.", includeEvent: "data" },
    });

    const result = await store.admitEvent(admissionCommand("work.overlap", { key: correlation }));

    expect(result.wakes).toEqual([expect.objectContaining({
      executionId, action: "COMPLETED", binding: { id: `a-complete-${correlation}`, version: 1 },
    })]);
    expect((await pool.query("select count(*)::int as count from agentbay_event_wakes where execution_id = $1", [executionId])).rows[0]).toEqual({ count: 1 });
  });

  it("does not consume an overdue active wait before maintenance expires it", async () => {
    const correlation = randomUUID();
    const executionId = await createWaitingExecution(correlation);
    await pool.query(`update agentbay_event_waits
      set activated_at = now() - interval '2 seconds', deadline_at = now() - interval '1 second'
      where execution_id = $1`, [executionId]);
    await publishWakeBinding(`late-${correlation}`, "work.late", {
      type: "continue", prompt: { literal: "Too late.", includeEvent: "data" },
    });

    const result = await store.admitEvent(admissionCommand("work.late", { key: correlation }));

    expect(result.wakes).toEqual([]);
    expect((await pool.query("select state from agentbay_event_waits where execution_id = $1", [executionId])).rows[0]).toEqual({ state: "ACTIVE" });
    expect(await store.getExecution("default", executionId)).toMatchObject({ state: "WAITING" });
  });

  async function createWaitingExecution(
    correlation: string,
    workspace: BindingWorkspace = { type: "empty" },
    extraData: Record<string, JsonValue> = {},
  ): Promise<string> {
    const bindingId = `start-${correlation}`;
    const createdAt = new Date().toISOString();
    await store.publishBindingVersion({
      bindingId, createdAt, disabledAt: null, enabled: true, id: randomUUID(), profile: { id: "developer", version: 1 }, tenantId: "default", triggerId: "events", version: 1,
      definition: {
        schemaVersion: 1, eventTypes: ["work.start"], filter: { all: [{ path: "/key", op: "eq", value: correlation }] },
        prompt: { literal: "Start work.", includeEvent: "data" }, workspace,
        afterTurn: { disposition: "wait", wait: { name: "work-lifecycle", correlation: [{ name: "key", path: "/key" }], deadlineSeconds: 600 } },
      },
    });
    const admitted = await store.admitEvent(admissionCommand("work.start", { key: correlation, ...extraData }));
    const executionId = admitted.executions[0]!.id;
    const claimed = await store.claimNextQueuedExecution({ leaseOwner: `worker-${correlation}`, leaseDurationMs: 60_000 });
    if (!claimed || claimed.executionId !== executionId) throw new Error("Expected execution claim");
    await store.transitionLeasedExecution({
      actor: claimed.lease.leaseOwner, attempt: claimed.lease.attempt, executionId, expectedAttemptState: "LEASED", expectedExecutionState: "PROVISIONING",
      fencingToken: claimed.lease.fencingToken, leaseOwner: claimed.lease.leaseOwner, reason: "sandbox ready", targetAttemptState: "RUNNING", targetExecutionState: "RUNNING", tenantId: "default",
    });
    const completed = await store.completeLeasedExecutionTurn({
      actor: claimed.lease.leaseOwner, attempt: claimed.lease.attempt, executionId, fencingToken: claimed.lease.fencingToken,
      leaseOwner: claimed.lease.leaseOwner, reason: "turn complete", result: null, tenantId: "default",
    });
    if (!completed.applied || completed.executionState !== "WAITING") throw new Error("Expected waiting execution");
    return executionId;
  }

  async function publishWakeBinding(bindingId: string, eventType: string, action: { type: "complete" } | {
    type: "continue"; prompt: { literal: string; includeEvent: "data" }; workspace?: BindingWorkspace;
  }): Promise<void> {
    await store.publishBindingVersion({
      bindingId, createdAt: new Date().toISOString(), disabledAt: null, enabled: true, id: randomUUID(),
      profile: { id: "developer", version: 1 }, tenantId: "default", triggerId: "events", version: 1,
      definition: {
        disposition: "wake", schemaVersion: 1, eventTypes: [eventType], filter: { all: [] },
        wake: { waitName: "work-lifecycle", correlation: [{ name: "key", path: "/key" }], action },
      },
    });
  }
});

function admissionCommand(type: string, data: JsonValue) {
  const event = { data, datacontenttype: "application/json", id: randomUUID(), source: "/test/wake", specversion: "1.0" as const, type };
  const command = {
    admittedAt: new Date().toISOString(), event, internalEventId: randomUUID(), sourceDeduplicationKey: randomUUID(), tenantId: "default", triggerId: "events",
  };
  return { ...command, admissionHash: hashCanonicalJson({ schemaVersion: 1, triggerId: command.triggerId, event } as JsonValue) };
}
