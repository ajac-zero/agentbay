export type ModelRef = {
  providerID: string;
  modelID: string;
};

/**
 * Loose shape for the JSON blob injected as OPENCODE_CONFIG_CONTENT. The
 * opencode config schema is large and evolves with the agent; we deliberately
 * keep typing open so admins can pass through any field (mcp, permission,
 * provider options, agents, etc.) without forcing schema upgrades here.
 */
export type OpencodeConfig = Record<string, unknown>;

export type BotProfile = {
  id: string;
  templateName: string;
  warmpool: "default" | "none" | (string & {});
  systemPrompt: string;
  defaultModel?: ModelRef;
  tools?: Record<string, boolean>;
  /**
   * Extra opencode config merged into the per-claim OPENCODE_CONFIG_CONTENT
   * blob. Fields here win over the derived defaults (`defaultModel`, `tools`)
   * and override anything declared in the workspace's `opencode.json` or
   * `.opencode/` directory. See opencode's config merge order.
   */
  opencodeConfig?: OpencodeConfig;
};

export type ThreadState = {
  claimName: string;
  podFQDN: string;
  sessionID: string;
  profileID: string;
  password: string;
  createdAt: string;
};

export type EnvVar = {
  name: string;
  value: string;
};
