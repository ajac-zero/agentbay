{{/*
Expand the name of the chart.
*/}}
{{- define "agentbay.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Create a fully qualified app name. Truncate to 63 chars because some
Kubernetes name fields are limited to this.
*/}}
{{- define "agentbay.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Chart label suitable for the helm.sh/chart label.
*/}}
{{- define "agentbay.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Common labels applied to every chart-managed resource.
*/}}
{{- define "agentbay.labels" -}}
helm.sh/chart: {{ include "agentbay.chart" . }}
{{ include "agentbay.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- with .Values.extraLabels }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{/*
Selector labels for the orchestrator. The SandboxTemplate's NetworkPolicy
selects orchestrator Pods using app.kubernetes.io/name, so we keep that
value stable and explicit.
*/}}
{{- define "agentbay.selectorLabels" -}}
app.kubernetes.io/name: {{ include "agentbay.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
Selector labels for the in-cluster Redis Deployment.
*/}}
{{- define "agentbay.redis.selectorLabels" -}}
app.kubernetes.io/name: {{ include "agentbay.name" . }}-redis
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: redis
{{- end -}}

{{/*
Name of the ServiceAccount used by the orchestrator.
*/}}
{{- define "agentbay.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "agentbay.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/*
Namespace where SandboxClaims are created. Defaults to the release namespace.
*/}}
{{- define "agentbay.claimsNamespace" -}}
{{- default .Release.Namespace .Values.claims.namespace -}}
{{- end -}}

{{/*
Name of the Secret read by the orchestrator. Either the chart-managed
Secret or the user-provided existing Secret.
*/}}
{{- define "agentbay.secretName" -}}
{{- if .Values.secrets.existingSecret -}}
{{- .Values.secrets.existingSecret -}}
{{- else -}}
{{- include "agentbay.fullname" . -}}
{{- end -}}
{{- end -}}

{{/*
Name of the in-cluster Redis Service.
*/}}
{{- define "agentbay.redis.fullname" -}}
{{- printf "%s-redis" (include "agentbay.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Resolve which Redis URL strategy is active. Output is one of:
  "in-cluster"        - use the chart's Redis Deployment
  "external-url"      - use the literal value from redis.external.url
  "external-secret"   - use a key from an existing Secret
  "none"              - no Redis, orchestrator falls back to in-memory state
*/}}
{{- define "agentbay.redis.mode" -}}
{{- if .Values.redis.enabled -}}
in-cluster
{{- else if .Values.redis.external.url -}}
external-url
{{- else if .Values.redis.external.existingSecret -}}
external-secret
{{- else -}}
none
{{- end -}}
{{- end -}}
