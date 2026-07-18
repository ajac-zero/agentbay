#!/bin/sh
set -eu

chart_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT

helm lint "$chart_dir"
helm template demo "$chart_dir" \
  --namespace agentbay-helm-test \
  --set sandboxTemplates.enabled=true \
  --show-only templates/sandboxtemplates.yaml > "$work_dir/default.yaml"

grep -q 'envVarsInjectionPolicy: Allowed' "$work_dir/default.yaml"
grep -q 'name: workspace-materializer' "$work_dir/default.yaml"
grep -q 'command: \["node", "/opt/agentbay/git-workspace-materializer.mjs"\]' "$work_dir/default.yaml"
grep -q 'name: AGENTBAY_WORKSPACE_DIRECTORY' "$work_dir/default.yaml"
grep -q 'fsGroup: 1000' "$work_dir/default.yaml"
grep -q 'fsGroupChangePolicy: OnRootMismatch' "$work_dir/default.yaml"
test "$(grep -c 'allowPrivilegeEscalation: false' "$work_dir/default.yaml")" -eq 2
test "$(grep -c 'runAsNonRoot: true' "$work_dir/default.yaml")" -eq 2
test "$(grep -c 'runAsUser: 1000' "$work_dir/default.yaml")" -eq 2
test "$(grep -c 'runAsGroup: 1000' "$work_dir/default.yaml")" -eq 2
test "$(grep -c 'type: RuntimeDefault' "$work_dir/default.yaml")" -eq 2
test "$(grep -c -- '- ALL' "$work_dir/default.yaml")" -eq 2
test "$(grep -c 'image: "ghcr.io/example/opencode-sandbox:latest"' "$work_dir/default.yaml")" -eq 2
test "$(grep -c 'mountPath: /workspace' "$work_dir/default.yaml")" -eq 2

cat > "$work_dir/overrides-values.yaml" <<'EOF'
sandboxTemplates:
  enabled: true
  templates:
    - name: overrides
      image:
        repository: example/sandbox
        tag: v1
        pullPolicy: Always
      workspaceMaterializer:
        image:
          repository: example/materializer
      workspace:
        type: emptyDir
      networkPolicy:
        ingressFromOrchestrator: false
        egress:
          allowDNS: false
          allowInternetExceptPrivate: false
      podSpecOverrides:
        automountServiceAccountToken: true
        containers:
          - name: duplicate-container
            image: example/duplicate:v1
        volumes:
          - name: duplicate-volume
            emptyDir: {}
        restartPolicy: Always
        securityContext:
          fsGroup: 2000
          runAsNonRoot: true
        initContainers:
          - name: user-init
            image: example/init:v1
        nodeSelector:
          kubernetes.io/os: linux
      containerOverrides:
        securityContext:
          runAsUser: 2000
          seccompProfile:
            type: Localhost
            localhostProfile: profiles/opencode.json
EOF

helm template demo "$chart_dir" \
  --namespace agentbay-helm-test \
  --show-only templates/sandboxtemplates.yaml \
  -f "$work_dir/overrides-values.yaml" > "$work_dir/overrides.yaml"

grep -q 'image: "example/materializer:v1"' "$work_dir/overrides.yaml"
grep -q 'imagePullPolicy: Always' "$work_dir/overrides.yaml"
grep -q 'name: user-init' "$work_dir/overrides.yaml"
grep -q 'fsGroup: 2000' "$work_dir/overrides.yaml"
grep -q 'runAsNonRoot: true' "$work_dir/overrides.yaml"
grep -q 'kubernetes.io/os: linux' "$work_dir/overrides.yaml"
grep -q 'runAsUser: 2000' "$work_dir/overrides.yaml"
grep -q 'type: Localhost' "$work_dir/overrides.yaml"
grep -q 'localhostProfile: profiles/opencode.json' "$work_dir/overrides.yaml"
test "$(grep -c '^      automountServiceAccountToken:' "$work_dir/overrides.yaml")" -eq 1
test "$(grep -c '^      containers:' "$work_dir/overrides.yaml")" -eq 1
test "$(grep -c '^      initContainers:' "$work_dir/overrides.yaml")" -eq 1
test "$(grep -c '^      restartPolicy:' "$work_dir/overrides.yaml")" -eq 1
test "$(grep -c '^      securityContext:' "$work_dir/overrides.yaml")" -eq 1
test "$(grep -c '^      volumes:' "$work_dir/overrides.yaml")" -eq 1
if grep -q 'duplicate-container\|duplicate-volume\|restartPolicy: Always\|automountServiceAccountToken: true' "$work_dir/overrides.yaml"; then
  echo "podSpecOverrides unexpectedly replaced chart-managed PodSpec fields" >&2
  exit 1
