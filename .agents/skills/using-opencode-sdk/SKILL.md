---
name: using-opencode-sdk
description: Drives a remote opencode server from TypeScript using @opencode-ai/sdk. Covers connecting via createOpencodeClient, session lifecycle (create, prompt, abort, resume), SSE event streaming for real-time output, HTTP Basic auth, the directory header, and patterns for orchestrators that talk to one opencode server per process/Pod. Use when writing client code that drives a headless `opencode serve` instance from another process.
---

# Using the opencode SDK (client side)

The opencode SDK ([`@opencode-ai/sdk`](https://www.npmjs.com/package/@opencode-ai/sdk)) is the TypeScript client for a headless `opencode serve` HTTP server. This skill focuses on the **client-driving-a-remote-server** scenario — not embedding opencode in-process.

Canonical source: [`anomalyco/opencode`](https://github.com/anomalyco/opencode). Generated OpenAPI spec lives at `packages/sdk/openapi.json` in that repo.

## When to use which factory

| Goal | Use |
|---|---|
| Drive a server you did **not** start (running in another Pod/host) | `createOpencodeClient({ baseUrl, headers, directory })` |
| Spawn a local `opencode` subprocess and get a client to it | `createOpencodeServer()` then `createOpencodeClient(...)` |
| Combined helper for local dev | `createOpencode()` returns `{ client, server }` |

For orchestrator/sandbox use cases, **always use `createOpencodeClient` directly**. Never use `createOpencodeServer` from the orchestrator — that spawns a subprocess.

## Install

```bash
npm install @opencode-ai/sdk
# or: bun add @opencode-ai/sdk
```

ESM only. Node ≥ 22 or Bun. The only runtime dep is `cross-spawn`.

## Connecting to a remote server

```ts
import { createOpencodeClient } from "@opencode-ai/sdk/client"

const client = createOpencodeClient({
  baseUrl: "http://my-pod.my-ns.svc:4096",
  headers: {
    Authorization: `Basic ${Buffer.from("opencode:" + password).toString("base64")}`,
  },
  directory: "/workspace",   // pinned x-opencode-directory on every request
})
```

Notes:
- The client disables fetch timeouts so long-running streaming calls don't drop.
- `directory` is **required** for any operation that touches an instance (sessions, files, tools, etc.). The server is multi-instance: it loads / caches an instance per `directory`.
- To override per-call, pass `directory` in the request `query` (or set `x-opencode-directory` header — for GETs it's auto-promoted to `?directory=`).

## The client surface

`OpencodeClient` is namespaced. The relevant ones for orchestration:

| Namespace | Use for |
|---|---|
| `client.global` | health, global event stream, dispose |
| `client.session` | the workhorse: create / prompt / abort / resume / status |
| `client.event` | per-instance SSE event stream |
| `client.file` | listing/reading files in the working directory |
| `client.find` | text/file/symbol search |
| `client.tool` | list available tool IDs and schemas |
| `client.config` | inspect/patch server config |
| `client.provider` | list configured model providers |

## Authentication

HTTP Basic, server-side env-driven:

| Server env var | Effect |
|---|---|
| `OPENCODE_SERVER_PASSWORD` | If set, auth is required |
| `OPENCODE_SERVER_USERNAME` | Defaults to `opencode` |

If `OPENCODE_SERVER_PASSWORD` is unset the server accepts everything and prints a warning. **Always set it** for any networked deployment.

Client side:
- Header form: `Authorization: Basic <base64("user:pass")>`.
- Query form (for SSE/WebSocket where headers are awkward): `?auth_token=<base64>`.

## Session lifecycle

### Create

```ts
const { data: session } = await client.session.create()
const sessionID = session.id  // ULID, durable
```

### Configure (optional)

```ts
await client.session.update({
  path: { id: sessionID },
  body: {
    title: "Slack T012345 / C0XXX / 1731XXXXXX",
    permissions: { /* per-tool allow/deny */ },
  },
})
```

### Prompt — synchronous (waits for full response)

```ts
const { data } = await client.session.prompt({
  path: { id: sessionID },
  body: {
    parts: [{ type: "text", text: "Refactor the auth module." }],
    // optional: providerID, modelID overrides
  },
})
// data.info: AssistantMessage; data.parts: Part[]
```

Synchronous mode blocks until the agent is done. **Use SSE if you want streaming.**

### Prompt — async (recommended for streaming)

```ts
await client.session.promptAsync({
  path: { id: sessionID },
  body: { parts: [{ type: "text", text: "..." }] },
})
// Returns 204 immediately. Track progress via SSE.
```

### Abort

```ts
await client.session.abort({ path: { id: sessionID } })
```

### Status (check before issuing a new prompt)

```ts
const { data: status } = await client.session.status({ path: { id: sessionID } })
// status: { type: "idle" } | { type: "busy" } | { type: "retry", ... }
```

### Resume

Sessions are persisted in SQLite on the server. To resume, just keep the `sessionID` and call `prompt`/`promptAsync` again on it. Use `session.messages` to pull history:

```ts
const { data: messages } = await client.session.messages({ path: { id: sessionID } })
```

## Streaming via SSE

The HTTP `prompt` endpoint does **not** stream the response body. Real-time output (text deltas, tool calls, status changes) comes from `GET /event`:

```ts
const stream = client.event.subscribe({ query: { directory: "/workspace" } })

for await (const event of stream) {
  switch (event.type) {
    case "message.part.updated": {
      const part = event.properties.part
      const delta = event.properties.delta  // string | undefined
      if (part.type === "text" && delta) yield delta
      break
    }
    case "session.status":
      // { type: "idle" | "busy" | "retry" }
      break
    case "session.idle":
      return  // session finished processing this prompt
    case "permission.updated":
      // tool requesting permission; respond if you handle this
      break
    case "server.heartbeat":
      // 10s keepalive, ignore
      break
  }
}
```

### Translating SSE → `AsyncIterable<string>` for Chat SDK

```ts
async function* runPrompt(client: OpencodeClient, sessionID: string, text: string) {
  const stream = client.event.subscribe({})
  await client.session.promptAsync({ path: { id: sessionID }, body: { parts: [{ type: "text", text }] } })
  for await (const event of stream) {
    if (event.type === "message.part.updated") {
      const { part, delta } = event.properties
      if (part.type === "text" && delta) yield delta
    }
    if (event.type === "session.idle") return
  }
}

// then:
await thread.post(runPrompt(client, sessionID, message.text))
```

Subscribe **before** calling `promptAsync` to avoid missing the opening deltas.

## The Part union (assistant message anatomy)

| Part type | Notes |
|---|---|
| `text` | streamed text content; carries `delta` |
| `reasoning` | chain-of-thought (model dependent) |
| `tool` | tool call; lifecycle `pending → running → completed | error` |
| `file` | attached/read file |
| `step-start` / `step-finish` | LLM step boundaries; `step-finish` has token + cost |
| `snapshot` | filesystem snapshot id |
| `patch` | list of file edits |
| `agent` | subagent invocation |
| `retry` | error + retry info |
| `compaction` | context-window compaction event |

Cost/token accounting: aggregate across `step-finish` parts.

## Permission flow

If a tool needs a permission decision, the server emits `permission.updated`. To respond from the client:

```ts
await client.session.postSessionIdPermissionsPermissionId({
  path: { id: sessionID, permissionID: "..." },
  body: { response: "allow" },  // or "deny"
})
```

For sandboxed deployments where the Pod boundary is the trust boundary, configure per-session permissions at session creation (`session.update`) so prompts auto-allow inside the sandbox without round-tripping through the orchestrator.

## Concurrency rules

- One server per process, one process per Pod (typical sandbox model).
- A session can have at most one in-flight prompt. Issue concurrent `prompt`s and the second fails with a busy error.
- Multiple clients can hit the same server simultaneously and read history; only one can be actively prompting per session.
- Always `session.status` before `promptAsync` if there's any chance of a race.

## Common patterns for orchestrators

### Cache one client per Pod

```ts
const clients = new Map<string, OpencodeClient>()
function getClient(podFQDN: string, password: string) {
  const key = `${podFQDN}:${password}`
  let c = clients.get(key)
  if (!c) {
    c = createOpencodeClient({
      baseUrl: `http://${podFQDN}:4096`,
      headers: { Authorization: `Basic ${Buffer.from("opencode:" + password).toString("base64")}` },
      directory: "/workspace",
    })
    clients.set(key, c)
  }
  return c
}
```

### Wait for server readiness after Pod start

The CLI prints `opencode server listening on http://<host>:<port>` to stdout. From outside, poll `GET /global/health` until 200:

