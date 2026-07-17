import type {
  ClaimedExecution,
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
