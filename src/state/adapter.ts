import { createRedisState } from "@chat-adapter/state-redis";
import type { StateAdapter } from "chat";
import type { Config } from "../config.js";
import { createMemoryState } from "./memory.js";

export function createStateAdapter(config: Config): StateAdapter {
  if (config.redisUrl) {
    return createRedisState({ keyPrefix: "agentbay", url: config.redisUrl });
  }

  return createMemoryState();
}
