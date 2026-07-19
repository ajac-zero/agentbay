import http from "node:http";
import net from "node:net";

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const RESPONSE_HEADERS = ["content-type", "mcp-session-id", "retry-after"];

async function readRequest(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_REQUEST_BYTES) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

function upstreamReady(upstream) {
  const url = new URL(upstream);
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: url.hostname, port: Number(url.port || 80) });
    const finish = (ready) => {
      socket.destroy();
      resolve(ready);
    };
    socket.setTimeout(1_000, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function copyHeaders(request, token) {
  const headers = new Headers();
  for (const name of ["accept", "content-type", "last-event-id", "mcp-protocol-version", "mcp-session-id"]) {
    const value = request.headers[name];
    if (typeof value === "string") headers.set(name, value);
  }
  headers.set("authorization", `Bearer ${token}`);
  return headers;
}

async function forward(request, body, config, provider, signal) {
  const target = new URL(request.url ?? "/", config.upstream);
  if (target.origin !== new URL(config.upstream).origin) throw new Error("INVALID_UPSTREAM_PATH");
  const token = await provider.getToken();
  const response = await fetch(target, {
    method: request.method,
    headers: copyHeaders(request, token),
    body: request.method === "GET" || request.method === "HEAD" ? undefined : body,
    redirect: "manual",
    signal,
  });
  if (response.status === 401) provider.invalidate(token);
  return response;
}

async function pipeResponse(upstream, response, signal, unbounded) {
  const declared = Number(upstream.headers.get("content-length"));
  if (!unbounded && Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error("RESPONSE_TOO_LARGE");
  const headers = {};
  for (const name of RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  if (!response.destroyed) response.writeHead(upstream.status, headers);
  if (!upstream.body) {
    response.end();
    return;
  }
  const reader = upstream.body.getReader();
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (!unbounded && length > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      response.destroy(new Error("GitHub MCP response exceeded size limit"));
      return;
    }
    if (response.destroyed) continue;
    if (!response.write(Buffer.from(value))) {
      await new Promise((resolve, reject) => {
        const cleanup = () => signal.removeEventListener("abort", onAbort);
        const onAbort = () => {
          response.removeListener("drain", onDrain);
          response.removeListener("close", onClose);
          reject(signal.reason);
        };
        const onDrain = () => {
          response.removeListener("close", onClose);
          cleanup();
          resolve();
        };
        const onClose = () => {
          response.removeListener("drain", onDrain);
          cleanup();
          resolve();
        };
        response.once("drain", onDrain);
        response.once("close", onClose);
        signal.addEventListener("abort", onAbort, { once: true });
      });
    }
  }
  if (!response.destroyed) response.end();
}

function createPullRequestArguments(body) {
  let message;
  try { message = JSON.parse(body.toString("utf8")); } catch { return undefined; }
  if (Array.isArray(message)) throw new Error("JSON_RPC_BATCH_NOT_SUPPORTED");
  if (message?.method !== "tools/call" || message?.params?.name !== "create_pull_request") return undefined;
  if (message.jsonrpc !== "2.0" || !(typeof message.id === "string" || typeof message.id === "number")) throw new Error("INVALID_CREATE_PULL_REQUEST");
  const args = message.params.arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("INVALID_CREATE_PULL_REQUEST");
  for (const field of ["owner", "repo", "title", "head", "base"]) if (typeof args[field] !== "string" || args[field].length === 0) throw new Error("INVALID_CREATE_PULL_REQUEST");
  return { args, id: message.id };
}

async function effectRequest(config, path, body) {
  if (!config.effect) throw new Error("EFFECT_CAPABILITY_MISSING");
  const response = await fetch(new URL(path, config.effect.endpoint), {
    method: "POST", headers: { authorization: `Bearer ${config.effect.token}`, "content-type": "application/json" }, body: JSON.stringify(body), redirect: "manual",
  });
  if (!response.ok) throw new Error("EFFECT_REQUEST_REJECTED");
  return response.json();
}

async function responseBytes(upstream) {
  const bytes = Buffer.from(await upstream.arrayBuffer());
  if (bytes.length > MAX_RESPONSE_BYTES) throw new Error("RESPONSE_TOO_LARGE");
  return bytes;
}

function pullRequestIdentity(bytes, owner, repo, requestId) {
  let textBody = bytes.toString("utf8");
  if (textBody.trimStart().startsWith("event:") || textBody.trimStart().startsWith("data:")) {
    const data = textBody.split(/\r?\n/).filter((line) => line.startsWith("data:"));
    if (data.length !== 1) throw new Error("INVALID_CREATE_PULL_REQUEST_RESULT");
    textBody = data[0].slice(5).trim();
  }
  let envelope;
  try { envelope = JSON.parse(textBody); } catch { throw new Error("INVALID_CREATE_PULL_REQUEST_RESULT"); }
  if (envelope.jsonrpc !== "2.0" || envelope.id !== requestId || envelope.error || envelope.result?.isError === true || !Array.isArray(envelope.result?.content)) throw new Error("INVALID_CREATE_PULL_REQUEST_RESULT");
  const text = envelope.result.content.length === 1 && envelope.result.content[0]?.type === "text" ? envelope.result.content[0].text : undefined;
  let result;
  try { result = JSON.parse(text); } catch { throw new Error("INVALID_CREATE_PULL_REQUEST_RESULT"); }
  if (typeof result?.id !== "string" || !/^[1-9][0-9]*$/.test(result.id) || typeof result.url !== "string") throw new Error("INVALID_CREATE_PULL_REQUEST_RESULT");
  const url = new URL(result.url);
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]*)$/);
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.username || url.password || url.search || url.hash
    || !match || match[1].toLowerCase() !== owner.toLowerCase() || match[2].toLowerCase() !== repo.toLowerCase()) throw new Error("INVALID_CREATE_PULL_REQUEST_RESULT");
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number)) throw new Error("INVALID_CREATE_PULL_REQUEST_RESULT");
  return { githubPullRequestId: result.id, pullRequestNumber: number, pullRequestUrl: result.url };
}

