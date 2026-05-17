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

## Secrets

All adapter credentials and orchestrator-side secrets (model API keys,
Redis URL, etc.) are mounted via `envFrom: secretRef`. Choose one of:

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
    - name: opencode-template          # must match claims.templateName
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
expose), set `specOverride: { ... }` on that entry. For per-container or
per-podSpec patches, use `containerOverrides` / `podSpecOverrides`.

The legacy examples in [`deploy/examples/`](../../examples) remain as a
reference for clusters that prefer applying YAML directly.
