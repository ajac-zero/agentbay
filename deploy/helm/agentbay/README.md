# agentbay Helm chart

Installs the agentbay execution API and its Kubernetes integration. The chart
includes the API Deployment and Service, PostgreSQL migration Job,
SandboxClaim RBAC, execution maintenance, sandbox reconciler, optional
in-cluster PostgreSQL, optional Ingress, optional `SandboxTemplate` and
`SandboxWarmPool` resources, and optional Envoy AI Gateway authorization.

Each orchestrator replica includes a fenced dispatcher worker that claims queued executions and runs them in attempt-scoped SandboxClaims. A durable external event bus is not selected yet.

## Prerequisite: agent-sandbox

Install the `agent-sandbox` CRDs and controllers once per cluster before using
SandboxClaim-based execution:

```bash
TAG=v0.4.6
kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/$TAG/manifest.yaml
kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/$TAG/extensions.yaml
kubectl -n agent-sandbox-system rollout status deploy/agent-sandbox-controller
```

The chart deliberately does not bundle this cluster-wide controller because it
has an independent lifecycle and upgrade cadence.

## Quick start

```bash
helm install agentbay deploy/helm/agentbay \
  --namespace agents --create-namespace \
  --set image.repository=ghcr.io/your-org/agentbay \
  --set image.tag=latest
```

The API exposes health, OpenAPI documentation, immutable profile versions, and
execution submission and lookup:

```text
GET  /healthz
GET  /docs
GET  /openapi.json
POST /v1/agent-profiles/:profileID/versions
GET  /v1/agent-profiles/:profileID/versions/:version
POST /v1/executions
GET  /v1/executions/:id
```

All `/v1/*` routes require `Authorization: Bearer <token>`.
`POST /v1/executions` also requires an `Idempotency-Key` header. The generated
OpenAPI document is the source of truth for request and response schemas.

## PostgreSQL and migrations

PostgreSQL is required for durable profile, execution, attempt, transition,
lease, and outbox state. Select a mode with `database.*`:

| Mode | Configuration | Notes |
|---|---|---|
| In-cluster PostgreSQL | `database.enabled=true` | Default, intended for development and small installs. Enable `database.persistence.enabled` to retain data across Pod replacement. |
| External URL | `database.enabled=false` and `database.external.url=postgres://...` | Renders the URL directly into workload environment configuration. |
| External Secret | `database.enabled=false` and `database.external.existingSecret=my-postgres` | Recommended for production. The key defaults to `AGENTBAY_DATABASE_URL`. |

`migrations.enabled=true` runs pending Drizzle migrations. External databases
use a `pre-install,pre-upgrade` hook. With chart-managed PostgreSQL, migrations
run as a normal Job so the database can start before migration while API
readiness waits for the schema.

For an external database:

```bash
helm install agentbay deploy/helm/agentbay \
  --namespace agents --create-namespace \
  --set database.enabled=false \
  --set database.external.existingSecret=agentbay-postgres
```

## Secrets and API token

The API currently uses `AGENTBAY_ADMIN_TOKEN` as its bearer token. Despite the
environment variable's historical name, it authenticates the execution API;
there is no runtime-admin API.

Choose one secret mode:

- `secrets.create=true` creates a Secret from `secrets.data`. If no
  `admin.token` is supplied, Helm generates `AGENTBAY_ADMIN_TOKEN` and preserves
  it across upgrades.
- `secrets.existingSecret=<name>` mounts a Secret managed outside this chart.
  It must contain `AGENTBAY_ADMIN_TOKEN` and any other process credentials under
  their canonical environment variable names.

Do not put plaintext production credentials in a values file. Use an existing
Secret, External Secrets, SOPS, Sealed Secrets, or workload identity. Profile
documents should reference credential policy rather than embed secret values.

## Replicas and maintenance

API replicas share durable state in PostgreSQL, so `replicaCount` can be greater
than one without a process-local session backend. Each replica runs execution
maintenance by default to promote due retries and recover expired leases. The
database operations are safe to run concurrently; tune or disable them under
`orchestrator.executionMaintenance`.

This maintenance loop complements the embedded execution dispatcher. Configure
it with `orchestrator.dispatcher.enabled`, `idlePollMs`, `leaseDurationMs`, and
`renewIntervalMs`. Each replica runs one worker when enabled.

## RBAC and namespaces

The API runs in the release namespace. SandboxClaims are created in
`claims.namespace`, which defaults to the release namespace. When `rbac.create`
is enabled, the chart installs a namespaced Role and RoleBinding for
SandboxClaim access. `claims.apiVersion` defaults to `v1alpha1`; use `v1beta1`
only when the installed CRDs serve it.

The separate reconciler CronJob lists agentbay-managed SandboxClaims and deletes
claims beyond their shutdown time plus `reconciler.graceMinutes`. Its service
account and RBAC are independently configurable under `reconciler.*`.

## Sandbox templates and warm pools

`sandboxTemplates.enabled` and `sandboxWarmPools.enabled` are off by default so
platform teams can own these resources independently. A minimal chart-managed
configuration is:

```yaml
sandboxTemplates:
  enabled: true
  templates:
    - name: opencode-template
      image:
        repository: ghcr.io/your-org/opencode-sandbox
        tag: v1.2.3
      resources:
        requests: { cpu: 500m, memory: 1Gi }
        limits: { cpu: "2", memory: 4Gi }
      workspace:
        type: emptyDir

sandboxWarmPools:
  enabled: true
  pools:
    - name: opencode-default
      sandboxTemplateRef: opencode-template
      replicas: 2
```

The template renderer provides an OpenCode container, workspace, service, and
managed NetworkPolicy. Use `sidecars`, `extraVolumes`, `extraVolumeMounts`,
`containerOverrides`, and `podSpecOverrides` for common extensions, or
`specOverride` for full control.

## Envoy AI Gateway authorization

Enable `aiGatewayAuthz` when sandbox Pods should reach model providers through
an Envoy AI Gateway without receiving provider API keys. The chart deploys the
central `agentbay-authz` `ext_authz` service and adds a localhost proxy sidecar
and projected, audience-bound service account token to chart-managed templates.

```yaml
aiGatewayAuthz:
  enabled: true
  upstreamBaseURL: http://envoy-ai-gateway.ai-gateway.svc.cluster.local:8080
  networkPolicy:
    egress:
      namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: ai-gateway
      podSelector:
        matchLabels:
          app.kubernetes.io/name: envoy-ai-gateway
      ports:
        - protocol: TCP
          port: 8080

sandboxTemplates:
  enabled: true
  templates:
    - name: opencode-template
      networkPolicy:
        egress:
          allowInternetExceptPrivate: false
```

Configure the published agent profile's native OpenCode provider to use
`http://agentbay-gateway:8080/v1`. The hostname maps to the sandbox Pod's
loopback proxy. Keep `envVarsInjectionPolicy: Allowed` because the execution
runtime still injects per-execution OpenCode configuration and authentication.
