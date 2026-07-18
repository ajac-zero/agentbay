import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  ACCEPT,
  API_VERSION,
  DEFAULT_API_BASE_URL,
  GitHubTokenManager,
  USER_AGENT,
  readJsonBounded,
} from "./auth.mjs";

const MAX_COMMENT_BYTES = 16 * 1024;
const MAX_REQUEST_BYTES = 32 * 1024;
const COMMENTS_PER_PAGE = 100;
const MAX_COMMENT_PAGES = 20;
const MARKER_PREFIX = "<!-- agentbay:";
const MARKER_PATTERN = /<!-- agentbay:([a-f0-9]{64}):([a-f0-9]{64}):([a-f0-9]{64}) -->(?![\s\S])/;
const MARKER_KEY_DOMAIN = "agentbay/github-comment-marker/v1";

export class GitHubApiError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
    this.code = code;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function markerMac(markerKey, connectionRef, keyHash, requestHash) {
  return createHmac("sha256", markerKey)
    .update(canonicalJson({ connectionRef, keyHash, requestHash }))
    .digest("hex");
}

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function assertPositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new GitHubApiError(`Invalid ${name}`, { code: "INVALID_ARGUMENT" });
}

function assertValidUtf8String(value, name) {
  if (typeof value !== "string" || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) {
    throw new GitHubApiError(`Invalid ${name}`, { code: "INVALID_ARGUMENT" });
  }
}

function lastPageFromLinkHeader(linkHeader, baseUrl) {
  if (linkHeader === null) return 1;
  let lastPage;
  const entries = [];
  let start = 0;
  let inTarget = false;
  let inQuotes = false;
  for (let index = 0; index < linkHeader.length; index += 1) {
    const character = linkHeader[index];
    if (character === "<" && !inQuotes) inTarget = true;
    else if (character === ">" && !inQuotes) inTarget = false;
    else if (character === '"' && !inTarget && linkHeader[index - 1] !== "\\") inQuotes = !inQuotes;
    else if (character === "," && !inTarget && !inQuotes) {
      entries.push(linkHeader.slice(start, index));
      start = index + 1;
    }
  }
  entries.push(linkHeader.slice(start));
  for (const entry of entries) {
    const hasLastRelation = /(?:^|;)\s*rel\s*=\s*(?:"[^"]*\blast\b[^"]*"|[^;,\s]*\blast\b[^;,\s]*)/i.test(entry);
    if (!hasLastRelation) continue;
    const match = entry.trim().match(/^<([^<>\s]+)>\s*(?:;.*)?$/);
    if (!match || lastPage !== undefined) {
      throw new GitHubApiError("GitHub returned an invalid comments Link header", { code: "INVALID_RESPONSE" });
    }
    let url;
    try {
      url = new URL(match[1], baseUrl);
    } catch {
      throw new GitHubApiError("GitHub returned an invalid comments Link header", { code: "INVALID_RESPONSE" });
    }
    const pages = url.searchParams.getAll("page");
    if (pages.length !== 1 || !/^\d+$/.test(pages[0])) {
      throw new GitHubApiError("GitHub returned an invalid comments Link header", { code: "INVALID_RESPONSE" });
    }
    lastPage = Number(pages[0]);
    if (!Number.isSafeInteger(lastPage) || lastPage <= 0) {
      throw new GitHubApiError("GitHub returned an invalid comments Link header", { code: "INVALID_RESPONSE" });
    }
  }
  return lastPage ?? 1;
}

export class GitHubClient {
  #owner;
  #repository;
  #repositoryId;
  #appId;
  #installationId;
  #connectionRef;
  #markerKey;
  #tokens;
  #fetch;
  #baseUrl;
  #singleflight = new Map();

  constructor({ owner, repository, repositoryId, appId, installationId, connectionRef, markerKey, tokenManager }, options = {}) {
    this.#owner = owner;
    this.#repository = repository;
    this.#repositoryId = repositoryId;
    this.#appId = appId;
    this.#installationId = installationId;
    this.#connectionRef = connectionRef;
    this.#markerKey = markerKey;
    this.#tokens = tokenManager;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#baseUrl = options.baseUrl ?? DEFAULT_API_BASE_URL;
  }

