export const EXECUTION_STATES = [
  "RECEIVED",
  "PLANNED",
  "QUEUED",
  "PROVISIONING",
  "RUNNING",
  "WAITING",
  "SUCCEEDED",
  "DELIVERING",
  "COMPLETED",
  "RETRY_WAIT",
  "AWAITING_APPROVAL",
  "CANCEL_REQUESTED",
  "CANCELLED",
  "TIMED_OUT",
  "FAILED",
  "DEAD_LETTERED",
] as const;

export type ExecutionState = (typeof EXECUTION_STATES)[number];

export const TERMINAL_EXECUTION_STATES = [
  "COMPLETED",
  "CANCELLED",
  "TIMED_OUT",
  "FAILED",
  "DEAD_LETTERED",
] as const satisfies readonly ExecutionState[];

export type TerminalExecutionState = (typeof TERMINAL_EXECUTION_STATES)[number];

export type ExecutionTransition = {
  from: ExecutionState;
  to: ExecutionState;
};

const executionStateSet: ReadonlySet<string> = new Set(EXECUTION_STATES);
const terminalExecutionStateSet: ReadonlySet<ExecutionState> = new Set(TERMINAL_EXECUTION_STATES);

const transitions: Readonly<Record<ExecutionState, ReadonlySet<ExecutionState>>> = {
  RECEIVED: new Set(["PLANNED", "CANCEL_REQUESTED", "FAILED", "DEAD_LETTERED"]),
  PLANNED: new Set(["QUEUED", "AWAITING_APPROVAL", "CANCEL_REQUESTED", "FAILED", "DEAD_LETTERED"]),
  QUEUED: new Set(["PROVISIONING", "CANCEL_REQUESTED", "RETRY_WAIT", "TIMED_OUT", "FAILED", "DEAD_LETTERED"]),
  PROVISIONING: new Set(["RUNNING", "CANCEL_REQUESTED", "RETRY_WAIT", "TIMED_OUT", "FAILED", "DEAD_LETTERED"]),
  RUNNING: new Set([
    "SUCCEEDED",
    "WAITING",
    "AWAITING_APPROVAL",
    "CANCEL_REQUESTED",
    "RETRY_WAIT",
    "TIMED_OUT",
    "FAILED",
    "DEAD_LETTERED",
  ]),
  SUCCEEDED: new Set(["DELIVERING", "COMPLETED", "FAILED", "DEAD_LETTERED"]),
  WAITING: new Set(["QUEUED", "CANCEL_REQUESTED", "TIMED_OUT", "FAILED"]),
  DELIVERING: new Set(["COMPLETED", "RETRY_WAIT", "FAILED", "DEAD_LETTERED"]),
  RETRY_WAIT: new Set(["QUEUED", "CANCEL_REQUESTED", "TIMED_OUT", "FAILED", "DEAD_LETTERED"]),
  AWAITING_APPROVAL: new Set(["QUEUED", "RUNNING", "CANCEL_REQUESTED", "TIMED_OUT", "FAILED"]),
  CANCEL_REQUESTED: new Set(["CANCELLED", "TIMED_OUT", "FAILED"]),
  COMPLETED: new Set(),
  CANCELLED: new Set(),
  TIMED_OUT: new Set(),
  FAILED: new Set(),
  DEAD_LETTERED: new Set(),
};

export function isExecutionState(value: unknown): value is ExecutionState {
  return typeof value === "string" && executionStateSet.has(value);
}

export function isTerminalExecutionState(state: ExecutionState): state is TerminalExecutionState {
  return terminalExecutionStateSet.has(state);
}

export function isValidExecutionTransition(from: ExecutionState, to: ExecutionState): boolean {
  return transitions[from].has(to);
}
