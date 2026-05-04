{{- if .Values.rbac.create }}
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: {{ include "agentbay.fullname" . }}
  labels:
    {{- include "agentbay.labels" . | nindent 4 }}
subjects:
  - kind: ServiceAccount
    name: {{ include "agentbay.serviceAccountName" . }}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: {{ include "agentbay.fullname" . }}
{{- end }}
