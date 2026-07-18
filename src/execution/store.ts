import type { AdmissionCommand, AdmissionResult } from "../control/admission.js";
import type { AgentProfileDefinition, AgentProfileVersion, Execution } from "./types.js";

export type PublishProfileVersionCommand = {
  id: string;
  tenantId: string;
  profileId: string;
  version: number;
  definition: AgentProfileDefinition;
  createdAt: string;
};

export interface ExecutionStore {
  publishProfileVersion(command: PublishProfileVersionCommand): Promise<AgentProfileVersion>;
  getProfileVersion(tenantId: string, profileId: string, version: number): Promise<AgentProfileVersion | undefined>;
  getExecution(tenantId: string, executionId: string): Promise<Execution | undefined>;
}

export interface EventAdmissionStore {
  admitEvent(command: AdmissionCommand): Promise<AdmissionResult>;
}
