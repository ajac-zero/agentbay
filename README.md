# Wolfgang

Wolfgang is an in-cluster orchestrator that bridges chat platforms to sandboxed OpenCode sessions.

## Development

- Install dependencies: `vp install`
- Run checks: `vp check`
- Build: `vp build`
- Kubernetes smoke test: `vp run k8s:smoke`

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
