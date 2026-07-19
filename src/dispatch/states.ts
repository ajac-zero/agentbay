import { isValidExecutionTransition, type ExecutionState } from "../execution/states.js";

export const ATTEMPT_STATES = [
  "PENDING",
  "LEASED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
] as const;

export type AttemptState = (typeof ATTEMPT_STATES)[number];

export type AttemptTransition = {
  from: AttemptState;
  to: AttemptState;
};

export type DispatcherExecutionTransition = {
  execution: {
    from: ExecutionState;
    to: ExecutionState;
  };
  attempt: AttemptTransition;
};

const attemptStateSet: ReadonlySet<string> = new Set(ATTEMPT_STATES);

const attemptTransitions: Readonly<Record<AttemptState, ReadonlySet<AttemptState>>> = {
  PENDING: new Set(["LEASED"]),
  LEASED: new Set(["RUNNING", "FAILED", "CANCELLED", "TIMED_OUT"]),
  RUNNING: new Set(["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT"]),
  SUCCEEDED: new Set(),
  FAILED: new Set(),
  CANCELLED: new Set(),
  TIMED_OUT: new Set(),
};

const dispatcherTransitionKeys: ReadonlySet<string> = new Set([
  transitionKey("QUEUED", "PROVISIONING", "PENDING", "LEASED"),
  transitionKey("PROVISIONING", "RUNNING", "LEASED", "RUNNING"),
  transitionKey("PROVISIONING", "FAILED", "LEASED", "FAILED"),
  transitionKey("PROVISIONING", "RETRY_WAIT", "LEASED", "FAILED"),
  transitionKey("PROVISIONING", "TIMED_OUT", "LEASED", "TIMED_OUT"),
  transitionKey("RUNNING", "FAILED", "RUNNING", "FAILED"),
  transitionKey("RUNNING", "RETRY_WAIT", "RUNNING", "FAILED"),
  transitionKey("RUNNING", "TIMED_OUT", "RUNNING", "TIMED_OUT"),
  transitionKey("CANCEL_REQUESTED", "CANCELLED", "LEASED", "CANCELLED"),
  transitionKey("CANCEL_REQUESTED", "CANCELLED", "RUNNING", "CANCELLED"),
]);

export function isAttemptState(value: unknown): value is AttemptState {
  return typeof value === "string" && attemptStateSet.has(value);
}

export function isValidAttemptTransition(from: AttemptState, to: AttemptState): boolean {
  return attemptTransitions[from].has(to);
}

export function isValidDispatcherExecutionTransition(transition: DispatcherExecutionTransition): boolean {
  const { execution, attempt } = transition;
  return isValidExecutionTransition(execution.from, execution.to)
    && isValidAttemptTransition(attempt.from, attempt.to)
    && dispatcherTransitionKeys.has(transitionKey(execution.from, execution.to, attempt.from, attempt.to));
}

function transitionKey(
  executionFrom: ExecutionState,
  executionTo: ExecutionState,
  attemptFrom: AttemptState,
  attemptTo: AttemptState,
): string {
  return `${executionFrom}:${executionTo}:${attemptFrom}:${attemptTo}`;
}
