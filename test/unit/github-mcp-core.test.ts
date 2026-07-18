import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
// @ts-ignore Standalone production code intentionally ships as dependency-free ESM.
import { createGitHubAppJwt, GitHubTokenManager } from "../../github-mcp-sidecar/auth.mjs";
// @ts-ignore Standalone production code intentionally ships as dependency-free ESM.
import { parseStartupConfig, readGitHubAppCredentials } from "../../github-mcp-sidecar/config.mjs";
// @ts-ignore Standalone production code intentionally ships as dependency-free ESM.
import { GitHubClient } from "../../github-mcp-sidecar/github.mjs";

const now = Date.parse("2026-07-18T12:00:00Z");
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function validToken(overrides: Record<string, unknown> = {}) {
  return {
    token: "installation-secret",
    expires_at: "2026-07-18T13:00:00Z",
    repositories: [{ id: 42 }],
    repository_selection: "selected",
    permissions: { issues: "write", metadata: "read" },
    ...overrides,
  };
}

function validEnv() {
  return {
    AGENTBAY_CONNECTIONS: JSON.stringify({ schemaVersion: 1, tenantId: "tenant-1", refs: ["github-production"] }),
    AGENTBAY_GITHUB_TENANT: "tenant-1",
    AGENTBAY_GITHUB_CONNECTION: "github-production",
    AGENTBAY_GITHUB_REPOSITORY_OWNER: "Acme",
    AGENTBAY_GITHUB_REPOSITORY_NAME: "widgets",
    AGENTBAY_GITHUB_REPOSITORY_ID: "42",
  };
}

function tokenManager(fetch: typeof globalThis.fetch) {
  return new GitHubTokenManager(
    { appId: 7, installationId: 9, privateKey: privateKeyPem, repositoryId: 42 },
    { fetch, now: () => now, baseUrl: "https://github.test" },
  );
}

describe("GitHub MCP startup configuration", () => {
  it("accepts only the exact connection envelope and matching tenant/ref", () => {
    expect(parseStartupConfig(validEnv())).toMatchObject({
      tenantId: "tenant-1",
      connectionRef: "github-production",
      repositoryId: 42,
    });
    expect(() => parseStartupConfig({ ...validEnv(), AGENTBAY_CONNECTIONS: '{"schemaVersion":1,"tenantId":"tenant-1","refs":["github-production"],"extra":true}' })).toThrow(/keys/);
    expect(() => parseStartupConfig({ ...validEnv(), AGENTBAY_CONNECTIONS: '{"schemaVersion":1,"tenantId":"other","refs":["github-production"]}' })).toThrow(/does not match/);
    expect(() => parseStartupConfig({ ...validEnv(), AGENTBAY_CONNECTIONS: '{"schemaVersion":1,"tenantId":"tenant-1","refs":["github-production","other"]}' })).toThrow(/does not match/);
    expect(() => parseStartupConfig({ ...validEnv(), AGENTBAY_GITHUB_REPOSITORY_ID: "9007199254740992" })).toThrow(/REPOSITORY_ID/);
  });

  it("does not accept an API base URL from environment", () => {
    const config = parseStartupConfig({ ...validEnv(), GITHUB_API_URL: "https://evil.test" });
    expect(config).not.toHaveProperty("baseUrl");
  });

  it("accepts RSA credentials and rejects non-RSA credentials", async () => {
    const paths = { appId: "app", installationId: "installation", privateKey: "key" };
    const readFile = vi.fn(async (path: string) => path === "app" ? "7" : path === "installation" ? "9" : privateKeyPem);
    await expect(readGitHubAppCredentials(paths, { readFile })).resolves.toMatchObject({ appId: 7, installationId: 9 });

    const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey
      .export({ type: "pkcs8", format: "pem" }).toString();
    await expect(readGitHubAppCredentials(paths, { readFile: async (path: string) => path === "app" ? "7" : path === "installation" ? "9" : ec }))
      .rejects.toThrow(/private key/);
    const rsaPss = generateKeyPairSync("rsa-pss", { modulusLength: 2048 }).privateKey
      .export({ type: "pkcs8", format: "pem" }).toString();
    await expect(readGitHubAppCredentials(paths, { readFile: async (path: string) => path === "app" ? "7" : path === "installation" ? "9" : rsaPss }))
      .rejects.toThrow(/private key/);
  });
});

