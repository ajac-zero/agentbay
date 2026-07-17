import type { ExecutionState } from "./states.js";

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type AgentProfileDefinition = {
  readonly schemaVersion: 1;
  readonly runtime: {
    readonly type: "opencode";
    readonly agent: string;
    readonly opencodeConfig: JsonObject;
  };
  readonly sandbox: {
    readonly templateName: string;
    readonly warmPool: string;
  };
  readonly permissions: {
    readonly onRequest: "fail";
  };
  readonly timeoutSeconds: number;
  readonly retention?: {
    readonly sandboxSecondsAfterFinished: number;
  };
};

export type AgentProfileRef = {
  id: string;
  version: number;
};

export type AgentProfileVersion = {
  id: string;
  tenantId: string;
  profile: AgentProfileRef;
  definition: AgentProfileDefinition;
  createdAt: string;
};

export type ExecutionInput = {
  text: string;
  context?: Record<string, JsonValue>;
};

export type EmptyWorkspace = {
  type: "empty";
};

export type Execution = {
  id: string;
  tenantId: string;
  state: ExecutionState;
  profile: AgentProfileRef;
  input: ExecutionInput;
  workspace: EmptyWorkspace;
  eventId: string;
  createdAt: string;
  updatedAt: string;
  result: JsonValue | null;
};

export class ProfileVersionAlreadyExistsError extends Error {
  readonly code = "PROFILE_VERSION_ALREADY_EXISTS";

  constructor(profileId: string, version: number) {
    super(`Agent profile ${profileId} version ${version} already exists`);
    this.name = "ProfileVersionAlreadyExistsError";
  }
}

export class ProfileVersionNotFoundError extends Error {
  readonly code = "PROFILE_VERSION_NOT_FOUND";

  constructor(profileId: string, version: number) {
    super(`Agent profile ${profileId} version ${version} was not found`);
    this.name = "ProfileVersionNotFoundError";
  }
}

export class ExecutionNotFoundError extends Error {
  readonly code = "EXECUTION_NOT_FOUND";

  constructor(executionId: string) {
    super(`Execution ${executionId} was not found`);
    this.name = "ExecutionNotFoundError";
  }
}

export class IdempotencyConflictError extends Error {
  readonly code = "IDEMPOTENCY_CONFLICT";

  constructor() {
    super("Idempotency-Key was already used for a different request");
    this.name = "IdempotencyConflictError";
  }
}
