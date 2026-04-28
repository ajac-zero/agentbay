{{- if .Values.rbac.create }}
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: {{ include "wolfgang.fullname" . }}
  labels:
    {{- include "wolfgang.labels" . | nindent 4 }}
subjects:
  - kind: ServiceAccount
    name: {{ include "wolfgang.serviceAccountName" . }}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: {{ include "wolfgang.fullname" . }}
{{- end }}
