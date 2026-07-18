import { logger, toErrCtx, type Logger } from "../logger.js";
import type { ExecutionAttemptProvisioner } from "../sandbox/types.js";
import { parseExecutionAttemptProfile, type ExecutionAttemptProfile } from "./profile.js";
import type { DispatcherExecutionStore } from "./store.js";
import type { ClaimedExecution, TransitionLeasedExecutionCommand } from "./types.js";
import { ExecutionLeaseLostError, startExecutionLeaseHeartbeat } from "./heartbeat.js";
import type { JsonValue } from "../execution/types.js";
import { runExecutionAttempt } from "../agent/runner.js";
import type { OpenCodeConnectionOptions } from "../agent/client.js";
import { SandboxClaimRejectedError } from "../sandbox/provisioner.js";

type AttemptProfile = ExecutionAttemptProfile;
type ProvisionedAttempt = Awaited<ReturnType<ExecutionAttemptProvisioner["provision"]>>;

export type ExecutionAttemptRunnerResult = {
  result: JsonValue;
  sessionId?: string;
};

export interface ExecutionAttemptRunner {
  run(input: {
    execution: ClaimedExecution;
    profile: AttemptProfile;
    provisioned: ProvisionedAttempt;
    signal: AbortSignal;
    onSession(sessionId: string): Promise<void>;
  }): Promise<ExecutionAttemptRunnerResult>;
}

export class OpenCodeExecutionAttemptRunner implements ExecutionAttemptRunner {
  constructor(private readonly connection: OpenCodeConnectionOptions) {}

  async run(input: Parameters<ExecutionAttemptRunner["run"]>[0]): Promise<ExecutionAttemptRunnerResult> {
    const result = await runExecutionAttempt({
      agent: input.profile.resolvedPolicy.runtime.agent,
      endpoint: {
        ...this.connection,
        host: input.provisioned.host,
        password: input.provisioned.password,
      },
      onSession: input.onSession,
      prompt: input.execution.input.text,
      signal: input.signal,
      title: `agentbay execution ${input.execution.executionId} attempt ${input.execution.lease.attempt}`,
    });
    return { result: { output: result.output }, sessionId: result.sessionId };
  }
}

export type DispatcherWorkerOptions = {
  idlePollMs: number;
  leaseDurationMs: number;
  maxAttempts: number;
  maxErrorLength?: number;
  maxResultBytes?: number;
  provisioner: ExecutionAttemptProvisioner;
  renewIntervalMs: number;
  retryDelayMs: number;
  runner: ExecutionAttemptRunner;
  store: DispatcherExecutionStore;
  workerId: string;
  log?: Logger;
};

export class DispatcherWorker {
  readonly #options: Required<Pick<DispatcherWorkerOptions, "maxErrorLength" | "maxResultBytes">>
    & Omit<DispatcherWorkerOptions, "maxErrorLength" | "maxResultBytes">;
  readonly #log: Logger;
  #active = false;

