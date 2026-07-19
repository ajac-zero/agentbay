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
      const upstream = await forward(request, body, config, provider, controller.signal);
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
