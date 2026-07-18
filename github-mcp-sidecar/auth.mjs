import { createSign } from "node:crypto";

const DEFAULT_API_BASE_URL = "https://api.github.com";
const ACCEPT = "application/vnd.github+json";
const API_VERSION = "2022-11-28";
const USER_AGENT = "agentbay-github-mcp-sidecar/1.0";

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

export function createGitHubAppJwt({ appId, privateKey, now = () => Date.now() }) {
  const nowSeconds = Math.floor(now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId }));
  const unsigned = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(privateKey, "base64url")}`;
}

async function readJsonBounded(response, maximumBytes = 2 * 1024 * 1024) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) throw new Error("GitHub response exceeded size limit");
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel();
      throw new Error("GitHub response exceeded size limit");
    }
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks, length);
  if (bytes.length === 0) return null;
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("GitHub returned invalid JSON");
  }
}

export class GitHubTokenManager {
  #appId;
  #installationId;
  #privateKey;
  #repositoryId;
  #fetch;
  #now;
  #baseUrl;
  #token;
  #expiresAt = 0;
  #refreshPromise;

  constructor({ appId, installationId, privateKey, repositoryId }, options = {}) {
    this.#appId = appId;
    this.#installationId = installationId;
    this.#privateKey = privateKey;
    this.#repositoryId = repositoryId;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => Date.now());
    this.#baseUrl = options.baseUrl ?? DEFAULT_API_BASE_URL;
  }

  createAppJwt() {
    return createGitHubAppJwt({ appId: this.#appId, privateKey: this.#privateKey, now: this.#now });
  }

  async getToken({ forceRefresh = false } = {}) {
    if (!forceRefresh && this.#token && this.#expiresAt - this.#now() > 5 * 60 * 1000) return this.#token;
    if (!this.#refreshPromise) {
      this.#refreshPromise = this.#mintToken().finally(() => {
        this.#refreshPromise = undefined;
      });
    }
    return this.#refreshPromise;
  }

  invalidate() {
    this.#token = undefined;
    this.#expiresAt = 0;
  }

  async #mintToken() {
    const body = JSON.stringify({
      repository_ids: [this.#repositoryId],
      permissions: { contents: "write", pull_requests: "write", issues: "write" },
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/app/installations/${this.#installationId}/access_tokens`, {
        method: "POST",
        headers: {
          Accept: ACCEPT,
          Authorization: `Bearer ${this.createAppJwt()}`,
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
          "X-GitHub-Api-Version": API_VERSION,
        },
        body,
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timer);
      throw new Error("GitHub token request failed");
    }
    let data;
    try {
      data = await readJsonBounded(response);
    } catch (error) {
      if (controller.signal.aborted) throw new Error("GitHub token request timed out");
      throw error;
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw new Error(`GitHub token request failed with status ${response.status}`);
    const expiresAt = typeof data?.expires_at === "string" ? Date.parse(data.expires_at) : NaN;
    if (typeof data?.token !== "string" || data.token.length === 0 || !Number.isFinite(expiresAt) || expiresAt <= this.#now()) {
      throw new Error("GitHub returned an invalid installation token");
    }
    if (
      !Array.isArray(data.repositories) ||
      data.repositories.length !== 1 ||
      data.repositories[0]?.id !== this.#repositoryId
    ) {
      throw new Error("GitHub installation token repository scope mismatch");
    }
    if (Object.hasOwn(data, "repository_selection") && data.repository_selection !== "selected") {
      throw new Error("GitHub installation token repository selection mismatch");
    }
    const permissions = data.permissions;
    if (permissions === null || typeof permissions !== "object" || Array.isArray(permissions)) {
      throw new Error("GitHub installation token permissions mismatch");
    }
    const permissionKeys = Object.keys(permissions);
    if (
      permissions.contents !== "write" ||
      permissions.pull_requests !== "write" ||
      permissions.issues !== "write" ||
      permissionKeys.some((key) => !["contents", "pull_requests", "issues", "metadata"].includes(key)) ||
      (Object.hasOwn(permissions, "metadata") && permissions.metadata !== "read")
    ) {
      throw new Error("GitHub installation token permissions mismatch");
    }
    this.#token = data.token;
    this.#expiresAt = expiresAt;
    return this.#token;
  }
}

export { ACCEPT, API_VERSION, DEFAULT_API_BASE_URL, USER_AGENT, readJsonBounded };
