# Agentbay

Agentbay is an in-cluster orchestrator that bridges chat platforms to sandboxed OpenCode sessions.

## Development

- Install dependencies: `vp install`
- Run checks: `vp check`
- Build: `vp build`
- Kubernetes smoke test: `vp run k8s:smoke`
- Bootstrap a local kind cluster: `vp run dev:cluster`
- End-to-end kind smoke test: `vp run e2e:kind`

## Repository conventions

- `src/` contains application/runtime code that ships with the server.
- `scripts/` contains operational, development, and smoke-test utilities that are not part of the runtime application.
- `dist/` is generated build output and should not be edited by hand.
- `deploy/` contains deployment assets such as the Helm chart.

Keep one-off validation tools and cluster/dev helpers in `scripts/`, not `src/`.

## Deployment

Helm chart location:

- `deploy/helm/agentbay`

Useful commands:

- Lint the chart: `helm lint deploy/helm/agentbay`
- Render manifests: `helm template agentbay deploy/helm/agentbay --namespace agent-sandbox`
- Install/upgrade: `helm upgrade --install agentbay deploy/helm/agentbay --namespace agent-sandbox --create-namespace`

## Local development

This repo includes a kind bootstrap script for a local Kubernetes environment with the upstream `agent-sandbox` CRDs and a `SandboxTemplate` for OpenCode.

Prerequisites:

- `kind`
- `kubectl`
- `docker`
- `python3` (or `python`)

Defaults used by the script:

- cluster name: `agentbay-dev`
- namespace: `agent-sandbox`
- `SandboxTemplate` name: `opencode`
- OpenCode image: `opencode:dev`
- agent-sandbox release: `v0.4.2`

Bootstrap the cluster:

```sh
vp run dev:cluster
```

If your OpenCode runtime image uses a different tag, override it:

```sh
OPENCODE_IMAGE=my-opencode-image:dev vp run dev:cluster
```

If you want a clean rebuild of the cluster:

```sh
RECREATE_CLUSTER=true vp run dev:cluster
```

What the script does:

- creates or reuses a kind cluster using `deploy/dev/kind-config.yaml`
- installs the upstream `agent-sandbox` release manifests and extension CRDs
- waits for the CRDs and controller to become ready
- ensures the `agent-sandbox` namespace exists
- loads the local OpenCode image into kind when it exists in Docker
- applies `deploy/dev/opencode-sandbox-template.yaml` as a `SandboxTemplate`

Useful follow-up commands:

- `kubectl config use-context kind-agentbay-dev`
- `kubectl get sandboxtemplates -n agent-sandbox`
- `kubectl get sandboxclaims -n agent-sandbox`
- `kubectl get pods -n agent-sandbox-system`

## End-to-end kind smoke test

Once you have a working OpenCode sandbox image locally (or available from a registry), you can run the full local smoke flow:

```sh
vp run e2e:kind
```

What the smoke script does:

- bootstraps or reuses the local kind cluster via `scripts/dev-cluster.sh`
- deploys a disposable Redis instance for thread/session state
- builds and loads a local `agentbay:dev` image into kind
- deploys Agentbay with Helm
- verifies Agentbay `/healthz`
- runs the real handler/session flow against a live sandbox through a port-forwarded `sandbox-router`
- verifies:
  - `SandboxClaim` creation
  - direct connection resolution exposes sandbox Service DNS
  - OpenCode session creation + Redis persistence
  - session reuse on follow-up messages
  - `SandboxClaim.spec.lifecycle.shutdownTime` bumps on subsequent activity

Useful overrides:

- `OPENCODE_IMAGE=... vp run e2e:kind`
- `AGENTBAY_IMAGE=agentbay:dev vp run e2e:kind`
- `BUILD_AGENTBAY_IMAGE=false vp run e2e:kind`
- `SKIP_CLUSTER_BOOTSTRAP=true vp run e2e:kind`
- `SKIP_PROMPT=true vp run e2e:kind`
- `E2E_FIRST_PROMPT='Reply with exactly: hello' vp run e2e:kind`