  #assertRepository(owner, repository) {
    if (owner !== this.#owner || repository !== this.#repository) {
      throw new GitHubApiError("Repository is outside the configured connection", { code: "REPOSITORY_NOT_ALLOWED" });
    }
  }

  async verifyStartup() {
    const installation = await this.#request(`/app/installations/${this.#installationId}`, {
      authorization: `Bearer ${this.#tokens.createAppJwt()}`,
      retry401: false,
    });
    if (installation?.app_id !== this.#appId || installation?.account?.login?.toLowerCase() !== this.#owner.toLowerCase()) {
      throw new GitHubApiError("GitHub App installation does not match configuration", { code: "INSTALLATION_MISMATCH" });
    }
    await this.#tokens.getToken();
    const repository = await this.#request(`/repositories/${this.#repositoryId}`);
    if (typeof repository?.full_name !== "string" || repository.full_name.toLowerCase() !== `${this.#owner}/${this.#repository}`.toLowerCase()) {
      throw new GitHubApiError("GitHub repository does not match configuration", { code: "REPOSITORY_MISMATCH" });
    }
  }

  async createIssueComment({ owner, repository, issueNumber, body, idempotencyKey }) {
    this.#assertRepository(owner, repository);
    assertPositiveInteger(issueNumber, "issue number");
    assertValidUtf8String(body, "comment body");
    if (body.includes(MARKER_PREFIX)) {
      throw new GitHubApiError("Comment body contains a reserved marker", { code: "INVALID_ARGUMENT" });
    }
    if (Buffer.byteLength(body, "utf8") > MAX_COMMENT_BYTES) {
      throw new GitHubApiError("Comment body exceeds 16 KiB", { code: "INVALID_ARGUMENT" });
    }
    if (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)) {
      throw new GitHubApiError("Invalid idempotency key", { code: "INVALID_ARGUMENT" });
    }

    const keyHash = sha256(idempotencyKey);
    const requestHash = sha256(canonicalJson({ body, issueNumber, owner, repository }));
    const existing = this.#singleflight.get(keyHash);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new GitHubApiError("Idempotency key was reused for a different request", { code: "IDEMPOTENCY_CONFLICT" });
      }
      return existing.promise;
    }
    const promise = this.#createIssueCommentIdempotently({ owner, repository, issueNumber, body, keyHash, requestHash })
      .finally(() => this.#singleflight.delete(keyHash));
    this.#singleflight.set(keyHash, { requestHash, promise });
    return promise;
  }

  async #createIssueCommentIdempotently(input) {
    const mac = markerMac(this.#markerKey, this.#connectionRef, input.keyHash, input.requestHash);
    const marker = `${MARKER_PREFIX}${input.keyHash}:${input.requestHash}:${mac} -->`;
    const commentsPath = `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/issues/${input.issueNumber}/comments`;
    const firstPage = await this.#request(`${commentsPath}?per_page=${COMMENTS_PER_PAGE}&page=1`, { returnResponse: true });
    if (!Array.isArray(firstPage.data) || firstPage.data.length > COMMENTS_PER_PAGE) {
      throw new GitHubApiError("GitHub returned invalid issue comments", { code: "INVALID_RESPONSE" });
    }
    const lastPage = lastPageFromLinkHeader(firstPage.headers.get("link"), this.#baseUrl);
    const oldestPage = Math.max(1, lastPage - MAX_COMMENT_PAGES + 1);
    for (let page = lastPage; page >= oldestPage; page -= 1) {
      const comments = page === 1
        ? firstPage.data
        : await this.#request(`${commentsPath}?per_page=${COMMENTS_PER_PAGE}&page=${page}`);
      if (!Array.isArray(comments) || comments.length > COMMENTS_PER_PAGE) {
        throw new GitHubApiError("GitHub returned invalid issue comments", { code: "INVALID_RESPONSE" });
      }
      for (const comment of comments) {
        if (typeof comment?.body !== "string") continue;
        const match = comment.body.match(MARKER_PATTERN);
        if (!match) continue;
        const expectedMac = markerMac(this.#markerKey, this.#connectionRef, match[1], match[2]);
        if (!timingSafeEqual(Buffer.from(match[3], "hex"), Buffer.from(expectedMac, "hex"))) continue;
        if (match[1] !== input.keyHash) continue;
        if (match[2] === input.requestHash) return { comment, replayed: true };
        throw new GitHubApiError("Idempotency key was reused for a different request", { code: "IDEMPOTENCY_CONFLICT" });
      }
    }
    const comment = await this.#request(
      commentsPath,
      { method: "POST", body: { body: `${input.body}\n\n${marker}` } },
    );
    return { comment, replayed: false };
  }

  async #request(path, { method = "GET", body, authorization, retry401 = true, returnResponse = false } = {}) {
    const encodedBody = body === undefined ? undefined : JSON.stringify(body);
    if (encodedBody !== undefined && Buffer.byteLength(encodedBody) > MAX_REQUEST_BYTES) {
      throw new GitHubApiError("GitHub request exceeded size limit", { code: "REQUEST_TOO_LARGE" });
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const auth = authorization ?? `Bearer ${await this.#tokens.getToken({ forceRefresh: attempt === 1 })}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      let response;
      try {
        response = await this.#fetch(`${this.#baseUrl}${path}`, {
          method,
          headers: {
            Accept: ACCEPT,
            Authorization: auth,
            ...(encodedBody === undefined ? {} : { "Content-Type": "application/json" }),
            "User-Agent": USER_AGENT,
            "X-GitHub-Api-Version": API_VERSION,
          },
          body: encodedBody,
          signal: controller.signal,
        });
      } catch {
        clearTimeout(timer);
        throw new GitHubApiError("GitHub request failed", { code: "UPSTREAM_FAILURE" });
      }
      let data;
      try {
        data = await readJsonBounded(response);
      } catch (error) {
        throw new GitHubApiError(controller.signal.aborted ? "GitHub request timed out" : error instanceof Error ? error.message : "Invalid GitHub response", {
          status: response.status,
          code: "INVALID_RESPONSE",
        });
      } finally {
        clearTimeout(timer);
      }
      if (response.status === 401 && retry401 && authorization === undefined && attempt === 0) {
        this.#tokens.invalidate();
        continue;
      }
      if (!response.ok) {
        throw new GitHubApiError(`GitHub request failed with status ${response.status}`, {
          status: response.status,
          code: "UPSTREAM_ERROR",
        });
      }
      return returnResponse ? { data, headers: response.headers } : data;
    }
    throw new GitHubApiError("GitHub authentication failed", { status: 401, code: "UPSTREAM_ERROR" });
  }
}

export function createGitHubCore(config, credentials, options = {}) {
  const tokenManager = new GitHubTokenManager(
    { ...credentials, repositoryId: config.repositoryId },
    { fetch: options.fetch, now: options.now, baseUrl: options.baseUrl },
  );
  const markerKey = createHmac("sha256", credentials.privateKey).update(MARKER_KEY_DOMAIN).digest();
  return new GitHubClient(
    { ...config, ...credentials, markerKey, tokenManager },
    { fetch: options.fetch, now: options.now, baseUrl: options.baseUrl },
  );
}
