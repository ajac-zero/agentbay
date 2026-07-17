import type { JsonObject } from "../execution/types.js";

/**
 * Build the JSON blob to inject into a sandbox Pod as
 * `OPENCODE_CONFIG_CONTENT`. opencode merges this above the project's
 * `opencode.json` and `.opencode/` configs at startup, so model, tool, and
 * permission settings declared here cannot be silently overridden by the
 * workspace contents that get checked out into the sandbox.
 *
 * Returns `undefined` when the resulting object is empty so we don't add a
 * noise env var on claims that don't need it.
 */
export function buildOpencodeConfigContent(opencodeConfig: JsonObject): string | undefined {
  if (Object.keys(opencodeConfig).length === 0) return undefined;
  return JSON.stringify(opencodeConfig);
}
