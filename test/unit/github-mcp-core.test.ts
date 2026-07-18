import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
// @ts-ignore Standalone production code intentionally ships as dependency-free ESM.
import { createGitHubAppJwt, GitHubTokenManager } from "../../github-mcp-sidecar/auth.mjs";
// @ts-ignore Standalone production code intentionally ships as dependency-free ESM.
import { parseStartupConfig, readGitHubAppCredentials } from "../../github-mcp-sidecar/config.mjs";
// @ts-ignore Standalone production code intentionally ships as dependency-free ESM.
import { GitHubClient, decodeContent, gitBlobSha, validateBranchRef, validateContentsPath } from "../../github-mcp-sidecar/github.mjs";

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
    permissions: { contents: "write", pull_requests: "write", issues: "write", metadata: "read" },
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
      expect(init?.body).toBe('{"repository_ids":[42],"permissions":{"contents":"write","pull_requests":"write","issues":"write"}}');
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
    ["missing issues permission", { permissions: { contents: "write", pull_requests: "write" } }],
    ["read issues permission", { permissions: { contents: "write", pull_requests: "write", issues: "read" } }],
    ["read contents permission", { permissions: { contents: "read", pull_requests: "write", issues: "write" } }],
    ["missing pull requests permission", { permissions: { contents: "write", issues: "write" } }],
    ["wrong metadata permission", { permissions: { contents: "write", pull_requests: "write", issues: "write", metadata: "write" } }],
    ["extra permission", { permissions: { contents: "write", pull_requests: "write", issues: "write", metadata: "read", actions: "read" } }],
  ])("rejects a token with %s", async (_name, overrides) => {
    const fetch = vi.fn(async () => jsonResponse(validToken(overrides)));
    await expect(tokenManager(fetch as typeof globalThis.fetch).getToken()).rejects.toThrow(/scope mismatch|selection mismatch|permissions mismatch/);
  });

  it("allows metadata to be omitted and repository_selection to be absent", async () => {
    const { repository_selection: _selection, ...response } = validToken({ permissions: { contents: "write", pull_requests: "write", issues: "write" } });
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

  it("posts a maximum-size backslash comment without rejecting the escaped request", async () => {
    let posts = 0;
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/access_tokens")) return jsonResponse(validToken());
      if (init?.method === "POST") {
        posts += 1;
        const posted = JSON.parse(String(init.body)).body;
        return jsonResponse({ id: 100, body: posted }, 201);
      }
      return jsonResponse([]);
    });
    const body = "\\".repeat(16 * 1024);

    await expect(authenticatedClient(fetch as typeof globalThis.fetch).createIssueComment({
      owner: "Acme", repository: "widgets", issueNumber: 3, body, idempotencyKey: "comment:max-backslashes",
    })).resolves.toMatchObject({ replayed: false, comment: { id: 100 } });
    expect(posts).toBe(1);
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
        return jsonResponse({ id: posts, body: JSON.parse(String(init.body)).body }, 201);
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

  it("reconciles a comment after a malformed successful response without reposting", async () => {
    let posted: { id: number; body: string } | undefined;
    let posts = 0;
    let scans = 0;
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/access_tokens")) return jsonResponse(validToken());
      if (init?.method === "POST") {
        posts += 1;
        posted = { id: 1, body: JSON.parse(String(init.body)).body };
        return new Response("not-json", { status: 201, headers: { "content-type": "application/json" } });
      }
      scans += 1;
      return jsonResponse(scans === 1 ? [] : [posted]);
    });
    await expect(authenticatedClient(fetch as typeof globalThis.fetch).createIssueComment({
      owner: "Acme", repository: "widgets", issueNumber: 1, body: "hello", idempotencyKey: "comment:malformed",
    })).resolves.toMatchObject({ replayed: true });
    expect(posts).toBe(1);
  });
});

