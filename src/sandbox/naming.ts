import { createHash } from "node:crypto";

export function claimNameForThread(threadId: string): string {
  const hash = createHash("sha256").update(threadId).digest("hex").slice(0, 16);
  return `agentbay-${hash}`;
}

export function claimNameForExecutionAttempt(executionId: string, attempt: number): string {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("Execution attempt must be a positive integer");

  const identity = `${executionId}\u0000${attempt}`;
  const hash = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  const suffix = `-${attempt}-${hash}`;
  const availableIdLength = 63 - "agentbay-".length - suffix.length;
  const safeExecutionId = executionId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, availableIdLength)
    .replace(/-+$/g, "") || "execution";

  return `agentbay-${safeExecutionId}${suffix}`;
}
