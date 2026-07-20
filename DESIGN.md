# agentbay - Architecture and Product Definition

> **Status:** Source of truth for agentbay architecture.
> **Audience:** Engineers, operators, agent authors, and AI coding agents contributing to this repository.

## 1. Definition

**agentbay is a platform for event-driven asynchronous agents.**

An immutable agent definition is invoked by an event through an enabled immutable binding version, runs asynchronously in an isolated workspace, and publishes durable results.

Agent authors configure agents deeply through native OpenCode configuration: models, providers, prompts, tools, MCP servers, permissions, and runtime behavior. Operators bind those agents to external events such as pull requests, issues, Grafana alerts, schedules, chat messages, queues, and generic webhooks. Agentbay admits and persists those events, plans durable executions, and runs them in isolated Kubernetes workloads at large scale.

Chat is one trigger and result destination among many. Kubernetes is the execution substrate, not the product model.

### 1.1 Core promise

| Audience | Promise |
|---|---|
| Agent authors | Define a capable OpenCode agent once, version it, and invoke it from many event sources. |
| Integration authors | Add triggers and result destinations through small, stable connector contracts. |
| Platform operators | Run agents with explicit quotas, identities, credentials, network policy, retention, and auditability. |
| Application teams | Turn operational and development events into asynchronous, observable agent work without owning agent infrastructure. |
| End users | Receive useful results where work already happens: GitHub, Grafana, chat, ticketing systems, or APIs. |

### 1.2 Non-goals

Agentbay is not:

- A new agent runtime. OpenCode owns the agent loop and native agent configuration.
- A general-purpose workflow engine. Agentbay may integrate with one when durable multi-stage workflows justify it.
- A chat bot framework. Chat is an integration, not the architecture.
- A Kubernetes operator as its primary product API. Users reason about events, agents, and executions, not Pods.
- A source of truth for secrets. It references credentials managed by a secret manager or workload identity system.
- An exactly-once distributed system. It provides effective-once behavior on top of at-least-once delivery.

## 2. Guiding Principles

1. **Events are inputs, not conversations.** A conversation may emit events, but no chat-specific abstraction belongs in the execution core.
2. **Executions are durable records, not handler calls.** Every accepted invocation remains inspectable and recoverable across process failures.
3. **Profiles are immutable capability definitions.** Every execution resolves an exact profile version and records the resolved configuration.
4. **Triggers and destinations are connectors around a stable core.** Adding an integration must not modify sandbox or OpenCode orchestration.
5. **Ingress is fast and asynchronous.** A webhook is authenticated, persisted, deduplicated, and acknowledged without waiting for a Pod.
6. **Delivery is at least once and idempotent.** Source events, executions, and result deliveries have stable idempotency keys.
7. **Kubernetes supplies isolation and elasticity, not business-state persistence.** Postgres and the durable bus own workflow state.
8. **Every execution is bounded.** It has a timeout, resource limits, cancellation semantics, retention policy, and attributable owner.
9. **Bindings may reduce capability but never expand it.** Profile policy is an upper bound.
10. **Workspace preparation is deterministic platform work.** Repository checkout, artifact materialization, and credentials are not delegated to prompts.
11. **Observability is part of the product.** Queue time, provisioning, model use, tool calls, outputs, and delivery are visible per execution.
12. **Scale is controlled, not accidental.** Queue depth does not translate directly into unbounded Pod creation.
13. **Execution creation is binding-only.** Connectors and callers admit normalized events; enabled immutable binding versions are the sole mechanism that creates executions. There is no direct execution-submission path.
14. **Delegation is event-driven.** An agent delegates by using ordinary tools or MCP servers to cause an externally observable effect that a connector normalizes as a new event. Another binding may consume that event; Agentbay does not require a source-specific delegation MCP server or tool.
15. **Ingress data is policy-neutral.** Connectors authenticate deliveries and project bounded source data into events. Core matching, correlation, creation, and wake behavior operate on arbitrary event data and do not encode issues, pull requests, labels, comments, reviews, or other vendor concepts.
16. **Waiting is durable; hibernation is optional.** Postgres owns event waits and continuation state. Suspending a Kubernetes sandbox may reduce resource use while waiting, but must never be the only record of what can wake an execution.
17. **Workflow policy is configuration.** Repository-specific routing, labels, roles, model selection, and review loops belong in immutable profiles and bindings. Reference factories live under `examples/`; they are not hard-coded control-plane behavior.

## 3. Domain Model

The core path is:

```text
Event -> Trigger -> Binding -> Execution -> Result -> Destination
```

### 3.1 AgentProfile

A versioned, immutable definition of an agent and the maximum capabilities it may receive. It contains native OpenCode configuration plus execution policy such as image, resources, timeout, workspace access, connection allow-list, network class, permission policy, and retention.

Changing a profile creates a new version. Existing executions continue to reference the original version.

### 3.2 Connection

A named reference to an external service identity or credential policy, for example `github-production`, `grafana-readonly`, or `anthropic-team-a`. Connections describe how a connector or execution obtains short-lived access. They never contain secrets in exported profile or binding documents.

The generic management surface creates and reads connection metadata with `POST /v1/connections` and `GET /v1/connections/:connectionID`. Creation accepts `{ id, type }`; neither request nor response contains credential material. An agent profile grants a connection to one template-owned sidecar with `connections: [{ id, sidecar }]`; profiles cannot supply sidecar images, commands, volumes, or Secret names. This keeps workload composition under the platform operator's immutable `SandboxTemplate` rather than profile-author control.

### 3.3 Trigger

A configured instance of an event connector. It defines the connector type, source-specific configuration, authentication policy, and connection references. Examples include a `github.app.webhook`, a Grafana alert webhook, a cron schedule, or an SQS subscription. The GitHub trigger configuration references the environment-variable name containing its webhook secret; it never stores the secret itself and has no workflow policy. Event selection and execution policy belong to bindings and profiles.

### 3.4 Binding

An immutable versioned connection from a trigger to an exact agent profile version. In V1 it defines:

- One to 32 exact event-type strings
- Zero to 16 conjunctive filters over event `data`
- A literal prompt with `includeEvent` set to `none`, `data`, or `envelope`
- An exact profile version
- An empty workspace

Bindings are configuration, not execution history. A published binding version is immutable and can be disabled. Only enabled versions participate in matching, and each event can create at most one execution for each matching binding version.

### 3.5 Event

An immutable, normalized input represented with a CloudEvents envelope. Agentbay retains source identity, normalized data, deduplication information, and a reference to the raw source payload when required.

One source delivery may normalize into zero, one, or multiple events according to its connector contract. `github.app.webhook` deliberately normalizes each delivery into zero or one event: unsupported event/action pairs produce none. One event may match multiple bindings and therefore produce multiple executions.

Connectors and API callers both enter the execution system at this normalized-event boundary. Neither can create an execution directly.

### 3.6 Execution

The durable record of one agent invocation. It records the event, binding, exact profile version, resolved policy, state transitions, attempts, Kubernetes workload, OpenCode session, usage, costs, artifacts, and final result.

Execution is the primary unit of scheduling, isolation, cancellation, retry, auditing, and billing.

### 3.7 Workspace

The deterministic file and context environment materialized for an execution. A workspace may come from an empty directory, Git revision, object-storage archive, previous execution snapshot, or persistent project workspace.

### 3.8 Result

A structured execution outcome independent of any destination. It may include a human-readable summary, status, annotations, proposed patch, machine-readable findings, usage, and artifact references.

### 3.9 Destination

A configured result connector such as a GitHub Check, pull-request comment, Grafana incident note, Slack message, generic webhook, ticket, queue, or object-storage location.

Deliveries are durable records with retry and dead-letter behavior separate from execution success.

