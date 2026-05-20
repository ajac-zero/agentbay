import type { AgentProfile, OpencodeConfig, OpencodeConfigRecord } from "./types.js";

const DNS_LABEL_PATTERN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const MAX_DNS_LABEL_LENGTH = 63;

export function validateRuntimeID(value: string, field: string): string {
  return validateDNSLabel(value, field);
}

export function validateRuntimeSlug(value: string, field: string): string {
  return validateDNSLabel(value, field);
}

export function assertOpencodeAgentExists(config: OpencodeConfig, agentName: string, configID: string): void {
  const agents = config.agent;
  if (!isRecord(agents) || !Object.hasOwn(agents, agentName)) {
    throw new Error(`Agent profile references missing opencode agent ${agentName} in config ${configID}`);
  }
}

export function assertOpencodeConfigSupportsProfiles(config: OpencodeConfigRecord, profiles: AgentProfile[]): void {
  for (const profile of profiles) {
    assertOpencodeAgentExists(config.config, profile.opencodeAgentName, config.id);
  }
}

function validateDNSLabel(value: string, field: string): string {
  if (value.length > MAX_DNS_LABEL_LENGTH || !DNS_LABEL_PATTERN.test(value)) {
    throw new Error(`${field} must be a lowercase DNS label with at most ${MAX_DNS_LABEL_LENGTH} characters`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
