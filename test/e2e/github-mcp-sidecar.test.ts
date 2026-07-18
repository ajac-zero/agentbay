import { generateKeyPairSync, verify, type KeyObject } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error The sidecar intentionally ships as dependency-free Node ESM.
import { parseStartupConfig, readGitHubAppCredentials } from "../../github-mcp-sidecar/config.mjs";
// @ts-expect-error The sidecar intentionally ships as dependency-free Node ESM.
import { createGitHubCore } from "../../github-mcp-sidecar/github.mjs";
// @ts-expect-error The sidecar intentionally ships as dependency-free Node ESM.
import { startServer } from "../../github-mcp-sidecar/server.mjs";

type RunningServer = { server: http.Server; close: () => Promise<void> };

const APP_ID = 731;
const INSTALLATION_ID = 947;
const REPOSITORY_ID = 1201;
const INSTALLATION_TOKEN = "installation-token-that-must-not-leak";
const PROTOCOL_VERSION = "2025-11-25";
const running: RunningServer[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((entry) => entry.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

async function listen(server: http.Server) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function closeServer(server: http.Server) {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function readJson(request: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response: http.ServerResponse, status: number, value: unknown) {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

function verifyAppJwt(authorization: string | undefined, publicKey: KeyObject) {
  expect(authorization).toMatch(/^Bearer /);
  const jwt = authorization!.slice("Bearer ".length);
  const parts = jwt.split(".");
  expect(parts).toHaveLength(3);
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
  expect(JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"))).toEqual({ alg: "RS256", typ: "JWT" });
  const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  const now = Math.floor(Date.now() / 1000);
  expect(payload.iss).toBe(APP_ID);
  expect(payload.iat).toBeGreaterThanOrEqual(now - 65);
  expect(payload.iat).toBeLessThanOrEqual(now - 55);
  expect(payload.exp).toBeGreaterThanOrEqual(now + 535);
  expect(payload.exp).toBeLessThanOrEqual(now + 545);
  expect(payload.exp - payload.iat).toBe(600);
  expect(verify(
    "RSA-SHA256",
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    publicKey,
    Buffer.from(encodedSignature, "base64url"),
  )).toBe(true);
}

async function rpc(baseUrl: string, id: number, method: string, params: unknown) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": PROTOCOL_VERSION,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await response.text();
  expect(response.status).toBe(200);
  return { text, payload: JSON.parse(text) };
}

describe("GitHub MCP sidecar", () => {
  it("runs startup and idempotent issue comments end to end without leaking credentials", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const credentialDirectory = await mkdtemp(join(tmpdir(), "agentbay-github-mcp-"));
    temporaryDirectories.push(credentialDirectory);
    const credentialPaths = {
      appId: join(credentialDirectory, "app-id"),
      installationId: join(credentialDirectory, "installation-id"),
      privateKey: join(credentialDirectory, "private-key.pem"),
    };
    await Promise.all([
      writeFile(credentialPaths.appId, `${APP_ID}\n`, { mode: 0o600 }),
      writeFile(credentialPaths.installationId, `${INSTALLATION_ID}\n`, { mode: 0o600 }),
      writeFile(credentialPaths.privateKey, privateKeyPem, { mode: 0o600 }),
    ]);

    const comments: Array<{ id: number; body: string; html_url: string }> = [];
    const upstreamRequests: Array<{ method: string; path: string }> = [];
    const fakeFailures: string[] = [];
    let posts = 0;
    const githubApi = http.createServer(async (request, response) => {
      try {
        const url = new URL(request.url!, "http://github.test");
        upstreamRequests.push({ method: request.method!, path: `${url.pathname}${url.search}` });

        if (request.method === "GET" && url.pathname === `/app/installations/${INSTALLATION_ID}`) {
          verifyAppJwt(request.headers.authorization, publicKey);
          return sendJson(response, 200, { app_id: APP_ID, account: { login: "Acme" } });
        }
        if (request.method === "POST" && url.pathname === `/app/installations/${INSTALLATION_ID}/access_tokens`) {
          verifyAppJwt(request.headers.authorization, publicKey);
          expect(await readJson(request)).toEqual({ repository_ids: [REPOSITORY_ID], permissions: { issues: "write" } });
          return sendJson(response, 201, {
            token: INSTALLATION_TOKEN,
            expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            repository_selection: "selected",
            permissions: { issues: "write", metadata: "read" },
            repositories: [{ id: REPOSITORY_ID }],
          });
        }

        expect(request.headers.authorization).toBe(`Bearer ${INSTALLATION_TOKEN}`);
        if (request.method === "GET" && url.pathname === `/repositories/${REPOSITORY_ID}`) {
          return sendJson(response, 200, { id: REPOSITORY_ID, full_name: "Acme/widgets" });
        }
        if (request.method === "GET" && url.pathname === "/repos/Acme/widgets/issues/42/comments") {
          expect(url.searchParams.get("per_page")).toBe("100");
          expect(url.searchParams.get("page")).toBe("1");
          expect(url.searchParams.has("sort")).toBe(false);
          expect(url.searchParams.has("direction")).toBe(false);
          return sendJson(response, 200, comments);
        }
        if (request.method === "POST" && url.pathname === "/repos/Acme/widgets/issues/42/comments") {
          const input = await readJson(request);
          expect(Object.keys(input)).toEqual(["body"]);
          const comment = { id: 500 + posts, body: input.body, html_url: `http://github.test/comments/${500 + posts}` };
          posts += 1;
          comments.push(comment);
          return sendJson(response, 201, comment);
        }
        return sendJson(response, 404, { message: "not found" });
      } catch (error) {
        const message = error instanceof Error ? error.message : "fake failure";
        fakeFailures.push(message);
        return sendJson(response, 500, { message });
      }
    });
    const githubBaseUrl = await listen(githubApi);

    const env = {
      AGENTBAY_CONNECTIONS: JSON.stringify({ schemaVersion: 1, tenantId: "tenant-1", refs: ["github-production"] }),
      AGENTBAY_GITHUB_TENANT: "tenant-1",
      AGENTBAY_GITHUB_CONNECTION: "github-production",
      AGENTBAY_GITHUB_REPOSITORY_OWNER: "Acme",
      AGENTBAY_GITHUB_REPOSITORY_NAME: "widgets",
      AGENTBAY_GITHUB_REPOSITORY_ID: String(REPOSITORY_ID),
      AGENTBAY_GITHUB_APP_ID_FILE: credentialPaths.appId,
      AGENTBAY_GITHUB_INSTALLATION_ID_FILE: credentialPaths.installationId,
      AGENTBAY_GITHUB_PRIVATE_KEY_FILE: credentialPaths.privateKey,
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const serializedOutputs: string[] = [];

    const start = async () => {
      let core: ReturnType<typeof createGitHubCore>;
      const service = {
        async initialize() {
          const config = parseStartupConfig(env);
          const credentials = await readGitHubAppCredentials(config.credentialPaths);
          core = createGitHubCore(config, credentials, { baseUrl: githubBaseUrl });
          await core.verifyStartup();
        },
        createIssueComment(input: unknown) {
          return core.createIssueComment(input);
        },
      };
      const started = await startServer(service, { host: "127.0.0.1", port: 0 }) as RunningServer;
      running.push(started);
      return `http://127.0.0.1:${(started.server.address() as AddressInfo).port}`;
    };

    try {
      let mcpBaseUrl = await start();
      const initialized = await rpc(mcpBaseUrl, 1, "initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "e2e", version: "1" },
      });
      serializedOutputs.push(initialized.text);
      expect(initialized.payload.result).toMatchObject({
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: { name: "github-mcp-sidecar", version: "1.0.0" },
      });

      const listed = await rpc(mcpBaseUrl, 2, "tools/list", {});
      serializedOutputs.push(listed.text);
      expect(listed.payload.result.tools).toHaveLength(1);
      expect(listed.payload.result.tools[0]).toMatchObject({
        name: "issue_comment",
        inputSchema: { additionalProperties: false },
      });

      const arguments_ = {
        owner: "Acme",
        repo: "widgets",
        issue_number: 42,
        body: "Deployed successfully",
        idempotency_key: "execution:abc:comment",
      };
      const created = await rpc(mcpBaseUrl, 3, "tools/call", { name: "issue_comment", arguments: arguments_ });
      serializedOutputs.push(created.text);
      expect(fakeFailures).toEqual([]);
      expect(created.payload.result.structuredContent).toMatchObject({ replayed: false, comment: { id: 500 } });
      expect(created.payload.result.content[0].text).toBe(JSON.stringify(created.payload.result.structuredContent));
      expect(posts).toBe(1);

      await running.pop()!.close();
      mcpBaseUrl = await start();
      const replayed = await rpc(mcpBaseUrl, 4, "tools/call", { name: "issue_comment", arguments: arguments_ });
      serializedOutputs.push(replayed.text);
      expect(replayed.payload.result.structuredContent).toMatchObject({ replayed: true, comment: { id: 500 } });
      expect(posts).toBe(1);

      const conflicted = await rpc(mcpBaseUrl, 5, "tools/call", {
        name: "issue_comment",
        arguments: { ...arguments_, body: "Changed payload" },
      });
      serializedOutputs.push(conflicted.text);
      expect(conflicted.payload.result).toEqual({
        content: [{ type: "text", text: '{"error":"Issue comment failed","code":"IDEMPOTENCY_CONFLICT"}' }],
        structuredContent: { error: "Issue comment failed", code: "IDEMPOTENCY_CONFLICT" },
        isError: true,
      });
      expect(posts).toBe(1);

      const beforeUnauthorized = upstreamRequests.length;
      const unauthorized = await rpc(mcpBaseUrl, 6, "tools/call", {
        name: "issue_comment",
        arguments: { ...arguments_, repo: "other", idempotency_key: "unauthorized" },
      });
      serializedOutputs.push(unauthorized.text);
      expect(unauthorized.payload.result.isError).toBe(true);
      expect(upstreamRequests).toHaveLength(beforeUnauthorized);

      const logs = JSON.stringify([...log.mock.calls, ...errorLog.mock.calls]);
      const externallyVisible = `${serializedOutputs.join("\n")}\n${logs}`;
      expect(externallyVisible).not.toContain(INSTALLATION_TOKEN);
      expect(externallyVisible).not.toContain(privateKeyPem);
      expect(externallyVisible).not.toContain("BEGIN PRIVATE KEY");
    } finally {
      await closeServer(githubApi);
    }
  });
});