### 3.10 Tenant

The ownership and policy boundary for profiles, connections, triggers, bindings, executions, quotas, and costs. Even if the first release is single-tenant, all durable records should carry `tenant_id` so multi-tenancy does not require redesigning identity and scheduling.

### 3.11 EventWait

A durable, bounded subscription registered by an execution that has reached a safe continuation boundary. It records exact event types, generic correlation and filter predicates over normalized event data, one-shot or repeated consumption policy, deadline, and continuation input policy. A matching event may wake an existing execution instead of, or in addition to, creating new executions.

Event waits are core records and contain no connector-specific fields. A GitHub configuration may correlate on a repository and pull-request number; a Linear configuration may correlate on a team and issue identifier; both compile to the same bounded event predicates.

## 4. V1 Configuration Example

The implemented V1 API publishes each resource separately. The following documents show the request bodies; route parameters supply profile and binding IDs.

```yaml
# POST /v1/agent-profiles/security-reviewer/versions
version: 1
definition:
  schemaVersion: 1
  runtime:
    type: opencode
    agent: review
    opencodeConfig:
      model: anthropic/claude-sonnet
      agent:
        review:
          prompt: Review the supplied event for security and correctness.
  sandbox:
    templateName: opencode
    warmPool: opencode-developer-pool
  connections:
    - id: github-production
      sidecar: github-token-broker
  permissions:
    onRequest: fail
  timeoutSeconds: 1800
  retention:
    sandboxSecondsAfterFinished: 0
---
# POST /v1/triggers
id: engineering-github
type: github.app.webhook
config:
  schemaVersion: 1
  webhookSecretEnv: AGENTBAY_GITHUB_WEBHOOK_SECRET_PRODUCTION
---
# POST /v1/bindings/review-new-pull-requests/versions
version: 1
triggerId: engineering-github
profile:
  id: security-reviewer
  version: 1
definition:
  schemaVersion: 1
  eventTypes:
    - com.github.pull_request.opened
    - com.github.pull_request.synchronize
  filter:
    all:
      - path: /repository/fullName
        op: eq
        value: acme/platform
  prompt:
    literal: Review the pull-request event below.
    includeEvent: data
  workspace:
    type: git
    repository:
      url:
        path: /pullRequest/head/repository/cloneUrl
    revision:
      commit:
        path: /pullRequest/head/sha
```

The profile and binding references are exact versions; V1 has no `latest` selector. Binding prompts are literal, not templates. When `includeEvent` is `data` or `envelope`, Agentbay appends canonical JSON between untrusted-event delimiters. V1 supports empty workspaces and public HTTPS Git workspaces selected from event `data` by RFC 6901 pointers. Git revisions must be full immutable 40-character SHA-1 commit object IDs, and repository DNS must resolve exclusively to public IPv4 addresses. Admission persists the canonical repository URL and commit on the execution; retries never resolve selectors or mutable refs again.

GitHub issue deliveries require trusted pre-admission enrichment because they
contain the default branch name but not its commit. If an enabled,
filter-matching binding selects
`/repository/defaultBranchRevision/commit`, ingress atomically persists the
unaltered normalized event and one `EventRevisionResolution` request, then
returns without creating executions. A fenced worker performs GitHub network I/O
outside database transactions using a selected-repository installation token
with `contents:read`. It validates repository ID, full name, canonical clone
URL, and default branch before resolving the branch ref. Completion atomically
persists the lowercase full SHA, marks the request succeeded, and creates the
matching executions from a trusted event projection. The original event data
and admission hash are never rewritten.

Resolution requests move through `PENDING`, `LEASED`, `RETRY_WAIT`, `SUCCEEDED`,
or `DEAD_LETTERED`. Lease tokens fence stale workers; expired leases are
claimable, and bounded attempts prevent permanent provider failures from
looping forever. Exact delivery replay returns the persisted event and its
current execution set without creating another request. Bindings are selected
at successful resolution time, and the recorded commit means the branch head at
resolution time. Agentbay does not attempt event-time ref reconstruction.
Execution timeouts begin at successful resolution, not webhook ingestion.

An immutable binding may define an `afterTurn` wait policy. Successful agent
turns never choose this disposition themselves. The fenced completion
transaction loads the execution's exact binding version, resolves bounded
primitive correlation values from the trusted originating event, marks the
attempt `SUCCEEDED`, inserts one active `EventWait`, and moves the execution
directly from `RUNNING` to `WAITING`. The wait policy's deadline becomes the
workflow deadline while waiting; active compute attempts remain bounded by the
deadline under which they were claimed. Waiting executions have no active lease.

## 5. High-Level Architecture

```mermaid
flowchart TB
    subgraph Sources[Event Sources]
        GitHub[GitHub]
        Grafana[Grafana]
        Chat[Chat Platforms]
        Cron[Schedules]
        Generic[Generic Webhooks]
        ExternalQueue[External Queues]
    end

    subgraph Connectors[Trigger Connectors]
        Push[Push Connectors]
        Pull[Polling Connectors]
        Subscription[Subscription Connectors]
        Scheduler[Scheduler]
    end

    subgraph Control[Agentbay Control Plane]
        Ingress[Event Admission]
        Normalize[Normalize and Validate]
        Match[Binding Matcher]
        Planner[Execution Planner]
        API[Management API and UI]
        Store[(Postgres)]
        Outbox[Transactional Outbox]
    end

    Bus[(Durable Event Bus)]
    Objects[(Object Storage)]
    Secrets[Secret Manager and Workload Identity]

    subgraph Execution[Agentbay Execution Plane]
        Dispatcher[Dispatcher]
        Admission[Quota and Policy Admission]
        Workspace[Workspace Provisioner]
        Sandbox[SandboxClaim or Job]
        OpenCode[OpenCode Runtime]
        Collector[Result Collector]
    end

    subgraph Results[Destination Connectors]
        GitHubResult[GitHub Checks and Comments]
        GrafanaResult[Grafana Incident Notes]
        ChatResult[Chat Messages]
        WebhookResult[Webhooks]
        QueueResult[Queues]
    end

    Sources --> Connectors --> Ingress
    Ingress --> Normalize --> Match --> Planner
    API --> Store
    Normalize --> Store
    Match --> Store
    Planner --> Store
    Planner --> Outbox --> Bus
    Bus --> Dispatcher --> Admission
    Admission --> Workspace --> Sandbox --> OpenCode --> Collector
    Secrets --> Connectors
    Secrets --> Sandbox
    Workspace <--> Objects
    Collector --> Store
    Collector --> Objects
    Collector --> Bus
    Bus --> Results
```

## 6. Control Plane

The control plane is always available, horizontally scalable, and inexpensive relative to agent execution. It must never hold an inbound webhook open while Kubernetes provisions work.

### 6.1 Event admission

Admission performs the following transaction boundary:

1. Identify the configured trigger from the ingress URL or subscription.
2. Authenticate and authorize the source.
3. Apply payload limits and reject malformed input.
4. Preserve the raw payload in object storage when retention policy requires it.
5. Normalize the source delivery into CloudEvents.
6. Derive and persist source deduplication keys.
7. Acknowledge accepted push requests quickly, normally with `202 Accepted`.

Connectors must not launch workloads directly.

The execution-creation invariant is strict: a connector or caller submits a normalized event to an enabled trigger, and admission evaluates enabled immutable binding versions. The transaction may persist zero or more executions, one for each matching create binding version, and may wake zero or more executions through matching wake bindings and active waits. No connector, source-specific agent tool, or internal caller creates or wakes executions outside this admission transaction.

