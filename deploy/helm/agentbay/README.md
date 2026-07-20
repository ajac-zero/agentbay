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
TAG=v0.5.2
kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/$TAG/sandbox.yaml
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
POST /v1/connections
GET  /v1/connections/:connectionID
POST /v1/triggers/:triggerID/events
GET  /v1/executions/:id
POST /hooks/github/:triggerID
```

Management routes and normalized event ingress require `Authorization: Bearer <token>`.
`POST /v1/triggers/:triggerID/events` also requires an `Idempotency-Key` header. The generated
OpenAPI document is the source of truth for request and response schemas.

A `github.app.webhook` trigger additionally exposes public `POST /hooks/github/:triggerID`.
Point the GitHub App webhook at the Ingress URL for that path. The route
authenticates `X-Hub-Signature-256` and does not use the API bearer token. Each
supported delivery produces zero or one event, with issue
types named `com.github.issues.<action>` and pull-request types named
`com.github.pull_request.<action>`. Signed pings and unsupported event/action
pairs return `204 No Content` without producing an event.

After a trigger is disabled, a new event delivery returns `404 Not Found`, even
when the event would match no bindings. An exact replay of an event already
persisted durably may still return `202 Accepted`; replay lookup precedes the
enabled-trigger check and does not create another event or executions.

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

For a GitHub App webhook, keep its HMAC secret in a dedicated Kubernetes Secret
and expose only that key to the orchestrator. `orchestrator.extraEnv` with
`secretKeyRef` is recommended because the public webhook is handled by the
orchestrator, not by migrations, the reconciler, or execution sandboxes:

```yaml
orchestrator:
  extraEnv:
    - name: AGENTBAY_GITHUB_WEBHOOK_SECRET_PRODUCTION
      valueFrom:
        secretKeyRef:
          name: agentbay-github-webhook
          key: webhook-secret
```

Set the trigger's `config.webhookSecretEnv` to
`AGENTBAY_GITHUB_WEBHOOK_SECRET_PRODUCTION`. Secret environment-variable names
must match `AGENTBAY_GITHUB_WEBHOOK_SECRET_<NAME>`. This credential verifies
inbound webhook signatures only. Do not reuse it as a GitHub App private key,
installation/API token, or Git clone credential. GitHub workspaces currently
clone only public HTTPS repositories, using
`/pullRequest/head/repository/cloneUrl` and `/pullRequest/head/sha` from
normalized pull-request event data.

For issue-driven Git workspaces, enable the durable default-branch resolver and
mount an operator-managed GitHub App Secret only into the orchestrator:

```yaml
orchestrator:
  revisionResolver:
    enabled: true
    credentialsSecret: agentbay-github-app
```

The Secret must contain `app-id` and `private-key.pem`. Each issue delivery
provides its installation and repository IDs. The worker mints a
selected-repository token with `contents:read`, resolves and persists the exact
default-branch commit, and only then admits bindings selecting
`/repository/defaultBranchRevision/commit`. Configure polling, lease, retry,
attempt, and request timeout bounds under `orchestrator.revisionResolver`.
Resolver credentials are not mounted into migrations or the reconciler.

To acknowledge newly opened issues immediately after durable admission, enable
the issue acknowledgment worker using the same App credential Secret:

```yaml
orchestrator:
  revisionResolver:
    credentialsSecret: agentbay-github-app
  githubIssueAcknowledgment:
    enabled: true
```

The worker mints a selected-repository token with only `issues:write`, verifies
the repository identity, and adds an `eyes` reaction. The reaction request is
stored transactionally with the webhook event, retried through the outbox, and
must publish before any execution for that event can begin provisioning.
GitHub webhook replay and duplicate reaction responses are idempotent.

## Replicas and maintenance

API replicas share durable state in PostgreSQL, so `replicaCount` can be greater
than one without a process-local session backend. Each replica runs execution
maintenance by default to promote due retries and recover expired leases. The
database operations are safe to run concurrently; tune or disable them under
`orchestrator.executionMaintenance`.

This maintenance loop complements the embedded execution dispatcher. Configure
it with `orchestrator.dispatcher.enabled`, `idlePollMs`, `leaseDurationMs`, and
`renewIntervalMs`. Each replica runs one worker when enabled.

Each replica also runs one revision worker when
`orchestrator.revisionResolver.enabled=true`. PostgreSQL fenced claims make this
safe with multiple replicas. Expired claims are recoverable; failed requests
enter retry wait and become `DEAD_LETTERED` after `maxAttempts`.

## RBAC and namespaces

The API runs in the release namespace. SandboxClaims are created in
`claims.namespace`, which defaults to the release namespace. When `rbac.create`
is enabled, the chart installs a namespaced Role and RoleBinding for
SandboxClaim access. `claims.apiVersion` defaults to `v1beta1`, matching Agent
Sandbox `v0.5.2`. `v1alpha1` is retained only for explicitly configured older
controllers.

Neither the orchestrator nor reconciler Role grants access to Kubernetes
Secrets. Agentbay resolves non-secret connection metadata and writes
authorization/runtime configuration to claims; it does not read sidecar Secret
volumes or Secret API objects.

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
      replicas: 0
```

