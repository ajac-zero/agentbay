import http from "node:http";
import { pathToFileURL } from "node:url";
import { GitHubApiError } from "./github.mjs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8082;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_COMMENT_BYTES = 16 * 1024;
const DEFAULT_BODY_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_TOOL_CONCURRENCY = 8;
const LATEST_PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  LATEST_PROTOCOL_VERSION,
  "2025-06-18",
  "2025-03-26",
]);
const SAFE_GITHUB_ERROR_CODES = new Set([
  "IDEMPOTENCY_CONFLICT",
  "INVALID_ARGUMENT",
  "INVALID_RESPONSE",
  "REPOSITORY_NOT_ALLOWED",
  "REQUEST_TOO_LARGE",
  "UPSTREAM_ERROR",
  "UPSTREAM_FAILURE",
]);
const OWNER_PATTERN = "^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$";
const REPOSITORY_PATTERN = "^(?!\\.{1,2}$)[A-Za-z0-9._-]+$";
const IDEMPOTENCY_KEY_PATTERN = "^[A-Za-z0-9._:-]{1,128}$";
const VALID_UTF16_PATTERN = "^(?:[^\\uD800-\\uDFFF]|[\\uD800-\\uDBFF][\\uDC00-\\uDFFF])*$";
const INVALID_SURROGATE_PATTERN = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const VALID_OWNER = new RegExp(OWNER_PATTERN);
const VALID_REPOSITORY = new RegExp(REPOSITORY_PATTERN);
const VALID_IDEMPOTENCY_KEY = new RegExp(IDEMPOTENCY_KEY_PATTERN);

const ISSUE_COMMENT_TOOL = Object.freeze({
  name: "issue_comment",
  description: "Create a comment on a GitHub issue",
  inputSchema: {
    type: "object",
    properties: {
      owner: { type: "string", minLength: 1, maxLength: 39, pattern: OWNER_PATTERN },
      repo: { type: "string", minLength: 1, maxLength: 100, pattern: REPOSITORY_PATTERN },
      issue_number: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      body: { type: "string", minLength: 1, maxLength: MAX_COMMENT_BYTES, pattern: VALID_UTF16_PATTERN },
      idempotency_key: { type: "string", minLength: 1, maxLength: 128, pattern: IDEMPOTENCY_KEY_PATTERN },
    },
    required: ["owner", "repo", "issue_number", "body", "idempotency_key"],
    additionalProperties: false,
  },
});

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function sendEmpty(response, status) {
  response.writeHead(status, { "content-length": "0" });
  response.end();
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function acceptsStreamableHttp(value) {
  if (typeof value !== "string") return false;
  const accepted = new Set(value.split(",").flatMap((entry) => {
    const [type, ...parameters] = entry.trim().toLowerCase().split(";").map((part) => part.trim());
    const rejected = parameters.some((parameter) => /^q=0(?:\.0*)?$/.test(parameter));
    return type && !rejected ? [type] : [];
  }));
  return accepted.has("application/json") && accepted.has("text/event-stream");
}

function validIssueCommentArguments(value) {
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  const expected = ["owner", "repo", "issue_number", "body", "idempotency_key"];
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) return false;
  return (
    typeof value.owner === "string" && VALID_OWNER.test(value.owner) &&
    typeof value.repo === "string" && value.repo.length <= 100 && VALID_REPOSITORY.test(value.repo) &&
    Number.isSafeInteger(value.issue_number) && value.issue_number >= 1 &&
    typeof value.body === "string" && value.body.length > 0 &&
      Buffer.byteLength(value.body, "utf8") <= MAX_COMMENT_BYTES && !INVALID_SURROGATE_PATTERN.test(value.body) &&
    typeof value.idempotency_key === "string" && VALID_IDEMPOTENCY_KEY.test(value.idempotency_key)
  );
}

function localOrigin(origin) {
  if (origin === undefined) return true;
  try {
    const hostname = new URL(origin).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function readBody(request, timeoutMs) {
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    request.resume();
    return Promise.reject(new Error("body_too_large"));
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
      callback(value);
    };
    const onData = (chunk) => {
      length += chunk.length;
      if (length > MAX_BODY_BYTES) {
        request.resume();
        settle(reject, new Error("body_too_large"));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => settle(resolve, Buffer.concat(chunks).toString("utf8"));
    const onError = () => settle(reject, new Error("request_error"));
    const onAborted = () => settle(reject, new Error("request_aborted"));
    const timer = setTimeout(() => {
      request.resume();
      settle(reject, new Error("body_timeout"));
    }, timeoutMs);
    timer.unref();
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
  });
}

function validRequest(message) {
  return isObject(message) && message.jsonrpc === "2.0" && typeof message.method === "string" &&
    (message.id === undefined || message.id === null || typeof message.id === "string" || typeof message.id === "number");
}

function toolError(id, error, code) {
  const value = { error, ...(code === undefined ? {} : { code }) };
  return {
    body: {
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: JSON.stringify(value) }],
        structuredContent: value,
        isError: true,
      },
    },
  };
}