The target admission transaction atomically persists the event, resolves replays, creates binding-selected executions, claims one-shot matching waits, appends wake events to their executions, queues continuations, and writes outbox records. Replay returns the original create and wake results without rematching current configuration. Connector policy may register a required event-scoped effect in the same transaction. The dispatcher excludes executions associated with an unpublished required effect, so deterministic source acknowledgment can complete before sandbox provisioning without making an external call inside the admission transaction.

### 6.2 Binding matching

The matcher selects enabled binding versions by tenant, trigger, and exact event-type equality, then evaluates every filter clause against event `data`. V1 supports at most 16 conjunctive clauses using RFC 6901 JSON Pointers and `eq`, `in`, `exists`, `contains`, or `containsAny`. Array predicates match only bounded arrays of JSON primitives, so configuration can route on projected collections such as labels without introducing connector-specific matching code. The language remains deterministic, size-bounded, non-recursive, and incapable of executing code.

Bindings have a configured disposition:

- **create:** create a new execution from an exact profile version, as implemented by V1.
- **wake:** consume a matching active wait and queue a continuation of its execution.
- **create-and-wake:** allow both behaviors when repository policy explicitly requires them.

Wake bindings additionally define generic correlation projections from event data and the waiting execution's durable context. They cannot name a Kubernetes workload or OpenCode session and cannot bypass an execution's registered wait policy.

The match result records the binding version used. Later edits do not change already planned work.

### 6.3 Execution planning

For each match, the planner:

1. Resolves an exact immutable agent profile version.
2. Validates binding restrictions against the profile's capability ceiling.
3. Renders bounded input and workspace templates from normalized event data.
4. Computes idempotency and concurrency keys.
5. Applies supersession and coalescing rules.
6. Creates the execution and initial state transition in Postgres.
7. Writes an execution-request message to the transactional outbox in the same transaction.

An outbox publisher moves committed messages to the durable bus. This prevents a committed execution from being lost between database insertion and queue publication.

For GitHub `issues.opened` and `pull_request.opened`, deployments may enable a required `eyes` reaction effect. The control-plane publisher mints a selected-repository installation token with exactly the corresponding `issues:write` or `pull_requests:write` permission, validates repository identity, and treats GitHub's created and already-present responses as success. The effect is event-scoped and idempotent across webhook replay. No App JWT or installation token is persisted in the event or outbox payload.

### 6.4 Management API

The implemented V1 management and ingress surface is:

```text
POST /v1/agent-profiles/:profileID/versions
GET  /v1/agent-profiles/:profileID/versions/:version
POST /v1/connections
GET  /v1/connections/:connectionID
POST /v1/triggers
GET  /v1/triggers/:triggerID
POST /v1/triggers/:triggerID/disable
POST /v1/bindings/:bindingID/versions
GET  /v1/bindings/:bindingID/versions/:version
POST /v1/bindings/:bindingID/versions/:version/disable
POST /v1/triggers/:triggerID/events
GET  /v1/executions/:id
POST /v1/executions/:id/cancel
POST /hooks/github/:triggerID
```

`POST /v1/triggers/:triggerID/events` is generic normalized CloudEvent trigger ingress, not a vendor webhook. It requires `Idempotency-Key`, accepts a structured CloudEvents 1.0 JSON envelope as `application/cloudevents+json` or `application/json`, and returns `202 Accepted` with the admitted event, all executions created by matching bindings, and a replay indicator. Zero matches is still an accepted event. Reusing a key for the same normalized request returns the original result as a replay; reusing it for different content returns `409 Conflict`. Once a trigger is disabled, any new event admission returns `404 Not Found`, including an event that would match no bindings. Because replay lookup precedes the enabled-trigger check at the durable admission boundary, an exact replay of an event already persisted may still return its original result with `202 Accepted` and `replayed: true`.

CLIs, CI systems, tests, and services use this same ingress with a configured `cloudevents.http` trigger and enabled binding. `POST /v1/executions` does not exist. Vendor-specific connectors authenticate and normalize source deliveries, then call the same admission boundary rather than creating executions themselves.

`POST /hooks/github/:triggerID` is the public ingress for a
`github.app.webhook` trigger and is the exception to bearer authentication on
the management API. GitHub supplies `X-Hub-Signature-256`; verification uses
the configured webhook secret and the exact raw request bytes before JSON
parsing. `X-GitHub-Delivery` is the stable source-delivery deduplication key, so
a redelivery cannot admit a second event or set of executions. The endpoint
acknowledges a supported delivery after admitting its zero or one normalized
event; it never creates an execution directly. Signed pings and unsupported
event/action pairs produce no event and return `204 No Content`. For supported
events, disabled-trigger behavior follows the durable admission semantics above:
an exact persisted replay may return `202`, while a new delivery returns `404`.

`GET /v1/executions/:id` returns the materialized current execution, its ordered
attempt records, and its append-only transition history. Execution state and
attempt status are intentionally separate: retries preserve earlier terminal
attempts while the execution advances through a later attempt. The history is
ordered by transition sequence and remains the audit record behind the current
materialized state.

`POST /v1/executions/:id/cancel` requires a JSON object whose `reason` field is
optional; `{}` requests cancellation without a caller-supplied reason. Work in
`AWAITING_APPROVAL`, like other work without an active attempt, can be finalized
immediately as `CANCELLED`. Active `PROVISIONING` or `RUNNING` work is durably
moved to `CANCEL_REQUESTED` before the worker is interrupted. Repeating the
request while the execution is `CANCEL_REQUESTED` or `CANCELLED` is idempotent.
`SUCCEEDED` is intentionally not cancellable because agent work has already
committed and the delivery lifecycle is not implemented; it returns `409
Conflict`. Non-cancellable terminal outcomes likewise retain their state and
return `409 Conflict`. Immediate or already-complete cancellation returns `200
OK` with state `CANCELLED`; active cancellation returns `202 Accepted` with
state `CANCEL_REQUESTED`. A `202` confirms durable acceptance, not immediate
workload deletion.

## 7. Canonical Event Model

Agentbay uses the CloudEvents 1.0 envelope. A normalized GitHub event is:

```json
{
  "specversion": "1.0",
  "id": "8d91f1c2-76c4-4a7d-9d3b-1a2b3c4d5e6f",
  "source": "https://github.com/acme/repo",
  "type": "com.github.pull_request.synchronize",
  "subject": "pulls/17",
  "datacontenttype": "application/json",
  "githubevent": "pull_request",
  "githubpayloadsha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "data": {
    "schemaVersion": 1,
    "deliveryId": "8d91f1c2-76c4-4a7d-9d3b-1a2b3c4d5e6f",
    "action": "synchronize",
    "installationId": 12345678,
    "repository": {
      "id": 1001,
      "fullName": "acme/repo",
      "cloneUrl": "https://github.com/acme/repo.git",
      "defaultBranch": "main",
      "private": false
    },
    "sender": {
      "id": 2001,
      "login": "octocat",
      "type": "User"
    },
    "pullRequest": {
      "number": 17,
      "title": "Harden webhook admission",
      "body": "Verify signatures over raw bytes.",
      "bodyTruncated": false,
      "draft": false,
      "state": "open",
      "merged": false,
      "user": {
        "id": 2002,
        "login": "contributor",
        "type": "User"
      },
      "head": {
        "sha": "abcdef0123456789abcdef0123456789abcdef01",
        "ref": "webhook-hardening",
        "repository": {
          "id": 1002,
          "fullName": "contributor/repo",
          "cloneUrl": "https://github.com/contributor/repo.git"
        }
      },
      "base": {
        "sha": "1234567890abcdef1234567890abcdef12345678",
        "ref": "main",
        "repository": {
          "id": 1001,
          "fullName": "acme/repo",
          "cloneUrl": "https://github.com/acme/repo.git"
        }
      },
      "labels": ["security", "webhook"],
      "assignees": [
        {
          "id": 2003,
          "login": "maintainer",
          "type": "User"
        }
      ],
      "requestedReviewers": [
        {
          "id": 2004,
          "login": "reviewer",
          "type": "User"
        }
      ],
      "createdAt": "2026-07-15T09:30:00.000Z",
      "updatedAt": "2026-07-17T10:14:00.000Z",
      "closedAt": null,
      "mergedAt": null
    }
  }
}
```

