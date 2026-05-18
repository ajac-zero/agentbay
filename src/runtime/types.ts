export type WarmpoolRef = "default" | "none" | (string & {});

/**
 * Loose shape for the JSON blob injected as OPENCODE_CONFIG_CONTENT. The
 * opencode config schema is large and evolves with the agent; we deliberately
 * keep typing open so admins can pass through any field without forcing schema
 * upgrades here.
 */
export type OpencodeConfig = Record<string, unknown>;

export type Bot = {
  id: string;
  slug: string;
  displayName: string;
  sandboxProfileID: string;
  defaultAgentProfileID: string;
  enabled: boolean;
};

export type SandboxProfile = {
  id: string;
  slug: string;
  templateName: string;
  warmpool: WarmpoolRef;
  enabled: boolean;
};

export type OpencodeConfigRecord = {
  id: string;
  slug: string;
  displayName: string;
  config: OpencodeConfig;
  configHash: string;
  updatedAt: string;
  enabled: boolean;
};

export type AgentProfile = {
  id: string;
  slug: string;
  displayName: string;
  opencodeConfigID: string;
  opencodeAgentName: string;
  enabled: boolean;
};

export type BotAgentProfile = {
  botID: string;
  agentProfileID: string;
};

export type ResolvedRuntime = {
  bot: Bot;
  sandboxProfile: SandboxProfile;
  agentProfile: AgentProfile;
  opencodeConfig: OpencodeConfigRecord;
  opencodeAgentName: string;
};
