export type ThreadState = {
  botID: string;
  sandboxProfileID: string;
  sandboxProfileHash: string;
  agentProfileID: string;
  opencodeConfigID: string;
  opencodeConfigHash: string;
  opencodeAgentName: string;
  claimName: string;
  podFQDN: string;
  sessionID: string;
  password: string;
  createdAt: string;
};

export type EnvVar = {
  name: string;
  value: string;
};