GitHub issue deliveries use exact event types `com.github.issues.<action>` and
normalized `data.action`, `data.repository`, and `data.issue`. Pull-request
deliveries use `com.github.pull_request.<action>` and normalized `data.action`,
`data.repository`, and `data.pullRequest`. Nested head and base repositories are
projected; the head repository is required because a fork's checkout source
differs from the base repository. Public Git workspace bindings therefore use
`/pullRequest/head/repository/cloneUrl` and `/pullRequest/head/sha`, not mutable
refs or top-level convenience fields.

The GitHub connector also normalizes `issue_comment`, `pull_request_review`, and
`pull_request_review_comment` deliveries. Reviews project native `review.state`,
`review.user`, bounded body data, and exact commit identity where GitHub supplies
it. Bindings use native review state for routing and add an actor-ID predicate
when review provenance is authoritative. These are ordinary normalized events:
only bindings decide whether they begin work, wake waiting work, or are ignored.

Rules for event data:

- Preserve vendor payloads by reference when they are needed for audit or future processing.
- Normalize stable cross-vendor concepts used by bindings.
- Keep large logs, archives, and attachments in object storage.
- Preserve source timestamps in normalized data and record ingestion timestamps separately from the CloudEvent.
- Never treat an event payload as trusted prompt text. Templates must delimit source data and defend against oversized input.
- Version connector normalization schemas so bindings can migrate deliberately.
- V1 binding `eventTypes` are exact strings, not glob or regular-expression patterns. A value containing `*` matches only an event type that literally contains `*`.

## 8. Connector Framework

Adding a trigger or destination must not require changes to execution planning, Kubernetes scheduling, or the OpenCode runner.

### 8.1 Trigger contract

```ts
interface TriggerConnector<TConfig> {
  readonly type: string
  readonly configVersion: number

  validateConfig(config: unknown): TConfig

  authenticate(
    request: TriggerRequest,
    config: TConfig,
  ): Promise<AuthenticatedRequest>

  normalize(
    request: AuthenticatedRequest,
    config: TConfig,
  ): Promise<CloudEvent[]>

  deduplicationKey(event: CloudEvent): string
}
```

Authentication is connector-specific and precedes normalization. In particular,
the GitHub connector verifies `X-Hub-Signature-256` over the unmodified body,
then parses and normalizes the delivery. Its webhook secret is solely an inbound
HMAC credential. GitHub App private keys or installation tokens used for API
calls, and any Git credentials used for cloning, are separate connections with
separate scope and rotation. V1 performs no authenticated clone: Git workspace
URLs must be public HTTPS URLs accepted by the workspace validator.

Trigger modes are:

- **Push:** GitHub webhooks, Grafana alerts, chat events, generic webhooks.
- **Pull:** Periodically query an external API and checkpoint progress.
- **Subscription:** Consume Kafka, NATS, SQS, Pub/Sub, or similar systems.
- **Schedule:** Emit events from cron, interval, or calendar definitions.

Connectors share lifecycle, telemetry, retry, rate-limit, and secret-resolution libraries. They may run in the control-plane process initially. They can become independently deployed workers when isolation or scale requires it; microservices are not the starting assumption.

Connector output and caller input converge on the same normalized event admission contract. Connector code never bypasses binding matching.

### 8.2 Destination contract

```ts
interface DestinationConnector<TConfig> {
  readonly type: string
  readonly configVersion: number

  validateConfig(config: unknown): TConfig

  publish(
    result: ExecutionResult,
    context: DeliveryContext,
    config: TConfig,
  ): Promise<DeliveryResult>
}
```

A result may be published to multiple destinations. Destination delivery has its own state, retry policy, idempotency key, and dead-letter handling. A successful agent execution remains successful if a temporary destination outage delays delivery.

### 8.3 Initial connector set

Build connectors in this order:

1. `webhook.generic` trigger and destination
2. `schedule.cron` trigger
3. `github.app.webhook` trigger, normalizing issue, pull-request, comment, and review deliveries
4. GitHub Check and comment destinations
5. `grafana.alert` trigger and incident-note destination
6. `chat.message` trigger and message destination
7. Queue connectors selected by deployment environment

The generic webhook is the escape hatch for integrations that do not yet justify a first-class connector.

## 9. Agent Profiles and Policy

### 9.1 Native OpenCode configuration

Agentbay does not re-model OpenCode's evolving configuration schema. A profile contains an OpenCode-native document and selects a named agent. Prompts, models, providers, tools, MCP servers, and agent-specific permissions remain authored in OpenCode terms.

Agentbay wraps that document with platform policy:

- Runtime image and OpenCode version
- CPU, memory, ephemeral storage, and optional accelerator limits
- Maximum duration
- Workspace provider and write policy
- Allowed connection references
- Network policy class
- Model/provider allow-list or cost ceiling
- Tool and MCP allow-list
- Permission decisions and approval routing
- Artifact and log retention

Profile publication validates the native document and the platform policy. A published version is immutable.

### 9.2 Capability intersection

Effective execution capability is the intersection of:

```text
platform policy
  AND tenant policy
  AND profile policy
  AND binding restrictions
  AND trigger principal policy
```

No lower layer may expand capability granted by an upper layer. The fully resolved policy is recorded on the execution for audit and reproducibility.

### 9.3 Permission decisions

OpenCode permission requests are evaluated as:

- `allow`: continue automatically.
- `deny`: reject the operation and continue or fail according to policy.
- `approve`: transition to `AWAITING_APPROVAL`, publish an approval request, and resume only after an authorized decision.

There is no blanket auto-approval mode outside explicitly trusted profiles. Approvals may live for hours or days, which is one reason execution state cannot be held only in a process.

## 10. Execution Lifecycle

### 10.1 State machine

The main success path is:

```text
RECEIVED -> PLANNED -> QUEUED -> PROVISIONING -> RUNNING
         -> SUCCEEDED -> DELIVERING -> COMPLETED
```

Control and failure states include:

```text
RETRY_WAIT
WAITING
AWAITING_APPROVAL
CANCEL_REQUESTED
CANCELLED
TIMED_OUT
FAILED
DEAD_LETTERED
```

State transitions are append-only records with timestamp, attempt, actor, reason, and trace context. A materialized current state supports efficient queries, but transition history is authoritative for audit.

Terminal execution states are `COMPLETED`, `CANCELLED`, `TIMED_OUT`, `FAILED`, and `DEAD_LETTERED`. `SUCCEEDED` means agent work completed; `COMPLETED` means required result delivery policy is satisfied.

### 10.2 Attempts and leases

Workers claim executions using time-bounded, fenced leases. Every mutation from an execution worker carries the attempt and fencing token. A worker that loses its lease cannot commit later state, even if it continues running due to a partition.

A retry creates a new attempt under the same execution unless policy explicitly creates a new execution. Attempt-specific artifacts and logs remain distinguishable.

The execution read model exposes these attempts alongside transition history.
An attempt's terminal status describes that attempt only; it does not override
the current execution state after a retry has created a newer attempt.

### 10.3 Idempotency and effective-once behavior

Exactly-once behavior is not assumed across webhooks, databases, queues, Kubernetes, and external APIs. Agentbay uses:

- Unique source-delivery keys
- Unique event IDs per source
- Binding and event execution keys
- Idempotent state transitions
- Transactional outbox publication
- Fenced worker leases
- Kubernetes resource names derived from execution and attempt IDs
- Idempotent destination delivery keys
- Connector-specific replay protection

### 10.4 Active execution singletons

Create bindings may specify an `activeSingleton` name and ordered JSON-pointer
key over normalized event data. Agentbay projects bounded primitives, hashes the
canonical ordered values, and permits only one nonterminal execution for each
tenant, name, and key. Distinct conflicting events remain durable but create no
execution; exact replay returns the original empty execution set. Terminal
execution state releases the slot for a later distinct event. Shared names let
multiple bindings, such as difficulty-specific issue developers, enforce one
logical lifecycle across binding versions and variants.

### 10.5 Cancellation and timeout

Cancellation is a durable, best-effort interruption protocol:

1. Persist `CANCEL_REQUESTED`.
2. Return the cancellation request without waiting for the active workload to
   stop.
3. Deliver cancellation to an active attempt through lease renewal and abort
   in-flight provisioning or OpenCode work.
4. Have the owning worker delete or terminate the provisioned Kubernetes
   workload.
5. Only after that cleanup, have the worker acknowledge `CANCELLED` with its
   attempt and fencing token.

`AWAITING_APPROVAL` and other work that has no active attempt move directly to
`CANCELLED`. For active work, detection latency is normally bounded by the
dispatcher lease renewal interval plus the time required for an in-flight
operation to observe its abort signal. The fenced acknowledgement prevents a
stale worker from finalizing cancellation after ownership has changed. If
worker cleanup fails, the execution remains `CANCEL_REQUESTED` until its lease
expires. Existing claim shutdown behavior and the Kubernetes reconciler are
fallbacks for workload cleanup; execution maintenance handles expired durable
ownership and cancellation state, but does not itself delete Kubernetes
resources. Therefore an API `202 Accepted` response proves only that the
cancellation request was persisted, not that deletion has already occurred.

`SUCCEEDED` is intentionally excluded from cancellation even though delivery
would normally follow it: the agent work has already committed, and the
delivery lifecycle is not implemented. A cancellation request in `SUCCEEDED`
returns `409 Conflict`.

Cancellation cannot retract an external side effect that has already committed.
For example, aborting an execution after GitHub accepted a branch, content,
comment, or pull-request mutation leaves that mutation in GitHub. Such effects
must be reconciled or compensated through their connector-specific contract;
the cancellation state means Agentbay stopped further work on a best-effort
basis, not that all effects were rolled back.

Timeout follows the same cleanup model but terminates as `TIMED_OUT`. Current
crash recovery may adopt an expired `RUNNING` attempt when its exact workload
and OpenCode session are both durably checkpointed. Adoption rotates the
database fencing token, transfers the SandboxClaim fence using Kubernetes
resource-version concurrency, and observes persisted session state without
submitting another prompt. An idle session succeeds only with a persisted
user/assistant exchange. Attempts lost before those checkpoints remain
non-adoptable and follow normal failed-attempt retry semantics.

### 10.6 Durable waits and continuations

An immutable binding policy may declare an after-turn wait boundary. After the current prompt has completed and externally committed work has been checkpointed, Agentbay persists an `EventWait`, records correlation context, and moves the execution to `WAITING`. The agent does not select this disposition. This is distinct from crash recovery: a continuation may submit a new prompt because the preceding prompt completed at a configured lifecycle boundary; crash adoption never guesses whether a prompt should be replayed.

When a normalized event matches a wake binding and an active wait, admission atomically consumes the one-shot wait, appends immutable continuation input and resolved workspace, records the exact wake binding version, and moves the execution back to `QUEUED`. Each input sequence therefore identifies the exact prompt and commit used by that turn and all of its retries. A terminal wake may instead move directly to `COMPLETED`. Exact event replay loads persisted wake results without rematching configuration or waits. The next attempt either resumes a retained runtime or starts from durable workspace state according to profile policy. Wait deadlines produce `TIMED_OUT`; cancellation removes active waits atomically.

Bindings can opt into busy wake admission on both the originating wait and wake delivery policies. The execution then owns an immutable correlation context from creation. Matching events admitted while it is queued, provisioning, running, or retrying become immutable wake intents behind one mutable pending pointer. Continuation replaces continuation, terminal completion replaces and dominates continuation, and exact replay returns the original admission disposition. At fenced successful turn completion, a pending continuation creates the next immutable input/workspace and moves directly to `QUEUED`, a pending terminal moves directly to `COMPLETED`, and only the absence of a pending intent creates an active `EventWait`.

An originating wait may declare one future correlation value supplied by a trusted connector authority. Event-derived values are persisted at execution creation; the supplied value is append-only and write-once. Until complete, the execution may hold a `PENDING_CONTEXT` wait. Wake bindings persist immutable offers even when no complete context exists, so event-before-receipt ordering cannot lose work or rematch current configuration. For GitHub development, the credential broker registers the execution's primary pull-request mutation under its current fence, reports the official MCP result, and the connector binds the PR number only after a signed opened event confirms repository ID, PR database ID, and number. Developer and reviewer remain separate event-linked executions.

Wait correlation is data-driven and source-independent. The core stores bounded values and predicates, not GitHub issue numbers or review-thread identifiers. Multiple matching deliveries are handled with durable idempotency, one-shot claims, and configured coalescing rather than process-local subscriptions.

## 11. Execution Plane

### 11.1 Dispatcher

Dispatchers consume execution requests, acquire leases, enforce admission policy, choose an execution cluster, and create workloads. They scale from queue depth but are also bounded by database-backed and cluster-backed quotas.

Routing inputs include:

- Tenant and priority
- Data residency
- Required architecture or accelerator
- Network policy class
- Workspace locality
- Profile image availability
- Cluster health and capacity

### 11.2 Kubernetes workload model

The default is one isolated sandbox per execution.

- Use `SandboxClaim` when agent-sandbox provides valuable lifecycle, warm-pool, stateful workspace, and isolation behavior.
- Permit ordinary Kubernetes Jobs for simple stateless profiles if they are a better operational fit.
- Never create workloads directly from ingress handlers.
- Never use Kubernetes objects as the only execution database.

Each workload receives labels for tenant, execution, attempt, profile version, and policy class. Names are deterministic and safe to reconcile.

### 11.3 OpenCode runtime

OpenCode runs headlessly inside the workload. The execution worker:

1. Waits for the runtime health endpoint.
2. Opens an authenticated OpenCode client.
3. Creates one session for the attempt.
4. Subscribes to events before submitting the prompt.
5. Sends the selected agent name and rendered input.
6. Persists progress, text, tool calls, permission requests, usage, and errors.
7. Produces a structured result when the session becomes idle.

The platform must tolerate SSE disconnects and worker restarts. Durable execution state, OpenCode session status, and artifact checkpoints determine whether to reconnect, retry, or fail. The dispatcher reconnects only to fully checkpointed `RUNNING` attempts, reconstructs output from persisted messages, and never resubmits their prompt. Missing workload/session checkpoints or incomplete prompt history fail closed into ordinary retry semantics.

Sandbox templates may include authenticated API, proxy, or MCP sidecars that expose standard, policy-bounded tools to OpenCode over localhost. Profile `connections: [{ id, sidecar }]` entries authorize named connections for those template-owned sidecars; they do not create or mutate containers. Agentbay validates each connection reference and sends the grant only to the named container. The agent-sandbox controller rejects a claim when that container is absent. The selected sidecar remains the enforcement boundary and must parse `AGENTBAY_CONNECTIONS` at startup and fail closed; Agentbay does not introspect or certify arbitrary sidecar implementations. Connection-enabled attempts use cold sandboxes rather than a `SandboxWarmPool` so claim-specific authorization cannot arrive after a sidecar has initialized.