  constructor(options: DispatcherWorkerOptions) {
    requireNonempty("workerId", options.workerId);
    requirePositiveInteger("leaseDurationMs", options.leaseDurationMs);
    requirePositiveInteger("renewIntervalMs", options.renewIntervalMs);
    requirePositiveInteger("idlePollMs", options.idlePollMs);
    requirePositiveInteger("maxAttempts", options.maxAttempts);
    if (options.renewIntervalMs >= options.leaseDurationMs) {
      throw new RangeError("renewIntervalMs must be less than leaseDurationMs");
    }

    this.#options = {
      ...options,
      maxErrorLength: options.maxErrorLength ?? 2_048,
      maxResultBytes: options.maxResultBytes ?? 128 * 1_024,
    };
    requirePositiveInteger("maxErrorLength", this.#options.maxErrorLength);
    if (!Number.isSafeInteger(this.#options.maxResultBytes) || this.#options.maxResultBytes < 64) {
      throw new RangeError("maxResultBytes must be an integer of at least 64");
    }
    this.#log = options.log ?? logger.child({ component: "dispatcher-worker", workerId: options.workerId });
  }

  async runOne(signal?: AbortSignal): Promise<boolean> {
    if (this.#active) return false;
    this.#active = true;
    try {
      signal?.throwIfAborted();
      const execution = await this.#options.store.claimNextQueuedExecution({
        leaseDurationMs: this.#options.leaseDurationMs,
        leaseOwner: this.#options.workerId,
      });
      if (!execution) return false;
      await this.#runClaimed(execution, signal);
      return true;
    } finally {
      this.#active = false;
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let claimed = false;
      try {
        claimed = await this.runOne(signal);
      } catch (error) {
        if (signal.aborted) break;
        this.#log.error("dispatcher worker iteration failed", { err: toErrCtx(error) });
      }
      if (!claimed && !signal.aborted) await abortableDelay(this.#options.idlePollMs, signal);
    }
  }

  async #runClaimed(execution: ClaimedExecution, parentSignal?: AbortSignal): Promise<void> {
    const log = this.#log.child({
      attempt: execution.lease.attempt,
      executionId: execution.executionId,
      tenantId: execution.tenantId,
    });
    const deadline = deadlineSignal(execution.timeoutAt, parentSignal);
    const heartbeat = startExecutionLeaseHeartbeat({
      execution,
      leaseDurationMs: this.#options.leaseDurationMs,
      renewIntervalMs: this.#options.renewIntervalMs,
      signal: deadline.signal,
      store: this.#options.store,
    });
    let provisioned: ProvisionedAttempt | undefined;
    let provisioningStarted = false;
    let running = false;
    let terminal = false;

    try {
      const profile = parseExecutionAttemptProfile(execution);
      heartbeat.assertOwned();
      provisioningStarted = true;
      provisioned = await this.#options.provisioner.provision({
        attempt: execution.lease.attempt,
        connections: profile.resolvedPolicy.connections,
        executionId: execution.executionId,
        opencodeConfig: profile.resolvedPolicy.runtime.opencodeConfig,
        profileVersion: {
          id: profile.profileVersion.id,
          profileId: profile.profileVersion.profileId,
          version: profile.profileVersion.version,
        },
        sandboxTemplate: profile.resolvedPolicy.sandbox.templateName,
        tenantId: execution.tenantId,
        timeoutAt: execution.timeoutAt,
        ttlSecondsAfterFinished: profile.resolvedPolicy.retention?.sandboxSecondsAfterFinished ?? 0,
        warmPool: profile.resolvedPolicy.sandbox.warmPool,
        workspace: execution.workspace,
      }, heartbeat.signal);
      heartbeat.assertOwned();

      const markRunning = async (sessionId?: string): Promise<void> => {
        if (running) {
          if (sessionId) throw new Error("Runner reported an OpenCode session after execution was already running");
          return;
        }
        heartbeat.assertOwned();
        const transition = await this.#transition(execution, {
          expectedAttemptState: "LEASED",
          expectedExecutionState: "PROVISIONING",
          opencodeSessionId: sessionId,
          reason: "execution workload ready",
          targetAttemptState: "RUNNING",
          targetExecutionState: "RUNNING",
          workloadName: provisioned?.workloadName,
        });
        if (!transition) throw new ExecutionLeaseLostError();
        running = true;
      };

      const runnerResult = await this.#options.runner.run({
        execution,
        onSession: markRunning,
        profile,
        provisioned,
        signal: heartbeat.signal,
      });
      heartbeat.assertOwned();
      if (!running) await markRunning(runnerResult.sessionId);
      heartbeat.assertOwned();
      await this.#transitionOrLose(execution, {
        expectedAttemptState: "RUNNING",
        expectedExecutionState: "RUNNING",
        reason: "execution completed",
        result: boundedResult(runnerResult.result, this.#options.maxResultBytes),
        targetAttemptState: "SUCCEEDED",
        targetExecutionState: "SUCCEEDED",
      });
      terminal = true;
    } catch (error) {
      if (heartbeat.fenceLost || error instanceof ExecutionLeaseLostError || parentSignal?.aborted) {
        log.warn("execution processing stopped after lease loss or shutdown");
        return;
      }

      const message = sanitizeError(error, this.#options.maxErrorLength);
      log.error("execution attempt failed", { error: message });
      try {
        const timedOut = Date.now() >= execution.timeoutAt.getTime();
        if (heartbeat.fenceLost) throw new ExecutionLeaseLostError();
        if (!timedOut) heartbeat.assertOwned();
        const retry = !(error instanceof SandboxClaimRejectedError) && !timedOut
          && execution.lease.attempt < this.#options.maxAttempts
          && Date.now() + this.#options.retryDelayMs < execution.timeoutAt.getTime();
        await this.#transitionOrLose(execution, running
          ? {
              expectedAttemptState: "RUNNING",
              expectedExecutionState: "RUNNING",
              reason: "execution runner failed",
              result: { error: message },
              retryDelayMs: retry ? this.#options.retryDelayMs : undefined,
              targetAttemptState: timedOut ? "TIMED_OUT" : "FAILED",
              targetExecutionState: timedOut ? "TIMED_OUT" : retry ? "RETRY_WAIT" : "FAILED",
            }
          : {
              expectedAttemptState: "LEASED",
              expectedExecutionState: "PROVISIONING",
              reason: "execution provisioning failed",
              result: { error: message },
              retryDelayMs: retry ? this.#options.retryDelayMs : undefined,
              targetAttemptState: timedOut ? "TIMED_OUT" : "FAILED",
              targetExecutionState: timedOut ? "TIMED_OUT" : retry ? "RETRY_WAIT" : "FAILED",
            });
        terminal = true;
      } catch (transitionError) {
        if (!(transitionError instanceof ExecutionLeaseLostError)) throw transitionError;
      }
    } finally {
      await heartbeat.stop();
      deadline.stop();
      if (provisioned && (
        !terminal
        || provisioned.release.ttlSecondsAfterFinished === 0
        || Date.now() >= execution.timeoutAt.getTime()
      )) {
        try {
          await this.#options.provisioner.release(provisioned.release, AbortSignal.timeout(this.#options.renewIntervalMs));
        } catch (error) {
          log.error("execution workload cleanup failed", { err: toErrCtx(error) });
        }
      }
    }
  }

  async #transitionOrLose(
    execution: ClaimedExecution,
    command: Omit<TransitionLeasedExecutionCommand, "actor" | "attempt" | "executionId" | "fencingToken" | "leaseOwner" | "tenantId">,
  ): Promise<void> {
    if (!await this.#transition(execution, command)) throw new ExecutionLeaseLostError();
  }

  async #transition(
    execution: ClaimedExecution,
    command: Omit<TransitionLeasedExecutionCommand, "actor" | "attempt" | "executionId" | "fencingToken" | "leaseOwner" | "tenantId">,
  ): Promise<boolean> {
    const { lease } = execution;
    const result = await this.#options.store.transitionLeasedExecution({
      ...command,
      actor: this.#options.workerId,
      attempt: lease.attempt,
      executionId: execution.executionId,
      fencingToken: lease.fencingToken,
      leaseOwner: lease.leaseOwner,
      tenantId: execution.tenantId,
    });
    return result.applied;
  }
}

