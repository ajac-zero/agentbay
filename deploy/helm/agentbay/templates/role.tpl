{{- if .Values.rbac.create }}
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: {{ include "agentbay.fullname" . }}
  labels:
    {{- include "agentbay.labels" . | nindent 4 }}
rules:
  - apiGroups: ["extensions.agents.x-k8s.io"]
    resources: ["sandboxclaims"]
    verbs: ["get", "list", "watch", "create", "delete"]
  - apiGroups: ["extensions.agents.x-k8s.io"]
    resources: ["sandboxes"]
    verbs: ["get"]
{{- end }}
