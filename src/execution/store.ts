import { createHash } from "node:crypto";
import type { AgentProfileDefinition, AgentProfileVersion, EmptyWorkspace, Execution, ExecutionInput, JsonObject, JsonValue } from "./types.js";

export type PublishProfileVersionCommand = {
  id: string;
  tenantId: string;
  profileId: string;
  version: number;
  definition: AgentProfileDefinition;
  createdAt: string;
};

export type CreateExecutionCommand = {
  id: string;
  tenantId: string;
  profile: {
    id: string;
    version: number;
  };
  input: ExecutionInput;
  workspace: EmptyWorkspace;
  event: {
    id: string;
    time: string;
    source: string;
    type: string;
    data: JsonObject;
  };
  idempotencyKey: string;
  requestHash: string;
  createdAt: string;
};

export type CreateExecutionResult = {
  execution: Execution;
  replayed: boolean;
};

/**
 * IDs, event metadata, timestamps, and the canonical request hash are generated
 * by the API. Implementations must atomically create the event and execution,
 * returning the prior execution when key and hash match and throwing
 * IdempotencyConflictError when only the key matches.
 */
export interface ExecutionStore {
  publishProfileVersion(command: PublishProfileVersionCommand): Promise<AgentProfileVersion>;
  getProfileVersion(tenantId: string, profileId: string, version: number): Promise<AgentProfileVersion | undefined>;
  createExecution(command: CreateExecutionCommand): Promise<CreateExecutionResult>;
  getExecution(tenantId: string, executionId: string): Promise<Execution | undefined>;
}

export function hashCanonicalRequest(value: JsonValue): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
    .join(",")}}`;
}