export function startBroker(config, provider) {
  const server = http.createServer(async (request, response) => {
    const controller = new AbortController();
    if (request.method === "GET") {
      request.once("aborted", () => controller.abort(new Error("MCP client disconnected")));
      response.once("close", () => {
        if (!response.writableFinished) controller.abort(new Error("MCP client disconnected"));
      });
    }
    try {
      if (request.url === "/livez") {
        response.writeHead(204).end();
        return;
      }
      if (request.url === "/readyz") {
        const ready = await upstreamReady(config.upstream) && await provider.getToken().then(() => true, () => false);
        response.writeHead(ready ? 204 : 503).end();
        return;
      }
      if (request.headers.authorization !== undefined || !["GET", "POST", "DELETE"].includes(request.method ?? "")) {
        response.writeHead(400).end();
        return;
      }
      const body = await readRequest(request);
      const createCall = request.method === "POST" ? createPullRequestArguments(body) : undefined;
      const createArguments = createCall?.args;
      let effect;
      if (createArguments) {
        effect = await effectRequest(config, "/internal/v1/github/pull-request-effects", {
          executionId: config.effect.executionId, repositoryId: config.repositoryId, repositoryFullName: `${createArguments.owner}/${createArguments.repo}`, request: createArguments,
        });
        if (effect.created !== true) throw new Error("PULL_REQUEST_EFFECT_ALREADY_REGISTERED");
      }
      const upstream = await forward(request, body, config, provider, controller.signal);
      if (createArguments) {
        const bytes = await responseBytes(upstream);
        if (!upstream.ok) {
          response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" }).end(bytes);
          return;
        }
        const identity = pullRequestIdentity(bytes, createArguments.owner, createArguments.repo, createCall.id);
        await effectRequest(config, `/internal/v1/github/pull-request-effects/${effect.id}/report`, { executionId: config.effect.executionId, ...identity });
        response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" }).end(bytes);
        return;
      }
      const unbounded = request.method === "GET" && upstream.headers.get("content-type")?.startsWith("text/event-stream") === true;
      await pipeResponse(upstream, response, controller.signal, unbounded);
    } catch (error) {
      if (controller.signal.aborted) {
        if (!response.destroyed) response.destroy();
        return;
      }
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.writeHead(error instanceof Error && error.message === "REQUEST_TOO_LARGE" ? 413 : 502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "GitHub MCP proxy request failed" }));
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => resolve({ server, close: () => new Promise((done, fail) => server.close((error) => error ? fail(error) : done())) }));
  });
}
