# Wolfgang

Wolfgang is an in-cluster orchestrator that bridges chat platforms to sandboxed OpenCode sessions.

## Development

- Install dependencies: `vp install`
- Run checks: `vp check`
- Build: `vp build`
- Kubernetes smoke test: `vp run k8s:smoke`
- Bootstrap a local kind cluster: `vp run dev:cluster`

## Repository conventions

- `src/` contains application/runtime code that ships with the server.
- `scripts/` contains operational, development, and smoke-test utilities that are not part of the runtime application.
- `dist/` is generated build output and should not be edited by hand.
- `deploy/` contains deployment assets such as the Helm chart.

Keep one-off validation tools and cluster/dev helpers in `scripts/`, not `src/`.

## Deployment

Helm chart location:

- `deploy/helm/wolfgang`

Useful commands:

- Lint the chart: `helm lint deploy/helm/wolfgang`
- Render manifests: `helm template wolfgang deploy/helm/wolfgang --namespace agent-sandbox`
- Install/upgrade: `helm upgrade --install wolfgang deploy/helm/wolfgang --namespace agent-sandbox --create-namespace`

## Local development

This repo includes a kind bootstrap script for a local Kubernetes environment with the upstream `agent-sandbox` CRDs and a `SandboxTemplate` for OpenCode.

Prerequisites:

- `kind`
- `kubectl`
- `docker`
- `python3` (or `python`)

Defaults used by the script:

- cluster name: `wolfgang-dev`
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

- `kubectl config use-context kind-wolfgang-dev`
- `kubectl get sandboxtemplates -n agent-sandbox`
- `kubectl get sandboxclaims -n agent-sandbox`
- `kubectl get pods -n agent-sandbox-system`