function deadlineSignal(timeoutAt: Date, parent?: AbortSignal): { signal: AbortSignal; stop(): void } {
  const controller = new AbortController();
  const abortParent = (): void => controller.abort(parent?.reason);
  if (parent?.aborted) abortParent();
  else parent?.addEventListener("abort", abortParent, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException("Execution deadline exceeded", "TimeoutError")), Math.max(0, timeoutAt.getTime() - Date.now()));
  return {
    signal: controller.signal,
    stop() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abortParent);
    },
  };
}

function boundedResult(result: JsonValue, maxBytes: number): JsonValue {
  const serialized = JSON.stringify(result);
  if (Buffer.byteLength(serialized, "utf8") <= maxBytes) return result;
  let low = 0;
  let high = serialized.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = { preview: serialized.slice(0, middle), truncated: true };
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return { preview: serialized.slice(0, low), truncated: true };
}

function sanitizeError(error: unknown, maxLength: number): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return (raw.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim() || "Unknown execution error").slice(0, maxLength);
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(finish, delayMs);
    signal.addEventListener("abort", finish, { once: true });
    function finish(): void {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}

function requirePositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
}

function requireNonempty(name: string, value: string): void {
  if (!value.trim()) throw new RangeError(`${name} must not be empty`);
}
