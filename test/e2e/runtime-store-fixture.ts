import { hashConfig, resolveRuntime, type RuntimeStore, type RuntimeStoreSnapshot, type UpsertOpencodeConfigInput } from "../../src/runtime/store.js";
import type { AgentProfile, Bot, BotAgentProfile, OpencodeConfigRecord, SandboxProfile } from "../../src/runtime/types.js";
import type { ThreadState } from "../../src/types.js";

export class TestRuntimeStore implements RuntimeStore {
  constructor(private readonly snapshot: RuntimeStoreSnapshot = defaultRuntimeSnapshot()) {}

  async addBotAgentProfile(entry: BotAgentProfile): Promise<BotAgentProfile> {
    this.requireBot(entry.botID);
    this.requireAgentProfile(entry.agentProfileID);
    if (!this.snapshot.botAgentProfiles.some((candidate) => sameBotAgentProfile(candidate, entry))) {
      this.snapshot.botAgentProfiles.push(entry);
    }
    return entry;
  }

  async deleteAgentProfile(id: string): Promise<boolean> {
    if (this.snapshot.bots.some((bot) => bot.defaultAgentProfileID === id)) throw new Error(`Cannot delete agent profile ${id}`);
    const before = this.snapshot.agentProfiles.length;
    this.snapshot.agentProfiles = this.snapshot.agentProfiles.filter((profile) => profile.id !== id);
    this.snapshot.botAgentProfiles = this.snapshot.botAgentProfiles.filter((entry) => entry.agentProfileID !== id);
    return this.snapshot.agentProfiles.length !== before;
  }

  async deleteBot(id: string): Promise<boolean> {
    const before = this.snapshot.bots.length;
    this.snapshot.bots = this.snapshot.bots.filter((bot) => bot.id !== id);
    this.snapshot.botAgentProfiles = this.snapshot.botAgentProfiles.filter((entry) => entry.botID !== id);
    return this.snapshot.bots.length !== before;
  }

  async deleteBotAgentProfile(botID: string, agentProfileID: string): Promise<boolean> {
    const bot = this.snapshot.bots.find((candidate) => candidate.id === botID);
    if (bot?.defaultAgentProfileID === agentProfileID) throw new Error(`Cannot delete default agent profile mapping for bot ${botID}`);

    const before = this.snapshot.botAgentProfiles.length;
    this.snapshot.botAgentProfiles = this.snapshot.botAgentProfiles.filter(
      (entry) => entry.botID !== botID || entry.agentProfileID !== agentProfileID,
    );
    return this.snapshot.botAgentProfiles.length !== before;
  }

  async deleteOpencodeConfig(id: string): Promise<boolean> {
    if (this.snapshot.agentProfiles.some((profile) => profile.opencodeConfigID === id)) throw new Error(`Cannot delete config ${id}`);
    const before = this.snapshot.opencodeConfigs.length;
    this.snapshot.opencodeConfigs = this.snapshot.opencodeConfigs.filter((config) => config.id !== id);
    return this.snapshot.opencodeConfigs.length !== before;
  }

  async deleteSandboxProfile(id: string): Promise<boolean> {
    if (this.snapshot.bots.some((bot) => bot.sandboxProfileID === id)) throw new Error(`Cannot delete sandbox profile ${id}`);
    const before = this.snapshot.sandboxProfiles.length;
    this.snapshot.sandboxProfiles = this.snapshot.sandboxProfiles.filter((profile) => profile.id !== id);
    return this.snapshot.sandboxProfiles.length !== before;
  }

  async getAgentProfile(id: string): Promise<AgentProfile | undefined> {
    return this.snapshot.agentProfiles.find((profile) => profile.id === id);
  }

  async getBot(id: string): Promise<Bot | undefined> {
    return this.snapshot.bots.find((bot) => bot.id === id);
  }

  async getOpencodeConfig(id: string): Promise<OpencodeConfigRecord | undefined> {
    return this.snapshot.opencodeConfigs.find((config) => config.id === id);
  }

  async getSandboxProfile(id: string): Promise<SandboxProfile | undefined> {
    return this.snapshot.sandboxProfiles.find((profile) => profile.id === id);
  }

  async listAgentProfiles(): Promise<AgentProfile[]> {
    return [...this.snapshot.agentProfiles];
  }

  async listBotAgentProfiles(): Promise<BotAgentProfile[]> {
    return [...this.snapshot.botAgentProfiles];
  }

  async listBots(): Promise<Bot[]> {
    return [...this.snapshot.bots];
  }

  async listOpencodeConfigs(): Promise<OpencodeConfigRecord[]> {
    return [...this.snapshot.opencodeConfigs];
  }

  async listSandboxProfiles(): Promise<SandboxProfile[]> {
    return [...this.snapshot.sandboxProfiles];
  }

  async botBySlug(slug: string): Promise<Bot | undefined> {
    return this.snapshot.bots.find((bot) => bot.slug === slug);
  }

