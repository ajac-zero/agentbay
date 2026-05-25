# agentbay Helm chart

Installs the agentbay orchestrator, RBAC scoped to `SandboxClaim` resources,
optionally an in-cluster Redis for Chat SDK state, optionally an Ingress
for chat platform webhooks, and optionally `SandboxTemplate` /
`SandboxWarmPool` resources.

## Prerequisite: agent-sandbox

The `agent-sandbox` CRDs **and** controllers must already exist in the
cluster. The orchestrator creates `SandboxClaim` objects on every chat
event; without the controllers nothing reconciles them into Pods and the
orchestrator hangs. Install once per cluster, separately from this chart:

```bash
TAG=v0.4.6   # match what your platform has tested; e2e suite pins v0.4.6
kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/$TAG/manifest.yaml
kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/$TAG/extensions.yaml

kubectl -n agent-sandbox-system rollout status deploy/agent-sandbox-controller
```

This chart deliberately does **not** bundle agent-sandbox. It is a
cluster-wide controller with its own upgrade cadence; co-managing it from
a per-app Helm release would be the operator-in-a-chart antipattern. The
e2e harness in [`test/e2e/`](../../../test/e2e) shows the full install
flow used for tests.

## Quick start

```bash
helm install agentbay deploy/helm/agentbay \
  --namespace agents --create-namespace \
  --set image.repository=ghcr.io/your-org/agentbay \
  --set image.tag=latest \
  --set adapters.slack.enabled=true \
  --set-string secrets.data.SLACK_BOT_TOKEN=xoxb-... \
  --set-string secrets.data.SLACK_SIGNING_SECRET=... \
  --set-string secrets.data.ANTHROPIC_API_KEY=sk-ant-...
```

For production, reference an existing `Secret` instead of inlining values:

```bash
helm install agentbay deploy/helm/agentbay \
  --namespace agents --create-namespace \
  --set secrets.existingSecret=agentbay-secrets \
  --set adapters.slack.enabled=true \
  --set adapters.github.enabled=true
```

## Redis (Chat SDK state)

The chart supports three modes, selected by `redis.*`:

| Mode | How to enable | Notes |
|---|---|---|
| In-cluster Redis (default) | `redis.enabled=true` | Single-replica Deployment + Service. Set `redis.persistence.enabled=true` for a PVC-backed volume. |
| External Redis URL | `redis.enabled=false` + `redis.external.url=redis://...` | URL is rendered into the orchestrator Deployment env. |
| External Redis from existing Secret | `redis.enabled=false` + `redis.external.existingSecret=my-redis` + `redis.external.existingSecretKey=REDIS_URL` | Recommended for production; keeps credentials out of values files. |
| None (in-memory) | `redis.enabled=false`, no `external.*` set | Chat SDK falls back to in-memory state. Single replica only; state is lost on restart. |

## Postgres (runtime configuration)

The chart supports three modes, selected by `database.*`:

| Mode | How to enable | Notes |
|---|---|---|
| In-cluster Postgres (default) | `database.enabled=true` | Single-replica Deployment + Service + Secret. The orchestrator uses discrete host/user/password env vars. Set `database.persistence.enabled=true` for a PVC-backed volume. |
| External Postgres URL | `database.enabled=false` + `database.external.url=postgres://...` | URL is rendered into the orchestrator Deployment env. |
| External Postgres from existing Secret | `database.enabled=false` + `database.external.existingSecret=my-postgres` + `database.external.existingSecretKey=AGENTBAY_DATABASE_URL` | Recommended for production; keeps credentials out of values files. |

The chart runs pending Drizzle migrations with a migration Job when `migrations.enabled=true` (the default). External databases use a `pre-install,pre-upgrade` hook so migrations complete before the orchestrator rollout. The chart-managed Postgres default renders migrations as a normal Job; the orchestrator can start, but its readiness probe stays unready until the Job creates the runtime tables.

Runtime rows are explicit: create bots/profiles/configs through the admin API, your own SQL/bootstrap tooling, or the chart's optional runtime seed hook.

For production, prefer an external database so the migration Job can run before the app Deployment is created. The in-cluster Postgres mode is intended for small installs and development.

When `migrations.enabled=true`, configure external database credentials through `database.external.url` or `database.external.existingSecret`. A generic `secrets.existingSecret` containing `AGENTBAY_DATABASE_URL` is also supported, but chart-managed `secrets.data.AGENTBAY_DATABASE_URL` is rejected because pre-install hooks cannot read normal chart resources before they are created.

For production, prefer an existing Secret:

```bash
helm install agentbay deploy/helm/agentbay \
  --namespace agents --create-namespace \
  --set database.enabled=false \
  --set database.external.existingSecret=agentbay-postgres
```

