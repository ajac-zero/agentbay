import { createSign } from "node:crypto";

const API_VERSION = "2022-11-28";

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

export function createGitHubAppJwt({ appId, privateKey, now = Date.now }) {
  const seconds = Math.floor(now() / 1000);
  const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: appId }))}`;
  const signer = createSign("RSA-SHA256");
  signer.end(unsigned);
  return `${unsigned}.${signer.sign(privateKey, "base64url")}`;
}

async function boundedJson(response, limit = 2 * 1024 * 1024) {
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > limit) throw new Error("GitHub response exceeded size limit");
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("GitHub returned invalid JSON");
  }
}

export class InstallationTokenProvider {
  #token;
  #expiresAt = 0;
  #refresh;

  constructor(config, readCredentials, options = {}) {
    this.config = config;
    this.readCredentials = typeof readCredentials === "function" ? readCredentials : async () => readCredentials;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.apiBaseUrl = options.apiBaseUrl ?? "https://api.github.com";
  }

  invalidate(token) {
    if (token === undefined || token === this.#token) {
      this.#token = undefined;
      this.#expiresAt = 0;
    }
  }

  async getToken({ forceRefresh = false } = {}) {
    if (!forceRefresh && this.#token && this.#expiresAt - this.now() > 5 * 60_000) return this.#token;
    this.#refresh ??= this.#mint().finally(() => { this.#refresh = undefined; });
    return this.#refresh;
  }

  async #mint() {
    const credentials = await this.readCredentials();
    const response = await this.fetch(`${this.apiBaseUrl}/app/installations/${credentials.installationId}/access_tokens`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${createGitHubAppJwt({ ...credentials, now: this.now })}`,
        "Content-Type": "application/json",
        "User-Agent": "agentbay-github-token-broker/1.0",
        "X-GitHub-Api-Version": API_VERSION,
      },
      body: JSON.stringify({ repository_ids: [this.config.repositoryId], permissions: this.config.permissions }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await boundedJson(response);
    if (!response.ok) throw new Error(`GitHub token request failed with status ${response.status}`);
    const expiresAt = Date.parse(data?.expires_at);
    if (typeof data?.token !== "string" || !data.token.startsWith("ghs_") || !Number.isFinite(expiresAt) || expiresAt <= this.now()) {
      throw new Error("GitHub returned an invalid installation token");
    }
    if (!Array.isArray(data.repositories) || data.repositories.length !== 1 || data.repositories[0]?.id !== this.config.repositoryId) {
      throw new Error("GitHub installation token repository scope mismatch");
    }
    if (data.repository_selection !== undefined && data.repository_selection !== "selected") {
      throw new Error("GitHub installation token repository selection mismatch");
    }
    const actual = data.permissions;
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) throw new Error("GitHub installation token permissions mismatch");
    for (const [name, access] of Object.entries(this.config.permissions)) {
      if (actual[name] !== access) throw new Error("GitHub installation token permissions mismatch");
    }
    const allowed = new Set([...Object.keys(this.config.permissions), "metadata"]);
    if (Object.keys(actual).some((name) => !allowed.has(name)) || (actual.metadata !== undefined && actual.metadata !== "read")) {
      throw new Error("GitHub installation token permissions mismatch");
    }
    this.#token = data.token;
    this.#expiresAt = expiresAt;
    return this.#token;
  }
}
