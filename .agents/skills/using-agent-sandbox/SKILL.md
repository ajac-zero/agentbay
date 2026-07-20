---
name: using-agent-sandbox
description: Provisions and manages isolated Kubernetes sandboxes for AI agents using the kubernetes-sigs/agent-sandbox CRDs (Sandbox, SandboxTemplate, SandboxWarmPool, SandboxClaim). Use when creating, claiming, pre-warming, or troubleshooting agent sandbox workloads on Kubernetes.
---

# Using agent-sandbox CRDs

The `kubernetes-sigs/agent-sandbox` project provides four CRDs for running isolated, stateful, singleton workloads (one sandbox per AI agent session) on Kubernetes. This skill explains the consumer/admin divide and how to use each CRD correctly.

## API Groups

- `agents.x-k8s.io/v1beta1` — core: `Sandbox`
- `extensions.agents.x-k8s.io/v1beta1` — extensions: `SandboxTemplate`, `SandboxWarmPool`, `SandboxClaim`
- `v1alpha1` remains served by `v0.5.2` only as a deprecated compatibility API.

## Consumer / Admin Divide

**Admin (platform team) creates:**
- `SandboxTemplate` — locked-down PodSpec, NetworkPolicy, env-injection policy.
- `SandboxWarmPool` (optional) — pre-warms N Sandboxes for low-latency provisioning.

**Consumer (agent / orchestrator) creates:**
- `SandboxClaim` only — references a template, optionally injects env, sets lifecycle.

Consumers should **not** create `Sandbox` objects directly unless they need full control and are bypassing the template/claim flow.

## Decision Guide

| Situation | Use |
|---|---|
| Need a one-off sandbox under your full control | `Sandbox` directly |
| Platform admin defining reusable sandbox config | `SandboxTemplate` |
| Need fast (sub-second) sandbox provisioning | `SandboxWarmPool` + `SandboxClaim` |
| End-user / agent requesting a sandbox session | `SandboxClaim` |

## CRD Quick Reference

### Sandbox (`agents.x-k8s.io/v1beta1`)
Singleton Pod wrapper. Replicas must be `0` or `1`. Key fields:
- `spec.podTemplate.spec` — full PodSpec (required)
- `spec.volumeClaimTemplates[]` — PVC templates
- `spec.service` — `*bool` to auto-create headless Service
- `spec.shutdownTime` — absolute expiry (RFC3339)
- `spec.shutdownPolicy` — `Delete` | `Retain` (default)

Status surfaces: `conditions[]` (`Ready`, `Finished`), `podIPs[]`, `serviceFQDN`.

### SandboxTemplate (`extensions.agents.x-k8s.io/v1beta1`)
Reusable blueprint. Key fields:
- `spec.podTemplate.spec` — PodSpec (required; `automountServiceAccountToken` defaults to `false`)
- `spec.networkPolicyManagement` — `Managed` (default) | `Unmanaged`
- `spec.networkPolicy.ingress[]` / `egress[]` — custom rules; if empty + Managed → **default-deny** (only Sandbox Router ingress; egress to public internet, RFC1918 + metadata server blocked)
- `spec.envVarsInjectionPolicy` — `Disallowed` (default) | `Allowed` | `Overrides`
- `spec.service` — `*bool` for headless Service on derived Sandboxes

### SandboxWarmPool (`extensions.agents.x-k8s.io/v1beta1`)
Pre-warmed pool. Key fields:
- `spec.replicas` — desired warm standby count (HPA-compatible via scale subresource)
- `spec.sandboxTemplateRef.name` — required template reference
- `spec.updateStrategy.type` — `OnReplenish` (default) | `Recreate`

