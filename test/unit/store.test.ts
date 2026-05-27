import { describe, expect, it } from "vitest";
import {
  agentProfileHash,
  botAdaptersHash,
  hashConfig,
  resolveRuntime,
  sandboxProfileHash,
  type RuntimeStoreSnapshot,
} from "../../src/runtime/store.js";
import type { AgentProfile, Bot, BotAgentProfile, OpencodeConfigRecord, SandboxProfile } from "../../src/runtime/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeBot(overrides: Partial<Bot> = {}): Bot {
  return {
    adapters: {},
    defaultAgentProfileID: "agent-1",
    displayName: "Test Bot",
    enabled: true,
    id: "bot-1",
    sandboxProfileID: "sandbox-1",
    slug: "testbot",
    ...overrides,
  };
}

function makeSandboxProfile(overrides: Partial<SandboxProfile> = {}): SandboxProfile {
  return {
    enabled: true,
    id: "sandbox-1",
    slug: "default",
    templateName: "opencode-template",
    warmpool: "none",
    ...overrides,
  };
}

function makeAgentProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    claimEnv: [],
    displayName: "Test Agent",
    enabled: true,
    id: "agent-1",
    opencodeAgentName: "coder",
    opencodeConfigID: "config-1",
    slug: "coder",
    ...overrides,
  };
}

