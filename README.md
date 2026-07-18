# agentbay

agentbay is a platform for durable, asynchronous agent execution. Clients
publish immutable OpenCode agent profile and binding versions, then admit
idempotent normalized events. Enabled immutable binding versions are the sole
execution-creation mechanism. PostgreSQL records event and execution state and
transactional outbox work; isolated Kubernetes sandboxes provide the execution
substrate.

The product architecture and roadmap are defined in [`DESIGN.md`](DESIGN.md).

## Current product surface

The current server provides the binding-driven execution foundation:

- Publish and retrieve immutable agent profile versions.
- Create, retrieve, and disable normalized CloudEvents HTTP triggers.
- Publish, retrieve, and disable immutable binding versions.
- Admit idempotent normalized CloudEvents and retrieve resulting execution state.
- Atomically persist normalized events, executions, lifecycle transitions, and
  transactional outbox messages.
- Promote due retries and recover expired execution leases through an embedded
  maintenance loop.
- Expose generated OpenAPI 3.1 documentation.

Event ingress returns `202 Accepted`; it does not wait for or directly create a
Kubernetes workload. Each orchestrator replica runs an embedded fenced
dispatcher by default. It claims queued executions and provisions one
SandboxClaim per attempt. A durable external event bus and destination delivery
remain separate future components.

The current migration history is a pre-production baseline covering profiles,
triggers, binding versions, admitted events, executions, and dispatch state.
Databases created with the pre-execution prototype must be recreated before
upgrading; there is intentionally no compatibility migration because no user
data exists.

## Local development

Install dependencies and typecheck:

```bash
pnpm install
pnpm typecheck
```

Configure PostgreSQL, apply migrations, and run the API:

```bash
export AGENTBAY_DATABASE_URL=postgres://agentbay:agentbay@localhost:5432/agentbay
export AGENTBAY_ADMIN_TOKEN=development-token
pnpm build
pnpm db:migrate
pnpm dev
```

Run tests with:

```bash
pnpm test:unit
pnpm test:e2e
```

The Kubernetes end-to-end tests use `@testcontainers/k3s`, so Docker or another
Testcontainers-compatible runtime and `kubectl` must be available. If Ryuk
cannot mount the Docker socket, run with `TESTCONTAINERS_RYUK_DISABLED=true`.

## Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `PORT` | `3000` | HTTP port for health, documentation, management, event ingress, and execution reads. |
| `AGENTBAY_ADMIN_TOKEN` | unset | Bearer token required by `/v1/*`. The historical variable name is retained temporarily; there is no runtime-admin API. |
| `AGENTBAY_DATABASE_URL` / `DATABASE_URL` | required unless host vars are set | PostgreSQL URL for profile, trigger, binding, event, execution, transition, lease, and outbox state. |
| `AGENTBAY_DATABASE_HOST` | unset | Alternative to URL configuration; pair with database user, password, and name. |
| `AGENTBAY_DATABASE_PORT` | `5432` | PostgreSQL port with host-based configuration. |
| `AGENTBAY_DATABASE_USER` | unset | PostgreSQL user with host-based configuration. |
| `AGENTBAY_DATABASE_PASSWORD` | unset | PostgreSQL password with host-based configuration. |
| `AGENTBAY_DATABASE_NAME` | unset | PostgreSQL database with host-based configuration. |
| `AGENTBAY_DATABASE_SSL` | `false` | Enables PostgreSQL SSL. |
| `AGENTBAY_DATABASE_SSL_REJECT_UNAUTHORIZED` | `false` | Verifies the PostgreSQL server certificate when SSL is enabled. Enable in production. |
| `AGENTBAY_DATABASE_MIGRATIONS_FOLDER` | `drizzle` | Migration folder used by `pnpm db:migrate`. |
| `AGENTBAY_EXECUTION_MAINTENANCE_ENABLED` | `true` | Enables retry promotion and expired-lease recovery. |
| `AGENTBAY_EXECUTION_MAINTENANCE_INTERVAL_MS` | `5000` | Delay between maintenance cycles. |
| `AGENTBAY_EXECUTION_MAINTENANCE_BATCH_SIZE` | `100` | Maximum rows handled by each maintenance operation per cycle. |
| `AGENTBAY_EXECUTION_MAX_ATTEMPTS` | `3` | Maximum execution attempts, including the initial attempt. |
| `AGENTBAY_EXECUTION_RETRY_DELAY_MS` | `30000` | Fixed delay before a failed execution is eligible for retry. |
| `AGENTBAY_DISPATCHER_ENABLED` | `true` | Enables the embedded fenced dispatcher worker. |
| `AGENTBAY_DISPATCHER_IDLE_POLL_MS` | `500` | Delay before polling again when no execution is queued. |
| `AGENTBAY_DISPATCHER_LEASE_DURATION_MS` | `60000` | Duration of each execution-attempt lease. |
| `AGENTBAY_DISPATCHER_RENEW_INTERVAL_MS` | `20000` | Lease renewal interval; must be shorter than the lease duration. |
| `AGENTBAY_DISPATCHER_WORKER_ID` | hostname/PID | Stable lease-owner identity for the process. |
| `AGENTBAY_KUBE_NAMESPACE` | `agents` | Namespace reserved for SandboxClaim-based execution. |
| `AGENTBAY_SANDBOX_CLAIM_API_VERSION` | `v1alpha1` | Installed agent-sandbox extensions API version. |
| `AGENTBAY_OPENCODE_PORT` | `4096` | OpenCode server port used by the execution runtime. |
| `AGENTBAY_OPENCODE_DIRECTORY` | `/workspace` | OpenCode working directory in execution sandboxes. |
| `LOG_LEVEL` | `info` | Structured JSON log threshold: `debug`, `info`, `warn`, or `error`. |
| `AGENTBAY_RECONCILER_GRACE_MINUTES` | `30` | Grace period used by the standalone SandboxClaim reconciler command. |