describe("GitHub code delivery core", () => {
  function deliveryClient(fetch: typeof globalThis.fetch) {
    const tokens = {
      getToken: vi.fn(async () => "token"),
      invalidate: vi.fn(),
      createAppJwt: vi.fn(() => "jwt"),
    };
    return new GitHubClient(
      {
        owner: "Acme", repository: "widgets", repositoryId: 42, appId: 7, installationId: 9,
        connectionRef: "github-production", markerKey: Buffer.alloc(32, 7), tokenManager: tokens,
      },
      { fetch, baseUrl: "https://github.test" },
    );
  }

  const sha = "a".repeat(40);
  const otherSha = "b".repeat(40);
  const ref = (branch: string, value = sha) => ({ ref: `refs/heads/${branch}`, object: { type: "commit", sha: value } });

  it("validates canonical refs, paths, content, and the Git blob vector", () => {
    expect(validateBranchRef("feature/code-delivery")).toBe("feature/code-delivery");
    for (const value of ["", ".bad", "bad.", "a/.bad", "a/bad.", "a..b", "a//b", "a@{b", "a.lock", "a b", "A".repeat(256)]) {
      expect(() => validateBranchRef(value)).toThrow();
    }
    expect(validateContentsPath("src/main.ts")).toBe("src/main.ts");
    for (const value of ["/a", "a/", "a//b", "a/../b", "a\\b", ".github/workflows/ci.yml", ".GITHUB/WORKFLOWS/ci.yml"]) {
      expect(() => validateContentsPath(value)).toThrow();
    }
    expect(decodeContent("aGVsbG8K", "base64").toString()).toBe("hello\n");
    expect(() => decodeContent("aGVsbG8", "base64")).toThrow();
    expect(gitBlobSha(Buffer.from("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });

  it("creates a branch with exact REST calls and no force", async () => {
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const parsed = new URL(String(url));
      if (init?.method === "POST") {
        expect(parsed.pathname).toBe("/repos/Acme/widgets/git/refs");
        expect(JSON.parse(String(init.body))).toEqual({ ref: "refs/heads/feature/a", sha });
        expect(String(init.body)).not.toContain("force");
        return jsonResponse(ref("feature/a"), 201);
      }
      expect(parsed.pathname).toBe("/repos/Acme/widgets/git/ref/heads/feature/a");
      return jsonResponse({ message: "missing" }, 404);
    });
    await expect(deliveryClient(fetch as typeof globalThis.fetch).branchCreate({ branch: "feature/a", baseSha: sha, idempotencyKey: "branch:1" }))
      .resolves.toEqual({ branch: "feature/a", sha, replayed: false });
  });

  it("replays a branch and conflicts when it points elsewhere", async () => {
    const replay = deliveryClient(vi.fn(async () => jsonResponse(ref("feature/a"))) as typeof globalThis.fetch);
    await expect(replay.branchCreate({ branch: "feature/a", baseSha: sha, idempotencyKey: "branch:replay" })).resolves.toMatchObject({ replayed: true });
    const conflict = deliveryClient(vi.fn(async () => jsonResponse(ref("feature/a", otherSha))) as typeof globalThis.fetch);
    await expect(conflict.branchCreate({ branch: "feature/a", baseSha: sha, idempotencyKey: "branch:conflict" })).rejects.toMatchObject({ code: "STATE_CONFLICT" });
  });

  it("reconciles an ambiguous branch POST", async () => {
    let reads = 0;
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") return jsonResponse({ message: "validation" }, 422);
      reads += 1;
      return reads === 1 ? jsonResponse({}, 404) : jsonResponse(ref("feature/a"));
    });
    await expect(deliveryClient(fetch as typeof globalThis.fetch).branchCreate({ branch: "feature/a", baseSha: sha, idempotencyKey: "branch:ambiguous" }))
      .resolves.toEqual({ branch: "feature/a", sha, replayed: true });
  });

  it.each([
    ["401", 401, ref("feature/a")],
    ["malformed 201", 201, {}],
    ["unexpected 202", 202, ref("feature/a")],
  ])("reconciles a branch after a %s response with one POST", async (_name, status, body) => {
    let reads = 0;
    let posts = 0;
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts += 1;
        return jsonResponse(body, status);
      }
      reads += 1;
      return reads === 1 ? jsonResponse({}, 404) : jsonResponse(ref("feature/a"));
    });
    await expect(deliveryClient(fetch as typeof globalThis.fetch).branchCreate({
      branch: "feature/a", baseSha: sha, idempotencyKey: `branch:${status}`,
    })).resolves.toEqual({ branch: "feature/a", sha, replayed: true });
    expect(posts).toBe(1);
  });

  it("conflicts concurrent branch requests that reuse a key with different requests", async () => {
    const fetch = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return jsonResponse({}, 404);
    });
    const github = deliveryClient(fetch as typeof globalThis.fetch);
    const first = github.branchCreate({ branch: "feature/a", baseSha: sha, idempotencyKey: "branch:same" });
    await expect(github.branchCreate({ branch: "feature/b", baseSha: sha, idempotencyKey: "branch:same" }))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(first).rejects.toMatchObject({ code: "UPSTREAM_ERROR", status: 404 });
  });

  it("puts contents with exact body, expected SHA, and a compact result", async () => {
    const desired = gitBlobSha(Buffer.from("hello\n"));
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const parsed = new URL(String(url));
      expect(parsed.pathname).toBe("/repos/Acme/widgets/contents/src/main.txt");
      if (init?.method === "PUT") {
        expect(JSON.parse(String(init.body))).toEqual({
          message: "Update main", content: "aGVsbG8K", branch: "feature/a", sha,
        });
        return jsonResponse({ content: { sha: desired }, commit: { sha: otherSha } }, 200);
      }
      expect(parsed.search).toBe("?ref=feature%2Fa");
      return jsonResponse({ type: "file", sha });
    });
    await expect(deliveryClient(fetch as typeof globalThis.fetch).contentsPut({
      path: "src/main.txt", branch: "feature/a", content: "hello\n", encoding: "utf8",
      message: "Update main", expectedSha: sha, idempotencyKey: "contents:1",
    })).resolves.toEqual({ path: "src/main.txt", branch: "feature/a", sha: desired, commitSha: otherSha, replayed: false });
  });

  it("checks desired blob replay before expected SHA and rejects stale writes", async () => {
    const desired = gitBlobSha(Buffer.from("hello"));
    const replay = deliveryClient(vi.fn(async () => jsonResponse({ type: "file", sha: desired })) as typeof globalThis.fetch);
    await expect(replay.contentsPut({ path: "a", branch: "main", content: "hello", message: "Update", expectedSha: null, idempotencyKey: "contents:replay" }))
      .resolves.toMatchObject({ sha: desired, replayed: true });
    const conflict = deliveryClient(vi.fn(async () => jsonResponse({ type: "file", sha })) as typeof globalThis.fetch);
    await expect(conflict.contentsPut({ path: "a", branch: "main", content: "different", message: "Update", expectedSha: null, idempotencyKey: "contents:conflict" }))
      .rejects.toMatchObject({ code: "STATE_CONFLICT" });
  });

  it("reconciles an ambiguous contents PUT", async () => {
    const desired = gitBlobSha(Buffer.from("hello"));
    let reads = 0;
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PUT") return jsonResponse({ message: "busy" }, 500);
      reads += 1;
      return reads === 1 ? jsonResponse({}, 404) : jsonResponse({ type: "file", sha: desired });
    });
    await expect(deliveryClient(fetch as typeof globalThis.fetch).contentsPut({
      path: "a", branch: "main", content: "hello", message: "Create", expectedSha: null, idempotencyKey: "contents:ambiguous",
    })).resolves.toEqual({ path: "a", branch: "main", sha: desired, replayed: true });
  });

  it("reconciles a null content successful PUT", async () => {
    const desired = gitBlobSha(Buffer.from("hello"));
    let reads = 0;
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PUT") return jsonResponse({ content: null, commit: { sha } }, 201);
      reads += 1;
      return reads === 1 ? jsonResponse({}, 404) : jsonResponse({ type: "file", sha: desired });
    });
    await expect(deliveryClient(fetch as typeof globalThis.fetch).contentsPut({
      path: "a", branch: "main", content: "hello", message: "Create", expectedSha: null, idempotencyKey: "contents:null",
    })).resolves.toEqual({ path: "a", branch: "main", sha: desired, replayed: true });
  });

  it("conflicts concurrent content requests that reuse a key with different requests", async () => {
    const fetch = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return jsonResponse({}, 404);
    });
    const github = deliveryClient(fetch as typeof globalThis.fetch);
    const first = github.contentsPut({ path: "a", branch: "main", content: "a", message: "A", expectedSha: null, idempotencyKey: "contents:same" });
    await expect(github.contentsPut({ path: "b", branch: "main", content: "b", message: "B", expectedSha: null, idempotencyKey: "contents:same" }))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(first).rejects.toMatchObject({ code: "UPSTREAM_ERROR", status: 404 });
  });

  it("serializes content writes on the same branch", async () => {
    let active = 0;
    let maximum = 0;
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method !== "PUT") return jsonResponse({}, 404);
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      const content = Buffer.from(JSON.parse(String(init.body)).content, "base64");
      return jsonResponse({ content: { sha: gitBlobSha(content) }, commit: { sha } }, 201);
    });
    const github = deliveryClient(fetch as typeof globalThis.fetch);
    await Promise.all([
      github.contentsPut({ path: "a", branch: "main", content: "a", message: "A", expectedSha: null, idempotencyKey: "contents:a" }),
      github.contentsPut({ path: "b", branch: "main", content: "b", message: "B", expectedSha: null, idempotencyKey: "contents:b" }),
    ]);
    expect(maximum).toBe(1);
  });

  it("creates a pull request with bounded newest filtering and repository-fixed refs", async () => {
    let postedBody = "";
    const pull = (body: string) => ({
      number: 12, html_url: "https://github.test/Acme/widgets/pull/12", state: "open", body,
      head: { ref: "feature/a", repo: { id: 42 } }, base: { ref: "main", repo: { id: 42 } },
    });
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const parsed = new URL(String(url));
      expect(parsed.pathname).toBe("/repos/Acme/widgets/pulls");
      if (init?.method === "POST") {
        const request = JSON.parse(String(init.body));
        expect(request).toMatchObject({ title: "Delivery", head: "feature/a", base: "main", draft: false });
        postedBody = request.body;
        return jsonResponse(pull(postedBody), 201);
      }
      expect(Object.fromEntries(parsed.searchParams)).toEqual({
        state: "all", head: "Acme:feature/a", base: "main", sort: "created", direction: "desc", per_page: "100", page: "1",
      });
      return jsonResponse([]);
    });
    await expect(deliveryClient(fetch as typeof globalThis.fetch).pullRequestCreate({
      head: "feature/a", base: "main", title: "Delivery", body: "Details", draft: false, idempotencyKey: "delivery:1",
    })).resolves.toEqual({ number: 12, url: "https://github.test/Acme/widgets/pull/12", state: "open", replayed: false });
    expect(postedBody).toMatch(/^Details\n\n<!-- agentbay-pr:[a-f0-9:]+ -->$/);
  });

  it("posts a maximum-size backslash pull request body without rejecting the escaped request", async () => {
    let posts = 0;
    const pull = (body: string) => ({
      number: 12, html_url: "https://github.test/Acme/widgets/pull/12", state: "open", body,
      head: { ref: "feature/a", repo: { id: 42 } }, base: { ref: "main", repo: { id: 42 } },
    });
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts += 1;
        return jsonResponse(pull(JSON.parse(String(init.body)).body), 201);
      }
      return jsonResponse([]);
    });
    const body = "\\".repeat(64 * 1024);

    await expect(deliveryClient(fetch as typeof globalThis.fetch).pullRequestCreate({
      head: "feature/a", base: "main", title: "Delivery", body, draft: false, idempotencyKey: "pr:max-backslashes",
    })).resolves.toEqual({ number: 12, url: "https://github.test/Acme/widgets/pull/12", state: "open", replayed: false });
    expect(posts).toBe(1);
  });

  it("reconciles an ambiguous PR POST and detects unrelated open PRs", async () => {
    let markerBody = "";
    let lists = 0;
    const makePull = (body: string) => ({
      number: 12, html_url: "url", state: "open", body,
      head: { ref: "feature/a", repo: { id: 42 } }, base: { ref: "main", repo: { id: 42 } },
    });
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        markerBody = JSON.parse(String(init.body)).body;
        return jsonResponse({}, 422);
      }
      lists += 1;
      return jsonResponse(lists === 1 ? [] : [makePull(markerBody)]);
    });
    const input = { head: "feature/a", base: "main", title: "Delivery", body: "Details", draft: true, idempotencyKey: "delivery:2" };
    await expect(deliveryClient(fetch as typeof globalThis.fetch).pullRequestCreate(input)).resolves.toMatchObject({ replayed: true });

    const unrelated = deliveryClient(vi.fn(async () => jsonResponse([makePull("unrelated")])) as typeof globalThis.fetch);
    await expect(unrelated.pullRequestCreate(input)).rejects.toMatchObject({ code: "STATE_CONFLICT" });
  });

  it("finds a pull request marker on page 2", async () => {
    let markerBody = "";
    let replay = false;
    const makePull = () => ({
      number: 12, html_url: "url", state: "open", body: markerBody,
      head: { ref: "feature/a", repo: { id: 42 } }, base: { ref: "main", repo: { id: 42 } },
    });
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        markerBody = JSON.parse(String(init.body)).body;
        return jsonResponse(makePull(), 201);
      }
      const page = new URL(String(url)).searchParams.get("page");
      if (!replay) return jsonResponse([]);
      if (page === "1") return jsonResponse([], 200, { link: '</repos/Acme/widgets/pulls?per_page=100&page=2>; rel="last"' });
      return jsonResponse([makePull()]);
    });
    const input = { head: "feature/a", base: "main", title: "Delivery", body: "Details", draft: false, idempotencyKey: "delivery:page2" };
    await expect(deliveryClient(fetch as typeof globalThis.fetch).pullRequestCreate(input)).resolves.toMatchObject({ replayed: false });
    replay = true;
    await expect(deliveryClient(fetch as typeof globalThis.fetch).pullRequestCreate(input)).resolves.toMatchObject({ replayed: true });
  });

  it("reconciles a malformed successful pull request response", async () => {
    let markerBody = "";
    let lists = 0;
    const pull = () => ({
      number: 12, html_url: "url", state: "open", body: markerBody,
      head: { ref: "feature/a", repo: { id: 42 } }, base: { ref: "main", repo: { id: 42 } },
    });
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        markerBody = JSON.parse(String(init.body)).body;
        return jsonResponse({}, 201);
      }
      lists += 1;
      return jsonResponse(lists === 1 ? [] : [pull()]);
    });
    await expect(deliveryClient(fetch as typeof globalThis.fetch).pullRequestCreate({
      head: "feature/a", base: "main", title: "Delivery", body: "Details", draft: false, idempotencyKey: "delivery:malformed",
    })).resolves.toMatchObject({ replayed: true });
  });
});