fi

cat > "$work_dir/gateway-overrides-values.yaml" <<'EOF'
aiGatewayAuthz:
  enabled: true
sandboxTemplates:
  enabled: true
  templates:
    - name: gateway-overrides
      image:
        repository: example/sandbox
        tag: v1
      workspace:
        type: emptyDir
      networkPolicy:
        ingressFromOrchestrator: false
        egress:
          allowDNS: false
          allowInternetExceptPrivate: false
      podSpecOverrides:
        serviceAccountName: duplicate-service-account
        hostAliases:
          - ip: 192.0.2.1
            hostnames: [duplicate.example]
EOF

helm template demo "$chart_dir" \
  --namespace agentbay-helm-test \
  --show-only templates/sandboxtemplates.yaml \
  -f "$work_dir/gateway-overrides-values.yaml" > "$work_dir/gateway-overrides.yaml"

test "$(grep -c '^      serviceAccountName:' "$work_dir/gateway-overrides.yaml")" -eq 1
test "$(grep -c '^      hostAliases:' "$work_dir/gateway-overrides.yaml")" -eq 1
if grep -q 'duplicate-service-account\|duplicate.example\|192.0.2.1' "$work_dir/gateway-overrides.yaml"; then
  echo "podSpecOverrides unexpectedly replaced gateway-managed PodSpec fields" >&2
  exit 1
fi

cat > "$work_dir/spec-override-values.yaml" <<'EOF'
sandboxTemplates:
  enabled: true
  templates:
    - name: takeover
      specOverride:
        envVarsInjectionPolicy: Forbidden
        podTemplate:
          spec:
            containers:
              - name: custom
                image: example/custom:v1
EOF

helm template demo "$chart_dir" \
  --namespace agentbay-helm-test \
  --show-only templates/sandboxtemplates.yaml \
  -f "$work_dir/spec-override-values.yaml" > "$work_dir/spec-override.yaml"

grep -q 'name: custom' "$work_dir/spec-override.yaml"
if grep -q 'workspace-materializer' "$work_dir/spec-override.yaml"; then
  echo "specOverride unexpectedly contains the managed workspace materializer" >&2
  exit 1
fi

cat > "$work_dir/webhook-secret-values.yaml" <<'EOF'
orchestrator:
  extraEnv:
    - name: AGENTBAY_GITHUB_WEBHOOK_SECRET_PRODUCTION
      valueFrom:
        secretKeyRef:
          name: agentbay-github-webhook
          key: webhook-secret
sandboxTemplates:
  enabled: true
EOF

helm template demo "$chart_dir" \
  --namespace agentbay-helm-test \
  --show-only templates/deployment.yaml \
  -f "$work_dir/webhook-secret-values.yaml" > "$work_dir/webhook-secret-deployment.yaml"

test "$(grep -c 'name: AGENTBAY_GITHUB_WEBHOOK_SECRET_PRODUCTION' "$work_dir/webhook-secret-deployment.yaml")" -eq 1
grep -q 'name: agentbay-github-webhook' "$work_dir/webhook-secret-deployment.yaml"
grep -q 'key: webhook-secret' "$work_dir/webhook-secret-deployment.yaml"

for template in migrations-job.yaml reconciler-cronjob.yaml sandboxtemplates.yaml; do
  helm template demo "$chart_dir" \
    --namespace agentbay-helm-test \
    --show-only "templates/$template" \
    -f "$work_dir/webhook-secret-values.yaml" > "$work_dir/$template"
  if grep -q 'AGENTBAY_GITHUB_WEBHOOK_SECRET_PRODUCTION\|agentbay-github-webhook\|webhook-secret' "$work_dir/$template"; then
    echo "GitHub webhook secret unexpectedly rendered in $template" >&2
    exit 1
  fi
done
