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
const MAX_COMMENT_REQUEST_BYTES = 128 * 1024;
const MAX_CONTENT_REQUEST_BYTES = 384 * 1024;
const MAX_PR_REQUEST_BYTES = 512 * 1024;
const MAX_CONTENT_BYTES = 256 * 1024;
const MAX_CONTENT_PATH_BYTES = 1024;
const MAX_BRANCH_BYTES = 255;
const MAX_COMMIT_MESSAGE_BYTES = 1024;
const MAX_PR_TITLE_BYTES = 256;
const MAX_PR_BODY_BYTES = 64 * 1024;
const COMMENTS_PER_PAGE = 100;
const MAX_COMMENT_PAGES = 20;
const PULLS_PER_PAGE = 100;
const MAX_PULL_PAGES = 10;
const MARKER_PREFIX = "<!-- agentbay:";
const MARKER_PATTERN = /<!-- agentbay:([a-f0-9]{64}):([a-f0-9]{64}):([a-f0-9]{64}) -->(?![\s\S])/;
const PR_MARKER_PREFIX = "<!-- agentbay-pr:";
const PR_MARKER_PATTERN = /<!-- agentbay-pr:([a-f0-9]{64}):([a-f0-9]{64}):([a-f0-9]{64}) -->(?![\s\S])/;
const MARKER_KEY_DOMAIN = "agentbay/github-comment-marker/v1";
const PR_MARKER_KEY_DOMAIN = "agentbay/github-pull-request-marker/v1";
const SHA40 = /^[a-f0-9]{40}$/;

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

function prMarkerMac(markerKey, connectionRef, keyHash, requestHash) {
  return createHmac("sha256", markerKey)
    .update(PR_MARKER_KEY_DOMAIN)
    .update("\0")
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

function assertIdempotencyKey(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new GitHubApiError("Invalid idempotency key", { code: "INVALID_ARGUMENT" });
  }
}

function assertValidUtf8String(value, name) {
  if (typeof value !== "string" || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) {
    throw new GitHubApiError(`Invalid ${name}`, { code: "INVALID_ARGUMENT" });
  }
}

function invalidArgument(message) {
  throw new GitHubApiError(message, { code: "INVALID_ARGUMENT" });
}

function assertByteLimit(value, maximum, name) {
  assertValidUtf8String(value, name);
  if (Buffer.byteLength(value, "utf8") > maximum) invalidArgument(`Invalid ${name}`);
}