describe("GitHub App authentication", () => {
  it("creates a correctly timed RS256 JWT", () => {
    const jwt = createGitHubAppJwt({ appId: 7, privateKey: privateKeyPem, now: () => now });
    const [header, payload, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toEqual({
      iat: now / 1000 - 60,
      exp: now / 1000 + 540,
      iss: 7,
    });
    expect(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature!, "base64url"))).toBe(true);
  });

  it("mints a repository-restricted token with the exact body", async () => {
    const fetch = vi.fn(async (_url, init) => {
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe('{"repository_ids":[42],"permissions":{"issues":"write"}}');
      return jsonResponse(validToken());
    });
    expect(await tokenManager(fetch as typeof globalThis.fetch).getToken()).toBe("installation-secret");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    ["missing repositories", { repositories: undefined }],
    ["empty repositories", { repositories: [] }],
    ["extra repository", { repositories: [{ id: 42 }, { id: 43 }] }],
    ["wrong repository", { repositories: [{ id: 43 }] }],
    ["wrong repository selection", { repository_selection: "all" }],
    ["missing permissions", { permissions: undefined }],
    ["missing issues permission", { permissions: { metadata: "read" } }],
    ["read issues permission", { permissions: { issues: "read" } }],
    ["wrong metadata permission", { permissions: { issues: "write", metadata: "write" } }],
    ["extra permission", { permissions: { issues: "write", metadata: "read", contents: "read" } }],
  ])("rejects a token with %s", async (_name, overrides) => {
    const fetch = vi.fn(async () => jsonResponse(validToken(overrides)));
    await expect(tokenManager(fetch as typeof globalThis.fetch).getToken()).rejects.toThrow(/scope mismatch|selection mismatch|permissions mismatch/);
  });

  it("allows metadata to be omitted and repository_selection to be absent", async () => {
    const { repository_selection: _selection, ...response } = validToken({ permissions: { issues: "write" } });
    const fetch = vi.fn(async () => jsonResponse(response));
    await expect(tokenManager(fetch as typeof globalThis.fetch).getToken()).resolves.toBe("installation-secret");
  });
});

