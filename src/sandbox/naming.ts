import { createHash } from "node:crypto";

export function claimNameForThread(threadId: string): string {
  const hash = createHash("sha256").update(threadId).digest("hex").slice(0, 16);
  return `agentbay-${hash}`;
}
