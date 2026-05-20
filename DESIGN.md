# agentbay — Design Document

> **Status:** Guiding target design. Current implementation may lag behind this document.
> **Audience:** Engineers building agentbay, and any AI coding agent contributing to it.
> **Scope:** End-to-end architecture, component responsibilities, data flow, and the design decisions behind them.

---

## 1. Vision

**agentbay** is a chat-native platform for running AI coding agents. A user mentions a bot in Slack, GitHub, Linear (or any other platform supported by the Chat SDK), and within seconds an isolated, sandboxed agent — backed by an opencode server in its own Kubernetes Pod — is answering them in-thread, with full tool access (shell, file edits, LSP, MCP) constrained by platform-level network and resource policy.

The system is composed entirely of off-the-shelf primitives glued together by a small TypeScript orchestrator. We write **no agent runtime, no sandbox runtime, no chat adapter** — only the wiring between them.

### Core promise

| For | We provide |
|---|---|
| End users | "Mention the bot, get an agent." Zero friction; works anywhere chat works. |
| Platform admins | Declarative bot definitions, sandbox profiles, network isolation, resource quotas — managed via DB records and Kubernetes CRDs. |
| Agent authors | The full opencode tool surface inside a clean, disposable sandbox. |

---

## 2. Building Blocks

agentbay stands on three projects. Understanding their roles is non-negotiable.

