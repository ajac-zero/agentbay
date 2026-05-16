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
| `AGENTBAY_TEMPLATE_NAME` | `opencode-template` | `SandboxTemplate` used by the default profile. |
| `AGENTBAY_WARMPOOL` | `none` | `SandboxClaim.spec.warmpool`. |
| `AGENTBAY_OPENCODE_PORT` | `4096` | Port exposed by `opencode serve` in the sandbox. |
| `AGENTBAY_OPENCODE_DIRECTORY` | `/workspace` | opencode instance directory. |
| `REDIS_URL` | unset | Enables persistent Chat SDK state; otherwise in-memory state is used. |
| `AGENTBAY_SLACK_ENABLED` | auto | Enables Slack when `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` are present. |
| `AGENTBAY_TEAMS_ENABLED` | auto | Enables Teams when `TEAMS_APP_ID` and `TEAMS_APP_PASSWORD` are present. |
| `AGENTBAY_GOOGLE_CHAT_ENABLED` | auto | Enables Google Chat when auth and webhook verification env vars are present. |
| `AGENTBAY_DISCORD_ENABLED` | auto | Enables Discord when `DISCORD_BOT_TOKEN`, `DISCORD_PUBLIC_KEY`, and `DISCORD_APPLICATION_ID` are present. |
| `AGENTBAY_TELEGRAM_ENABLED` | auto | Enables Telegram when `TELEGRAM_BOT_TOKEN` is present. |
| `AGENTBAY_GITHUB_ENABLED` | auto | Enables GitHub when `GITHUB_WEBHOOK_SECRET` and GitHub token or app credentials are present. |
| `AGENTBAY_LINEAR_ENABLED` | auto | Enables Linear when `LINEAR_WEBHOOK_SECRET` and a Linear auth method are present. |
| `AGENTBAY_WHATSAPP_ENABLED` | auto | Enables WhatsApp when `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_PHONE_NUMBER_ID`, and `WHATSAPP_VERIFY_TOKEN` are present. |
| `AGENTBAY_MESSENGER_ENABLED` | auto | Enables Messenger when `FACEBOOK_APP_SECRET`, `FACEBOOK_PAGE_ACCESS_TOKEN`, and `FACEBOOK_VERIFY_TOKEN` are present. |
| `AGENTBAY_CLAIM_ENV_KEYS` | common model/repo keys | Comma-separated orchestrator env vars to inject into each claim when present. |

## Webhooks

Enabled adapter webhooks are mounted at:

```text
ANY /webhooks/slack
ANY /webhooks/teams
ANY /webhooks/gchat
ANY /webhooks/discord
ANY /webhooks/telegram
ANY /webhooks/github
ANY /webhooks/linear
ANY /webhooks/whatsapp
ANY /webhooks/messenger
```

Health is mounted at:

```text
GET /healthz
```

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

The `deploy/` directory contains starter Kubernetes manifests:

```bash
kubectl apply -f deploy/rbac.yaml
kubectl apply -f deploy/examples/sandbox-template.yaml
kubectl apply -f deploy/orchestrator.yaml
```

The manifests are intentionally examples. Platform admins should own the `SandboxTemplate`, image, resource limits, network policy, and secret injection policy.