  async resolveByBotSlug(slug: string) {
    const bot = await this.botBySlug(slug);
    if (!bot || !bot.enabled) throw new Error(`Unknown or disabled bot: ${slug}`);
    return resolveRuntime(this.snapshot, bot, bot.defaultAgentProfileID);
  }

  async resolveByThreadState(state: ThreadState) {
    const bot = this.snapshot.bots.find((candidate) => candidate.id === state.botID);
    if (!bot || !bot.enabled) throw new Error(`Unknown or disabled bot: ${state.botID}`);
    return resolveRuntime(this.snapshot, bot, state.agentProfileID);
  }

  async upsertAgentProfile(profile: AgentProfile): Promise<AgentProfile> {
    this.requireOpencodeConfig(profile.opencodeConfigID);
    upsertByID(this.snapshot.agentProfiles, profile);
    return profile;
  }

  async upsertBot(bot: Bot): Promise<Bot> {
    this.requireSandboxProfile(bot.sandboxProfileID);
    this.requireAgentProfile(bot.defaultAgentProfileID);
    upsertByID(this.snapshot.bots, bot);
    await this.addBotAgentProfile({ agentProfileID: bot.defaultAgentProfileID, botID: bot.id });
    return bot;
  }

  async upsertOpencodeConfig(input: UpsertOpencodeConfigInput): Promise<OpencodeConfigRecord> {
    const config = { ...input, configHash: hashConfig(input.config), updatedAt: input.updatedAt ?? new Date().toISOString() };
    upsertByID(this.snapshot.opencodeConfigs, config);
    return config;
  }

  async upsertSandboxProfile(profile: SandboxProfile): Promise<SandboxProfile> {
    upsertByID(this.snapshot.sandboxProfiles, profile);
    return profile;
  }

  private requireAgentProfile(id: string): void {
    if (!this.snapshot.agentProfiles.some((profile) => profile.id === id)) throw new Error(`Unknown agent profile: ${id}`);
  }

  private requireBot(id: string): void {
    if (!this.snapshot.bots.some((bot) => bot.id === id)) throw new Error(`Unknown bot: ${id}`);
  }

  private requireOpencodeConfig(id: string): void {
    if (!this.snapshot.opencodeConfigs.some((config) => config.id === id)) throw new Error(`Unknown opencode config: ${id}`);
  }

  private requireSandboxProfile(id: string): void {
    if (!this.snapshot.sandboxProfiles.some((profile) => profile.id === id)) throw new Error(`Unknown sandbox profile: ${id}`);
  }
}

export function defaultRuntimeSnapshot(): RuntimeStoreSnapshot {
  return runtimeSnapshot({
    agentProfileID: "agent-profile-default",
    botID: "bot-default",
    botSlug: "agentbay",
    opencodeAgentName: "agentbay",
    opencodeConfigID: "opencode-config-default",
    opencodeConfigSlug: "default",
    opencodeConfig: {
      agent: {
        agentbay: {
          prompt:
            "You are running inside an isolated Kubernetes sandbox. Help the user with the requested coding task, keep them informed, and avoid touching unrelated files.",
        },
      },
      default_agent: "agentbay",
    },
    sandboxProfileID: "sandbox-profile-default",
  });
}

export function runtimeSnapshot(input: {
  agentProfileID: string;
  botID: string;
  botSlug: string;
  opencodeAgentName: string;
  opencodeConfig: Record<string, unknown>;
  opencodeConfigID: string;
  opencodeConfigSlug: string;
  sandboxProfileID: string;
}): RuntimeStoreSnapshot {
  return {
    agentProfiles: [
      {
        displayName: input.opencodeAgentName,
        enabled: true,
        id: input.agentProfileID,
        opencodeAgentName: input.opencodeAgentName,
        opencodeConfigID: input.opencodeConfigID,
        slug: input.opencodeAgentName,
      },
    ],
    botAgentProfiles: [{ agentProfileID: input.agentProfileID, botID: input.botID }],
    bots: [
      {
        defaultAgentProfileID: input.agentProfileID,
        displayName: input.botSlug,
        enabled: true,
        id: input.botID,
        sandboxProfileID: input.sandboxProfileID,
        slug: input.botSlug,
      },
    ],
    opencodeConfigs: [
      {
        config: input.opencodeConfig,
        configHash: hashConfig(input.opencodeConfig),
        displayName: input.opencodeConfigSlug,
        enabled: true,
        id: input.opencodeConfigID,
        slug: input.opencodeConfigSlug,
        updatedAt: new Date(0).toISOString(),
      },
    ],
    sandboxProfiles: [
      {
        enabled: true,
        id: input.sandboxProfileID,
        slug: "default",
        templateName: "opencode-template",
        warmpool: "none",
      },
    ],
  };
}

function sameBotAgentProfile(left: BotAgentProfile, right: BotAgentProfile): boolean {
  return left.botID === right.botID && left.agentProfileID === right.agentProfileID;
}

function upsertByID<T extends { id: string }>(items: T[], item: T): void {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index === -1) items.push(item);
  else items[index] = item;
}
