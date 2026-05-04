apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ include "agentbay.configMapName" . }}
  labels:
    {{- include "agentbay.labels" . | nindent 4 }}
data:
  PORT: {{ .Values.containerPort | quote }}
  NAMESPACE: {{ include "agentbay.namespace" . | quote }}
  KUBERNETES_CLUSTER_DOMAIN: {{ .Values.config.clusterDomain | quote }}
  SANDBOX_TEMPLATE_NAME: {{ .Values.config.sandboxTemplateName | quote }}
  SANDBOX_ACCESS_MODE: {{ .Values.config.sandboxAccessMode | quote }}
  SANDBOX_ROUTER_URL: {{ include "agentbay.sandboxRouterUrl" . | quote }}
  SANDBOX_PORT: {{ .Values.config.sandboxPort | quote }}
  SANDBOX_IDLE_TTL_MINUTES: {{ .Values.config.sandboxIdleTtlMinutes | quote }}
  SANDBOX_READY_TIMEOUT_SECONDS: {{ .Values.config.sandboxReadyTimeoutSeconds | quote }}
  STATE_BACKEND_URL: {{ .Values.config.stateBackendUrl | quote }}
