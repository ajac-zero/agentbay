#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
KIND_CONFIG=${KIND_CONFIG:-"$ROOT_DIR/deploy/dev/kind-config.yaml"}
SANDBOX_TEMPLATE_MANIFEST=${SANDBOX_TEMPLATE_MANIFEST:-"$ROOT_DIR/deploy/dev/opencode-sandbox-template.yaml"}

CLUSTER_NAME=${CLUSTER_NAME:-agentbay-dev}
KUBECTL_CONTEXT=${KUBECTL_CONTEXT:-kind-${CLUSTER_NAME}}
AGENT_SANDBOX_VERSION=${AGENT_SANDBOX_VERSION:-v0.4.2}
AGENT_SANDBOX_SYSTEM_NAMESPACE=${AGENT_SANDBOX_SYSTEM_NAMESPACE:-agent-sandbox-system}
NAMESPACE=${NAMESPACE:-agent-sandbox}
SANDBOX_TEMPLATE_NAME=${SANDBOX_TEMPLATE_NAME:-opencode}
SANDBOX_PORT=${SANDBOX_PORT:-8888}
OPENCODE_IMAGE=${OPENCODE_IMAGE:-opencode:dev}
RECREATE_CLUSTER=${RECREATE_CLUSTER:-false}

MANIFEST_URL="https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${AGENT_SANDBOX_VERSION}/manifest.yaml"
EXTENSIONS_URL="https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${AGENT_SANDBOX_VERSION}/extensions.yaml"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

find_python() {
  if command -v python3 >/dev/null 2>&1; then
    echo python3
    return
  fi

  if command -v python >/dev/null 2>&1; then
    echo python
    return
  fi

  echo "Missing required command: python3 (or python)" >&2
  exit 1
}

log() {
  printf '[dev-cluster] %s\n' "$*"
}

ensure_kind_cluster() {
  if kind get clusters | grep -Fxq "$CLUSTER_NAME"; then
    if [[ "$RECREATE_CLUSTER" == "true" ]]; then
      log "Deleting existing kind cluster ${CLUSTER_NAME}"
      kind delete cluster --name "$CLUSTER_NAME"
    else
      log "Reusing existing kind cluster ${CLUSTER_NAME}"
      return
    fi
  fi

  log "Creating kind cluster ${CLUSTER_NAME} using ${KIND_CONFIG}"
  kind create cluster --name "$CLUSTER_NAME" --config "$KIND_CONFIG"
}

ensure_context() {
  kubectl cluster-info --context "$KUBECTL_CONTEXT" >/dev/null
  kubectl config use-context "$KUBECTL_CONTEXT" >/dev/null
}

install_agent_sandbox() {
  log "Installing agent-sandbox ${AGENT_SANDBOX_VERSION}"
  kubectl apply -f "$MANIFEST_URL"
  kubectl apply -f "$EXTENSIONS_URL"

  log "Waiting for CRDs"
  kubectl wait --for=condition=Established --timeout=180s crd/sandboxes.agents.x-k8s.io
  kubectl wait --for=condition=Established --timeout=180s crd/sandboxclaims.extensions.agents.x-k8s.io
  kubectl wait --for=condition=Established --timeout=180s crd/sandboxtemplates.extensions.agents.x-k8s.io

  log "Waiting for agent-sandbox controller deployment"
  kubectl rollout status deployment/agent-sandbox-controller \
    --namespace "$AGENT_SANDBOX_SYSTEM_NAMESPACE" \
    --timeout=180s
}

ensure_namespace() {
  log "Ensuring namespace ${NAMESPACE} exists"
  kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
}

maybe_load_opencode_image() {
  if docker image inspect "$OPENCODE_IMAGE" >/dev/null 2>&1; then
    log "Loading local image ${OPENCODE_IMAGE} into kind"
    kind load docker-image "$OPENCODE_IMAGE" --name "$CLUSTER_NAME"
    return
  fi

  log "Local Docker image ${OPENCODE_IMAGE} was not found; assuming it is already available from a registry"
}

apply_sandbox_template() {
  log "Applying SandboxTemplate ${SANDBOX_TEMPLATE_NAME} in namespace ${NAMESPACE}"
  NAMESPACE="$NAMESPACE" \
  SANDBOX_TEMPLATE_NAME="$SANDBOX_TEMPLATE_NAME" \
  OPENCODE_IMAGE="$OPENCODE_IMAGE" \
  SANDBOX_PORT="$SANDBOX_PORT" \
  "$PYTHON_BIN" - "$SANDBOX_TEMPLATE_MANIFEST" <<'PY' | kubectl apply -f -
import os
import sys
from pathlib import Path

manifest = Path(sys.argv[1]).read_text()
for key in ["NAMESPACE", "SANDBOX_TEMPLATE_NAME", "OPENCODE_IMAGE", "SANDBOX_PORT"]:
    manifest = manifest.replace('${' + key + '}', os.environ[key])
print(manifest)
PY
}

print_summary() {
  cat <<EOF

Agentbay local cluster bootstrap complete.

Cluster:
- name: ${CLUSTER_NAME}
- context: ${KUBECTL_CONTEXT}

Installed:
- agent-sandbox version: ${AGENT_SANDBOX_VERSION}
- namespace: ${NAMESPACE}
- SandboxTemplate: ${SANDBOX_TEMPLATE_NAME}
- OpenCode image: ${OPENCODE_IMAGE}

Useful commands:
- kubectl config use-context ${KUBECTL_CONTEXT}
- kubectl get sandboxtemplates -n ${NAMESPACE}
- kubectl get sandboxclaims -n ${NAMESPACE}
- kubectl get pods -n ${AGENT_SANDBOX_SYSTEM_NAMESPACE}
EOF
}

main() {
  require_command kind
  require_command kubectl
  require_command docker
  PYTHON_BIN=$(find_python)
  export PYTHON_BIN

  ensure_kind_cluster
  ensure_context
  install_agent_sandbox
  ensure_namespace
  maybe_load_opencode_image
  apply_sandbox_template
  print_summary
}

main "$@"
