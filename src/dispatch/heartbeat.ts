import type { DispatcherExecutionStore } from "./store.js";
import type { ClaimedExecution } from "./types.js";

export class ExecutionLeaseLostError extends Error {
  constructor() {
    super("Execution lease was lost");
    this.name = "ExecutionLeaseLostError";
  }
}

export type ExecutionLeaseHeartbeat = {
  readonly signal: AbortSignal;
  readonly fenceLost: boolean;
  assertOwned(): void;
  stop(): Promise<void>;
};

export function startExecutionLeaseHeartbeat(input: {
  execution: ClaimedExecution;
  leaseDurationMs: number;
  renewIntervalMs: number;
  signal?: AbortSignal;
  store: Pick<DispatcherExecutionStore, "renewExecutionLease">;
}): ExecutionLeaseHeartbeat {
  requirePositiveInteger("leaseDurationMs", input.leaseDurationMs);
  requirePositiveInteger("renewIntervalMs", input.renewIntervalMs);
  if (input.renewIntervalMs >= input.leaseDurationMs) {
    throw new RangeError("renewIntervalMs must be less than leaseDurationMs");
  }

  const controller = new AbortController();
  let fenceLost = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let renewal: Promise<void> | undefined;
  let confirmedExpiry = input.execution.lease.leaseExpiresAt.getTime();

  const abortFromParent = (): void => controller.abort(input.signal?.reason);
  if (input.signal?.aborted) abortFromParent();
  else input.signal?.addEventListener("abort", abortFromParent, { once: true });

  const loseFence = (): void => {
    if (stopped || fenceLost) return;
    fenceLost = true;
    controller.abort(new ExecutionLeaseLostError());
  };

  const watchExpiry = (): void => {
    clearTimeout(expiryTimer);
    if (stopped || controller.signal.aborted) return;
    expiryTimer = setTimeout(loseFence, Math.max(0, confirmedExpiry - Date.now()));
  };

  const schedule = (): void => {
    if (stopped || controller.signal.aborted) return;
    timer = setTimeout(() => {
      renewal = renew().finally(() => {
        renewal = undefined;
        schedule();
      });
    }, input.renewIntervalMs);
  };

  const renew = async (): Promise<void> => {
    try {
      const execution = input.execution;
      const { lease } = execution;
      const renewed = await input.store.renewExecutionLease({
        attempt: lease.attempt,
        executionId: execution.executionId,
        fencingToken: lease.fencingToken,
        leaseDurationMs: input.leaseDurationMs,
        leaseOwner: lease.leaseOwner,
        tenantId: execution.tenantId,
      });
      if (!renewed) loseFence();
      else {
        confirmedExpiry = Math.max(confirmedExpiry, Date.now() + input.leaseDurationMs);
        watchExpiry();
      }
    } catch {
      loseFence();
    }
  };

  schedule();
  watchExpiry();

  return {
    get signal() {
      return controller.signal;
    },
    get fenceLost() {
      return fenceLost;
    },
    assertOwned() {
      if (fenceLost) throw new ExecutionLeaseLostError();
      input.signal?.throwIfAborted();
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      clearTimeout(expiryTimer);
      input.signal?.removeEventListener("abort", abortFromParent);
      await Promise.race([renewal, new Promise<void>((resolve) => setTimeout(resolve, input.renewIntervalMs))]);
    },
  };
}

function requirePositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
}