function makeOpencodeConfig(overrides: Partial<OpencodeConfigRecord> = {}): OpencodeConfigRecord {
  return {
    config: { agent: { coder: { prompt: "test" } } },
    configHash: "abc",
    displayName: "Test Config",
    enabled: true,
    id: "config-1",
    slug: "default",
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function makeAllowEntry(botID = "bot-1", agentProfileID = "agent-1"): BotAgentProfile {
  return { agentProfileID, botID };
}

function makeSnapshot(overrides: Partial<RuntimeStoreSnapshot> = {}): RuntimeStoreSnapshot {
  return {
    agentProfiles: [makeAgentProfile()],
    botAgentProfiles: [makeAllowEntry()],
    bots: [makeBot()],
    opencodeConfigs: [makeOpencodeConfig()],
    sandboxProfiles: [makeSandboxProfile()],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolveRuntime
// ---------------------------------------------------------------------------

describe("resolveRuntime", () => {
  it("resolves a valid runtime", () => {
    const snapshot = makeSnapshot();
    const result = resolveRuntime(snapshot, makeBot(), "agent-1");
    expect(result.bot.id).toBe("bot-1");
    expect(result.sandboxProfile.id).toBe("sandbox-1");
    expect(result.agentProfile.id).toBe("agent-1");
    expect(result.opencodeConfig.id).toBe("config-1");
    expect(result.opencodeAgentName).toBe("coder");
  });

  it("throws when the sandbox profile is unknown", () => {
    const snapshot = makeSnapshot({ sandboxProfiles: [] });
    expect(() => resolveRuntime(snapshot, makeBot(), "agent-1")).toThrow(/unknown or disabled sandbox profile/i);
  });

  it("throws when the sandbox profile is disabled", () => {
    const snapshot = makeSnapshot({ sandboxProfiles: [makeSandboxProfile({ enabled: false })] });
    expect(() => resolveRuntime(snapshot, makeBot(), "agent-1")).toThrow(/unknown or disabled sandbox profile/i);
  });

  it("throws when the agent profile is unknown", () => {
    const snapshot = makeSnapshot({ agentProfiles: [] });
    expect(() => resolveRuntime(snapshot, makeBot(), "agent-1")).toThrow(/unknown or disabled agent profile/i);
  });

  it("throws when the agent profile is disabled", () => {
    const snapshot = makeSnapshot({ agentProfiles: [makeAgentProfile({ enabled: false })] });
    expect(() => resolveRuntime(snapshot, makeBot(), "agent-1")).toThrow(/unknown or disabled agent profile/i);
  });

  it("throws when the agent profile is not in the bot allow-list", () => {
    const snapshot = makeSnapshot({ botAgentProfiles: [] });
    expect(() => resolveRuntime(snapshot, makeBot(), "agent-1")).toThrow(/is not allowed for bot/);
  });

  it("throws when the opencode config is unknown", () => {
    const snapshot = makeSnapshot({ opencodeConfigs: [] });
    expect(() => resolveRuntime(snapshot, makeBot(), "agent-1")).toThrow(/unknown or disabled opencode config/i);
  });

  it("throws when the opencode config is disabled", () => {
    const snapshot = makeSnapshot({ opencodeConfigs: [makeOpencodeConfig({ enabled: false })] });
    expect(() => resolveRuntime(snapshot, makeBot(), "agent-1")).toThrow(/unknown or disabled opencode config/i);
  });

  it("throws when the opencode agent is missing from the config", () => {
    const snapshot = makeSnapshot({
      agentProfiles: [makeAgentProfile({ opencodeAgentName: "missing" })],
      opencodeConfigs: [makeOpencodeConfig({ config: { agent: { coder: {} } } })],
    });
    expect(() => resolveRuntime(snapshot, makeBot(), "agent-1")).toThrow(
      /missing opencode agent missing in config config-1/,
    );
  });
});

// ---------------------------------------------------------------------------
// Hash functions
// ---------------------------------------------------------------------------

describe("agentProfileHash", () => {
  it("returns the same hash for the same profile", () => {
    const profile = makeAgentProfile();
    expect(agentProfileHash(profile)).toBe(agentProfileHash(profile));
  });

  it("returns different hashes when the profile changes", () => {
    const base = makeAgentProfile();
    const changed = makeAgentProfile({ opencodeAgentName: "reviewer" });
    expect(agentProfileHash(base)).not.toBe(agentProfileHash(changed));
  });

  it("is not sensitive to untracked fields (displayName)", () => {
    // displayName is intentionally excluded from the hash
    const a = makeAgentProfile({ displayName: "Name A" });
    const b = makeAgentProfile({ displayName: "Name B" });
    expect(agentProfileHash(a)).toBe(agentProfileHash(b));
  });

  it("is sensitive to id changes", () => {
    const a = makeAgentProfile({ id: "agent-1" });
    const b = makeAgentProfile({ id: "agent-2" });
    expect(agentProfileHash(a)).not.toBe(agentProfileHash(b));
  });

  it("is sensitive to claimEnv changes", () => {
    const a = makeAgentProfile({ claimEnv: [] });
    const b = makeAgentProfile({ claimEnv: [{ name: "KEY", valueFromEnv: "SOURCE" }] });
    expect(agentProfileHash(a)).not.toBe(agentProfileHash(b));
  });

  it("returns a non-empty hex string", () => {
    expect(agentProfileHash(makeAgentProfile())).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("botAdaptersHash", () => {
  it("returns the same hash for the same bot", () => {
    const bot = makeBot();
    expect(botAdaptersHash(bot)).toBe(botAdaptersHash(bot));
  });

  it("returns different hashes when adapters change", () => {
    const a = makeBot({ adapters: {} });
    const b = makeBot({ adapters: { telegram: { botTokenEnv: "TOKEN" } } });
    expect(botAdaptersHash(a)).not.toBe(botAdaptersHash(b));
  });

  it("is not sensitive to untracked fields (displayName)", () => {
    const a = makeBot({ displayName: "Bot A" });
    const b = makeBot({ displayName: "Bot B" });
    expect(botAdaptersHash(a)).toBe(botAdaptersHash(b));
  });

  it("returns a non-empty hex string", () => {
    expect(botAdaptersHash(makeBot())).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("hashConfig", () => {
  it("returns the same hash for identical configs", () => {
    const config = { agent: { coder: { prompt: "hello" } } };
    expect(hashConfig(config)).toBe(hashConfig(config));
  });

  it("is key-order independent (stable serialization)", () => {
    const a = { b: 2, a: 1 };
    const b = { a: 1, b: 2 };
    expect(hashConfig(a)).toBe(hashConfig(b));
  });

  it("returns different hashes for different configs", () => {
    expect(hashConfig({ model: "gpt-4" })).not.toBe(hashConfig({ model: "claude-3" }));
  });

  it("returns different hashes for different nested values", () => {
    const a = { agent: { coder: { prompt: "v1" } } };
    const b = { agent: { coder: { prompt: "v2" } } };
    expect(hashConfig(a)).not.toBe(hashConfig(b));
  });

  it("returns a non-empty hex string", () => {
    expect(hashConfig({})).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("sandboxProfileHash", () => {
  it("returns the same hash for the same profile", () => {
    const profile = makeSandboxProfile();
    expect(sandboxProfileHash(profile)).toBe(sandboxProfileHash(profile));
  });

  it("returns different hashes when templateName changes", () => {
    const a = makeSandboxProfile({ templateName: "template-a" });
    const b = makeSandboxProfile({ templateName: "template-b" });
    expect(sandboxProfileHash(a)).not.toBe(sandboxProfileHash(b));
  });

  it("returns different hashes when warmpool changes", () => {
    const a = makeSandboxProfile({ warmpool: "none" });
    const b = makeSandboxProfile({ warmpool: "my-pool" });
    expect(sandboxProfileHash(a)).not.toBe(sandboxProfileHash(b));
  });

  it("is not sensitive to untracked fields (enabled)", () => {
    const a = makeSandboxProfile({ enabled: true });
    const b = makeSandboxProfile({ enabled: false });
    expect(sandboxProfileHash(a)).toBe(sandboxProfileHash(b));
  });

  it("returns a non-empty hex string", () => {
    expect(sandboxProfileHash(makeSandboxProfile())).toMatch(/^[0-9a-f]{64}$/);
  });
});
