# agentbay — Design Document

> **Status:** Guiding design. Implementation has not started.
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
| Platform admins | Declarative bot profiles, network isolation, resource quotas — managed via Kubernetes CRDs. |
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
│  │  Chat SDK      │──▶│  Routing /        │──▶│  Sandbox Manager         │   │
│  │  (all adapters)│   │  Profile Resolver │   │  (k8s client)            │   │
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

- **One `Chat` instance**, all adapters registered at boot.
- One handler per relevant event: `onNewMention`, `onSubscribedMessage`, `onDirectMessage`, optionally `onSlashCommand` and `onAction` for control surfaces (e.g., a "stop" button).
- **State**: persisted via a state adapter (Redis or equivalent) keyed by thread.
- **Per-thread state shape** (stored via `thread.setState`):
  ```ts
  type ThreadState = {
    claimName: string        // SandboxClaim.metadata.name
    podFQDN: string          // headless service FQDN of the sandbox pod
    sessionID: string        // opencode session id
    profileID: string        // which bot profile is bound to this thread
    createdAt: string        // ISO8601
  }
  ```

### 4.2 Routing / Profile Resolver

- Static configuration (TS object or YAML loaded at boot) maps **bot identity → profile**.
- A **profile** is the agentbay-level concept; it bundles:
  - `templateName` — the `SandboxTemplate` to claim from
  - `warmpool` — `"default" | "none" | <named pool>`
  - `systemPrompt` — prelude prepended to the first opencode prompt
  - `defaultModel` — opencode `providerID`/`modelID`
  - `permissions` — opencode permission policy passed via `session.update`
- Profile selection is a pure function of the chat event (which `userName` was mentioned, optionally which channel/repo).

### 4.3 Sandbox Manager

- Wraps `@kubernetes/client-node`.
- Single ServiceAccount with RBAC scoped to `sandboxclaims` (verbs: `create`, `get`, `list`, `watch`, `delete`) in tenant namespaces.
- Operations:
  - `claimFor(thread, profile) → { claimName, podFQDN, password }`
    - Computes a deterministic claim name from `thread.id` (e.g. `sha256(thread.id)[:16]`).
    - Checks if the claim already exists; if so, returns its current details.
    - Otherwise creates the claim with the right template, env vars, and lifecycle.
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
  2. `session.update()` to apply profile permissions / title
  3. `session.promptAsync()` with prelude + user message
  4. `event.subscribe()` and translate to `AsyncIterable<string>` for `thread.post(stream)`
  5. Persist `sessionID` in thread state
- **Subsequent messages**: skip 1–2; reuse `sessionID`.

---

## 5. End-to-End Flow

### 5.1 First mention in a new thread

```diagram
User                Chat Platform     Orchestrator        kube-apiserver       Sandbox Pod
 │  "@bot do X"        │                   │                    │                    │
 ├────────────────────▶│                   │                    │                    │
 │                     ├──webhook─────────▶│                    │                    │
 │                     │                   │ resolveProfile()   │                    │
 │                     │                   ├─claim.create──────▶│                    │
 │                     │                   │                    ├─schedule pod──────▶│ (warm or cold)
 │                     │                   │ watch Ready        │                    │
 │                     │                   │◀───status: Ready───┤                    │
 │                     │                   │ openClient(pod)    │                    │
 │                     │                   ├─session.create────────────────────────▶│
 │                     │                   │◀──sessionID────────────────────────────┤
 │                     │                   │ thread.setState({claimName, sessionID})│
 │                     │                   ├─promptAsync(prelude+msg)───────────────▶│
 │                     │                   ├─event.subscribe (SSE)──────────────────▶│
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
 │                     │                   ├─prompt(sessionID)─▶│
 │                     │   stream tokens   │◀──SSE deltas───────┤
 │◀────token stream────┤◀──────────────────┤                    │
```

### 5.3 Cleanup

- **Soft expiry**: `claim.spec.lifecycle.ttlSecondsAfterFinished = 1800` — opencode session ends → pod marked finished → cleaned up after TTL.
- **Hard cap**: `claim.spec.lifecycle.shutdownTime` set on creation (e.g. now + 4h) — absolute upper bound.
- **Explicit**: a `/agent stop` slash command, or `onAction` from a "Stop" button on a status card → `releaseClaim()`.
- **Reconciler**: periodic sweep deletes claims whose Chat SDK thread has been inactive beyond the policy.

---

## 6. The Two Identity Maps

These are the only persistent mappings the orchestrator owns.

### 6.1 `bot-profile` (static, in code)
```
mention "@triage-bot"   → profile: triage
mention "@review-bot"   → profile: pr-review
slash "/refactor"       → profile: refactor
```

### 6.2 `thread → sandbox` (dynamic, in Chat SDK state)
```
slack:T012345/C0XXX/1731XXXXXX  → { claimName, podFQDN, sessionID, profileID }
github:owner/repo/PR#142        → { claimName, podFQDN, sessionID, profileID }
```

Everything else (template contents, network policy, model keys, image versions) lives in Kubernetes objects managed by platform admins, **not** in the orchestrator's code.

---

## 7. Data & Control Plane Boundaries