Apply pending migrations before serving traffic:

```bash
pnpm build
pnpm db:migrate
```

## HTTP API

Health and generated documentation are public:

```text
GET /healthz
GET /docs
GET /openapi.json
```

Management routes and normalized event ingress require `Authorization: Bearer
<AGENTBAY_ADMIN_TOKEN>`:

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
```

The public `POST /hooks/github/:triggerID` endpoint accepts GitHub deliveries for
a `github.app.webhook` trigger. It does not accept the bearer token;
GitHub authenticates with `X-Hub-Signature-256` using the trigger's configured
webhook-secret environment variable.

Publish an exact profile version, create a `cloudevents.http` trigger, and
publish an enabled binding version before admitting an event. The binding names
one to 32 exact event types, applies up to 16 conjunctive filters to event
`data`, selects an exact profile version, supplies a literal prompt, and resolves
an empty or Git workspace. Filters use RFC 6901 JSON Pointers with `eq`, `in`, or `exists`;
comparison values are JSON primitives. The prompt's `includeEvent` is `none`,
`data`, or `envelope`. It does not perform template expansion.

Connections are generic, tenant-owned metadata records created with `POST
/v1/connections` and read with `GET /v1/connections/:connectionID`; the generated
OpenAPI document defines their request and response schemas. They contain no raw
credential; the create body is `{"id":"github-production","type":"github"}`.
A profile grants connections by mapping each connection ID to a
sidecar that must already be owned by its immutable sandbox template:

```json
"connections": [{ "id": "github-production", "sidecar": "github-mcp" }]
```

At dispatch, Agentbay resolves the records and injects one canonical, non-secret
`AGENTBAY_CONNECTIONS` JSON envelope into each selected sidecar. The envelope
contains only that sidecar's sorted connection IDs:

```json
{"refs":["github-production"],"schemaVersion":1,"tenantId":"default"}
```

Resolution is fail closed: a missing connection or invalid mapping prevents
profile publication, and a sidecar name absent from the selected template makes
the controller reject the attempt rather than redirecting access. Connection-enabled profiles
use cold sandboxes (`warmPool: none`) so the template-owned sidecars, mounts, and
claim-specific authorization/runtime configuration are applied together.

For example, a V1 binding-version request body is:

```json
{
  "version": 1,
  "triggerId": "github",
  "profile": { "id": "coder", "version": 1 },
  "definition": {
    "schemaVersion": 1,
    "eventTypes": ["issue.opened"],
    "filter": {
      "all": [{ "path": "/action", "op": "eq", "value": "opened" }]
    },
    "prompt": { "literal": "Handle this issue.", "includeEvent": "data" },
    "workspace": { "type": "empty" }
  }
}
```

A Git workspace selects a repository URL and commit from normalized event
`data`, then persists their resolved values on the execution:

```json
"workspace": {
  "type": "git",
  "repository": { "url": { "path": "/repository/cloneUrl" } },
  "revision": { "commit": { "path": "/headSha" } }
}
```

V1 accepts public HTTPS repositories resolving exclusively to public IPv4 addresses and full 40-character SHA-1 commit object
IDs only. It rejects credentials, mutable refs, local/private hosts, and mixed
public/private DNS results. The sandbox materializer pins a validated DNS answer,
fetches the exact commit without a shell, checks it out detached, and verifies
`HEAD` before OpenCode starts. Git workspaces require a cold sandbox (`warmPool:
none`); private repository credentials, submodules, Git LFS, and warm-pool Git
materialization are not implemented yet.

Callers, connectors, the CLI, and tests all invoke agents through generic
normalized CloudEvent trigger ingress. `POST /v1/triggers/:triggerID/events`
requires `Idempotency-Key` and a structured CloudEvents 1.0 JSON envelope and
returns `202 Accepted`. Its response contains the admitted event, zero or more
executions created by matching enabled binding versions, and `replayed`. Reusing
the key with the same normalized request returns the original result; reusing it
with different content returns `409 Conflict`. There is no
`POST /v1/executions` route.

Disabling a trigger prevents new event admission. A new delivery returns `404
Not Found`, including an event that would be a no-op because it matches no
bindings. An exact replay of an event already persisted durably can still return
its original result with `202 Accepted` and `replayed: true`.

For GitHub App delivery, create a trigger such as:

```json
{
  "id": "github",
  "type": "github.app.webhook",
  "config": {
    "schemaVersion": 1,
    "webhookSecretEnv": "AGENTBAY_GITHUB_WEBHOOK_SECRET_PRODUCTION"
  }
}
```

Configure GitHub to send webhooks to
`https://agentbay.example.com/hooks/github/github`. Agentbay verifies the
SHA-256 signature against the raw request bytes before parsing JSON, uses
`X-GitHub-Delivery` to deduplicate retries, and normalizes each supported
delivery to zero or one event. Signed pings and unsupported event/action pairs
are acknowledged with `204 No Content` and produce no event. Issues use
`com.github.issues.<action>` with normalized `repository` and
`issue` data; pull requests use `com.github.pull_request.<action>` with
normalized `repository` and `pullRequest` data. Bindings, rather than trigger
configuration, decide which normalized event types invoke agents.