### SandboxClaim (`extensions.agents.x-k8s.io/v1beta1`)
Consumer request. Key fields:
- `spec.warmPoolRef.name` — required concrete `SandboxWarmPool` name
- `spec.lifecycle.shutdownTime` — absolute expiry
- `spec.lifecycle.ttlSecondsAfterFinished` — auto-cleanup delay
- `spec.lifecycle.shutdownPolicy` — `Retain` (default) | `Delete` | `DeleteForeground`
- `spec.env[]` — injected env vars (gated by template's `envVarsInjectionPolicy`)
- `spec.additionalPodMetadata.labels` / `annotations` — propagated to Pod

Status: `status.sandbox.name`, `status.sandbox.podIPs[]`, mirrored `conditions[]`.

## Workflow: Provisioning a Sandbox via Claim

1. Confirm a `SandboxTemplate` exists: `kubectl get sandboxtemplate -n <ns>`.
2. Check its `envVarsInjectionPolicy` — if `Disallowed`, do not set `spec.env[]` on the claim.
3. (Optional) Check for a matching `SandboxWarmPool`: `kubectl get swp -n <ns>`.
4. Create the `SandboxClaim` referencing the selected pool. Use a zero-replica pool for cold starts.
5. Wait for `status.conditions[type=Ready]=True`; read `status.sandbox.podIPs[0]` (or use the headless Service FQDN) to connect.
6. On session end, delete the claim or let `lifecycle.shutdownTime` / `ttlSecondsAfterFinished` expire it.

## Examples

### Admin: SandboxTemplate
```yaml
apiVersion: extensions.agents.x-k8s.io/v1beta1
kind: SandboxTemplate
metadata:
  name: python-sandbox-template
  namespace: agents
spec:
  envVarsInjectionPolicy: Allowed
  podTemplate:
    spec:
      containers:
      - name: python-runtime
        image: python-runtime-sandbox:latest
        ports:
        - containerPort: 8888
      restartPolicy: OnFailure
```

### Admin: SandboxWarmPool
```yaml
apiVersion: extensions.agents.x-k8s.io/v1beta1
kind: SandboxWarmPool
metadata:
  name: python-sdk-warmpool
  namespace: agents
spec:
  replicas: 10
  sandboxTemplateRef:
    name: python-sandbox-template
  updateStrategy:
    type: OnReplenish
```

### Consumer: SandboxClaim
```yaml
apiVersion: extensions.agents.x-k8s.io/v1beta1
kind: SandboxClaim
metadata:
  name: agent-session-abc123
  namespace: agents
spec:
  warmPoolRef:
    name: python-sdk-warmpool
  lifecycle:
    ttlSecondsAfterFinished: 300
    shutdownPolicy: Delete
  env:
  - name: SESSION_ID
    value: "abc-123"
```

### Direct Sandbox (advanced / no template)
```yaml
apiVersion: agents.x-k8s.io/v1beta1
kind: Sandbox
metadata:
  name: hello-world
spec:
  podTemplate:
    spec:
      containers:
      - name: my-container
        image: my-agent:latest
      restartPolicy: Never
```

## Common Pitfalls

- **`SandboxClaim.spec.env` ignored / rejected** — the referenced `SandboxTemplate` has `envVarsInjectionPolicy: Disallowed`. Ask the admin to switch to `Allowed` or `Overrides`.
- **Sandbox can't reach external services** — Managed NetworkPolicy default-denies RFC1918 and metadata-server egress. Either add explicit `egress` rules to the template or set `networkPolicyManagement: Unmanaged`.
- **Slow sandbox startup** — the selected `SandboxWarmPool` has no ready replicas, or claim env/PVC injection forces a cold start. Size the pool for workloads that can safely adopt prewarmed Pods.
- **Replicas validation error on Sandbox** — `spec.replicas` only accepts `0` or `1`. Use multiple `Sandbox` objects (or a `SandboxWarmPool` of claims) for parallelism.
- **Sandbox not deleted after session** — `shutdownPolicy` defaults to `Retain`. Set `Delete` (or `DeleteForeground`) on the claim or sandbox.
- **Confusing Sandbox with StatefulSet** — Sandbox is singleton + finite-lifetime + claim-driven; StatefulSet is N coordinated replicas + indefinite. Do not migrate StatefulSet workloads without rethinking the topology.

## Inspection Commands

```bash
kubectl get sandbox,sandboxclaim,sandboxtemplate,swp -A
kubectl describe sandboxclaim <name> -n <ns>
kubectl get sandbox <name> -n <ns> -o jsonpath='{.status.podIPs}'
kubectl get sandbox <name> -n <ns> -o jsonpath='{.status.serviceFQDN}'
```

## Source

- Repository: https://github.com/kubernetes-sigs/agent-sandbox
- Core types: `api/v1alpha1/sandbox_types.go`
- Extension types: `extensions/api/v1beta1/{sandboxtemplate,sandboxwarmpool,sandboxclaim}_types.go`
