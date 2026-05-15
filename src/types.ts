export type ModelRef = {
  providerID: string;
  modelID: string;
};

export type BotProfile = {
  id: string;
  templateName: string;
  warmpool: "default" | "none" | (string & {});
  systemPrompt: string;
  defaultModel?: ModelRef;
  tools?: Record<string, boolean>;
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
