---
name: agentbay-testing
description: Run and troubleshoot tests for the agentbay TypeScript orchestrator, including typechecks, handler-level e2e tests, and @testcontainers/k3s sandbox lifecycle tests.
---

# Testing agentbay

Use this skill when changing agentbay code, adding tests, or debugging test failures in this repository.

## Commands

Install dependencies:

```bash
pnpm install
```

Typecheck production code only:

```bash
pnpm typecheck
```

Typecheck production and test code:

```bash
pnpm typecheck:test
```

Run the full e2e suite:

```bash
pnpm test:e2e
```

Run the full e2e suite in this workspace when Ryuk cannot mount the Docker socket:

```bash
TESTCONTAINERS_RYUK_DISABLED=true pnpm test:e2e
```

Run only the fast handler-level e2e tests:

```bash
pnpm exec vitest run --config vitest.e2e.config.ts test/e2e/handlers.test.ts
```

Run only the k3s-backed sandbox e2e test:

```bash
pnpm exec vitest run --config vitest.e2e.config.ts test/e2e/sandbox-manager.test.ts
```

Run with verbose Vitest output:

```bash
pnpm exec vitest run --config vitest.e2e.config.ts --reporter verbose
```

Run Testcontainers with debug logs:

```bash
DEBUG=testcontainers* pnpm test:e2e
```

Use both debug logs and the local Ryuk workaround:

```bash
DEBUG=testcontainers* TESTCONTAINERS_RYUK_DISABLED=true pnpm test:e2e
```

## Test Layers

`test/e2e/handlers.test.ts` is the fast product-behavior layer. It uses fake Chat SDK `Chat`, `Thread`, and `Message` objects, a fake `SandboxManager`, and a local fake opencode HTTP/SSE server. It exercises the real `registerHandlers` flow for new sessions, state persistence, continuing existing sessions, expired state restarts, and unavailable sandbox restarts.

`test/e2e/sandbox-manager.test.ts` is the heavy Kubernetes layer. It starts k3s with `@testcontainers/k3s`, applies pinned upstream `kubernetes-sigs/agent-sandbox` manifests, waits for the real controller and CRDs, creates a real `SandboxTemplate`, provisions a real `SandboxClaim` through `SandboxManager`, runs a fake opencode server in the resulting sandbox Pod, port-forwards to it, and verifies `createSession` plus `runPrompt` streaming.

## Requirements

- `pnpm` 11.x.
- Docker or another Testcontainers-compatible runtime.
- `kubectl` for the k3s-backed test, because the test uses `kubectl port-forward` to reach the sandbox Pod from the host process.
- Network access to fetch pinned `kubernetes-sigs/agent-sandbox` release manifests unless they are already cached by the environment.
- Enough time for the k3s test. A normal run can take around 60-90 seconds, mostly from starting k3s and controller/sandbox Pods.

## Gotchas

Ryuk failures in TCP Docker environments:

If Docker is exposed as `tcp://localhost:2375`, Testcontainers may start Ryuk and fail with an error like `Cannot connect to the Docker daemon at unix:///var/run/docker.sock`. Use `TESTCONTAINERS_RYUK_DISABLED=true pnpm test:e2e` in that environment. Do not bake this into `package.json`; it is environment-specific. The tests explicitly stop their containers, but Ryuk is safer when available.

pnpm build-script approvals:

Adding Testcontainers dependencies can trigger pnpm's build-script approval gate for transitive packages such as `cpu-features`, `protobufjs`, or `ssh2`. Use `pnpm approve-builds <pkg...>` if the install/typecheck command fails with `ERR_PNPM_IGNORED_BUILDS`. This repository records approved builds in `pnpm-workspace.yaml`.

k3s Pod IPs are not reachable from the host:

The app gets pod IPs from real `SandboxClaim.status`, which is correct inside a cluster. The Vitest process runs on the host, outside the k3s pod network, so the e2e test uses `kubectl port-forward` for opencode HTTP checks. A direct request to `10.42.x.x:4096` from the host will usually time out.

Real CRDs are strict:

Do not add fields to local TypeScript `SandboxClaim` types just because they are convenient in tests. The k3s test installs the real upstream CRDs and should catch schema drift. In particular, `SandboxClaim.status.sandbox` currently exposes `name` and `podIPs`; service FQDN fields belong to the core `Sandbox` status, not the claim status.

Restricted additional Pod metadata:

The agent-sandbox controller rejects restricted system-domain labels in `SandboxClaim.spec.additionalPodMetadata`. Use project-owned labels such as `agentbay.dev/managed-by`, not `app.kubernetes.io/managed-by`, when propagating labels into sandbox Pods.

Fake opencode is intentional:

The e2e tests use fake opencode-compatible HTTP/SSE servers. This avoids model credentials and external LLM calls while still exercising the real agentbay opencode client paths: health check, session creation, session status, SSE events, and `prompt_async`.

## When To Run What

For pure TypeScript or config changes, run:

```bash
pnpm typecheck
pnpm typecheck:test
```

For chat handler behavior changes, run:

```bash
pnpm exec vitest run --config vitest.e2e.config.ts test/e2e/handlers.test.ts
```

For sandbox manager, Kubernetes object shape, CRD, or agent-sandbox integration changes, run:

```bash
TESTCONTAINERS_RYUK_DISABLED=true pnpm exec vitest run --config vitest.e2e.config.ts test/e2e/sandbox-manager.test.ts
```

For final verification before handing off larger changes, run:

```bash
pnpm typecheck
pnpm typecheck:test
TESTCONTAINERS_RYUK_DISABLED=true pnpm test:e2e
```
