# agentbay

agentbay is a TypeScript orchestrator that connects Chat SDK webhooks to `agent-sandbox` `SandboxClaim`s and drives a headless opencode server in each sandbox Pod.

## Local Development

Install dependencies:

```bash
pnpm install
```

Typecheck:

```bash
pnpm typecheck
```

Run the k3s end-to-end test:

```bash
pnpm test:e2e
```

The e2e test uses `@testcontainers/k3s`, so Docker or another Testcontainers-compatible runtime and `kubectl` must be available. It fetches the pinned `kubernetes-sigs/agent-sandbox` release manifests, installs the real controllers and CRDs into k3s, provisions a real `SandboxClaim` from a test `SandboxTemplate`, and connects to a fake opencode HTTP server running in the sandbox Pod.

If your Docker endpoint prevents Testcontainers Ryuk from mounting the Docker socket, run the test with `TESTCONTAINERS_RYUK_DISABLED=true pnpm test:e2e`. The test still stops the k3s container in teardown, but Ryuk is safer when your Docker environment supports it.

Run the webhook server:

```bash
pnpm dev
```

## Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `PORT` | `3000` | HTTP port for health and webhooks. |
| `AGENTBAY_KUBE_NAMESPACE` | `agents` | Namespace where `SandboxClaim`s are created. |
| `AGENTBAY_SANDBOX_CLAIM_API_VERSION` | `v1alpha1` | agent-sandbox extensions API version for `SandboxClaim`s. Set `v1beta1` only on clusters serving beta CRDs. |
| `AGENTBAY_OPENCODE_PORT` | `4096` | Port exposed by `opencode serve` in the sandbox. |
| `AGENTBAY_OPENCODE_DIRECTORY` | `/workspace` | opencode instance directory. |
| `REDIS_URL` | unset | Enables persistent Chat SDK state; otherwise in-memory state is used. |
| `AGENTBAY_DATABASE_URL` / `DATABASE_URL` | required unless host vars are set | Postgres URL for bot/runtime/profile storage. Run pending Drizzle migrations with `pnpm db:migrate` or the Helm migration Job before serving traffic. |
| `AGENTBAY_DATABASE_HOST` | unset | Alternative to URL-based config; pair with `AGENTBAY_DATABASE_USER`, `AGENTBAY_DATABASE_PASSWORD`, and `AGENTBAY_DATABASE_NAME`. |
| `AGENTBAY_DATABASE_PORT` | `5432` | Postgres port when using `AGENTBAY_DATABASE_HOST`. |
| `AGENTBAY_DATABASE_USER` | unset | Postgres user when using `AGENTBAY_DATABASE_HOST`. |
| `AGENTBAY_DATABASE_PASSWORD` | unset | Postgres password when using `AGENTBAY_DATABASE_HOST`. |
| `AGENTBAY_DATABASE_NAME` | unset | Postgres database when using `AGENTBAY_DATABASE_HOST`. |
| `AGENTBAY_DATABASE_SSL` | `false` | Enables SSL for Postgres connections. |
| `AGENTBAY_DATABASE_MIGRATIONS_FOLDER` | `drizzle` | Migration folder used by the explicit migration command. |
| `AGENTBAY_ADMIN_TOKEN` | required for bootstrap | Enables bearer-token-protected runtime CRUD routes under `/admin/runtime`. |
| `AGENTBAY_SLACK_ENABLED` | auto | Enables Slack when `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` are present. |
| `AGENTBAY_TEAMS_ENABLED` | auto | Enables Teams when `TEAMS_APP_ID` and `TEAMS_APP_PASSWORD` are present. |
| `AGENTBAY_GOOGLE_CHAT_ENABLED` | auto | Enables Google Chat when auth and webhook verification env vars are present. |
| `AGENTBAY_DISCORD_ENABLED` | auto | Enables Discord when `DISCORD_BOT_TOKEN`, `DISCORD_PUBLIC_KEY`, and `DISCORD_APPLICATION_ID` are present. |
| `AGENTBAY_TELEGRAM_ENABLED` | auto | Enables Telegram when `TELEGRAM_BOT_TOKEN` is present. Per-bot Telegram token env refs in bot records also enable Telegram for that bot. |
| `AGENTBAY_GITHUB_ENABLED` | auto | Enables GitHub when `GITHUB_WEBHOOK_SECRET` and GitHub token or app credentials are present. |
| `AGENTBAY_LINEAR_ENABLED` | auto | Enables Linear when `LINEAR_WEBHOOK_SECRET` and a Linear auth method are present. |
| `AGENTBAY_WHATSAPP_ENABLED` | auto | Enables WhatsApp when `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_PHONE_NUMBER_ID`, and `WHATSAPP_VERIFY_TOKEN` are present. |
| `AGENTBAY_MESSENGER_ENABLED` | auto | Enables Messenger when `FACEBOOK_APP_SECRET`, `FACEBOOK_PAGE_ACCESS_TOKEN`, and `FACEBOOK_VERIFY_TOKEN` are present. |

