import { describe, expect, it } from "vitest";
import {
  assertOpencodeAgentExists,
  assertOpencodeConfigSupportsProfiles,
  validateBotAdapters,
  validateEnvVarName,
  validateEnvVarRefs,
  validateRuntimeID,
  validateRuntimeSlug,
} from "../../src/runtime/validation.js";
import type { AgentProfile, OpencodeConfig, OpencodeConfigRecord } from "../../src/runtime/types.js";

// ---------------------------------------------------------------------------
// validateRuntimeID / validateRuntimeSlug
// ---------------------------------------------------------------------------

describe("validateRuntimeID", () => {
  it("accepts valid lowercase DNS labels", () => {
    expect(validateRuntimeID("abc", "id")).toBe("abc");
    expect(validateRuntimeID("a", "id")).toBe("a");
    expect(validateRuntimeID("abc-123", "id")).toBe("abc-123");
    expect(validateRuntimeID("a".repeat(63), "id")).toBe("a".repeat(63));
  });

  it("returns the value on success", () => {
    expect(validateRuntimeID("my-bot", "id")).toBe("my-bot");
  });

  it("rejects uppercase characters", () => {
    expect(() => validateRuntimeID("MyBot", "id")).toThrow(/lowercase DNS label/);
  });

  it("rejects labels with underscores", () => {
    expect(() => validateRuntimeID("my_bot", "id")).toThrow(/lowercase DNS label/);
  });

  it("rejects labels with leading hyphens", () => {
    expect(() => validateRuntimeID("-bot", "id")).toThrow(/lowercase DNS label/);
  });

  it("rejects labels with trailing hyphens", () => {
    expect(() => validateRuntimeID("bot-", "id")).toThrow(/lowercase DNS label/);
  });

  it("rejects empty strings", () => {
    expect(() => validateRuntimeID("", "id")).toThrow(/lowercase DNS label/);
  });

  it("rejects labels exceeding 63 characters", () => {
    expect(() => validateRuntimeID("a".repeat(64), "id")).toThrow(/lowercase DNS label/);
  });

  it("rejects labels with dots", () => {
    expect(() => validateRuntimeID("my.bot", "id")).toThrow(/lowercase DNS label/);
  });

  it("includes the field name in the error message", () => {
    expect(() => validateRuntimeID("Bad", "myField")).toThrow(/myField/);
  });
});

describe("validateRuntimeSlug", () => {
  it("accepts valid lowercase DNS labels", () => {
    expect(validateRuntimeSlug("my-slug", "slug")).toBe("my-slug");
  });

  it("rejects invalid slugs with the field name", () => {
    expect(() => validateRuntimeSlug("Bad/Slug", "botSlug")).toThrow(/botSlug/);
  });
});

// ---------------------------------------------------------------------------
// validateEnvVarName
// ---------------------------------------------------------------------------

describe("validateEnvVarName", () => {
  it("accepts names starting with a letter", () => {
    expect(validateEnvVarName("API_KEY", "field")).toBe("API_KEY");
  });

  it("accepts names starting with an underscore", () => {
    expect(validateEnvVarName("_PRIVATE", "field")).toBe("_PRIVATE");
  });

  it("accepts mixed-case names with digits", () => {
    expect(validateEnvVarName("ANTHROPIC_API_KEY_2", "field")).toBe("ANTHROPIC_API_KEY_2");
  });

  it("rejects names starting with a digit", () => {
    expect(() => validateEnvVarName("1BAD", "field")).toThrow(/valid environment variable name/);
  });

  it("rejects names with hyphens", () => {
    expect(() => validateEnvVarName("BAD-NAME", "field")).toThrow(/valid environment variable name/);
  });

  it("rejects empty strings", () => {
    expect(() => validateEnvVarName("", "field")).toThrow(/valid environment variable name/);
  });

  it("rejects names with spaces", () => {
    expect(() => validateEnvVarName("MY VAR", "field")).toThrow(/valid environment variable name/);
  });

  it("includes the field name in the error message", () => {
    expect(() => validateEnvVarName("bad-name", "myEnvField")).toThrow(/myEnvField/);
  });
});

// ---------------------------------------------------------------------------
// validateBotAdapters
// ---------------------------------------------------------------------------

describe("validateBotAdapters", () => {
  it("accepts empty adapters config", () => {
    expect(() => validateBotAdapters({})).not.toThrow();
  });

  it("accepts valid telegram adapter config", () => {
    expect(() =>
      validateBotAdapters({ telegram: { botTokenEnv: "TELEGRAM_BOT_TOKEN", secretTokenEnv: "TELEGRAM_SECRET_TOKEN" } }),
    ).not.toThrow();
  });

  it("accepts telegram adapter with only botTokenEnv", () => {
    expect(() => validateBotAdapters({ telegram: { botTokenEnv: "TELEGRAM_BOT_TOKEN" } })).not.toThrow();
  });

  it("accepts telegram adapter with only secretTokenEnv", () => {
    expect(() => validateBotAdapters({ telegram: { secretTokenEnv: "SECRET" } })).not.toThrow();
  });

  it("accepts telegram adapter with no env var fields", () => {
    expect(() => validateBotAdapters({ telegram: { userName: "mybot" } })).not.toThrow();
  });

  it("rejects invalid botTokenEnv names", () => {
    expect(() => validateBotAdapters({ telegram: { botTokenEnv: "bad-token-env" } })).toThrow(
      /adapters.telegram.botTokenEnv/,
    );
  });

  it("rejects invalid secretTokenEnv names", () => {
    expect(() => validateBotAdapters({ telegram: { secretTokenEnv: "bad-secret-env" } })).toThrow(
      /adapters.telegram.secretTokenEnv/,
    );
  });
});