```ts
async function waitReady(baseUrl: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/global/health`)
      if (res.ok) return
    } catch {}
    await new Promise(r => setTimeout(r, 200))
  }
  throw new Error(`opencode server at ${baseUrl} not ready`)
}
```

### Provider keys

Set on the server side via env vars (e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`). The orchestrator does not pass keys per-request.

For sandboxed deployments, inject keys via `SandboxClaim.spec.env` — never bake them into the image.

## Pitfalls

- **`directory` not set** → 4xx with "no instance for directory". Set it in the client config.
- **`promptAsync` then immediately subscribe** → race; you may miss early events. Subscribe first.
- **Synchronous `prompt` for long agent runs** → fine, but you get no streaming UX. Prefer `promptAsync` + SSE.
- **No auth in production** → server warns but still serves. Always set `OPENCODE_SERVER_PASSWORD`.
- **Session lost on Pod eviction** → SQLite at `~/.opencode` dies with the container. Mount a PVC, or persist a summary externally and seed a new session with it.
- **Calling `createOpencodeServer` from the orchestrator** → spawns a local subprocess. You almost certainly want `createOpencodeClient` instead.

## Reference

- Repo: https://github.com/anomalyco/opencode
- SDK package source: `packages/sdk/js/`
- OpenAPI spec: `packages/sdk/openapi.json`
- Server entrypoint: `packages/opencode/src/cli/cmd/serve.ts`
- Auth middleware: `packages/opencode/src/server/routes/instance/httpapi/middleware/authorization.ts`
- Generated types: `packages/sdk/js/src/gen/types.gen.ts`
