# agentbay

agentbay is a platform for durable, asynchronous agent execution. Clients
publish immutable OpenCode agent profile versions and submit idempotent
executions. PostgreSQL records execution state and transactional outbox work;
isolated Kubernetes sandboxes provide the execution substrate.

The product architecture and roadmap are defined in [`DESIGN.md`](DESIGN.md).

## Current product surface

The current server provides the execution API foundation:

- Publish and retrieve immutable agent profile versions.
- Submit idempotent asynchronous executions and retrieve their state.
- Atomically persist normalized events, executions, lifecycle transitions, and
  transactional outbox messages.
- Promote due retries and recover expired execution leases through an embedded
  maintenance loop.
- Expose generated OpenAPI 3.1 documentation.

Execution submission returns `202 Accepted`; it does not wait for or directly
create a Kubernetes workload. The dispatcher and result collector described in
Each orchestrator replica runs an embedded fenced dispatcher by default. It
claims queued executions and provisions one SandboxClaim per attempt. A durable
external event bus and destination delivery remain separate future components.

The current migration history is an execution-only baseline. Existing databases
created with the pre-execution prototype must be recreated before upgrading;
there is intentionally no compatibility migration because no user data exists.

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
| `PORT` | `3000` | HTTP port for health, documentation, and the execution API. |
| `AGENTBAY_ADMIN_TOKEN` | unset | Bearer token required by `/v1/*`. The historical variable name is retained temporarily; there is no runtime-admin API. |
| `AGENTBAY_DATABASE_URL` / `DATABASE_URL` | required unless host vars are set | PostgreSQL URL for profile, execution, transition, lease, and outbox state. |
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

## Execution API

Health and generated documentation are public:

```text
GET /healthz
GET /docs
GET /openapi.json
```

The execution routes require `Authorization: Bearer <AGENTBAY_ADMIN_TOKEN>`:

```text
POST /v1/agent-profiles/:profileID/versions
GET  /v1/agent-profiles/:profileID/versions/:version
POST /v1/executions
GET  /v1/executions/:id
```

Publish an exact, immutable profile version before submitting an execution.
`POST /v1/executions` requires an `Idempotency-Key` header and a profile ID and
version. Reusing the key with the same request returns the existing execution;
reusing it with different input is a conflict. The generated OpenAPI document
contains the authoritative request and response schemas.

The API currently assigns records to the `default` tenant. Tenant-aware
authentication and authorization remain roadmap work.

## Secrets

Do not embed provider or infrastructure credentials in profile definitions.
Use Kubernetes Secrets, an external secret manager, or workload identity. The
Helm chart can generate and preserve `AGENTBAY_ADMIN_TOKEN` for development, but
production deployments should provide a managed Secret and rotate tokens under
their normal credential policy.

The optional Helm AI gateway authorization path lets sandbox workloads use
short-lived Kubernetes identity instead of receiving model-provider keys.

## Deployment

Build and push the API and OpenCode sandbox images:

```bash
docker build -t ghcr.io/your-org/agentbay:latest .
docker push ghcr.io/your-org/agentbay:latest
docker build -f opencode-sandbox.Dockerfile -t ghcr.io/your-org/opencode-sandbox:latest .
docker push ghcr.io/your-org/opencode-sandbox:latest
```

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