describe("GitHub repository client", () => {
  function client(fetch: typeof globalThis.fetch) {
    return new GitHubClient(
      { owner: "Acme", repository: "widgets", repositoryId: 42, appId: 7, installationId: 9, tokenManager: tokenManager(fetch) },
      { fetch, now: () => now, baseUrl: "https://github.test" },
    );
  }

  function authenticatedClient(fetch: typeof globalThis.fetch) {
    return new GitHubClient(
      {
        owner: "Acme",
        repository: "widgets",
        repositoryId: 42,
        appId: 7,
        installationId: 9,
        connectionRef: "github-production",
        markerKey: Buffer.alloc(32, 7),
        tokenManager: tokenManager(fetch),
      },
      { fetch, now: () => now, baseUrl: "https://github.test" },
    );
  }

  it("rejects a startup repository mismatch", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const value = String(url);
      if (value.endsWith("/app/installations/9")) return jsonResponse({ app_id: 7, account: { login: "acme" } });
      if (value.endsWith("/access_tokens")) return jsonResponse(validToken({ token: "secret" }));
      return jsonResponse({ id: 42, full_name: "Acme/other" });
    });
    await expect(client(fetch as typeof globalThis.fetch).verifyStartup()).rejects.toMatchObject({ code: "REPOSITORY_MISMATCH" });
  });

  it("creates once, replays, conflicts, and singleflights concurrent calls", async () => {
    let comments: Array<{ id: number; body: string }> = [];
    let posts = 0;
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/access_tokens")) return jsonResponse(validToken({ token: "secret" }));
      if (init?.method === "POST") {
        posts += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        const created = { id: 100, body: JSON.parse(String(init.body)).body };
        comments = [created];
        return jsonResponse(created, 201);
      }
      return jsonResponse(comments);
    });
    const github = authenticatedClient(fetch as typeof globalThis.fetch);
    const request = { owner: "Acme", repository: "widgets", issueNumber: 3, body: "hello", idempotencyKey: "job:123" };
    const [first, concurrent] = await Promise.all([github.createIssueComment(request), github.createIssueComment(request)]);
    expect(first.replayed).toBe(false);
    expect(concurrent).toEqual(first);
    expect(posts).toBe(1);
    expect((await github.createIssueComment(request)).replayed).toBe(true);
    expect(posts).toBe(1);
    await expect(github.createIssueComment({ ...request, body: "different" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("rejects marker injection in the requested comment body", async () => {
    const fetch = vi.fn();
    await expect(authenticatedClient(fetch as typeof globalThis.fetch).createIssueComment({
      owner: "Acme",
      repository: "widgets",
      issueNumber: 1,
      body: "hello <!-- agentbay:forged -->",
      idempotencyKey: "key",
    })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("discovers and replays an authenticated marker from the newest page across client restarts", async () => {
    let created: { id: number; body: string } | undefined;
    let posts = 0;
    let replayScan = false;
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/access_tokens")) return jsonResponse(validToken());
      if (init?.method === "POST") {
        posts += 1;
        created = { id: 101, body: JSON.parse(String(init.body)).body };
        return jsonResponse(created, 201);
      }
      const page = new URL(String(url)).searchParams.get("page");
      if (!replayScan) return jsonResponse([]);
      if (page === "1") {
        return jsonResponse([], 200, {
          link: '<https://api.github.com/repos/other/path/issues/999/comments?label=a,b&per_page=100&page=25>; rel="last", <https://api.github.com/repos/other/path/issues/999/comments?per_page=100&page=2>; rel="next"',
        });
      }
      return jsonResponse(page === "25" ? [created] : []);
    });
    const request = { owner: "Acme", repository: "widgets", issueNumber: 3, body: "hello", idempotencyKey: "job:restart" };
    expect((await authenticatedClient(fetch as typeof globalThis.fetch).createIssueComment(request)).replayed).toBe(false);
    replayScan = true;
    expect((await authenticatedClient(fetch as typeof globalThis.fetch).createIssueComment(request)).replayed).toBe(true);
    expect(posts).toBe(1);
    const listUrls = fetch.mock.calls
      .map(([url]) => new URL(String(url)))
      .filter((url) => url.pathname.endsWith("/issues/3/comments") && url.search !== "");
    expect(listUrls.map((url) => url.searchParams.get("page"))).toEqual(["1", "1", "25"]);
    for (const url of listUrls) {
      expect(Object.fromEntries(url.searchParams)).toEqual({
        per_page: "100",
        page: url.searchParams.get("page")!,
      });
      expect(url.origin).toBe("https://github.test");
      expect(url.pathname).toBe("/repos/Acme/widgets/issues/3/comments");
    }
  });

  it("ignores forged and non-terminal markers", async () => {
    let posts = 0;
    const forged = "<!-- agentbay:" + "a".repeat(64) + ":" + "b".repeat(64) + ":" + "c".repeat(64) + " -->";
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/access_tokens")) return jsonResponse(validToken());
      if (init?.method === "POST") {
        posts += 1;
        return jsonResponse({ id: posts, body: JSON.parse(String(init.body)).body }, 201);
      }
      return jsonResponse([
        { id: 1, body: forged },
        { id: 2, body: `${forged}\ntrailing` },
        { id: 3, body: `${forged}\n` },
      ]);
    });
    const result = await authenticatedClient(fetch as typeof globalThis.fetch).createIssueComment({
      owner: "Acme", repository: "widgets", issueNumber: 3, body: "hello", idempotencyKey: "job:forged",
    });
    expect(result.replayed).toBe(false);
    expect(posts).toBe(1);
  });

  it("posts after scanning the newest 2,000 comments when more than 2,000 exist", async () => {
    let posts = 0;
    let pages = 0;
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/access_tokens")) return jsonResponse(validToken());
      if (init?.method === "POST") {
        posts += 1;
        return jsonResponse({}, 201);
      }
      pages += 1;
      return jsonResponse(
        Array.from({ length: 100 }, (_, id) => ({ id, body: "old" })),
        200,
        new URL(String(url)).searchParams.get("page") === "1"
          ? { link: '</repos/Acme/widgets/issues/3/comments?per_page=100&page=25>; rel="last"' }
          : {},
      );
    });
    await expect(authenticatedClient(fetch as typeof globalThis.fetch).createIssueComment({
      owner: "Acme", repository: "widgets", issueNumber: 3, body: "hello", idempotencyKey: "job:limit",
    })).resolves.toMatchObject({ replayed: false });
    expect(pages).toBe(21);
    expect(posts).toBe(1);
    const listUrls = fetch.mock.calls
      .filter(([, init]) => init?.method !== "POST")
      .map(([url]) => new URL(String(url)))
      .filter((url) => url.pathname.endsWith("/issues/3/comments"));
    expect(listUrls).toHaveLength(21);
    expect(listUrls.map((url) => url.searchParams.get("page"))).toEqual(
      ["1", ...Array.from({ length: 20 }, (_, index) => String(25 - index))],
    );
    expect(listUrls.every((url) => !url.searchParams.has("sort") && !url.searchParams.has("direction"))).toBe(true);
  });

  it.each([
    ['<not a URL>; rel="last"'],
    ['</comments?page=9007199254740992>; rel="last"'],
    ['</comments?page=2&page=3>; rel="last"'],
  ])("rejects an invalid last-page Link target: %s", async (link) => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/access_tokens")) return jsonResponse(validToken());
      return jsonResponse([], 200, { link });
    });
    await expect(authenticatedClient(fetch as typeof globalThis.fetch).createIssueComment({
      owner: "Acme", repository: "widgets", issueNumber: 3, body: "hello", idempotencyKey: "job:bad-link",
    })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("rejects a comment page larger than the requested bound", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/access_tokens")) return jsonResponse(validToken());
      return jsonResponse(Array.from({ length: 101 }, (_, id) => ({ id, body: "old" })));
    });
    await expect(authenticatedClient(fetch as typeof globalThis.fetch).createIssueComment({
      owner: "Acme", repository: "widgets", issueNumber: 3, body: "hello", idempotencyKey: "job:large-page",
    })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("rejects outside-repository operations before any upstream call", async () => {
    const fetch = vi.fn();
    await expect(authenticatedClient(fetch as typeof globalThis.fetch).createIssueComment({
      owner: "Acme",
      repository: "other",
      issueNumber: 1,
      body: "no",
      idempotencyKey: "key",
    })).rejects.toMatchObject({ code: "REPOSITORY_NOT_ALLOWED" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refreshes and retries once on 401 without exposing tokens in errors", async () => {
    let mint = 0;
    let list = 0;
    const fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/access_tokens")) {
        mint += 1;
        return jsonResponse(validToken({ token: `highly-secret-${mint}` }));
      }
      list += 1;
      return list === 1 ? jsonResponse({ message: "highly-secret-1" }, 401) : jsonResponse({ message: "highly-secret-2" }, 500);
    });
    await expect(authenticatedClient(fetch as typeof globalThis.fetch).createIssueComment({
      owner: "Acme", repository: "widgets", issueNumber: 1, body: "hello", idempotencyKey: "401",
    }))
      .rejects.toMatchObject({ message: "GitHub request failed with status 500" });
    expect(mint).toBe(2);
    expect(list).toBe(2);
  });
});
