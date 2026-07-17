import { afterEach, describe, expect, it, vi } from "vitest";
import type { DispatcherExecutionStore } from "../../src/dispatch/store.js";
import type { ClaimedExecution, TransitionLeasedExecutionCommand } from "../../src/dispatch/types.js";
import { DispatcherWorker, type ExecutionAttemptRunner } from "../../src/dispatch/worker.js";
import type { ExecutionAttemptEndpoint, ExecutionAttemptProvisioner } from "../../src/sandbox/types.js";

afterEach(() => vi.useRealTimers());

describe("DispatcherWorker", () => {
  it("provisions, records the session before running, succeeds, and releases", async () => {
    const fixture = workerFixture();
    fixture.runner.run = vi.fn(async ({ onSession }) => {
      await onSession("session-1");
      return { result: { text: "complete" } };
    });

    await expect(fixture.worker.runOne()).resolves.toBe(true);

    expect(fixture.store.transitions).toMatchObject([
      {
        expectedExecutionState: "PROVISIONING",
        opencodeSessionId: "session-1",
        targetExecutionState: "RUNNING",
        workloadName: "workload-1",
      },
      {
        expectedExecutionState: "RUNNING",
        result: { text: "complete" },
        targetExecutionState: "SUCCEEDED",
      },
    ]);
    expect(fixture.provisioner.release).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 1, executionId: "execution-1" }),
      expect.any(AbortSignal),
    );
  });

  it("fails the leased pair and attempts cleanup when provisioning fails", async () => {
    const fixture = workerFixture();
    fixture.provisioner.provision = vi.fn().mockRejectedValue(new Error("bad\u0000 secret-ish failure"));

    await fixture.worker.runOne();

    expect(fixture.store.transitions).toHaveLength(1);
    expect(fixture.store.transitions[0]).toMatchObject({
      expectedAttemptState: "LEASED",
      expectedExecutionState: "PROVISIONING",
      result: { error: "Error: bad  secret-ish failure" },
      targetAttemptState: "FAILED",
      targetExecutionState: "RETRY_WAIT",
    });
    expect(fixture.provisioner.release).not.toHaveBeenCalled();
  });

  it("fails the running pair when the runner fails", async () => {
    const fixture = workerFixture();
    fixture.runner.run = vi.fn(async ({ onSession }) => {
      await onSession("session-1");
      throw new Error("prompt failed");
    });

    await fixture.worker.runOne();

    expect(fixture.store.transitions).toMatchObject([
      { targetExecutionState: "RUNNING" },
      {
        expectedExecutionState: "RUNNING",
        result: { error: "Error: prompt failed" },
        targetAttemptState: "FAILED",
        targetExecutionState: "RETRY_WAIT",
      },
    ]);
    expect(fixture.provisioner.release).toHaveBeenCalledOnce();
  });

  it("aborts the runner and performs no late transition after heartbeat fence loss", async () => {
    vi.useFakeTimers();
    const fixture = workerFixture({ renew: false });
    fixture.runner.run = vi.fn(({ onSession, signal }) => new Promise<never>(async (_resolve, reject) => {
      await onSession("session-1");
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));

    const running = fixture.worker.runOne();
    await vi.waitFor(() => expect(fixture.store.transitions).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(10);
    await running;

    expect(fixture.store.renewExecutionLease).toHaveBeenCalledOnce();
    expect(fixture.store.transitions).toHaveLength(1);
    expect(fixture.provisioner.release).toHaveBeenCalledOnce();
  });

  it("rejects invalid heartbeat timing and prevents overlapping runOne calls", async () => {
    const fixture = workerFixture();
    expect(() => fixture.createWorker({ renewIntervalMs: 100, leaseDurationMs: 100 })).toThrow(/less than/);

    let finish!: () => void;
    fixture.provisioner.provision = vi.fn(() => new Promise<ExecutionAttemptEndpoint>((resolve) => {
      finish = () => resolve({ host: "sandbox", password: "password", workloadName: "workload-1", release: provisioningInput() });
    }));
    const first = fixture.worker.runOne();
    await vi.waitFor(() => expect(fixture.provisioner.provision).toHaveBeenCalledOnce());
    await expect(fixture.worker.runOne()).resolves.toBe(false);
    finish();
    await first;
    expect(fixture.store.claimNextQueuedExecution).toHaveBeenCalledOnce();
  });
});

