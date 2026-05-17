import type { Message, Thread } from "chat";
import type { BotProfile, OpencodeConfig } from "./types.js";

const defaultProfile: BotProfile = {
  id: "default",
  templateName: process.env.AGENTBAY_TEMPLATE_NAME ?? "opencode-template",
  warmpool: process.env.AGENTBAY_WARMPOOL ?? "none",
  systemPrompt:
    process.env.AGENTBAY_SYSTEM_PROMPT ??
    "You are running inside an isolated Kubernetes sandbox. Help the user with the requested coding task, keep them informed, and avoid touching unrelated files.",
  defaultModel: readDefaultModel(),
  tools: readTools(),
  opencodeConfig: readOpencodeConfig(),
};

export const profiles: Record<string, BotProfile> = {
  default: defaultProfile,
};

export function resolveProfile(_thread: Thread, _message: Message): BotProfile {
  return defaultProfile;
}

export function getProfile(profileID: string): BotProfile {
  const profile = profiles[profileID];
  if (!profile) throw new Error(`Unknown profile: ${profileID}`);
  return profile;
}

function readDefaultModel(): BotProfile["defaultModel"] {
  const providerID = process.env.AGENTBAY_DEFAULT_PROVIDER_ID;
  const modelID = process.env.AGENTBAY_DEFAULT_MODEL_ID;
  return providerID && modelID ? { providerID, modelID } : undefined;
}

function readOpencodeConfig(): OpencodeConfig | undefined {
  const raw = process.env.AGENTBAY_OPENCODE_CONFIG_JSON;
  if (!raw) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`AGENTBAY_OPENCODE_CONFIG_JSON is not valid JSON: ${(error as Error).message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("AGENTBAY_OPENCODE_CONFIG_JSON must be a JSON object");
  }

  return parsed as OpencodeConfig;
}

function readTools(): Record<string, boolean> | undefined {
  const raw = process.env.AGENTBAY_TOOLS;
  if (!raw) return undefined;

  return Object.fromEntries(
    raw
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [name, value = "true"] = entry.split("=");
        return [name, ["1", "true", "yes", "allow"].includes(value.toLowerCase())];
      }),
  );
}