async function dispatch(message, service, toolSlots) {
  const id = message.id;
  const notification = id === undefined;

  if (message.method === "notifications/initialized") return { notification: true };
  if (notification) return { notification: true };

  if (message.method === "initialize") {
    if (!isObject(message.params) || typeof message.params.protocolVersion !== "string") {
      return { body: jsonRpcError(id, -32602, "Invalid params") };
    }
    const offered = message.params.protocolVersion;
    const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(offered) ? offered : LATEST_PROTOCOL_VERSION;
    return {
      body: {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "github-mcp-sidecar", version: "1.0.0" },
        },
      },
    };
  }

  if (message.method === "ping") {
    return { body: { jsonrpc: "2.0", id, result: {} } };
  }

  if (message.method === "tools/list") {
    if (message.params !== undefined && !isObject(message.params)) {
      return { body: jsonRpcError(id, -32602, "Invalid params") };
    }
    return { body: { jsonrpc: "2.0", id, result: { tools: [ISSUE_COMMENT_TOOL] } } };
  }

  if (message.method === "tools/call") {
    if (!isObject(message.params) || Object.keys(message.params).length !== 2 ||
        !Object.hasOwn(message.params, "name") || !Object.hasOwn(message.params, "arguments") ||
        message.params.name !== ISSUE_COMMENT_TOOL.name ||
        !validIssueCommentArguments(message.params.arguments)) {
      return { body: jsonRpcError(id, -32602, "Invalid params") };
    }
    if (!toolSlots.acquire()) return toolError(id, "Server busy", "BUSY");
    try {
      const input = message.params.arguments;
      const result = await service.createIssueComment({
        owner: input.owner,
        repository: input.repo,
        issueNumber: input.issue_number,
        body: input.body,
        idempotencyKey: input.idempotency_key,
      });
      return {
        body: {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
          },
        },
      };
    } catch (error) {
      const code = error instanceof GitHubApiError && SAFE_GITHUB_ERROR_CODES.has(error.code) ? error.code : undefined;
      return toolError(id, "Issue comment failed", code);
    } finally {
      toolSlots.release();
    }
  }

  return { body: jsonRpcError(id, -32601, "Method not found") };
}

export function createMcpHandler(service, options = {}) {
  if (!service || typeof service.createIssueComment !== "function") {
    throw new TypeError("service.createIssueComment must be a function");
  }
  const isReady = options.isReady ?? (() => true);
  const bodyTimeoutMs = options.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS;
  const maxToolConcurrency = options.maxToolConcurrency ?? DEFAULT_MAX_TOOL_CONCURRENCY;
  let activeToolCalls = 0;
  const toolSlots = {
    acquire() {
      if (activeToolCalls >= maxToolConcurrency) return false;
      activeToolCalls += 1;
      return true;
    },
    release() {
      activeToolCalls -= 1;
    },
  };

  return async function mcpHandler(request, response) {
    try {
      if (request.method === "GET" && request.url === "/livez") {
        return sendEmpty(response, 200);
      }
      if (request.method === "GET" && request.url === "/readyz") {
        return sendEmpty(response, isReady() ? 200 : 503);
      }
      if (request.method !== "POST" || request.url !== "/mcp") {
        response.setHeader("allow", request.url === "/mcp" ? "POST" : "GET, POST");
        return sendEmpty(response, 405);
      }
      if (!localOrigin(request.headers.origin)) return sendEmpty(response, 403);
      if (!acceptsStreamableHttp(request.headers.accept)) return sendEmpty(response, 406);

      const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
      if (contentType !== "application/json") return sendEmpty(response, 415);

      let rawBody;
      try {
        rawBody = await readBody(request, bodyTimeoutMs);
      } catch (error) {
        const status = error?.message === "body_too_large" ? 413 : error?.message === "body_timeout" ? 408 : 400;
        return sendEmpty(response, status);
      }

      let message;
      try {
        message = JSON.parse(rawBody);
      } catch {
        return sendJson(response, 400, jsonRpcError(null, -32700, "Parse error"));
      }
      if (!validRequest(message)) {
        return sendJson(response, 400, jsonRpcError(isObject(message) ? message.id : null, -32600, "Invalid Request"));
      }

      if (message.method !== "initialize") {
        const protocolVersion = request.headers["mcp-protocol-version"];
        if (protocolVersion !== undefined && !SUPPORTED_PROTOCOL_VERSIONS.has(protocolVersion)) {
          return sendEmpty(response, 400);
        }
      }

      const result = await dispatch(message, service, toolSlots);
      if (result.notification) return sendEmpty(response, 202);
      return sendJson(response, result.status ?? 200, result.body);
    } catch {
      if (!response.headersSent) return sendEmpty(response, 500);
      response.end();
    }
  };
}

export async function startServer(service, options = {}) {
  if (!service || typeof service.initialize !== "function") {
    throw new TypeError("service.initialize must be a function");
  }

  const readiness = { ready: false };
  await service.initialize();
  readiness.ready = true;

  const server = http.createServer(createMcpHandler(service, {
    isReady: () => readiness.ready,
    bodyTimeoutMs: options.bodyTimeoutMs,
    maxToolConcurrency: options.maxToolConcurrency,
  }));
  server.requestTimeout = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  server.headersTimeout = options.headersTimeoutMs ?? 10_000;
  server.keepAliveTimeout = options.keepAliveTimeoutMs ?? 5_000;
  server.maxRequestsPerSocket = options.maxRequestsPerSocket ?? 100;
  server.maxConnections = options.maxConnections ?? 32;
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    server,
    async close() {
      readiness.ready = false;
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

async function main() {
  const { createGitHubCore, parseStartupConfig, readGitHubAppCredentials } = await import("./index.mjs");
  let core;
  const service = {
    async initialize() {
      const config = parseStartupConfig();
      const credentials = await readGitHubAppCredentials(config.credentialPaths);
      core = createGitHubCore(config, credentials);
      await core.verifyStartup();
    },
    createIssueComment(input) {
      return core.createIssueComment(input);
    },
  };
  const running = await startServer(service);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await running.close();
      process.exitCode = 0;
    } catch {
      process.exitCode = 1;
    }
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(() => {
    process.exitCode = 1;
  });
}
