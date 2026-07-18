import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error The sidecar is intentionally plain Node ESM rather than TypeScript.
import { createMcpHandler, startServer } from "../../github-mcp-sidecar/server.mjs";
// @ts-expect-error The sidecar is intentionally plain Node ESM rather than TypeScript.
import { GitHubApiError } from "../../github-mcp-sidecar/github.mjs";

type RunningServer = { server: http.Server; close: () => Promise<void> };
const running: RunningServer[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((entry) => entry.close()));
});

async function serve(service = { createIssueComment: vi.fn() }, ready = true, options: Record<string, unknown> = {}) {
  const server = http.createServer(createMcpHandler(service, { isReady: () => ready, ...options }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const close = () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  running.push({ server, close });
  const { port } = server.address() as AddressInfo;
  return { service, baseUrl: `http://127.0.0.1:${port}` };
}

async function rpc(baseUrl: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const callArguments = {
  owner: "octo",
  repo: "project",
  issue_number: 42,
  body: "hello",
  idempotency_key: "execution-1",
};

describe("GitHub MCP sidecar protocol", () => {
  it("supports the protocol version offered by OpenCode 1.14.50", async () => {
    const { baseUrl } = await serve();
    const initialized = await rpc(baseUrl, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "opencode", version: "1.14.50" },
      },
    });
    expect(initialized.status).toBe(200);
    await expect(initialized.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "github-mcp-sidecar", version: "1.0.0" },
      },
    });

    const tools = await rpc(baseUrl, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, {
      "mcp-protocol-version": "2025-11-25",
    });
    expect(tools.status).toBe(200);
    const payload = await tools.json() as any;
    expect(payload.jsonrpc).toBe("2.0");
    expect(payload.id).toBe(2);
    expect(payload.result.tools).toHaveLength(1);
    expect(payload.result.tools[0].name).toBe("issue_comment");
  });

  it("negotiates initialization and handles initialized notifications and ping", async () => {
    const { baseUrl } = await serve();
    const initialized = await rpc(baseUrl, {
      jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" },
    });
    expect(initialized.status).toBe(200);
    expect(initialized.headers.get("content-type")).toMatch(/^application\/json/);
    await expect(initialized.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "github-mcp-sidecar", version: "1.0.0" },
      },
    });

    const notification = await rpc(baseUrl, { jsonrpc: "2.0", method: "notifications/initialized" }, {
      "mcp-protocol-version": "2025-06-18",
    });
    expect(notification.status).toBe(202);
    expect(await notification.text()).toBe("");

    const ping = await rpc(baseUrl, { jsonrpc: "2.0", id: "p", method: "ping" });
    await expect(ping.json()).resolves.toEqual({ jsonrpc: "2.0", id: "p", result: {} });

    const previous = await rpc(baseUrl, {
      jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-03-26" },
    });
    await expect(previous.json()).resolves.toMatchObject({ result: { protocolVersion: "2025-03-26" } });
  });

  it("lists exactly the strict issue_comment tool", async () => {
    const { baseUrl } = await serve();
    const response = await rpc(baseUrl, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const payload = await response.json() as any;
    expect(payload.result.tools).toHaveLength(1);
    expect(payload.result.tools[0]).toMatchObject({
      name: "issue_comment",
      inputSchema: {
        type: "object",
        required: ["owner", "repo", "issue_number", "body", "idempotency_key"],
        additionalProperties: false,
      },
    });
    expect(Object.keys(payload.result.tools[0].inputSchema.properties)).toEqual([
      "owner", "repo", "issue_number", "body", "idempotency_key",
    ]);
    expect(payload.result.tools[0].inputSchema.properties).toMatchObject({
      owner: { maxLength: 39 },
      repo: { maxLength: 100 },
      body: { minLength: 1, maxLength: 16 * 1024 },
      idempotency_key: { maxLength: 128, pattern: "^[A-Za-z0-9._:-]{1,128}$" },
    });
  });

  it("calls the core service and returns text and structured content", async () => {
    const createIssueComment = vi.fn().mockResolvedValue({ id: 7, url: "https://github.test/comment/7" });
    const { baseUrl } = await serve({ createIssueComment });
    const response = await rpc(baseUrl, {
      jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "issue_comment", arguments: callArguments },
    });
    expect(createIssueComment).toHaveBeenCalledWith({
      owner: "octo",
      repository: "project",
      issueNumber: 42,
      body: "hello",
      idempotencyKey: "execution-1",
    });
    await expect(response.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: 3,
      result: {
        content: [{ type: "text", text: '{"id":7,"url":"https://github.test/comment/7"}' }],
        structuredContent: { id: 7, url: "https://github.test/comment/7" },
      },
    });
  });

  it("uses -32602 for invalid calls and sanitizes operational failures", async () => {
    const createIssueComment = vi.fn().mockRejectedValue(
      new GitHubApiError("secret token ghp_leaked and stack", { code: "IDEMPOTENCY_CONFLICT" }),
    );
    const { baseUrl } = await serve({ createIssueComment });

    const invalid = await rpc(baseUrl, {
      jsonrpc: "2.0", id: 4, method: "tools/call",
      params: { name: "issue_comment", arguments: { ...callArguments, extra: true } },
    });
    await expect(invalid.json()).resolves.toMatchObject({ error: { code: -32602, message: "Invalid params" } });
    expect(createIssueComment).not.toHaveBeenCalled();

    const failed = await rpc(baseUrl, {
      jsonrpc: "2.0", id: 5, method: "tools/call",
      params: { name: "issue_comment", arguments: callArguments },
    });
    const text = await failed.text();
    expect(text).not.toContain("ghp_leaked");
    expect(JSON.parse(text)).toMatchObject({
      result: { isError: true, structuredContent: { error: "Issue comment failed", code: "IDEMPOTENCY_CONFLICT" } },
    });
  });

  it("enforces runtime tool argument bounds before calling the service", async () => {
    const createIssueComment = vi.fn();
    const { baseUrl } = await serve({ createIssueComment });
    const invalidArguments = [
      { ...callArguments, owner: "a".repeat(40) },
      { ...callArguments, repo: ".." },
      { ...callArguments, issue_number: Number.MAX_SAFE_INTEGER + 1 },
      { ...callArguments, body: "😀".repeat(4097) },
      { ...callArguments, body: "\uD800" },
      { ...callArguments, idempotency_key: "not allowed" },
      { ...callArguments, idempotency_key: "a".repeat(129) },
    ];
    for (const [index, argumentsValue] of invalidArguments.entries()) {
      const response = await rpc(baseUrl, {
        jsonrpc: "2.0", id: index, method: "tools/call",
        params: { name: "issue_comment", arguments: argumentsValue },
      });
      await expect(response.json()).resolves.toMatchObject({ error: { code: -32602 } });
    }
    expect(createIssueComment).not.toHaveBeenCalled();
  });

  it("rejects batches, malformed JSON, unsupported protocol headers, and non-local origins", async () => {
    const { baseUrl } = await serve();
    const batch = await rpc(baseUrl, [{ jsonrpc: "2.0", id: 1, method: "ping" }]);
    expect(batch.status).toBe(400);
    await expect(batch.json()).resolves.toMatchObject({ error: { code: -32600 } });

    const malformed = await rpc(baseUrl, "{");
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({ error: { code: -32700 } });

    const version = await rpc(baseUrl, { jsonrpc: "2.0", id: 1, method: "ping" }, {
      "mcp-protocol-version": "2099-01-01",
    });
    expect(version.status).toBe(400);

    const oldHeader = await rpc(baseUrl, { jsonrpc: "2.0", id: 1, method: "ping" }, {
      "mcp-protocol-version": "2024-11-05",
    });
    expect(oldHeader.status).toBe(400);

    const futureInitialize = await rpc(baseUrl, {
      jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2099-01-01" },
    });
    expect(futureInitialize.status).toBe(200);
    await expect(futureInitialize.json()).resolves.toMatchObject({ result: { protocolVersion: "2025-11-25" } });

    const origin = await rpc(baseUrl, { jsonrpc: "2.0", id: 1, method: "ping" }, {
      origin: "https://localhost.evil.test",
    });
    expect(origin.status).toBe(403);
    expect((await rpc(baseUrl, { jsonrpc: "2.0", id: 1, method: "ping" }, {
      origin: "http://localhost:3000",
    })).status).toBe(200);
  });

  it("enforces content type and the 1 MiB body limit", async () => {
    const { baseUrl } = await serve();
    const wrongType = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      body: "{}",
      headers: { accept: "application/json, text/event-stream", "content-type": "text/plain" },
    });
    expect(wrongType.status).toBe(415);

    const oversized = await rpc(baseUrl, "x".repeat(1024 * 1024 + 1));
    expect(oversized.status).toBe(413);
  });

  it("requires both Streamable HTTP response media types in Accept", async () => {
    const { baseUrl } = await serve();
    for (const accept of [undefined, "application/json", "text/event-stream", "application/json, text/event-stream;q=0"]) {
      const headers = new Headers({ "content-type": "application/json" });
      if (accept !== undefined) headers.set("accept", accept);
      const response = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      expect(response.status).toBe(406);
    }
  });

  it("accepts every notification with 202", async () => {
    const { baseUrl } = await serve();
    for (const method of ["notifications/initialized", "notifications/cancelled", "unknown/notification"]) {
      const response = await rpc(baseUrl, { jsonrpc: "2.0", method });
      expect(response.status).toBe(202);
      expect(await response.text()).toBe("");
    }
  });

  it("returns an immediate busy tool error at the concurrency limit", async () => {
    let release!: () => void;
    const createIssueComment = vi.fn(() => new Promise((resolve) => { release = () => resolve({ id: 1 }); }));
    const { baseUrl } = await serve({ createIssueComment }, true, { maxToolConcurrency: 1 });
    const first = rpc(baseUrl, {
      jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "issue_comment", arguments: callArguments },
    });
    await vi.waitFor(() => expect(createIssueComment).toHaveBeenCalledOnce());
    const busy = await rpc(baseUrl, {
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "issue_comment", arguments: { ...callArguments, idempotency_key: "execution-2" } },
    });
    await expect(busy.json()).resolves.toMatchObject({
      id: 2,
      result: { isError: true, structuredContent: { error: "Server busy", code: "BUSY" } },
    });
    expect(createIssueComment).toHaveBeenCalledOnce();
    release();
    expect((await first).status).toBe(200);
  });

  it("times out a slow request body", async () => {
    const { baseUrl } = await serve(undefined, true, { bodyTimeoutMs: 25 });
    const url = new URL(`${baseUrl}/mcp`);
    let clientRequest!: http.ClientRequest;
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      clientRequest = http.request(url, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "content-length": "2",
        },
      }, resolve);
      clientRequest.on("error", reject);
      clientRequest.write("{");
      clientRequest.flushHeaders();
    });
    expect(response.statusCode).toBe(408);
    response.resume();
    clientRequest.destroy();
  });

  it("reports liveness independently from readiness and rejects other routes", async () => {
    const { baseUrl } = await serve(undefined, false);
    expect((await fetch(`${baseUrl}/livez`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/readyz`)).status).toBe(503);
    expect((await fetch(`${baseUrl}/mcp`)).status).toBe(405);
    expect((await fetch(`${baseUrl}/unknown`)).status).toBe(405);
  });

  it("does not listen before asynchronous core initialization succeeds", async () => {
    let finishInitialization!: () => void;
    const initialize = vi.fn(() => new Promise<void>((resolve) => { finishInitialization = resolve; }));
    const starting = startServer({ initialize, createIssueComment: vi.fn() }, { host: "127.0.0.1", port: 0 });
    let settled = false;
    void starting.then(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(initialize).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    finishInitialization();
    const started = await starting as RunningServer;
    running.push(started);
    expect(started.server.listening).toBe(true);
    expect(started.server.requestTimeout).toBe(20_000);
    expect(started.server.headersTimeout).toBe(10_000);
    expect(started.server.keepAliveTimeout).toBe(5_000);
    expect(started.server.maxRequestsPerSocket).toBe(100);
    expect(started.server.maxConnections).toBe(32);
  });
});