| Layer | Project | Role |
|---|---|---|
| Chat I/O | [`chat`](https://chat-sdk.dev) (Vercel Chat SDK) | Unified TS interface for Slack, GitHub, Linear, Discord, Teams, Google Chat, Telegram, WhatsApp. Handles webhooks, threads, streaming, dedupe, state. |
| Sandbox | [`kubernetes-sigs/agent-sandbox`](https://github.com/kubernetes-sigs/agent-sandbox) | Four CRDs (`Sandbox`, `SandboxTemplate`, `SandboxWarmPool`, `SandboxClaim`) for managing isolated, stateful, singleton Pods on Kubernetes. |
| Agent runtime | [`anomalyco/opencode`](https://github.com/anomalyco/opencode) + [`@opencode-ai/sdk`](https://www.npmjs.com/package/@opencode-ai/sdk) | Headless AI coding agent with HTTP/SSE API. Runs as a server inside the sandbox. Driven via the SDK from outside. |

### What we write

A single TypeScript service — the **orchestrator** — that:
1. Runs Chat SDK adapters and receives webhooks.
2. Maps incoming chat events to `SandboxClaim` operations (create, lookup, delete) on the cluster.
3. Drives each Pod's opencode server via `@opencode-ai/sdk/client`.
4. Streams responses back into chat threads.

That's it. There is no agent code, no sandbox controller, no chat adapter to maintain.

---

## 3. High-Level Architecture

```diagram
╭─────────────────────────────────────────────────────────────────────────────╮
│                          External Chat Platforms                             │
│              Slack · GitHub · Linear · Discord · Teams · …                   │
╰────────────────────────────────────┬────────────────────────────────────────╯
                                     │ webhooks (HTTPS)
                                     ▼
╭─────────────────────────────────────────────────────────────────────────────╮
│                        agentbay Orchestrator (TS)                            │
│                                                                              │
│  ╭────────────────╮   ╭──────────────────╮   ╭──────────────────────────╮   │
│  │  Chat SDK      │──▶│  Bot / Runtime    │──▶│  Sandbox Manager         │   │
│  │  (all adapters)│   │  Resolver         │   │  (k8s client)            │   │
│  ╰───────┬────────╯   ╰──────────────────╯   ╰────────────┬─────────────╯   │
│          │                                                 │                 │
│          │ thread.post(stream)                             │ create/get/del  │
│          │                                                 │ SandboxClaim    │
│          ▲                                                 ▼                 │
│  ╭───────┴──────────────────────────────────────────────────────────────╮   │
│  │  opencode SDK client                                                  │   │
│  │  • session.create / .prompt / .abort                                  │   │
│  │  • event.subscribe (SSE → AsyncIterable<string>)                      │   │
│  ╰─────────────────────────────────┬─────────────────────────────────────╯   │
╰────────────────────────────────────┼────────────────────────────────────────╯
                                     │ HTTP/SSE        │ k8s API
                                     ▼                 ▼
                ╭────────────────────────────╮  ╭──────────────────╮
                │  Sandbox Pod (one of many) │  │  kube-apiserver  │
                │  ╭──────────────────────╮  │  │  + agent-sandbox │
                │  │ opencode serve       │  │  │   controllers    │
                │  │  --hostname 0.0.0.0  │  │  ╰─────────┬────────╯
                │  │  --port 4096         │  │            │ creates
                │  │ working-dir:         │  │            ▼
                │  │  /workspace/<repo>   │  │     SandboxClaim
                │  │ SQLite at PVC mount  │  │      → Sandbox
                │  ╰──────────────────────╯  │       → Pod
                ╰────────────────────────────╯
```

---

## 4. Component Responsibilities

### 4.1 Chat SDK Layer

- **One `Chat` instance per bot as needed**, with adapters registered using that bot's secret references. This is required for platforms such as Telegram where the adapter credential is the bot identity.
- One handler per relevant event: `onNewMention`, `onSubscribedMessage`, `onDirectMessage`, optionally `onSlashCommand` and `onAction` for control surfaces (e.g., a "stop" button).
- Webhooks are mounted under an explicit bot path: `/agents/:botSlug/webhooks/:adapter`. There is no implicit global bot and no `/webhooks/:adapter` fallback in the target architecture.
- **State**: persisted via a state adapter (Redis or equivalent) keyed by thread.
- **Per-thread state shape** (stored via `thread.setState`):
  ```ts
  type ThreadState = {
    botID: string            // chat-facing bot definition used by this thread
    sandboxProfileID: string // sandbox/runtime boundary selected at thread start
    agentProfileID: string   // agentbay selectable profile pointing to an opencode agent
    opencodeConfigID: string // injected opencode config document
    opencodeConfigHash: string
    opencodeAgentName: string
    claimName: string        // SandboxClaim.metadata.name
    podFQDN: string          // headless service FQDN of the sandbox pod
    sessionID: string        // opencode session id
    password: string         // per-claim opencode server password
    createdAt: string        // ISO8601
  }
  ```

### 4.2 Bot / Runtime Resolver

- A **Bot** is the chat-facing identity addressed by webhook path, e.g. `/agents/clusterbot/webhooks/slack`.
- A **SandboxProfile** is the cluster/runtime boundary: which `SandboxTemplate` to claim and which warm pool to use. In alpha this is intentionally minimal: `templateName`, `warmpool`, and `enabled`.
- An **OpencodeConfig** is the JSON document injected as `OPENCODE_CONFIG_CONTENT`. It includes opencode-native agent definitions under `agent`, plus model/provider/MCP/tool/permission settings.
- An **AgentProfile** is agentbay metadata that points to one named opencode agent inside an `OpencodeConfig`. It does not duplicate prompt/model/tools; opencode owns those fields.
- A **Bot** binds one `SandboxProfile`, one default `AgentProfile`, and an allowed set of `AgentProfile`s.
- First message in a thread resolves bot/runtime in this order:
  1. Resolve `botSlug` from `/agents/:botSlug/webhooks/:adapter`.
  2. Load the bot's `SandboxProfile`.
  3. Resolve the `AgentProfile` from bot policy; alpha uses the bot default unless explicit selection is added later.
  4. Load the referenced `OpencodeConfig` and selected `opencodeAgentName`.
  5. Persist the resolved IDs and config hash in thread state.
- Subsequent messages reuse the thread's stored bot/runtime. They do not re-resolve based on sender. Alpha security warning: anyone who can post in a thread can interact with that thread's sandbox and inherits its selected runtime capability.

### 4.3 Sandbox Manager

- Wraps `@kubernetes/client-node`.
- Single ServiceAccount with RBAC scoped to `sandboxclaims` (verbs: `create`, `get`, `list`, `watch`, `delete`) in tenant namespaces.
- Operations:
  - `claimFor(thread, runtime) → { claimName, podFQDN, password }`
    - Computes a deterministic claim name from `thread.id` (e.g. `sha256(thread.id)[:16]`).
    - Checks if the claim already exists; if so, returns its current details.
    - Otherwise creates the claim with the `SandboxProfile` template/warm-pool, per-claim auth env vars, injected opencode config, and lifecycle.
    - Watches until `status.conditions[Ready]=True`; reads `status.sandbox.podIPs[]` / serviceFQDN.
  - `releaseClaim(claimName)` — explicit deletion (used on stop commands).
  - **Reconciler loop** — periodically lists `SandboxClaim`s, cross-checks Chat SDK state, deletes orphans.

### 4.4 opencode SDK Client

- For each thread interaction, build a client targeted at the Pod:
  ```ts
  const client = createOpencodeClient({
    baseUrl: `http://${podFQDN}:4096`,
    headers: { Authorization: `Basic ${b64("opencode:" + password)}` },
    directory: "/workspace",
  })
  ```
- **First mention in a thread**:
  1. `session.create()`
  2. Persist `sessionID` and resolved runtime IDs in thread state
  3. `event.subscribe()` and translate to `AsyncIterable<string>` for `thread.post(stream)`
  4. `session.promptAsync()` with `agent: opencodeAgentName` and user message
- **Subsequent messages**: skip `session.create`; reuse `sessionID` and pass the stored `opencodeAgentName` on each prompt.
- The orchestrator does not prepend its own system prompt in the target design. The selected opencode agent's `prompt`, `model`, `tools`, and `permission` config are authoritative.

---

## 5. End-to-End Flow

### 5.1 First mention in a new thread

```diagram
User                Chat Platform     Orchestrator        kube-apiserver       Sandbox Pod
 │  "@bot do X"        │                   │                    │                    │
 ├────────────────────▶│                   │                    │                    │
 │                     ├──webhook─────────▶│                    │                    │
 │                     │                   │ resolve runtime    │                    │
 │                     │                   ├─claim.create──────▶│                    │
 │                     │                   │                    ├─schedule pod──────▶│ (warm or cold)
 │                     │                   │ watch Ready        │                    │
 │                     │                   │◀───status: Ready───┤                    │
 │                     │                   │ openClient(pod)    │                    │
 │                     │                   ├─session.create────────────────────────▶│
 │                     │                   │◀──sessionID────────────────────────────┤
 │                     │                   ├─event.subscribe (SSE)──────────────────▶│
 │                     │                   │ thread.setState({botID, agentProfileID, sessionID})│
 │                     │                   ├─promptAsync(agent+msg)──────────────────▶│
 │                     │   "spinning up…"  │                                         │
 │                     │◀──post(stream)────┤◀────message.part.updated (delta)────────┤
 │◀────token stream────┤                   │                                         │
 │                     │                   │◀────session.idle────────────────────────┤
 │                     │                   │ stream.close()                          │
```

### 5.2 Subsequent mention in the same thread

```diagram
User                Chat Platform     Orchestrator        Sandbox Pod
 │  "@bot also Y"      │                   │                    │
 ├────────────────────▶│                   │                    │
 │                     ├──webhook─────────▶│                    │
 │                     │                   │ thread.getState()  │
 │                     │                   │ openClient(podFQDN)│
 │                     │                   ├─session.status────▶│
 │                     │                   │◀──{type:"idle"}────┤
 │                     │                   ├─promptAsync(sessionID, agent)▶│
 │                     │   stream tokens   │◀──SSE deltas───────┤
 │◀────token stream────┤◀──────────────────┤                    │
```

### 5.3 Cleanup

- **Soft expiry**: `claim.spec.lifecycle.ttlSecondsAfterFinished = 1800` — opencode session ends → pod marked finished → cleaned up after TTL.
- **Hard cap**: `claim.spec.lifecycle.shutdownTime` set on creation (e.g. now + 4h) — absolute upper bound.
- **Explicit**: a `/agent stop` slash command, or `onAction` from a "Stop" button on a status card → `releaseClaim()`.
- **Reconciler**: periodic sweep deletes claims whose Chat SDK thread has been inactive beyond the policy.

---

## 6. Configuration Model

The old single `Profile` concept is superseded by four explicit records. This keeps cluster/runtime policy separate from opencode-native agent behavior.

### 6.1 Bot

Chat-facing identity and webhook target.

```ts
type Bot = {
  id: string
  slug: string                 // used in /agents/:botSlug/webhooks/:adapter
  displayName: string
  adapters: {
    telegram?: {
      botTokenEnv?: string      // env var containing this Telegram bot token
      secretTokenEnv?: string   // env var containing this webhook secret token
      userName?: string
    }
  }
  sandboxProfileID: string
  defaultAgentProfileID: string
  enabled: boolean
}
```

There is no global default bot. A webhook request without a valid `botSlug` is rejected before adapter processing/provisioning.

### 6.2 SandboxProfile

Cluster/runtime boundary. This is admin-owned and intentionally small in alpha.

```ts
type SandboxProfile = {
  id: string
  slug: string
  templateName: string         // SandboxTemplate.metadata.name
  warmpool: "default" | "none" | (string & {})
  enabled: boolean
}
```

Future versions may add policy fields such as allowed models, tools, MCP servers, env keys, PVC classes, and permission bounds. Alpha defers that policy engine and relies on `SandboxTemplate`, RBAC, network policy, image contents, and injected secrets as the hard boundary.

### 6.3 OpencodeConfig

Mutable JSON document injected into the sandbox as `OPENCODE_CONFIG_CONTENT`.

```ts
type OpencodeConfigRecord = {
  id: string
  slug: string
  displayName: string
  config: Record<string, unknown>
  configHash: string
  updatedAt: string
  enabled: boolean
}
```

The document is opencode-native. Agent definitions live in `config.agent.<name>` and may specify `prompt`, `model`, `tools`, `permission`, `mode`, temperature/options, MCP, providers, and other opencode settings.

### 6.4 AgentProfile

Selectable agentbay metadata that points to a named opencode agent inside an `OpencodeConfig`.

```ts
type AgentProfile = {
  id: string
  slug: string
  displayName: string
  opencodeConfigID: string
  opencodeAgentName: string
  claimEnv: Array<{ name: string, valueFromEnv: string }>
  enabled: boolean
}
```

`AgentProfile` does not duplicate system prompt/model/tool fields. The referenced opencode agent definition is the source of truth. `claimEnv` stores env-var references only; secret values stay in the orchestrator environment and are resolved when creating a `SandboxClaim`.

### 6.5 Bot-Agent Allow List

Bots bind a sandbox profile and an allowed set of agent profiles.

```ts
type BotAgentProfile = {
  botID: string
  agentProfileID: string
}
```

Alpha uses `bot.defaultAgentProfileID`. Later milestones can resolve different allowed agent profiles by principal, channel, repo, slash command, or interactive selection.

### 6.6 Thread → Runtime Mapping

This dynamic mapping is stored through Chat SDK state.

```text
slack:T012345/C0XXX/1731XXXXXX  → { botID, sandboxProfileID, agentProfileID, opencodeConfigID, claimName, podFQDN, sessionID }
github:owner/repo/PR#142        → { botID, sandboxProfileID, agentProfileID, opencodeConfigID, claimName, podFQDN, sessionID }
```

Thread state is sticky. The initiating message selects the runtime; subsequent messages reuse it. If `opencodeConfigHash` changes while a thread is active, alpha behavior should restart the sandbox/session before continuing so the new injected config is applied deterministically.

---

## 7. Data & Control Plane Boundaries

| Responsibility | Lives in |
|---|---|
| Bots, sandbox profiles, agent profiles, opencode config docs | Orchestrator DB |
| Pod spec, image, network policy | `SandboxTemplate` (admin-owned) |
| Per-tenant quotas | `ResourceQuota` on the tenant namespace |
| Pre-warming | `SandboxWarmPool` (admin-owned, optional) |
| Per-session secrets (opencode password, model API keys) | Injected via `claim.spec.env` (template policy: `Allowed`) |
| Per-thread session continuity | Chat SDK state + opencode SQLite |
| Conversation history | opencode SQLite (PVC-backed for durability) |
| Streaming protocol | opencode SSE (`/event`) |

---

## 8. Key Design Decisions and Trade-offs

### D1. The Chat SDK webhook handler **is** the API.
We do not build a separate REST API for sandbox management. The chat platforms are the entry points; the orchestrator is a webhook server. This collapses two services into one and inherits per-platform identity, threading, dedupe, and streaming for free.

### D2. One opencode server per Pod, one Pod per thread.
- ✅ Matches user mental model ("the agent is in this thread").
- ✅ Sandbox is already singleton — no impedance mismatch.
- ✅ Permission/network blast radius is one conversation.
- ⚠️ Cannot fan out parallel prompts in the same thread; check `session.status` before issuing.
- ⚠️ Long-running threads consume a Pod for their lifetime. Mitigated by TTL + reconciler.

### D3. Always go through `SandboxClaim`, never `Sandbox` directly.
This preserves the admin's `SandboxTemplate` policy (network, env injection, resource limits). The orchestrator's RBAC should *not* grant create on `Sandbox`.

### D4. opencode in headless `serve` mode, not embedded.
- ✅ Strong process isolation: agent crash ≠ orchestrator crash.
- ✅ Single, stable HTTP/SSE contract.
- ✅ Sandbox network policy is enforced naturally (orchestrator → Pod is the only allowed ingress path).
- ⚠️ Requires HTTP roundtrips for every interaction (negligible inside a cluster).

### D5. Session continuity = opencode `sessionID` + Chat SDK `thread.setState`.
- ✅ No custom persistence layer.
- ⚠️ If the Pod dies (eviction, expiry) before the thread ends, `sessionID` is invalid. Two options:
  - **PVC-backed SQLite** per thread (mount `~/.opencode` at a `volumeClaimTemplates` entry).
  - **Summary fallback**: store an opencode-generated summary in thread state; seed a fresh session with it on resume.
  - We will start with the **summary fallback** (simpler) and add PVCs only if it proves insufficient.

### D5b. opencode config is injected per claim and enforced.
- The orchestrator forwards LLM provider credentials from its **own** environment into each `SandboxClaim.spec.env`. Global `AGENTBAY_CLAIM_ENV_KEYS` entries are defaults; `AgentProfile.claimEnv` can add or override env per agent without storing secret values in the database.
- The resolved `OpencodeConfig` JSON is injected as `OPENCODE_CONFIG_CONTENT`. It contains the named opencode agent definitions that `AgentProfile` records point to.
- On every prompt, the orchestrator passes `agent: opencodeAgentName` to `session.promptAsync()`. opencode's agent config owns prompt/model/tools/permission behavior.
- In opencode's config merge order this injected layer sits **above** any `opencode.json` or `.opencode/` directory shipped inside the repo checked out into the sandbox, so a workspace cannot silently override the platform's chosen agent config.
- For absolute cluster-wide overrides (e.g. blocking certain providers regardless of bot/agent config), an admin can mount a ConfigMap at `/etc/opencode/opencode.json` via the `SandboxTemplate`; that managed-path config wins over `OPENCODE_CONFIG_CONTENT`.

### D6. Authentication is per-claim shared secret.
- Generated by the orchestrator on claim creation, injected via `claim.spec.env.OPENCODE_SERVER_PASSWORD`, stored in Chat SDK thread state.
- Cluster network policy already restricts who can reach the Pod; the password is defense in depth.
- This requires `SandboxTemplate.spec.envVarsInjectionPolicy: Allowed`.

### D7. Warm pools are an optimization, not a requirement.
- First implementation: every claim is cold (`warmpool: "none"`). Cold start ≈ pull image + start opencode ≈ a few seconds. We post a "spinning up…" message and edit it.
- Second iteration: introduce a `SandboxWarmPool` per popular `SandboxProfile` once latency complaints arise.

### D8. No wrapper CRD / operator (yet).
A custom CRD that translates to `SandboxClaim` would add an operator to the system and a Kubernetes-shaped API surface. We don't need it: chat is the API. Revisit only if a non-chat consumer of agent provisioning emerges.

### D9. Alpha binds capability to thread, not principal.
- Alpha deliberately reuses one sandbox/session for a chat thread, following the runtime selected by the initiating message.
- This is not a complete security boundary. Anyone who can post in the thread can interact with the existing sandbox and its selected opencode agent.
- Privileged bots should be used in DMs or restricted channels until principal-bound sessions, approval flows, or per-message authorization are added.

### D10. SandboxProfile policy bounding is deferred.
- The model keeps `SandboxProfile` as the place where policy bounds will live, but alpha only stores `templateName`, `warmpool`, and `enabled`.
- We rely on Kubernetes objects (`SandboxTemplate`, RBAC, network policy, image contents, Secrets) for the hard boundary in alpha.
- Future policy validation can reject opencode configs that exceed the sandbox profile's allowed models, tools, MCP servers, permission rules, env keys, or storage/network classes.

---

## 9. Repository Layout (proposed)

```
agentbay/
├── DESIGN.md                       ← this file
├── README.md                       ← quickstart for ops
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                    ← bootstrap: build Chat, register handlers, start http
│   ├── config.ts                   ← env parsing
│   ├── runtime/
│   │   ├── store.ts                ← DB-backed bot/runtime/config lookup
│   │   ├── resolver.ts             ← botSlug + thread/message → resolved runtime
│   │   └── types.ts                ← Bot, SandboxProfile, OpencodeConfig, AgentProfile
│   ├── chat/
│   │   ├── handlers.ts             ← onNewMention, onSubscribedMessage, …
│   │   └── webhooks.ts             ← /agents/:botSlug/webhooks/:adapter route wiring
│   ├── sandbox/
│   │   ├── client.ts               ← @kubernetes/client-node setup
│   │   ├── manager.ts              ← claimFor(), releaseClaim()
│   │   ├── reconciler.ts           ← periodic orphan sweep
│   │   └── naming.ts               ← deterministic claim names from thread ids
│   ├── agent/
│   │   ├── client.ts               ← per-claim opencode client factory
│   │   ├── runner.ts               ← prompt → SSE → AsyncIterable<string>
│   │   └── config.ts               ← opencode config injection helpers
│   └── state/
│       └── adapter.ts              ← Redis state adapter wiring
├── deploy/
│   ├── orchestrator.yaml           ← Deployment + Service + ServiceAccount
│   ├── rbac.yaml                   ← Role/RoleBinding for SandboxClaim
│   └── examples/
│       ├── sandbox-template.yaml   ← reference SandboxTemplate
│       └── warmpool.yaml           ← reference SandboxWarmPool
└── .agents/skills/
    ├── using-agent-sandbox/        ← already exists
    └── chat-sdk/                   ← already exists
```

---

## 10. Implementation Roadmap

Each milestone is independently demoable.

### M1 — Hello sandbox (no chat)
- Stand up the cluster, install `agent-sandbox` CRDs and controllers.
- Hand-write a `SandboxTemplate` with an opencode image.
- From a local script, create a `SandboxClaim`, wait for Ready, hit `GET /global/health` on the Pod via port-forward.
- **Deliverable:** proof that we can drive opencode in a sandbox at all.

### M2 — Hello orchestrator (one platform, hardcoded runtime)
- TS service with `@kubernetes/client-node` + `@opencode-ai/sdk` + Chat SDK with **only Slack adapter**.
- One bot, one sandbox profile, one opencode config, one agent profile, hardcoded or seeded.
- Webhook path includes bot slug: `/agents/:botSlug/webhooks/slack`.
- `onNewMention` creates a claim, opens a session, prompts, streams response.
- No state persistence yet (one-shot per mention; new claim every time).
- **Deliverable:** mention the bot in Slack, get an opencode-driven answer.

### M3 — Thread continuity
- Wire Redis state adapter.
- Persist resolved runtime IDs plus `{claimName, podFQDN, sessionID, password}` in thread state.
- `onSubscribedMessage` reuses the same sandbox + session.
- Add TTL + reconciler.
- **Deliverable:** multi-turn conversation in a single sandbox.

### M4 — DB-backed bots and opencode agents
- Add GitHub and Linear adapters.
- DB-backed `Bot`, `SandboxProfile`, `OpencodeConfig`, `AgentProfile`, and bot-agent allow-list records.
- Inject selected `OpencodeConfig` as `OPENCODE_CONFIG_CONTENT`.
- Pass selected `opencodeAgentName` to `session.promptAsync()` on every message.
- Remove global default bot/profile path behavior; all webhooks require `/agents/:botSlug/webhooks/:adapter`.
- Slash commands for control: `/agent stop`, `/agent status`.
- **Deliverable:** review-bot on GitHub PRs, triage-bot in Linear, generic chat-bot in Slack — same orchestrator.

### M5 — Hardening
- Warm pools for hot sandbox profiles.
- Per-tenant namespaces and `ResourceQuota`s.
- Summary-fallback session resume after Pod eviction.
- Observability: structured logs, metrics on claim age / session duration / cost.
- Principal-bound sessions, approval flows, or per-message authorization for privileged bots.
- SandboxProfile policy validation for opencode configs.
- **Deliverable:** ready to invite real teams.

---

## 11. Open Questions (to revisit during implementation)

1. **Workspace seeding.** When the bot is mentioned on a GitHub PR, who clones the repo into the Pod? Options: an `initContainer` in the template, an early `session.prompt` that invokes git tools, or a pre-baked image per repo. Likely: `initContainer` driven by claim env vars.
2. **Model API keys.** Inject per-claim (more isolation, harder rotation) or mount a shared Secret into the template (simpler, less isolated)? Default: per-claim via env injection.
3. **Per-tenant cost accounting.** opencode reports tokens/cost in `StepFinishPart`. Do we aggregate in the orchestrator and emit metrics labeled by chat-workspace?
4. **Permission UX.** opencode emits `permission.updated` events for tool calls. Auto-allow within the sandbox (it's already isolated) or surface as an interactive Chat SDK card (`Button` with callback)? Default: auto-allow inside the sandbox; the sandbox boundary is the trust boundary.
5. **Multi-repo / multi-workspace per thread.** Out of scope for v1. One thread = one working directory = one Pod.
6. **Config update semantics.** Alpha restarts active sandboxes when the selected `OpencodeConfig` hash changes. Later, can we safely patch opencode config live for some fields and avoid restarts?
7. **Agent selection UX.** Alpha uses each bot's default agent profile. Later, should agent selection happen through slash commands, buttons/selects, principal policy, channel/repo policy, or all of the above?
8. **Policy bounds.** Which `SandboxProfile` policy fields are worth enforcing first: model allow-list, tool allow-list, MCP allow-list, env-key allow-list, permission ceiling, storage class, or network class?

---

## 12. Glossary

| Term | Meaning |
|---|---|
| **Bot** | Chat-facing agentbay identity addressed by `/agents/:botSlug/webhooks/:adapter`. |
| **SandboxProfile** | Admin-owned runtime boundary selecting a `SandboxTemplate` and warm pool. Future home for policy bounds. |
| **OpencodeConfig** | opencode-native JSON config document injected as `OPENCODE_CONFIG_CONTENT`; contains named opencode agent definitions. |
| **AgentProfile** | agentbay metadata that points to a named opencode agent inside an `OpencodeConfig`. |
| **Claim** | A `SandboxClaim` Kubernetes object — the orchestrator's request for a sandbox. |
| **Sandbox** | The `Sandbox` Kubernetes object created by the agent-sandbox controller in response to a claim, and the Pod it owns. |
| **Session** | An opencode session — a persistent conversation in the Pod's SQLite. |
| **Thread** | A conversation context in a chat platform (Slack thread, GitHub PR comment chain, Linear comment thread). The unit of mapping to a sandbox. |
| **Orchestrator** | The single TypeScript service we are building. |

---

*This document is the source of truth. Decisions that contradict it must update it.*