// ---------------------------------------------------------------------------
// validateEnvVarRefs
// ---------------------------------------------------------------------------

describe("validateEnvVarRefs", () => {
  it("accepts an empty refs array", () => {
    expect(() => validateEnvVarRefs([], "claimEnv")).not.toThrow();
  });

  it("accepts valid env var refs", () => {
    expect(() =>
      validateEnvVarRefs(
        [
          { name: "ANTHROPIC_API_KEY", valueFromEnv: "ANTHROPIC_API_KEY_SECRET" },
          { name: "GITHUB_TOKEN", valueFromEnv: "GITHUB_TOKEN_ENV" },
        ],
        "claimEnv",
      ),
    ).not.toThrow();
  });

  it("rejects an invalid name with field and index in the error", () => {
    expect(() =>
      validateEnvVarRefs([{ name: "bad-name", valueFromEnv: "VALID_ENV" }], "claimEnv"),
    ).toThrow(/claimEnv\[0\]\.name/);
  });

  it("rejects an invalid valueFromEnv with field and index in the error", () => {
    expect(() =>
      validateEnvVarRefs([{ name: "VALID_NAME", valueFromEnv: "bad-env" }], "claimEnv"),
    ).toThrow(/claimEnv\[0\]\.valueFromEnv/);
  });

  it("reports the correct index for the failing ref", () => {
    expect(() =>
      validateEnvVarRefs(
        [
          { name: "VALID", valueFromEnv: "ALSO_VALID" },
          { name: "VALID2", valueFromEnv: "bad-env" },
        ],
        "claimEnv",
      ),
    ).toThrow(/claimEnv\[1\]\.valueFromEnv/);
  });
});

// ---------------------------------------------------------------------------
// assertOpencodeAgentExists
// ---------------------------------------------------------------------------

describe("assertOpencodeAgentExists", () => {
  const config: OpencodeConfig = {
    agent: { coder: { prompt: "You are a coder" }, reviewer: {} },
    default_agent: "coder",
  };

  it("does not throw when the agent exists", () => {
    expect(() => assertOpencodeAgentExists(config, "coder", "my-config")).not.toThrow();
    expect(() => assertOpencodeAgentExists(config, "reviewer", "my-config")).not.toThrow();
  });

  it("throws when the agent is missing from the config", () => {
    expect(() => assertOpencodeAgentExists(config, "missing-agent", "my-config")).toThrow(
      /missing opencode agent missing-agent in config my-config/,
    );
  });

  it("throws when the agent map is not a record", () => {
    expect(() => assertOpencodeAgentExists({ agent: "not-an-object" }, "coder", "cfg")).toThrow(/missing opencode agent/);
  });

  it("throws when the config has no agent key at all", () => {
    expect(() => assertOpencodeAgentExists({}, "coder", "cfg")).toThrow(/missing opencode agent/);
  });
});

// ---------------------------------------------------------------------------
// assertOpencodeConfigSupportsProfiles
// ---------------------------------------------------------------------------

describe("assertOpencodeConfigSupportsProfiles", () => {
  const configRecord: OpencodeConfigRecord = {
    id: "cfg-1",
    slug: "default",
    displayName: "Default",
    config: { agent: { coder: {}, reviewer: {} } },
    configHash: "abc",
    updatedAt: new Date(0).toISOString(),
    enabled: true,
  };

  const makeProfile = (id: string, agentName: string): AgentProfile => ({
    claimEnv: [],
    displayName: agentName,
    enabled: true,
    id,
    opencodeAgentName: agentName,
    opencodeConfigID: "cfg-1",
    slug: id,
  });

  it("does not throw when all profiles reference agents that exist in the config", () => {
    expect(() =>
      assertOpencodeConfigSupportsProfiles(configRecord, [makeProfile("p1", "coder"), makeProfile("p2", "reviewer")]),
    ).not.toThrow();
  });

  it("does not throw for an empty profiles array", () => {
    expect(() => assertOpencodeConfigSupportsProfiles(configRecord, [])).not.toThrow();
  });

  it("throws when a profile references a missing agent", () => {
    expect(() =>
      assertOpencodeConfigSupportsProfiles(configRecord, [makeProfile("p1", "coder"), makeProfile("p2", "missing")]),
    ).toThrow(/missing opencode agent missing in config cfg-1/);
  });
});
