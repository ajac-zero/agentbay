apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ include "wolfgang.configMapName" . }}
  labels:
    {{- include "wolfgang.labels" . | nindent 4 }}
data:
  PORT: {{ .Values.containerPort | quote }}
  NAMESPACE: {{ include "wolfgang.namespace" . | quote }}
  SANDBOX_TEMPLATE_NAME: {{ .Values.config.sandboxTemplateName | quote }}
  SANDBOX_ROUTER_URL: {{ include "wolfgang.sandboxRouterUrl" . | quote }}
  SANDBOX_PORT: {{ .Values.config.sandboxPort | quote }}
  STATE_BACKEND_URL: {{ .Values.config.stateBackendUrl | quote }}
