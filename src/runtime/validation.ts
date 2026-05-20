import type { AgentProfile, BotAdapterConfig, EnvVarRef, OpencodeConfig, OpencodeConfigRecord } from "./types.js";

const DNS_LABEL_PATTERN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_DNS_LABEL_LENGTH = 63;

export function validateRuntimeID(value: string, field: string): string {
  return validateDNSLabel(value, field);
}

export function validateRuntimeSlug(value: string, field: string): string {
  return validateDNSLabel(value, field);
}

export function validateEnvVarName(value: string, field: string): string {
  if (!ENV_VAR_NAME_PATTERN.test(value)) throw new Error(`${field} must be a valid environment variable name`);
  return value;
}

export function validateBotAdapters(adapters: BotAdapterConfig): void {
  if (adapters.telegram?.botTokenEnv) validateEnvVarName(adapters.telegram.botTokenEnv, "adapters.telegram.botTokenEnv");
  if (adapters.telegram?.secretTokenEnv) validateEnvVarName(adapters.telegram.secretTokenEnv, "adapters.telegram.secretTokenEnv");
}

export function validateEnvVarRefs(refs: EnvVarRef[], field: string): void {
  refs.forEach((ref, index) => {
    validateEnvVarName(ref.name, `${field}[${index}].name`);
    validateEnvVarName(ref.valueFromEnv, `${field}[${index}].valueFromEnv`);
  });
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
