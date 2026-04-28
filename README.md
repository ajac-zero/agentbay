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

Keep one-off validation tools and cluster/dev helpers in `scripts/`, not `src/`.
