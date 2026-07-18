import type { AdmissionCommand, AdmissionResult } from "../control/admission.js";
import type {
  AgentProfileDefinition,
  AgentProfileVersion,
  Execution,
  ExecutionDetail,
  RequestExecutionCancellationCommand,
  RequestExecutionCancellationResult,
} from "./types.js";

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
  getExecutionDetail(tenantId: string, executionId: string): Promise<ExecutionDetail | undefined>;
  requestExecutionCancellation(command: RequestExecutionCancellationCommand): Promise<RequestExecutionCancellationResult | undefined>;
}

export interface EventAdmissionStore {
  admitEvent(command: AdmissionCommand): Promise<AdmissionResult>;
}