Every profile must name a concrete pool in `sandbox.warmPool`. A zero-replica
pool provides cold-start allocation. Claim-specific environment injection also
forces a cold start when a pool is prewarmed.

The template renderer provides an OpenCode container, workspace, service, and
managed NetworkPolicy. It also runs a `workspace-materializer` init container
from the sandbox image before OpenCode starts. The materializer mounts the
workspace at `/workspace`; the Pod defaults to `fsGroup: 1000` with
`fsGroupChangePolicy: OnRootMismatch`. The managed materializer and OpenCode
containers run as UID/GID 1000, require a non-root user, disable privilege
escalation, drop all capabilities, and use the runtime-default seccomp profile.
Override Pod security-context fields or append init containers with
`podSpecOverrides`; use `containerOverrides.securityContext` to customize the
OpenCode container defaults.

The chart owns the PodSpec `containers`, `initContainers`, `volumes`,
`restartPolicy`, `automountServiceAccountToken`, and `securityContext` keys, so
those keys are not emitted from the trailing `podSpecOverrides` block.
`serviceAccountName` and `hostAliases` are also chart-owned while
`aiGatewayAuthz` is enabled. Use `sidecars`, `extraVolumes`,
`extraVolumeMounts`, and `containerOverrides` for the corresponding extensions.
`specOverride` remains a full takeover: when set, the chart does not add the
materializer, workspace, or security context.

Keep `envVarsInjectionPolicy: Allowed` so each SandboxClaim can pass the Git
materialization inputs to the init container. Git-backed workspaces require a
cold sandbox: do not configure a `SandboxWarmPool` for templates used by Git
executions. A warm Pod has already run its init containers before claim-specific
environment variables are injected.

Generic connections use the same cold-sandbox rule. Profiles map records to
template-owned sidecars with `connections: [{id, sidecar}]`. Agentbay fails the
attempt if a record cannot be resolved or the named sidecar is not in the exact
template, and injects only the non-secret canonical envelope, for example
`{"refs":["github-production"],"schemaVersion":1,"tenantId":"default"}`,
as `AGENTBAY_CONNECTIONS` on that sidecar. Sidecar images, commands, and
credential volumes are operator-owned template configuration, not profile input.

Provider-specific stacks should keep their tool server, credential broker,
permission model, credential mounts, and tests together. The complete GitHub
configuration is maintained in
[`examples/github-software-factory`](../../../examples/github-software-factory/README.md),
including the official GitHub MCP sidecar and installation-token broker. This
chart remains provider-neutral and renders sidecars and volumes supplied by an
operator without embedding a specific provider stack.

By default, the materializer uses the template's `image.repository`, `tag`, and
`pullPolicy`. If it is published as a separate image, override any of those
fields under `workspaceMaterializer.image`.

## Observability

Agentbay serves Prometheus metrics at `/metrics` on the separate internal metrics
Service port (9090 by default). The Ingress exposes only the API port. Counters and histograms record
committed lifecycle outcomes; restart-safe gauges are projected from PostgreSQL,
which remains authoritative. PostgreSQL collection uses one aggregate query, a
five-second process cache, and a two-second timeout. A failed collection leaves
the last successful business snapshot available while
`agentbay_observability_collector_up` becomes `0` and
`agentbay_observability_snapshot_age_seconds` continues increasing.

Metric labels are intentionally bounded: tenant, state, result, event type,
profile ID, binding ID, trigger ID, topic, operation, and component. Execution
IDs, event IDs, pull request numbers, commit SHAs, claim names, and error messages
are never metric labels; use structured logs and PostgreSQL for those identities.

Enable portable scrape annotations, Prometheus Operator resources, and the
Grafana sidecar dashboard independently:

```yaml
observability:
  podAnnotations:
    enabled: true
  serviceMonitor:
    enabled: true
    labels:
      release: kube-prometheus-stack
  prometheusRule:
    enabled: true
    labels:
      release: kube-prometheus-stack
  dashboard:
    enabled: true
```

The initial rules alert when the oldest pending outbox message exceeds ten
minutes, an active execution exceeds its persisted timeout, or an enabled
schedule has missed two expected cron intervals past `next_fire_at`. They also warn when the
PostgreSQL collector has failed for five minutes. Tune these values under
`observability.prometheusRule` after observing normal production behavior.

`ServiceMonitor` and `PrometheusRule` require the Prometheus Operator CRDs and
are disabled by default. Annotation-based collectors can use
`observability.podAnnotations`. Static collectors must add the Agentbay Service
as an explicit `/metrics` scrape target. The dashboard ConfigMap is labeled
`grafana_dashboard=1` by default for common Grafana sidecar discovery.

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
