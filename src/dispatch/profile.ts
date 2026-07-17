import { agentProfileDefinitionSchema } from "../execution/api-schema.js";
import type { AgentProfileDefinition } from "../execution/types.js";
import type { ClaimedExecution } from "./types.js";

export type ExecutionAttemptProfile = Omit<ClaimedExecution, "profileVersion" | "resolvedPolicy"> & {
  readonly profileVersion: Omit<ClaimedExecution["profileVersion"], "definition"> & {
    readonly definition: AgentProfileDefinition;
  };
  readonly resolvedPolicy: AgentProfileDefinition;
};

export function mapExecutionAttemptProfile(claimed: ClaimedExecution): ExecutionAttemptProfile {
  const definition = agentProfileDefinitionSchema.parse(claimed.profileVersion.definition);
  const resolvedPolicy = agentProfileDefinitionSchema.parse(claimed.resolvedPolicy);

  return {
    ...claimed,
    profileVersion: { ...claimed.profileVersion, definition },
    resolvedPolicy,
    timeoutAt: claimed.timeoutAt,
  };
}

export const parseExecutionAttemptProfile = mapExecutionAttemptProfile;