| Responsibility | Lives in |
|---|---|
| Bot profiles → templates | Orchestrator config (TS) |
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
- The orchestrator forwards LLM provider credentials from its **own** environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) into each `SandboxClaim.spec.env`. Today the orchestrator must have the secrets; tighter isolation (per-template `envFrom` Secret) is a later milestone.
- Profile-level opencode settings (model, allowed tools, MCP servers, permissions, …) are serialized to JSON and injected as `OPENCODE_CONFIG_CONTENT`. In opencode's config merge order this layer sits **above** any `opencode.json` or `.opencode/` directory shipped inside the repo checked out into the sandbox, so a workspace cannot silently override the platform's choice of model or permission policy.
- For absolute cluster-wide overrides (e.g. blocking certain providers regardless of profile), an admin can mount a ConfigMap at `/etc/opencode/opencode.json` via the `SandboxTemplate`; that managed-path config wins over `OPENCODE_CONFIG_CONTENT`.

### D6. Authentication is per-claim shared secret.
- Generated by the orchestrator on claim creation, injected via `claim.spec.env.OPENCODE_SERVER_PASSWORD`, stored in Chat SDK thread state.
- Cluster network policy already restricts who can reach the Pod; the password is defense in depth.
- This requires `SandboxTemplate.spec.envVarsInjectionPolicy: Allowed`.

### D7. Warm pools are an optimization, not a requirement.
- First implementation: every claim is cold (`warmpool: "none"`). Cold start ≈ pull image + start opencode ≈ a few seconds. We post a "spinning up…" message and edit it.
- Second iteration: introduce a `SandboxWarmPool` per popular profile once latency complaints arise.

### D8. No wrapper CRD / operator (yet).
A custom CRD that translates to `SandboxClaim` would add an operator to the system and a Kubernetes-shaped API surface. We don't need it: chat is the API. Revisit only if a non-chat consumer of agent provisioning emerges.

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
│   ├── profiles.ts                 ← bot-profile registry
│   ├── chat/
│   │   ├── handlers.ts             ← onNewMention, onSubscribedMessage, …
│   │   └── webhooks.ts             ← framework route wiring (Hono/Express)
│   ├── sandbox/
│   │   ├── client.ts               ← @kubernetes/client-node setup
│   │   ├── manager.ts              ← claimFor(), releaseClaim()
│   │   ├── reconciler.ts           ← periodic orphan sweep
│   │   └── naming.ts               ← deterministic claim names from thread ids
│   ├── agent/
│   │   ├── client.ts               ← per-claim opencode client factory
│   │   ├── runner.ts               ← prompt → SSE → AsyncIterable<string>
│   │   └── permissions.ts          ← profile → opencode session config
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

### M2 — Hello orchestrator (one platform, hardcoded profile)
- TS service with `@kubernetes/client-node` + `@opencode-ai/sdk` + Chat SDK with **only Slack adapter**.
- One profile, hardcoded.
- `onNewMention` creates a claim, opens a session, prompts, streams response.
- No state persistence yet (one-shot per mention; new claim every time).
- **Deliverable:** mention the bot in Slack, get an opencode-driven answer.

### M3 — Thread continuity
- Wire Redis state adapter.
- Persist `{claimName, podFQDN, sessionID, password}` in thread state.
- `onSubscribedMessage` reuses the same sandbox + session.
- Add TTL + reconciler.
- **Deliverable:** multi-turn conversation in a single sandbox.

### M4 — Multi-platform & multi-profile
- Add GitHub and Linear adapters.
- Profile registry + per-profile template / system prompt / model.
- Slash commands for control: `/agent stop`, `/agent status`.
- **Deliverable:** review-bot on GitHub PRs, triage-bot in Linear, generic chat-bot in Slack — same orchestrator.

### M5 — Hardening
- Warm pools for hot profiles.
- Per-tenant namespaces and `ResourceQuota`s.
- Summary-fallback session resume after Pod eviction.
- Observability: structured logs, metrics on claim age / session duration / cost.
- **Deliverable:** ready to invite real teams.

---

## 11. Open Questions (to revisit during implementation)

1. **Workspace seeding.** When the bot is mentioned on a GitHub PR, who clones the repo into the Pod? Options: an `initContainer` in the template, an early `session.prompt` that invokes git tools, or a pre-baked image per repo. Likely: `initContainer` driven by claim env vars.
2. **Model API keys.** Inject per-claim (more isolation, harder rotation) or mount a shared Secret into the template (simpler, less isolated)? Default: per-claim via env injection.
3. **Per-tenant cost accounting.** opencode reports tokens/cost in `StepFinishPart`. Do we aggregate in the orchestrator and emit metrics labeled by chat-workspace?
4. **Permission UX.** opencode emits `permission.updated` events for tool calls. Auto-allow within the sandbox (it's already isolated) or surface as an interactive Chat SDK card (`Button` with callback)? Default: auto-allow inside the sandbox; the sandbox boundary is the trust boundary.
5. **Multi-repo / multi-workspace per thread.** Out of scope for v1. One thread = one working directory = one Pod.

---

## 12. Glossary

| Term | Meaning |
|---|---|
| **Profile** | agentbay-level configuration that bundles a `SandboxTemplate` + opencode session settings + system prompt. |
| **Claim** | A `SandboxClaim` Kubernetes object — the orchestrator's request for a sandbox. |
| **Sandbox** | The `Sandbox` Kubernetes object created by the agent-sandbox controller in response to a claim, and the Pod it owns. |
| **Session** | An opencode session — a persistent conversation in the Pod's SQLite. |
| **Thread** | A conversation context in a chat platform (Slack thread, GitHub PR comment chain, Linear comment thread). The unit of mapping to a sandbox. |
| **Orchestrator** | The single TypeScript service we are building. |

---

*This document is the source of truth. Decisions that contradict it must update it.*
