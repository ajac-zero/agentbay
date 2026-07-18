import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE_PATTERN = /^sha256=[0-9a-f]{64}$/;

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function verifyGitHubSignature(
  signature: string | null | undefined,
  secret: string | Uint8Array,
  body: Uint8Array,
): boolean {
  if (typeof signature !== "string" || !SIGNATURE_PATTERN.test(signature)) return false;

  const supplied = Buffer.from(signature.slice("sha256=".length), "hex");
  const expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(expected, supplied);
}
