import { createSign, createPrivateKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ClaimedRevisionResolution } from "./types.js";

const API_VERSION = "2022-11-28";

export type GitHubAppRevisionResolverOptions = {
  appIdFile: string;
  privateKeyFile: string;
  apiBaseUrl?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  readFile?: (path: string, encoding: "utf8") => Promise<string>;
};

export class GitHubAppRevisionResolver {
  constructor(private readonly options: GitHubAppRevisionResolverOptions) {}

  async resolve(request: ClaimedRevisionResolution, signal?: AbortSignal): Promise<string> {
    const credentials = await readCredentials(this.options.appIdFile, this.options.privateKeyFile, this.options.readFile ?? readFile);
    const fetch = this.options.fetch ?? globalThis.fetch;
    const apiBaseUrl = this.options.apiBaseUrl ?? "https://api.github.com";
    const headers = {
      Accept: "application/vnd.github+json",
      "User-Agent": "agentbay-revision-resolver/1.0",
      "X-GitHub-Api-Version": API_VERSION,
    };
    const tokenResponse = await fetch(`${apiBaseUrl}/app/installations/${request.installationId}/access_tokens`, {
      method: "POST",
      headers: { ...headers, Authorization: `Bearer ${appJwt(credentials, this.options.now ?? Date.now)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ repository_ids: [request.repositoryId], permissions: { contents: "read" } }),
      redirect: "error",
      signal,
    });
    const tokenData = await responseJson(tokenResponse);
    const expiresAt = Date.parse(tokenData.expires_at);
    if (!tokenResponse.ok || typeof tokenData.token !== "string" || !tokenData.token.startsWith("ghs_")
      || !Number.isFinite(expiresAt) || expiresAt <= (this.options.now ?? Date.now)()) {
      throw new Error(`GitHub installation token request failed with status ${tokenResponse.status}`);
    }
    if (!Array.isArray(tokenData.repositories) || tokenData.repositories.length !== 1 || tokenData.repositories[0]?.id !== request.repositoryId) {
      throw new Error("GitHub installation token repository scope mismatch");
    }
    if (tokenData.repository_selection !== undefined && tokenData.repository_selection !== "selected") {
      throw new Error("GitHub installation token repository selection mismatch");
    }
    if (tokenData.permissions?.contents !== "read"
      || Object.entries(tokenData.permissions ?? {}).some(([name, access]) => name !== "contents" && !(name === "metadata" && access === "read"))) {
      throw new Error("GitHub installation token permissions mismatch");
    }

    const authorization = { ...headers, Authorization: `Bearer ${tokenData.token}` };
    const repositoryResponse = await fetch(`${apiBaseUrl}/repositories/${request.repositoryId}`, {
      headers: authorization,
      redirect: "error",
      signal,
    });
    const repository = await responseJson(repositoryResponse);
    if (!repositoryResponse.ok) throw new Error(`GitHub repository request failed with status ${repositoryResponse.status}`);
    if (repository.id !== request.repositoryId || repository.full_name !== request.repositoryFullName
      || repository.default_branch !== request.branch || repository.clone_url !== request.cloneUrl) {
      throw new Error("GitHub repository identity or default branch changed");
    }

    const encodedBranch = request.branch.split("/").map(encodeURIComponent).join("/");
    const refResponse = await fetch(`${apiBaseUrl}/repos/${request.repositoryFullName}/git/ref/heads/${encodedBranch}`, {
      headers: authorization,
      redirect: "error",
      signal,
    });
    const ref = await responseJson(refResponse);
    if (!refResponse.ok) throw new Error(`GitHub branch request failed with status ${refResponse.status}`);
    if (ref.object?.type !== "commit" || typeof ref.object.sha !== "string" || !/^[0-9a-fA-F]{40}$/.test(ref.object.sha)) {
      throw new Error("GitHub returned an invalid default branch commit");
    }
    return ref.object.sha.toLowerCase();
  }
}

async function readCredentials(
  appIdFile: string,
  privateKeyFile: string,
  read: (path: string, encoding: "utf8") => Promise<string>,
): Promise<{ appId: number; privateKey: string }> {
  const [appIdValue, privateKey] = await Promise.all([read(appIdFile, "utf8"), read(privateKeyFile, "utf8")]);
  const appId = Number(appIdValue.trim());
  if (!Number.isSafeInteger(appId) || appId < 1) throw new Error("Invalid GitHub App ID credential");
  if (createPrivateKey(privateKey).asymmetricKeyType !== "rsa") throw new Error("Invalid GitHub App private key credential");
  return { appId, privateKey };
}

function appJwt(credentials: { appId: number; privateKey: string }, now: () => number): string {
  const seconds = Math.floor(now() / 1_000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: seconds - 60, exp: seconds + 540, iss: credentials.appId })}`;
  const signer = createSign("RSA-SHA256");
  signer.end(unsigned);
  return `${unsigned}.${signer.sign(credentials.privateKey, "base64url")}`;
}

async function responseJson(response: Response): Promise<Record<string, any>> {
  const limit = 2 * 1_024 * 1_024;
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > limit) throw new Error("GitHub response exceeded size limit");
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = response.body?.getReader();
  if (!reader) throw new Error("GitHub returned an empty response");
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel();
      throw new Error("GitHub response exceeded size limit");
    }
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks, length);
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new Error("GitHub returned invalid JSON");
  }
}