Agentbay injects resolved, non-secret metadata through one canonical `AGENTBAY_CONNECTIONS` envelope per selected sidecar. Its JSON representation is `{"refs":["github-production"],"schemaVersion":1,"tenantId":"default"}`; `refs` contains only that sidecar's sorted connection IDs. The envelope is the complete authorized set for that sidecar and attempt; consumers must not merge it with ambient defaults. Credentials remain outside the envelope. A static compatibility deployment references an operator-managed Kubernetes Secret as a volume mounted only into the selected sidecar. OpenCode and the workspace materializer receive no credential mount, and Agentbay neither reads Secret values nor receives Kubernetes RBAC for Secrets.

The GitHub integration uses GitHub's official `github-mcp-server`, pinned to an
immutable release image digest, rather than an Agentbay-specific GitHub MCP
implementation. The official server runs in stateless HTTP mode on loopback and
registers an explicit operator-owned `--tools` allow-list. OpenCode connects to
it through an Agentbay GitHub token broker on `http://127.0.0.1:8083/` with MCP
OAuth disabled. The broker is an HTTP credential proxy, not an MCP server: it
defines no tools and does not interpret MCP messages.

The broker is the selected profile connection sidecar. It validates the complete
`AGENTBAY_CONNECTIONS` grant, reads a GitHub App ID, installation ID, and private
key from a sidecar-only Secret mount, and mints short-lived installation tokens
restricted to one configured repository and an exact permission set. It verifies
GitHub's returned repository and permissions before caching a token, refreshes
before expiry, and injects the current token into each request forwarded to the
official server. The private key and installation token never enter OpenCode,
its configuration, workspace, prompts, or tool results. The official MCP
container receives neither the App Secret nor the Agentbay grant.

Effective GitHub capability is the intersection of three controls:

1. GitHub App installation repository selection and permissions.
2. Official server registration-time `--tools`, `--exclude-tools`, and optional
   read-only or lockdown policy.
3. OpenCode deny-by-default `github_*` permissions with exact per-agent allows.

OpenCode permissions reduce the selected agent's exposed tools but are not the
sole security boundary. Containers in a Pod share loopback, so software-factory
roles must use separate SandboxTemplates with exact server-side allow-lists. Tool
names and the official image digest are versioned deployment inputs and must be
tested when upgrading `github-mcp-server`.

The broker never automatically replays a request after a 401, timeout, transport
failure, or 5xx because an MCP request may contain a mutation whose outcome is
ambiguous. A 401 invalidates the cached token for the next request and is returned
to OpenCode. Idempotency and reconciliation remain properties of the official
GitHub tool and caller workflow; Agentbay does not claim exactly-once GitHub
mutations.

These sidecars provide ordinary tool access to external systems; they are not a privileged execution-creation channel. If an agent uses a standard tool to create an issue, publish a message, enqueue work, or perform another external effect, the corresponding source connector may later normalize that effect into an event. An enabled binding can then create a delegated execution. No Agentbay-specific delegation MCP is required.

This event-producing delegation path is distinct from a **destination**. A delegation effect becomes a new admitted source event and may cause new executions through bindings. A destination consumes an existing execution result for delivery and does not create another execution by itself.

### 11.4 Warm execution

Cold-start improvements include:

- Pre-pulled images
- `SandboxWarmPool`
- Profile-specific runtime pools
- Git object and dependency caches
- Workspace snapshots
- Cluster autoscaler capacity planning

Warm pools are an optimization. Correctness and security cannot depend on reuse. Any reused sandbox must be reset and validated before receiving another tenant execution.

### 11.5 Suspension and hibernation

Agent Sandbox `v0.5.2` provides PVC-based manual suspend/resume on the core `agents.x-k8s.io/v1beta1` `Sandbox` through `spec.operatingMode: Running | Suspended`. Suspension terminates the Pod while preserving PVC-backed state; it does not preserve process memory. Automatic inactivity suspension, resume on traffic, scale-to-zero policy, and deeper archival remain upstream roadmap work.

`SandboxClaim` does not currently expose `operatingMode`; it identifies the underlying Sandbox in status. Agentbay should retain the claim/template boundary and experimentally validate patching the owned core Sandbox rather than moving profile authors to raw Sandbox objects. This requires explicit RBAC, ownership checks, readiness handling, and compatibility tests against the pinned upstream release. Agentbay should migrate its integration and examples toward `v1beta1`; upstream marks `v1alpha1` deprecated.

For a durable wait, profile policy chooses one resource strategy:

- `release`: delete the sandbox and continue later from durable context.
- `retain`: keep the sandbox running for a short wait.
- `suspend`: suspend a PVC-backed sandbox and resume it before continuation.

Postgres remains authoritative in every mode. A suspended Sandbox without an active durable wait is an orphan; an active wait without a Sandbox remains valid and can continue through reconstruction.

### 11.6 Massive scale

Queue depth is absorbed independently from execution concurrency. Capacity control occurs at multiple levels:

- Global execution ceiling
- Tenant quota and rate limit
- Profile concurrency limit
- Connection/provider rate limit
- Cluster and namespace quota
- Priority class and fairness policy

KEDA or an equivalent system may scale dispatchers and supporting workers from queue depth. Cluster autoscaling supplies compute. Backpressure remains explicit: accepted work waits durably rather than causing admission failure or an uncontrolled Pod storm.

## 12. Workspace Model

Workspace provisioning is a platform contract:

```ts
interface WorkspaceProvider<TSpec> {
  readonly type: string

  validateSpec(spec: unknown): TSpec

  materialize(
    spec: TSpec,
    execution: ExecutionContext,
  ): Promise<WorkspaceMount>

  snapshot?(
    mount: WorkspaceMount,
    execution: ExecutionContext,
  ): Promise<ArtifactRef>
}
```

Initial providers are:

- Empty workspace
- Git repository at an immutable revision
- Object-storage archive
- Previous execution snapshot
- Persistent project workspace

Repository checkout is performed with narrowly scoped source-control identity before the agent runs. The checked-out revision, submodule state, and materialization logs are recorded. Agents do not receive write credentials unless the profile and binding explicitly require them.

Workspace retention is independent from execution-record retention. A workspace may be deleted immediately, retained for debugging, or snapshotted as an artifact.

## 13. Results and Delivery

The runtime emits a source-independent result:

```ts
type ExecutionResult = {
  status: "succeeded" | "failed" | "cancelled" | "timed_out"
  summary?: string
  findings?: Array<{
    severity?: string
    title: string
    body: string
    location?: { path?: string; line?: number }
  }>
  patch?: ArtifactRef
  artifacts: ArtifactRef[]
  usage?: {
    inputTokens?: number
    outputTokens?: number
    cost?: number
    currency?: string
  }
}
```

Destination connectors translate this result into vendor concepts. A GitHub destination may create a Check Run with annotations; a Grafana destination may append an incident note; a chat destination may render a concise message and artifact links.

Every delivery records request identity, attempt, response metadata, external object identifier, and retry schedule. Credentials and sensitive payloads are redacted from logs.

## 14. Security Model

### 14.1 Identity and credentials

Each execution receives a unique workload identity where the environment supports it. Prefer short-lived, audience-bound credentials from workload identity or a secret broker. Static credentials are a compatibility fallback.

Connections are references resolved at runtime. Raw secrets are never embedded in events, profile versions, bindings, queue messages, or execution results.

Static Secret volumes are a compatibility fallback and expand the sidecar's blast radius to every operation allowed by that credential. A sidecar is trusted with the requests it receives, its mounted credentials, and any reachable upstream; compromise of the sidecar compromises all three. Use a dedicated, least-privilege identity per connection purpose, constrain egress, avoid sharing credential volumes between sidecars, and never mount them into OpenCode.

