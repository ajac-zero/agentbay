import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GitHubAppRevisionResolver } from "../../src/revision/github.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const request = {
  attempt: 1,
  branch: "main",
  cloneUrl: "https://github.com/acme/widgets.git",
  eventId: "event-1",
  installationId: 44,
  leaseOwner: "worker-1",
  leaseToken: "lease-1",
  provider: "github" as const,
  repositoryFullName: "acme/widgets",
  repositoryId: 10,
  tenantId: "default",
};

describe("GitHubAppRevisionResolver", () => {
  it("mints a selected-repository read token and resolves the exact default branch commit", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({
        token: "ghs_token",
        expires_at: "2026-07-19T01:00:00Z",
        repository_selection: "selected",
        repositories: [{ id: 10 }],
        permissions: { contents: "read", metadata: "read" },
      }))
      .mockResolvedValueOnce(Response.json({
        id: 10,
        full_name: "acme/widgets",
        clone_url: "https://github.com/acme/widgets.git",
        default_branch: "main",
      }))
      .mockResolvedValueOnce(Response.json({ object: { type: "commit", sha: "A".repeat(40) } }));
    const resolver = new GitHubAppRevisionResolver({
      appIdFile: "app-id",
      privateKeyFile: "private-key",
      fetch,
      now: () => Date.parse("2026-07-19T00:00:00Z"),
      readFile: async (path) => String(path) === "app-id" ? "123" : pem,
    });
    await expect(resolver.resolve(request)).resolves.toBe("a".repeat(40));
    expect(fetch.mock.calls[0]![1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ repository_ids: [10], permissions: { contents: "read" } }),
    });
    expect(fetch.mock.calls[1]![0]).toBe("https://api.github.com/repositories/10");
    expect(fetch.mock.calls[2]![0]).toBe("https://api.github.com/repos/acme/widgets/git/ref/heads/main");
  });

  it("rejects repository identity drift", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({
        token: "ghs_token",
        expires_at: "2099-01-01T00:00:00Z",
        repositories: [{ id: 10 }],
        permissions: { contents: "read" },
      }))
      .mockResolvedValueOnce(Response.json({
        id: 10,
        full_name: "acme/widgets",
        clone_url: "https://github.com/acme/widgets.git",
        default_branch: "renamed",
      }));
    const resolver = new GitHubAppRevisionResolver({
      appIdFile: "app-id", privateKeyFile: "private-key", fetch,
      readFile: async (path) => String(path) === "app-id" ? "123" : pem,
    });
    await expect(resolver.resolve(request)).rejects.toThrow(/changed/);
  });
});
