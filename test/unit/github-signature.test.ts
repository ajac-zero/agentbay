import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256, verifyGitHubSignature } from "../../src/connectors/github/signature.js";

describe("GitHub webhook signatures", () => {
  it("verifies GitHub's official SHA-256 example using the exact raw bytes", () => {
    const secret = "It's a Secret to Everybody";
    const body = Buffer.from("Hello, World!");
    const signature = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
    expect(verifyGitHubSignature(signature, secret, body)).toBe(true);
    expect(verifyGitHubSignature(signature, secret, Buffer.from("Hello, World!\n"))).toBe(false);
  });

  it("rejects malformed, uppercase, and non-SHA-256 signatures", () => {
    const body = new Uint8Array([0, 255, 1]);
    const valid = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;
    expect(verifyGitHubSignature(valid, "secret", body)).toBe(true);
    for (const signature of [null, "", valid.toUpperCase(), valid.slice(0, -1), `sha1=${"a".repeat(64)}`, `sha256=${"g".repeat(64)}`]) {
      expect(verifyGitHubSignature(signature, "secret", body)).toBe(false);
    }
  });

  it("hashes raw bytes without text conversion", () => {
    expect(sha256(new Uint8Array([0, 255, 1]))).toBe("47ffa3ea45a70b8a41c2c0825df323c00a8b7a01c1ea06083cc41dddcc001123");
  });
});