Rotation updates the operator-managed Secret and replaces cold sandboxes; existing Pods may retain old mounted material until terminated. Revocation therefore disables or deletes the upstream credential, then terminates affected sandboxes. Connection records are create/read-only in V1 and do not provide online revocation. The intended future secret broker exchanges workload and connection identity for short-lived, audience-bound credentials and supports central revocation without changing the canonical envelope or profile mapping.

### 14.2 Sandbox hardening

Execution workloads should use:

- Dedicated service accounts with no Kubernetes API access by default
- Pod Security restricted settings
- Non-root user and read-only root filesystem where compatible
- Seccomp and dropped Linux capabilities
- CPU, memory, storage, process, and duration limits
- NetworkPolicy derived from an approved class
- Isolated writable workspace
- Per-execution OpenCode authentication
- No host mounts or privileged containers

### 14.3 Network policy

Profiles select named network classes rather than arbitrary CIDRs. Platform operators own those classes. Examples include `no-egress`, `source-control`, `observability-readonly`, and `approved-model-gateway`.

Bindings may choose a stricter class but cannot broaden profile access. Prefer routing model traffic through a controlled AI gateway rather than distributing provider keys to Pods.

### 14.4 Input and prompt safety

Events and checked-out repositories are untrusted input. Agentbay must:

- Delimit event content in rendered prompts
- Enforce prompt and payload size limits
- Avoid interpreting event fields as templates
- Keep platform instructions above workspace-local OpenCode config
- Prevent repositories from overriding managed capability policy
- Treat tool output and destination content as potentially sensitive

### 14.5 Administrative authorization

Management APIs require tenant-aware RBAC. Roles should distinguish profile authors, integration administrators, operators, approvers, auditors, and execution viewers. Approval decisions record the authenticated principal and policy evaluated.

## 15. Persistence and Infrastructure

### 15.1 Postgres

Postgres stores:

- Tenants and authorization metadata
- Agent profiles and immutable versions
- Connections and non-secret configuration
- Triggers, bindings, and destinations
- Events and deduplication records
- Executions, attempts, leases, and state transitions
- Event waits, correlations, continuation inputs, and deadlines
- Permission requests and approvals
- Result delivery records
- Transactional outbox entries

### 15.2 Durable event bus

The bus carries execution requests, lifecycle events, and delivery work. Selection depends on deployment context:

- **NATS JetStream:** preferred self-hosted starting point for a lightweight event system.
- **SQS, Pub/Sub, or equivalent:** preferred when committing to a cloud platform.
- **Kafka:** appropriate only when throughput, long retention, replay, and existing operational investment justify it.

The domain must not depend on vendor-specific queue semantics. Consumer handling assumes redelivery.

### 15.3 Object storage

S3-compatible object storage holds raw source payloads, logs, repository or workspace snapshots, patches, reports, and large result artifacts. Database rows contain metadata, checksums, retention, and references.

### 15.4 Secret manager

Use cloud secret managers, Vault, External Secrets, or workload identity. Postgres stores connection metadata and secret references only.

### 15.5 Temporal decision

A database state machine plus durable queue is sufficient for short autonomous executions. Introduce Temporal or another durable workflow engine only when the product requires substantial support for:

- Human approvals lasting hours or days
- Multi-stage agent workflows
- Durable timers and signals
- Child executions and fan-out/fan-in
- Complex compensation or pause/resume behavior

Temporal is not required merely to start a Pod and wait for an agent.

## 16. Reconciliation and Recovery

Every external side effect has a reconciler:

- **Outbox publisher:** republishes committed, unpublished messages.
- **Execution reconciler:** detects expired leases and schedules recovery.
- **Kubernetes reconciler:** compares active attempts to workloads and removes or repairs orphans.
- **Timeout reconciler:** requests cancellation for overdue executions.
- **Wait reconciler:** expires overdue waits and reconciles retained or suspended sandbox policy.
- **Delivery reconciler:** retries due result deliveries and dead-letters exhausted work.
- **Retention reconciler:** deletes expired payloads, logs, artifacts, and workspaces.

Reconciliation is based on durable desired state, not only workload age. All operations are idempotent.

## 17. Observability

Every execution is a traceable product object. The UI and API expose:

- Source trigger, event, and raw-payload reference
- Matching binding and exact profile version
- Resolved capabilities and policy decisions
- Queue latency and scheduling reason
- Sandbox provisioning duration and selected cluster
- OpenCode session state and event timeline
- Model, token use, and cost
- Tool calls and permission decisions
- Logs, patches, reports, and other artifacts
- Retries, cancellation, timeout, and recovery history
- Active waits, correlations, wake events, and continuation history
- Destination delivery state and external links

OpenTelemetry propagates `tenant_id`, `event_id`, `execution_id`, `attempt_id`, `binding_id`, `profile_version`, and `delivery_id` across ingress, database, bus, Kubernetes, OpenCode, and destinations.

Required platform metrics include:

- Event admission and rejection rate
- Deduplication rate
- Binding match count
- Queue age and depth by tenant/priority
- Execution state counts and duration histograms
- Active wait count, wait age, and wake latency
- Provisioning latency and failure rate
- Active sandbox count and capacity saturation
- OpenCode error and disconnect rate
- Token use and cost by tenant/profile/model
- Delivery latency, retry count, and dead-letter count

Logs are structured and redact secrets. High-cardinality identifiers belong in traces and logs, not metric labels.

## 18. Deployment Topology

The first production topology can remain operationally modest:

- One control-plane deployment containing API, ingress, matcher, planner, and outbox publisher
- One dispatcher deployment
- One destination-worker deployment
- Postgres
- NATS JetStream or a managed queue
- S3-compatible object storage
- One Kubernetes execution cluster

The component boundaries are logical before they are process boundaries. Split components only for scaling, failure isolation, or security.

Later, one global control plane may route to multiple execution clusters. Each cluster runs a small execution gateway/dispatcher with local Kubernetes credentials. The global control plane should not require broad direct credentials to every tenant namespace if a narrower pull-based cluster agent can be used.

## 19. End-to-End Examples

### 19.1 Pull-request review

1. GitHub sends `pull_request.opened`; CI starts, but Agentbay creates no reviewer execution or sandbox.
2. The canonical CI workflow reaches a terminal state and GitHub sends `workflow_run.completed` for one pull request and exact head SHA.
3. The GitHub connector verifies the signature and normalizes a CloudEvent containing the workflow conclusion, PR number, and immutable head revision.
4. A binding matches the repository, workflow name, and pull-request event source. Its active singleton is keyed by repository ID, PR number, and head SHA.
5. The planner resolves `security-reviewer@12`, renders input, and writes one one-shot execution plus outbox event.
6. A dispatcher admits the execution under tenant and GitHub connection quotas.
7. The workspace provider clones the exact workflow head SHA with read-only credentials.
8. OpenCode reviews the repository and completed CI evidence in an isolated sandbox, then submits a SHA-bound native review.
9. A later push runs CI again and can create a distinct reviewer only after that revision's terminal workflow event; stale workflow events remain bound to their old SHA.

Verified Dependabot npm patch and minor updates may use a deterministic fast lane instead of provisioning a reviewer sandbox. A trusted `pull_request_target` workflow never checks out or executes pull-request code; it verifies the fixed Dependabot actor and signed commit metadata, restricts changes to dependency manifests and lockfiles, waits for all repository-required checks on the exact head SHA, revalidates the open pull request immediately before submitting an exact-SHA approval, and uses GitHub's ephemeral workflow token. Major updates, non-npm ecosystems, unexpected files, metadata failures, and failed or timed-out checks receive a trusted fallback label that admits the normal reviewer binding. Dependabot branches are excluded from the generic workflow-completion reviewer binding so one revision cannot enter both lanes. Repository protection and the merge broker accept the fixed workflow bot actor only as the deterministic fast-lane approver; all other automated reviews remain fenced to the reviewer App actor.
10. A native approval starts a separate fenced merger execution, and GitHub branch protection remains the final merge authority.

