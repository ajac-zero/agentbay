import type { ExecutionState } from "../execution/states.js";
import type { ExecutionInput, JsonObject, JsonValue } from "../execution/types.js";
import type { AttemptState } from "./states.js";

export type ExecutionLease = {
  attempt: number;
  fencingToken: string;
  leaseOwner: string;
  leaseExpiresAt: Date;
};

/** Immutable inputs needed to provision and run one execution. */
export type ClaimedExecution = {
  executionId: string;
  tenantId: string;
  eventId: string;
  profileVersion: {
    id: string;
    profileId: string;
    version: number;
    definition: JsonObject;
  };
  input: ExecutionInput;
  workspace: JsonObject;
  resolvedPolicy: JsonObject;
  createdAt: Date;
  timeoutAt: Date;
  lease: ExecutionLease;
};

export type TransitionLeasedExecutionCommand = {
  executionId: string;
  tenantId: string;
  attempt: number;
  fencingToken: string;
  leaseOwner: string;
  expectedExecutionState: ExecutionState;
  expectedAttemptState: AttemptState;
  targetExecutionState: ExecutionState;
  targetAttemptState: AttemptState;
  actor: string;
  reason: string;
  result?: JsonValue;
  workloadName?: string;
  opencodeSessionId?: string;
  retryDelayMs?: number;
};

export type TransitionLeasedExecutionResult =
  | {
      applied: true;
      executionState: ExecutionState;
      attemptState: AttemptState;
    }
  | {
      applied: false;
      reason: "NOT_FOUND" | "STATE_MISMATCH" | "LEASE_MISMATCH" | "LEASE_EXPIRED";
    };

export type RecoveredExecutionLease = {
  executionId: string;
  tenantId: string;
  attempt: number;
  executionState: "RETRY_WAIT" | "FAILED" | "TIMED_OUT";
  recoveredAt: Date;
};

export type PromotedExecutionRetry = {
  executionId: string;
  executionState: "QUEUED" | "TIMED_OUT";
  tenantId: string;
  promotedAt: Date;
};
