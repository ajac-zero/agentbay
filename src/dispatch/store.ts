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
  CompleteLeasedExecutionTurnCommand,
  CompleteLeasedExecutionTurnResult,
  ExpiredEventWait,
} from "./types.js";
import { isValidDispatcherExecutionTransition } from "./states.js";

export interface DispatcherExecutionStore {
  completeLeasedExecutionTurn(command: CompleteLeasedExecutionTurnCommand): Promise<CompleteLeasedExecutionTurnResult>;

  expireDueEventWaits(input: { limit: number }): Promise<ExpiredEventWait[]>;

  claimNextQueuedExecution(input: {
    leaseOwner: string;
    leaseDurationMs: number;
  }): Promise<ClaimedExecution | undefined>;

  claimExpiredRunningExecution(input: {
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
  }): Promise<ExecutionLeaseRenewalResult>;

  acknowledgeLeasedExecutionCancellation(
    command: AcknowledgeLeasedExecutionCancellationCommand,
  ): Promise<AcknowledgeLeasedExecutionCancellationResult>;

  listRequestedCancellationCleanups(input: {
    limit: number;
  }): Promise<RequestedCancellationCleanup[]>;

  finalizeRequestedExecutionCancellation(
    command: FinalizeRequestedExecutionCancellationCommand,
  ): Promise<FinalizedRequestedExecutionCancellation | undefined>;

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