## Webhooks

Bot adapter webhooks are handled through the bot-scoped route:

```text
ANY /agents/:botSlug/webhooks/:adapter
```

Requests return 404 when the bot does not exist or that adapter is not
configured for the bot.

Health is mounted at:

```text
GET /healthz
```

OpenAPI docs are mounted at:

```text
GET /docs
GET /openapi.json
```

Runtime admin routes and schemas are documented from the same route definitions used to mount the handlers. Chat adapter webhook payloads remain adapter-owned pass-through requests and are documented as a generic webhook endpoint.

## Runtime Admin API

Set `AGENTBAY_ADMIN_TOKEN` to enable authenticated CRUD routes. Requests must include `Authorization: Bearer <token>`.

```text
GET    /admin/runtime/bots
POST   /admin/runtime/bots
GET    /admin/runtime/bots/:id
PUT    /admin/runtime/bots/:id
DELETE /admin/runtime/bots/:id

GET    /admin/runtime/sandbox-profiles
POST   /admin/runtime/sandbox-profiles
GET    /admin/runtime/sandbox-profiles/:id
PUT    /admin/runtime/sandbox-profiles/:id
DELETE /admin/runtime/sandbox-profiles/:id

GET    /admin/runtime/opencode-configs
POST   /admin/runtime/opencode-configs
GET    /admin/runtime/opencode-configs/:id
PUT    /admin/runtime/opencode-configs/:id
DELETE /admin/runtime/opencode-configs/:id

GET    /admin/runtime/agent-profiles
POST   /admin/runtime/agent-profiles
GET    /admin/runtime/agent-profiles/:id
PUT    /admin/runtime/agent-profiles/:id
DELETE /admin/runtime/agent-profiles/:id

GET    /admin/runtime/bot-agent-profiles
POST   /admin/runtime/bot-agent-profiles
DELETE /admin/runtime/bot-agent-profiles/:botID/:agentProfileID
```

Runtime database schema lives in `src/runtime/schema.ts`; generate new Drizzle migrations with `pnpm db:generate` after changing it. Apply pending migrations with `pnpm build && pnpm db:migrate`.

Bots can store adapter secret references without storing secret values. For Telegram, set `adapters.telegram.botTokenEnv` to the env var containing that bot's token, optionally `secretTokenEnv`, and optionally `userName`.

Agent profiles can store per-agent sandbox secret references in `claimEnv`:

```json
[{ "name": "ANTHROPIC_API_KEY", "valueFromEnv": "ANTHROPIC_API_KEY_REVIEWER" }]
```

The orchestrator resolves `valueFromEnv` from its own environment when creating a `SandboxClaim` and injects it as `name` inside the sandbox.

## Deployment

Build and push the orchestrator image:

```bash
docker build -t ghcr.io/your-org/agentbay:latest .
docker push ghcr.io/your-org/agentbay:latest
```

Build and push the opencode sandbox image:

```bash
docker build -f opencode-sandbox.Dockerfile -t ghcr.io/your-org/opencode-sandbox:latest .
docker push ghcr.io/your-org/opencode-sandbox:latest
```

Update `deploy/orchestrator.yaml` and `deploy/examples/sandbox-template.yaml` with your pushed image names before applying them.

A Postgres database must be configured before starting the orchestrator. Use `AGENTBAY_DATABASE_URL` / `DATABASE_URL`, or the discrete `AGENTBAY_DATABASE_HOST` settings. Apply Drizzle migrations from `drizzle/` before serving traffic. The Helm chart can run migrations as a Job, deploy an in-cluster Postgres for small installs, or reference an external Postgres URL/Secret.

The `deploy/` directory contains starter Kubernetes manifests:

```bash
kubectl apply -f deploy/rbac.yaml
kubectl apply -f deploy/examples/sandbox-template.yaml
kubectl apply -f deploy/orchestrator.yaml
```

The manifests are intentionally examples. Platform admins should own the `SandboxTemplate`, image, resource limits, network policy, and secret injection policy.

### Helm chart

A Helm chart for the orchestrator (Deployment, RBAC, optional in-cluster Redis, optional Ingress, optional `SandboxTemplate` / `SandboxWarmPool`) lives in [`deploy/helm/agentbay`](deploy/helm/agentbay). See its [README](deploy/helm/agentbay/README.md) for values, Redis modes, and the agent-sandbox prerequisite.

The agent-sandbox CRDs and controllers must be installed in the cluster first:

```bash
TAG=v0.4.6
kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/$TAG/manifest.yaml
kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/$TAG/extensions.yaml
```

Then install the chart:

```bash
helm install agentbay deploy/helm/agentbay \
  --namespace agents --create-namespace \
  --set image.repository=ghcr.io/your-org/agentbay \
  --set image.tag=latest \
  --set secrets.existingSecret=agentbay-secrets
```