## Secrets

All adapter credentials and orchestrator-side secrets (model API keys,
Redis/Postgres URLs, `AGENTBAY_ADMIN_TOKEN`, etc.) are mounted via `envFrom: secretRef`. Choose one of:

- **Chart-managed** (`secrets.create=true`, default): the chart creates a
  `Secret` named after the release with the keys provided in
  `secrets.data`. Convenient for dev / GitOps where the values file itself
  is encrypted (e.g. SOPS, sealed-secrets).
- **Existing Secret** (`secrets.existingSecret=<name>`): the chart skips
  creating its own Secret and mounts the one you already manage. The Secret
  must live in the release namespace and use the canonical env var names
  (e.g. `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `ANTHROPIC_API_KEY`).

The full list of supported env var keys is in the project
[README](../../../README.md#configuration).

When the chart creates its own Secret, it also creates or preserves an
`AGENTBAY_ADMIN_TOKEN` value so a fresh install can create the initial
runtime records through `/admin/runtime/*`. If you use `secrets.existingSecret`,
put `AGENTBAY_ADMIN_TOKEN` in that Secret yourself.

## Runtime seed

Set `runtimeSeed.enabled=true` to create/update runtime records after each
install or upgrade. The chart renders a `post-install,post-upgrade` Job that
waits for `/healthz`, reads `AGENTBAY_ADMIN_TOKEN` from the same Secret as the
orchestrator, and upserts records through the admin API. It does not write SQL
directly, so seed data goes through the same validation as manual admin API
calls.

Seed arrays are empty by default. Define the records that match your
environment-specific bots, sandbox profiles, and model/provider config:

```yaml
runtimeSeed:
  enabled: true
  opencodeConfigs:
    - id: opencode-config-default
      slug: default
      displayName: Default
      enabled: true
      config:
        model: azure-anthropic/claude-sonnet-4-5
        provider:
          azure-anthropic:
            name: Azure AI Foundry (Anthropic)
            npm: "@ai-sdk/anthropic"
            options:
              baseURL: https://example.openai.azure.com/anthropic/v1
              apiKey: "{env:ANTHROPIC_API_KEY}"
            models:
              claude-sonnet-4-5:
                id: claude-sonnet-4-5
                name: Claude Sonnet 4.5
                tool_call: true
                attachment: true
                reasoning: true
                temperature: true
        agent:
          agentbay:
            prompt: You are running inside an isolated Kubernetes sandbox. Help the user with the requested coding task.
        default_agent: agentbay
  sandboxProfiles:
    - id: sandbox-profile-default
      slug: default
      templateName: opencode-template
      warmpool: none
      enabled: true
  agentProfiles:
    - id: agent-profile-agentbay
      slug: agentbay
      displayName: agentbay
      opencodeConfigID: opencode-config-default
      opencodeAgentName: agentbay
      claimEnv:
        - name: ANTHROPIC_API_KEY
          valueFromEnv: ANTHROPIC_API_KEY_AGENTBAY
      enabled: true
  bots:
    - id: bot-agentbay
      slug: agentbay
      displayName: agentbay
      adapters:
        telegram:
          botTokenEnv: TELEGRAM_BOT_TOKEN_AGENTBAY
      sandboxProfileID: sandbox-profile-default
      defaultAgentProfileID: agent-profile-agentbay
      enabled: true
```

The seed Job is intentionally idempotent. It uses `PUT` for bots, sandbox
profiles, opencode configs, and agent profiles, and `POST` with conflict-ignore
semantics for extra bot-agent allow-list entries.

Use `helm install --wait` and `helm upgrade --wait` when runtime seed is
enabled with an external database so the orchestrator is ready before the seed
Job calls the admin API.
For future upgrades that rename an opencode agent already referenced by an
AgentProfile, seed a config containing both old and new agent names before
switching the AgentProfile, then remove the old agent in a later upgrade.

## Adapter toggles

Setting `adapters.<name>.enabled=true` causes the chart to emit
`AGENTBAY_<NAME>_ENABLED=true` so the orchestrator fails fast at startup if
any required credential is missing. The orchestrator's auto-detection
behaviour from the [project README](../../../README.md) still applies — you
can leave the toggles off and let the orchestrator enable an adapter
whenever its credentials are present in the mounted Secret.

## RBAC and namespaces

- The orchestrator runs in the **release namespace**.
- `SandboxClaim` objects are created in `claims.namespace` (defaults to the
  release namespace).
- `claims.apiVersion` defaults to `v1alpha1` for compatibility with the latest
  public agent-sandbox release. Set it to `v1beta1` only when the cluster
  serves beta agent-sandbox CRDs.
- A `Role` + `RoleBinding` granting `create/delete/get/list/watch` on
  `sandboxclaims.extensions.agents.x-k8s.io` is installed in
  `claims.namespace`.
- If you split orchestrator and tenant namespaces, set `claims.namespace`
  and ensure that namespace exists.

## SandboxTemplates and SandboxWarmPools

The chart can optionally manage `SandboxTemplate` and `SandboxWarmPool`
resources. Both are **off by default** — enable them when you want the
chart to be the single source of truth for the orchestrator and the
sandboxes it references.

```yaml
sandboxTemplates:
  enabled: true
  templates:
    - name: opencode-template          # referenced by SandboxProfile.templateName in the runtime DB
      namespace: ""                    # defaults to claims.namespace
      image:
        repository: ghcr.io/your-org/opencode-sandbox
        tag: v1.2.3
      resources:
        requests: { cpu: 500m, memory: 1Gi }
        limits:   { cpu: "2",   memory: 4Gi }
      workspace:
        type: persistentVolumeClaim    # or emptyDir
        size: 5Gi

sandboxWarmPools:
  enabled: true
  pools:
    - name: opencode-default
      sandboxTemplateRef: opencode-template
      replicas: 2
```

Why opt-in:

- The agent-sandbox CRDs must be installed in the cluster first. Without
  them, `helm install` fails when these resources are enabled.
- Some platforms own `SandboxTemplate` / `NetworkPolicy` through GitOps
  or admission policy (OPA, Kyverno) and prefer the orchestrator chart
  to stay out of that domain.

Why enabling is usually the right call:

- `claims.templateName` and the actual `SandboxTemplate` name stay in
  lockstep under one `helm upgrade`.
- The template's NetworkPolicy `ingress.from.podSelector` is auto-rendered
  from the orchestrator's own Pod labels, so the two cannot drift.
- One image bump in values updates both the orchestrator and the
  sandbox image references — no more "edit `deploy/examples/...` and
  remember to apply it."

For full takeover of a template's spec (e.g. fields the chart does not
expose), set `specOverride: { ... }` on that entry. For common extensions,
prefer `sidecars`, `extraVolumes`, `extraVolumeMounts`, `containerOverrides`,
and `podSpecOverrides` so the chart still renders the standard opencode
container, workspace volume, service, and NetworkPolicy.

### Envoy AI Gateway authz pattern

For deployments where sandbox Pods should not receive model-provider API keys,
enable the chart's `aiGatewayAuthz` integration. The chart deploys the central
`agentbay-authz` Envoy `ext_authz` service, adds an `agentbay-gateway-proxy`
sidecar to chart-managed `SandboxTemplate`s, and projects a short-lived
Kubernetes service account token only into that sidecar.

Leave `agentProfiles[].claimEnv` empty and point opencode at the sidecar's
localhost listener:

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

runtimeSeed:
  opencodeConfigs:
    - id: opencode-config-default
      config:
        model: envoy-gateway/claude-sonnet-4-5
        provider:
          envoy-gateway:
            name: Envoy AI Gateway
            npm: "@ai-sdk/openai-compatible"
            options:
              baseURL: http://agentbay-gateway:8080/v1
              apiKey: unused
            models:
              claude-sonnet-4-5:
                id: claude-sonnet-4-5
                tool_call: true
        agent:
          agentbay:
            prompt: You are running inside an isolated Kubernetes sandbox.
        default_agent: agentbay
  agentProfiles:
    - id: agent-profile-agentbay
      slug: agentbay
      displayName: agentbay
      opencodeConfigID: opencode-config-default
      opencodeAgentName: agentbay
      claimEnv: []
      enabled: true

sandboxTemplates:
  enabled: true
  templates:
    - name: opencode-template
      networkPolicy:
        egress:
          allowInternetExceptPrivate: false
```

The `agentbay-gateway` hostname is rendered as a Pod `hostAliases` entry
pointing at `127.0.0.1`. Use `http://127.0.0.1:8080/v1` if you prefer not to
rely on that alias. A URL without a port, such as `http://agentbay-gateway/v1`,
would require the sidecar to bind port 80; the default non-root proxy image
listens on 8080 instead.

The orchestrator still injects `OPENCODE_SERVER_PASSWORD` and
`OPENCODE_CONFIG_CONTENT` through each `SandboxClaim`, so keep
`envVarsInjectionPolicy: Allowed` unless you also change that runtime contract.

The legacy examples in [`deploy/examples/`](../../examples) remain as a
reference for clusters that prefer applying YAML directly.