### 19.2 Grafana alert diagnosis

1. Grafana posts a firing alert with a stable fingerprint.
2. A binding filters for production severity and invokes an incident diagnostician.
3. The profile grants only a read-only Grafana connection and an `observability-readonly` network class.
4. The agent queries bounded logs, metrics, traces, and dashboards through approved tools or MCP servers.
5. The result is attached to a Grafana incident and summarized in Slack.
6. Repeated notifications deduplicate or join the active concurrency key rather than launching an agent storm.

### 19.3 Scheduled maintenance

1. An enabled `schedule.cron` trigger stores a standard five-field expression with explicit UTC timezone and `skip` misfire policy.
2. When `next_fire_at` is due, one scheduler replica locks the schedule row, inserts a uniquely keyed occurrence, and advances the schedule in the same PostgreSQL transaction.
3. An occurrence worker leases the durable occurrence and admits a normalized `dev.agentbay.schedule.triggered` CloudEvent using its stable occurrence ID and scheduled time.
4. Repository schedules request the existing GitHub default-branch revision-resolution gate. No execution is created until the exact commit SHA is persisted.
5. A binding invokes a one-shot maintenance or audit agent against that immutable revision. An active singleton may suppress overlapping executions without losing occurrence audit history.
6. Crash recovery re-leases the same occurrence; admission idempotency prevents duplicate events or executions. Disabled triggers stop both future materialization and pending occurrence delivery.
7. No sandbox exists between occurrences. Per-tenant and provider quotas continue to control execution fan-out.
8. Create bindings may define a stable binding-level checkpoint projected from event data. Admission locks its identity, skips unchanged values before execution creation, and injects the previous/current range into execution input.
9. A one-shot execution reaching `SUCCEEDED` conditionally advances its pending checkpoint in the same transaction. Failure leaves the previous value intact, and compare-and-set semantics prevent stale executions from moving a checkpoint backward.

### 19.4 Chat request

1. A chat connector normalizes a mention or command as an event.
2. A binding uses channel and principal policy to choose an agent.
3. The message thread becomes a destination reference, not the execution database.
4. Agentbay posts an acknowledgement immediately and later publishes progress or the final result to the thread.

## 20. Delivery Roadmap

### Phase 1: Generic asynchronous execution

- Immutable, versioned OpenCode agent profiles
- Generic normalized CloudEvent trigger ingress with idempotency
- Immutable binding versions as the sole execution-creation mechanism
- Generic webhook trigger and destination
- Postgres execution state machine and append-only transitions
- Transactional outbox
- Durable queue
- Kubernetes dispatcher
- One sandbox per execution
- Empty and Git workspace providers
- Object-storage artifacts
- Cancellation, timeout, retry, leases, and idempotency
- Basic execution API and observability

**Exit criterion:** An API caller or generic webhook can admit a normalized event that an enabled binding reliably turns into versioned agent work, survive component restarts, and deliver a durable result.

### Phase 2: GitHub product path

- GitHub App connection
- Pull-request and issue triggers
- Deterministic repository checkout
- GitHub Check and comment destinations
- Supersession on new commits
- Installation-scoped credentials
- Review annotations and patch artifacts

**Exit criterion:** A new or updated pull request triggers a reproducible review and publishes a Check Run without chat-specific state.

### Phase 3: Operational agents

- Grafana alert trigger
- Read-only Grafana connection and tools/MCP
- Grafana incident-note destination
- Schedule triggers
- Chat destination
- Approval state and approval destinations

**Exit criterion:** A firing alert can trigger bounded diagnosis and publish results to multiple operational systems.

### Phase 4: Event-driven software factories

- GitHub comment and review ingress
- Generic bounded array predicates for label and tag routing
- Create, wake, and create-and-wake binding dispositions
- Durable event waits, correlation, continuation input, and deadlines
- Configurable release, retain, or suspend wait policy
- Agent Sandbox `v1beta1` migration and PVC-based suspend/resume validation
- Profile-specific MCP tool allow-lists rather than source-specific core tools
- A complete `examples/github-software-factory` configuration with triage, label-selected developer profiles, review, and reciprocal continuation loops

**Exit criterion:** Repository configuration can route an issue through triage, label-selected development, pull-request review, and event-driven developer/reviewer continuations without GitHub workflow concepts in Agentbay core.

### Phase 5: Scale, policy, and tenancy

- Tenant-aware RBAC and quotas
- Priority and fairness scheduling
- KEDA worker scaling
- Multiple execution clusters
- Warm pools and caches
- Cost accounting and budgets
- Profile and binding policy engine
- Administrative UI

**Exit criterion:** Multiple tenants can safely operate large event bursts with predictable isolation, cost, and latency.

## 21. Open Decisions

These decisions should be resolved by implementation evidence rather than hidden assumptions:

1. **Initial durable bus:** NATS JetStream versus the deployment environment's managed queue.
2. **Future filter language:** Whether bounded primitive and array predicates remain sufficient or justify a larger declarative language.
3. **Profile document format:** API-native JSON only or a first-class YAML authoring and GitOps workflow.
4. **Execution result schema:** Minimum common structure that remains useful across code, operations, and general agents.
5. **OpenCode recovery:** Which failures can reconnect to a session versus requiring a new attempt.
6. **Approval orchestration:** Keep in the database state machine initially or adopt a workflow engine when approval is implemented.
7. **Multi-cluster protocol:** Push from control plane or pull from a cluster-local execution gateway.
8. **Policy implementation:** Built-in validation, CEL, OPA, or a combination.
9. **Artifact log format:** Plain objects, OpenTelemetry logs, or a queryable log backend plus archival storage.
10. **Wait declaration protocol:** Whether agents return a structured lifecycle result or use a generic Agentbay lifecycle MCP to register a durable wait.
11. **Sandbox suspension control:** Whether Agentbay may safely patch a claim-owned core Sandbox until `SandboxClaim` exposes operating mode directly.

## 22. Glossary

| Term | Meaning |
|---|---|
| **AgentProfile** | Immutable, versioned OpenCode agent and maximum execution capability definition. |
| **Binding** | Declarative connection from matching trigger events to an agent profile, execution policy, workspace, and destinations. |
| **Connection** | Named reference to external-service authentication and access policy. |
| **Connector** | Pluggable source or destination integration around the stable event/execution core. |
| **Destination** | Configuration for publishing an execution result to an external system. |
| **Event** | Immutable normalized input represented by a CloudEvents envelope. |
| **EventWait** | Durable, bounded subscription that allows a matching admitted event to continue an existing execution. |
| **Execution** | Durable record and scheduling unit for one agent invocation. |
| **Attempt** | One leased runtime attempt to complete an execution. |
| **Result** | Source-independent structured outcome of an execution. |
| **Trigger** | Configured source connector that authenticates and normalizes external deliveries. |
| **Workspace** | Deterministically materialized files and context available to an execution. |
| **Control plane** | Event admission, configuration, planning, durable state, APIs, and reconciliation. |
| **Execution plane** | Scheduling, workspace provisioning, sandbox operation, OpenCode execution, and result collection. |
| **Sandbox** | Isolated Kubernetes workload in which OpenCode runs an execution attempt. |

---

This document is the source of truth. Architectural decisions that contradict it must update this document explicitly.