For a public pull-request checkout, select the contributor repository and exact
head commit from the normalized data:

```json
"workspace": {
  "type": "git",
  "repository": { "url": { "path": "/pullRequest/head/repository/cloneUrl" } },
  "revision": { "commit": { "path": "/pullRequest/head/sha" } }
}
```

The webhook secret authenticates inbound deliveries only. It is not a GitHub
App private key, installation token, or Git credential. V1 Git workspaces remain
limited to public HTTPS repositories and do not use the webhook secret for
cloning or GitHub API access.

An agent delegates by using ordinary tools or MCP servers to cause an external
effect that a connector later normalizes into another event. Bindings consume
that event exactly like any other; no special Agentbay delegation MCP is
required. Template-owned MCP sidecars provide standard policy-bounded tool
access. The included GitHub MCP sidecar's current one-tool slice exposes only
`issue_comment` through a GitHub App without exposing an installation token to
OpenCode.
Result destinations are separate: they deliver an existing execution's result
and are not an execution-creation mechanism.

The generated OpenAPI document contains the authoritative request and response
schemas.

The API currently assigns records to the `default` tenant. Tenant-aware
authentication and authorization remain roadmap work.

## Secrets

Do not embed provider or infrastructure credentials in profile definitions.
Use Kubernetes Secrets, an external secret manager, or workload identity. The
Helm chart can generate and preserve `AGENTBAY_ADMIN_TOKEN` for development, but
production deployments should provide a managed Secret and rotate tokens under
their normal credential policy.

Reference a GitHub webhook secret from `orchestrator.extraEnv` with
`valueFrom.secretKeyRef`; do not place the secret value in trigger configuration
or Helm values. Keep webhook authentication, GitHub API/App credentials, and
Git clone credentials separate.

The optional Helm AI gateway authorization path lets sandbox workloads use
short-lived Kubernetes identity instead of receiving model-provider keys.

For static connection credentials, operators may put a Secret volume on the
template-owned connection sidecar only. Do not mount that volume into OpenCode,
the workspace materializer, or Agentbay. Agentbay reads connection metadata, not
Secret values, and its chart RBAC intentionally grants no `secrets` access.
Rotate by updating the operator-managed Secret and starting new cold sandboxes;
revoke by disabling/deleting the external credential before terminating affected
sandboxes. Connection records are create/read-only in V1 and do not provide online
revocation. A sidecar is inside the sandbox trust boundary:
it can observe requests sent to it and misuse every credential it mounts, so use
one narrowly scoped identity per purpose and account for the resulting blast
radius. A future broker can replace static mounts with short-lived,
audience-bound credentials without changing the profile-to-sidecar contract.