export function validateBranchRef(value, name = "branch") {
  assertByteLimit(value, MAX_BRANCH_BYTES, name);
  if (
    value.length === 0 || value === "@" || value.startsWith("/") || value.endsWith("/") ||
    value.startsWith(".") || value.endsWith(".") || value.includes("//") || value.includes("..") ||
    value.includes("@{") || /[\u0000-\u0020\u007f~^:?*[\\]/.test(value) ||
    value.split("/").some((part) => part.length === 0 || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"))
  ) invalidArgument(`Invalid ${name}`);
  return value;
}

export function validateSha40(value, name = "SHA") {
  if (typeof value !== "string" || !SHA40.test(value)) invalidArgument(`Invalid ${name}`);
  return value;
}

export function validateContentsPath(value) {
  assertByteLimit(value, MAX_CONTENT_PATH_BYTES, "contents path");
  const parts = value.split("/");
  if (
    value.length === 0 || value.startsWith("/") || value.endsWith("/") || value.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(value) || parts.some((part) => part === "" || part === "." || part === "..")
  ) invalidArgument("Invalid contents path");
  if (parts.length >= 2 && parts[0].toLowerCase() === ".github" && parts[1].toLowerCase() === "workflows") {
    invalidArgument("GitHub workflow paths are not allowed");
  }
  return value;
}

export function decodeContent(content, encoding = "utf8") {
  assertValidUtf8String(content, "content");
  let bytes;
  if (encoding === "utf8") {
    bytes = Buffer.from(content, "utf8");
  } else if (encoding === "base64") {
    if (content.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)) {
      invalidArgument("Invalid base64 content");
    }
    bytes = Buffer.from(content, "base64");
    if (bytes.toString("base64") !== content) invalidArgument("Invalid base64 content");
  } else {
    invalidArgument("Invalid content encoding");
  }
  if (bytes.length > MAX_CONTENT_BYTES) invalidArgument("Content exceeds 256 KiB");
  return bytes;
}

export function gitBlobSha(content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function encodePath(value) {
  return value.split("/").map(encodeURIComponent).join("/");
}

function compactPull(pull, replayed) {
  return { number: pull.number, url: pull.html_url, state: pull.state, replayed };
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
  #branchWrites = new Map();

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
    assertIdempotencyKey(idempotencyKey);

    const keyHash = sha256(idempotencyKey);
    const requestHash = sha256(canonicalJson({ body, issueNumber, owner, repository }));
    const flightKey = `comment:${keyHash}`;
    const existing = this.#singleflight.get(flightKey);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new GitHubApiError("Idempotency key was reused for a different request", { code: "IDEMPOTENCY_CONFLICT" });
      }
      return existing.promise;
    }
    const promise = this.#createIssueCommentIdempotently({ owner, repository, issueNumber, body, keyHash, requestHash })
      .finally(() => this.#singleflight.delete(flightKey));
    this.#singleflight.set(flightKey, { requestHash, promise });
    return promise;
  }

  #runSingleflight(operation, key, request, callback) {
    const flightKey = `${operation}:${key}`;
    const requestHash = sha256(canonicalJson(request));
    const existing = this.#singleflight.get(flightKey);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new GitHubApiError("Operation key was reused for a different request", { code: "IDEMPOTENCY_CONFLICT" });
      }
      return existing.promise;
    }
    const promise = Promise.resolve().then(callback).finally(() => this.#singleflight.delete(flightKey));
    this.#singleflight.set(flightKey, { requestHash, promise });
    return promise;
  }

  async branchCreate({ branch, baseSha, idempotencyKey }) {
    validateBranchRef(branch);
    validateSha40(baseSha, "base SHA");
    assertIdempotencyKey(idempotencyKey);
    const keyHash = sha256(idempotencyKey);
    return this.#runSingleflight("branch", keyHash, { branch, baseSha }, () => this.#branchCreate(branch, baseSha));
  }

  async #branchCreate(branch, sha) {
    const refPath = `/repos/${encodeURIComponent(this.#owner)}/${encodeURIComponent(this.#repository)}/git/ref/heads/${encodePath(branch)}`;
    const current = await this.#request(refPath, { exposeStatus: true, allowedStatuses: [404], expectedStatuses: [200] });
    if (current.status !== 404) return this.#branchResult(current.data, branch, sha, true);
    try {
      const created = await this.#request(
        `/repos/${encodeURIComponent(this.#owner)}/${encodeURIComponent(this.#repository)}/git/refs`,
        {
          method: "POST", body: { ref: `refs/heads/${branch}`, sha }, retry401: false,
          returnResponse: true, expectedStatuses: [201],
        },
      );
      return this.#branchResult(created.data, branch, sha, false, created.status);
    } catch (error) {
      if (!this.#ambiguousWrite(error)) throw error;
      const reconciled = await this.#request(refPath, { exposeStatus: true, allowedStatuses: [404], expectedStatuses: [200] });
      if (reconciled.status !== 404) return this.#branchResult(reconciled.data, branch, sha, true);
      throw error;
    }
  }

  #branchResult(value, branch, sha, replayed, status) {
    if (value?.ref !== `refs/heads/${branch}` || value?.object?.type !== "commit" || !SHA40.test(value?.object?.sha)) {
      throw new GitHubApiError("GitHub returned an invalid branch", { status, code: "INVALID_RESPONSE" });
    }
    if (value.object.sha !== sha) throw new GitHubApiError("Branch already exists at a different commit", { code: "STATE_CONFLICT" });
    return { branch, sha, replayed };
  }

  async contentsPut(input) {
    const value = input ?? {};
    const { path, branch, content, encoding = "utf8", message, expectedSha, idempotencyKey } = value;
    validateContentsPath(path);
    validateBranchRef(branch);
    assertByteLimit(message, MAX_COMMIT_MESSAGE_BYTES, "commit message");
    if (message.length === 0 || /[\u0000-\u001f\u007f]/.test(message)) invalidArgument("Invalid commit message");
    if (!Object.hasOwn(value, "expectedSha") || (expectedSha !== null && !SHA40.test(expectedSha))) invalidArgument("Invalid expected SHA");
    assertIdempotencyKey(idempotencyKey);
    const bytes = decodeContent(content, encoding);
    const desiredSha = gitBlobSha(bytes);
    const request = { path, branch, desiredSha, message, expectedSha };
    return this.#runSingleflight("contents", sha256(idempotencyKey), request, () => {
      const previous = this.#branchWrites.get(branch) ?? Promise.resolve();
      const operation = previous.catch(() => {}).then(() => this.#contentsPut({ path, branch, bytes, message, expectedSha, desiredSha }));
      this.#branchWrites.set(branch, operation);
      return operation.finally(() => {
        if (this.#branchWrites.get(branch) === operation) this.#branchWrites.delete(branch);
      });
    });
  }

  async #getContents(path, branch) {
    const result = await this.#request(
      `/repos/${encodeURIComponent(this.#owner)}/${encodeURIComponent(this.#repository)}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`,
      { exposeStatus: true, allowedStatuses: [404], expectedStatuses: [200] },
    );
    if (result.status === 404) return null;
    if (Array.isArray(result.data) || result.data?.type !== "file" || !SHA40.test(result.data?.sha)) {
      throw new GitHubApiError("GitHub returned invalid contents", { code: "INVALID_RESPONSE" });
    }
    return result.data;
  }

  async #contentsPut({ path, branch, bytes, message, expectedSha, desiredSha }) {
    const current = await this.#getContents(path, branch);
    if (current?.sha === desiredSha) return { path, branch, sha: desiredSha, replayed: true };
    if ((current?.sha ?? null) !== expectedSha) throw new GitHubApiError("Contents changed from the expected SHA", { code: "STATE_CONFLICT" });
    const contentsPath = `/repos/${encodeURIComponent(this.#owner)}/${encodeURIComponent(this.#repository)}/contents/${encodePath(path)}`;
    const body = { message, content: bytes.toString("base64"), branch, ...(expectedSha === null ? {} : { sha: expectedSha }) };
    try {
      const response = await this.#request(contentsPath, {
        method: "PUT", body, maximumRequestBytes: MAX_CONTENT_REQUEST_BYTES, retry401: false,
        returnResponse: true, expectedStatuses: [expectedSha === null ? 201 : 200],
      });
      const result = response.data;
      if (result?.content === null || !SHA40.test(result?.content?.sha) || result.content.sha !== desiredSha || !SHA40.test(result?.commit?.sha)) {
        throw new GitHubApiError("GitHub returned invalid updated contents", { status: response.status, code: "INVALID_RESPONSE" });
      }
      return { path, branch, sha: desiredSha, commitSha: result.commit.sha, replayed: false };
    } catch (error) {
      if (!this.#ambiguousWrite(error)) throw error;
      const reconciled = await this.#getContents(path, branch);
      if (reconciled?.sha === desiredSha) return { path, branch, sha: desiredSha, replayed: true };
      throw error;
    }
  }

  async pullRequestCreate({ head, base, title, body, draft, idempotencyKey }) {
    validateBranchRef(head, "head branch");
    validateBranchRef(base, "base branch");
    assertByteLimit(title, MAX_PR_TITLE_BYTES, "pull request title");
    assertByteLimit(body, MAX_PR_BODY_BYTES, "pull request body");
    if (title.length === 0 || /[\u0000-\u001f\u007f]/.test(title) || body.includes(PR_MARKER_PREFIX)) invalidArgument("Invalid pull request");
    if (typeof draft !== "boolean") invalidArgument("Invalid draft value");
    assertIdempotencyKey(idempotencyKey);
    const request = { head, base, title, body, draft };
    return this.#runSingleflight("pull-request", sha256(idempotencyKey), request, () => this.#pullRequestCreate({ ...request, idempotencyKey }));
  }

  async #pullRequestCreate(input) {
    const keyHash = sha256(input.idempotencyKey);
    const requestHash = sha256(canonicalJson({ owner: this.#owner, repository: this.#repository, head: input.head, base: input.base, title: input.title, body: input.body, draft: input.draft }));
    const marker = `${PR_MARKER_PREFIX}${keyHash}:${requestHash}:${prMarkerMac(this.#markerKey, this.#connectionRef, keyHash, requestHash)} -->`;
    const pullsPath = `/repos/${encodeURIComponent(this.#owner)}/${encodeURIComponent(this.#repository)}/pulls`;
    const find = async () => {
      const query = new URLSearchParams({ state: "all", head: `${this.#owner}:${input.head}`, base: input.base, sort: "created", direction: "desc", per_page: String(PULLS_PER_PAGE), page: "1" });
      const firstPage = await this.#request(`${pullsPath}?${query}`, { returnResponse: true, expectedStatuses: [200] });
      const lastPage = lastPageFromLinkHeader(firstPage.headers.get("link"), this.#baseUrl);
      const newestPages = Math.min(lastPage, MAX_PULL_PAGES);
      let openConflict = false;
      for (let page = 1; page <= newestPages; page += 1) {
        query.set("page", String(page));
        const pulls = page === 1 ? firstPage.data : await this.#request(`${pullsPath}?${query}`, { expectedStatuses: [200] });
        if (!Array.isArray(pulls) || pulls.length > PULLS_PER_PAGE) throw new GitHubApiError("GitHub returned invalid pull requests", { code: "INVALID_RESPONSE" });
        for (const pull of pulls) {
          if (!this.#sameRepositoryPull(pull, input.head, input.base)) throw new GitHubApiError("GitHub returned an unrelated pull request", { code: "INVALID_RESPONSE" });
          const match = typeof pull.body === "string" ? pull.body.match(PR_MARKER_PATTERN) : null;
          if (match) {
            const expectedMac = prMarkerMac(this.#markerKey, this.#connectionRef, match[1], match[2]);
            if (timingSafeEqual(Buffer.from(match[3], "hex"), Buffer.from(expectedMac, "hex")) && match[1] === keyHash) {
              if (match[2] !== requestHash) throw new GitHubApiError("Idempotency key was reused for a different request", { code: "IDEMPOTENCY_CONFLICT" });
              return compactPull(pull, true);
            }
          }
          if (pull.state === "open") openConflict = true;
        }
      }
      if (openConflict) throw new GitHubApiError("An unrelated open pull request already uses this head and base", { code: "STATE_CONFLICT" });
      return null;
    };
    const existing = await find();
    if (existing) return existing;
    try {
      const response = await this.#request(pullsPath, {
        method: "POST",
        body: { title: input.title, head: input.head, base: input.base, body: `${input.body}\n\n${marker}`, draft: input.draft },
        maximumRequestBytes: MAX_PR_REQUEST_BYTES,
        retry401: false,
        returnResponse: true,
        expectedStatuses: [201],
      });
      const pull = response.data;
      if (!this.#sameRepositoryPull(pull, input.head, input.base) || pull.state !== "open" || pull.body !== `${input.body}\n\n${marker}`) {
        throw new GitHubApiError("GitHub returned an invalid pull request", { status: response.status, code: "INVALID_RESPONSE" });
      }
      return compactPull(pull, false);
    } catch (error) {
      if (!this.#ambiguousWrite(error)) throw error;
      const reconciled = await find();
      if (reconciled) return reconciled;
      throw error;
    }
  }

  #sameRepositoryPull(pull, head, base) {
    return Number.isSafeInteger(pull?.number) && pull.number > 0 && typeof pull?.html_url === "string" &&
      (pull?.state === "open" || pull?.state === "closed") && pull?.head?.ref === head && pull?.base?.ref === base &&
      pull?.head?.repo?.id === this.#repositoryId && pull?.base?.repo?.id === this.#repositoryId;
  }

  #ambiguousWrite(error) {
    return error instanceof GitHubApiError && (
      error.code === "UPSTREAM_FAILURE" || error.status === 401 || error.status === 409 || error.status === 422 || error.status >= 500 ||
      (error.code === "INVALID_RESPONSE" && (error.status === undefined || (error.status >= 200 && error.status < 300)))
    );
  }

  async #createIssueCommentIdempotently(input) {
    const mac = markerMac(this.#markerKey, this.#connectionRef, input.keyHash, input.requestHash);
    const marker = `${MARKER_PREFIX}${input.keyHash}:${input.requestHash}:${mac} -->`;
    const commentsPath = `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/issues/${input.issueNumber}/comments`;
    const find = async () => {
      const firstPage = await this.#request(`${commentsPath}?per_page=${COMMENTS_PER_PAGE}&page=1`, { returnResponse: true, expectedStatuses: [200] });
      if (!Array.isArray(firstPage.data) || firstPage.data.length > COMMENTS_PER_PAGE) {
        throw new GitHubApiError("GitHub returned invalid issue comments", { code: "INVALID_RESPONSE" });
      }
      const lastPage = lastPageFromLinkHeader(firstPage.headers.get("link"), this.#baseUrl);
      const oldestPage = Math.max(1, lastPage - MAX_COMMENT_PAGES + 1);
      for (let page = lastPage; page >= oldestPage; page -= 1) {
        const comments = page === 1
          ? firstPage.data
          : await this.#request(`${commentsPath}?per_page=${COMMENTS_PER_PAGE}&page=${page}`, { expectedStatuses: [200] });
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
      return null;
    };
    const existing = await find();
    if (existing) return existing;
    const postedBody = `${input.body}\n\n${marker}`;
    try {
      const response = await this.#request(commentsPath, {
        method: "POST", body: { body: postedBody }, retry401: false, returnResponse: true,
        expectedStatuses: [201], maximumRequestBytes: MAX_COMMENT_REQUEST_BYTES,
      });
      const comment = response.data;
      if (!Number.isSafeInteger(comment?.id) || comment.id <= 0 || comment?.body !== postedBody) {
        throw new GitHubApiError("GitHub returned an invalid issue comment", { status: response.status, code: "INVALID_RESPONSE" });
      }
      return { comment, replayed: false };
    } catch (error) {
      if (!this.#ambiguousWrite(error)) throw error;
      const reconciled = await find();
      if (reconciled) return reconciled;
      throw error;
    }
  }

  async #request(path, {
    method = "GET", body, authorization, retry401 = true, returnResponse = false,
    exposeStatus = false, allowedStatuses = [], expectedStatuses, maximumRequestBytes = MAX_REQUEST_BYTES,
  } = {}) {
    const encodedBody = body === undefined ? undefined : JSON.stringify(body);
    if (encodedBody !== undefined && Buffer.byteLength(encodedBody) > maximumRequestBytes) {
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
      if (!response.ok && !allowedStatuses.includes(response.status)) {
        throw new GitHubApiError(`GitHub request failed with status ${response.status}`, {
          status: response.status,
          code: "UPSTREAM_ERROR",
        });
      }
      if (response.ok && expectedStatuses !== undefined && !expectedStatuses.includes(response.status)) {
        throw new GitHubApiError(`GitHub returned unexpected status ${response.status}`, {
          status: response.status,
          code: "INVALID_RESPONSE",
        });
      }
      if (returnResponse) return { data, headers: response.headers, status: response.status };
      return exposeStatus ? { data, status: response.status, notFound: response.status === 404 } : data;
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
