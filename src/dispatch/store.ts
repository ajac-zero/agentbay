import type {
  ClaimedExecution,
  PromotedExecutionRetry,
  RecoveredExecutionLease,
  TransitionLeasedExecutionCommand,
  TransitionLeasedExecutionResult,
} from "./types.js";
import { isValidDispatcherExecutionTransition } from "./states.js";

export interface DispatcherExecutionStore {
  claimNextQueuedExecution(input: {
    leaseOwner: string;
    leaseDurationMs: number;
  }): Promise<ClaimedExecution | undefined>;

  renewExecutionLease(input: {
    executionId: string;
    tenantId: string;
    attempt: number;
    fencingToken: string;
    leaseOwner: string;
    leaseDurationMs: number;
  }): Promise<boolean>;

  recoverExpiredExecutionLeases(input: {
    limit: number;
    maxAttempts: number;
    retryDelayMs: number;
  }): Promise<RecoveredExecutionLease[]>;

  promoteDueExecutionRetries(input: {
    limit: number;
  }): Promise<PromotedExecutionRetry[]>;

  transitionLeasedExecution(
    command: TransitionLeasedExecutionCommand,
  ): Promise<TransitionLeasedExecutionResult>;
}

export function isValidTransitionLeasedExecutionCommand(command: TransitionLeasedExecutionCommand): boolean {
  return isValidDispatcherExecutionTransition({
    execution: {
      from: command.expectedExecutionState,
      to: command.targetExecutionState,
    },
    attempt: {
      from: command.expectedAttemptState,
      to: command.targetAttemptState,
    },
  });
}