## Deployment

Build and push the API and OpenCode sandbox images:

```bash
docker build -t ghcr.io/your-org/agentbay:latest .
docker push ghcr.io/your-org/agentbay:latest
docker build -f opencode-sandbox.Dockerfile -t ghcr.io/your-org/opencode-sandbox:latest .
docker push ghcr.io/your-org/opencode-sandbox:latest
```

Build the dependency-free GitHub MCP sidecar separately. Publish the image and
deploy the immutable digest, not a mutable tag:

```bash
docker build -f github-mcp-sidecar.Dockerfile \
  -t ghcr.io/your-org/github-mcp-sidecar:v1 .
docker push ghcr.io/your-org/github-mcp-sidecar:v1
docker inspect --format='{{index .RepoDigests 0}}' \
  ghcr.io/your-org/github-mcp-sidecar:v1
```

The image copies only `github-mcp-sidecar/*.mjs`, runs `server.mjs` directly as
fixed UID/GID 65532 on a distroless Node 24 image with CA certificates, and is
compatible with a read-only root filesystem. The sidecar reads
`AGENTBAY_GITHUB_APP_ID_FILE`, `AGENTBAY_GITHUB_INSTALLATION_ID_FILE`, and
`AGENTBAY_GITHUB_PRIVATE_KEY_FILE`, restricts calls to the configured
`AGENTBAY_GITHUB_REPOSITORY_OWNER`, `AGENTBAY_GITHUB_REPOSITORY_NAME`, and
`AGENTBAY_GITHUB_REPOSITORY_ID`, binds localhost port 8082, serves MCP at
`/mcp`, and reports readiness at `/readyz` and liveness at `/livez`. It accepts
only the connection refs in injected
`AGENTBAY_CONNECTIONS`. Its GitHub upstream is fixed to github.com; there is no
GitHub host override.

Configure the OpenCode profile with a remote MCP entry at
`http://127.0.0.1:8082/mcp` and `oauth: false`. Configure a GitHub App with only
**Issues: read/write**, install it on one selected repository, and mount its App
ID, installation ID, and private key Secret files only into `github-mcp`. An
`issues.opened` execution calling `issue_comment` is one intended use; the
sidecar grants no workflow policy or Workflows permission. Installation tokens
are minted and used inside the sidecar and never leave it. The sidecar's MCP
2025-11-25 support is compatible with the OpenCode 1.14.50 version pinned by
`opencode-sandbox.Dockerfile`.

Marker replay is best-effort at-least-once recovery, not a uniqueness guarantee.
Callers must derive a stable `idempotency_key` for each logical comment, and
workflows must tolerate duplicates: overlapping sidecars or attempts can both
miss the marker and create duplicate comments even with a stable key. The sidecar
scans only the newest 2,000 comments before posting, so a marker older than that
best-effort window is treated as absent and may result in a duplicate rather
than failing closed. The marker HMAC key is derived from the GitHub App private
key, so rotating that key makes old markers unauthenticatable and may also cause
duplicates. Preserve the old key and sidecars through the replay window, or
explicitly tolerate those duplicates. See the Helm
[`README`](deploy/helm/agentbay/README.md) and
[`sandbox-template.yaml`](deploy/examples/sandbox-template.yaml) for complete
examples.

PostgreSQL is required. The Helm chart can run migrations, deploy an in-cluster
PostgreSQL instance for small installs, or use an external PostgreSQL URL or
Secret. It preserves SandboxClaim RBAC, optional `SandboxTemplate` and
`SandboxWarmPool` management, the SandboxClaim reconciler, AI gateway
authorization, and execution maintenance.

Install the agent-sandbox CRDs and controllers before enabling sandbox
resources:

```bash
TAG=v0.4.6
kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/$TAG/manifest.yaml
kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/$TAG/extensions.yaml
```

Then install the chart:

```bash
helm install agentbay deploy/helm/agentbay \
  --namespace agents --create-namespace \
  --set image.repository=ghcr.io/your-org/agentbay \
  --set image.tag=latest \
  --set secrets.existingSecret=agentbay-secrets
```

See the chart [`README`](deploy/helm/agentbay/README.md) for PostgreSQL,
migrations, RBAC, sandbox resources, reconciler, and AI gateway settings.