function workerFixture(overrides: { renew?: boolean } = {}) {
  const execution = claimedExecution();
  const transitions: TransitionLeasedExecutionCommand[] = [];
  const store = {
    claimNextQueuedExecution: vi.fn().mockResolvedValue(execution),
    renewExecutionLease: vi.fn().mockResolvedValue(overrides.renew ?? true),
    transitionLeasedExecution: vi.fn(async (command: TransitionLeasedExecutionCommand) => {
      transitions.push(command);
      return {
        applied: true as const,
        attemptState: command.targetAttemptState,
        executionState: command.targetExecutionState,
      };
    }),
  } as unknown as DispatcherExecutionStore & { transitions: TransitionLeasedExecutionCommand[] };
  store.transitions = transitions;

  const provisioner: ExecutionAttemptProvisioner = {
    provision: vi.fn().mockResolvedValue({ host: "sandbox", password: "password", workloadName: "workload-1", release: provisioningInput() }),
    release: vi.fn().mockResolvedValue(undefined),
  };
  const runner: ExecutionAttemptRunner = {
    run: vi.fn().mockResolvedValue({ result: null, sessionId: "session-1" }),
  };
  const createWorker = (options: Partial<ConstructorParameters<typeof DispatcherWorker>[0]> = {}) => new DispatcherWorker({
    idlePollMs: 20,
    leaseDurationMs: 100,
    maxAttempts: 3,
    provisioner,
    renewIntervalMs: 10,
    retryDelayMs: 10,
    runner,
    store,
    workerId: "worker-1",
    ...options,
  });

  return { createWorker, execution, provisioner, runner, store, worker: createWorker() };
}

function provisioningInput() {
  return {
    attempt: 1,
    executionId: "execution-1",
    opencodeConfig: { agent: { coder: {} } },
    profileVersion: { id: "profile-version-1", profileId: "coder", version: 1 },
    sandboxTemplate: "opencode",
    tenantId: "tenant-1",
    timeoutAt: new Date(Date.now() + 60_000),
    ttlSecondsAfterFinished: 0,
    warmPool: "none",
  };
}

function claimedExecution(): ClaimedExecution {
  return {
    createdAt: new Date("2026-01-01T00:00:00Z"),
    eventId: "event-1",
    executionId: "execution-1",
    input: { text: "do work" },
    lease: {
      attempt: 1,
      fencingToken: "fence-1",
      leaseExpiresAt: new Date("2026-01-01T00:01:00Z"),
      leaseOwner: "worker-1",
    },
    profileVersion: {
      definition: {
        schemaVersion: 1,
        runtime: {
          agent: "coder",
          opencodeConfig: { agent: { coder: { prompt: "Test" } } },
          type: "opencode",
        },
        sandbox: { templateName: "opencode", warmPool: "opencode" },
        permissions: { onRequest: "fail" },
        timeoutSeconds: 60,
      },
      id: "profile-version-1",
      profileId: "coder",
      version: 1,
    },
    resolvedPolicy: {
      schemaVersion: 1,
      runtime: { agent: "coder", opencodeConfig: { agent: { coder: { prompt: "Test" } } }, type: "opencode" },
      sandbox: { templateName: "opencode", warmPool: "opencode" },
      permissions: { onRequest: "fail" },
      timeoutSeconds: 60,
    },
    tenantId: "tenant-1",
    timeoutAt: new Date(Date.now() + 60_000),
    workspace: { type: "empty" },
  };
}
