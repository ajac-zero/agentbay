{{- define "agentbay.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

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

{{- define "agentbay.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "agentbay.labels" -}}
helm.sh/chart: {{ include "agentbay.chart" . }}
app.kubernetes.io/name: {{ include "agentbay.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "agentbay.selectorLabels" -}}
app.kubernetes.io/name: {{ include "agentbay.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "agentbay.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "agentbay.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "agentbay.namespace" -}}
{{- default .Release.Namespace .Values.config.namespace -}}
{{- end -}}

{{- define "agentbay.sandboxRouterUrl" -}}
{{- if .Values.config.sandboxRouterUrl -}}
{{- .Values.config.sandboxRouterUrl -}}
{{- else -}}
{{- printf "http://sandbox-router.%s.svc.cluster.local:8080" (include "agentbay.namespace" .) -}}
{{- end -}}
{{- end -}}

{{- define "agentbay.secretName" -}}
{{- printf "%s-secrets" (include "agentbay.fullname" .) -}}
{{- end -}}

{{- define "agentbay.configMapName" -}}
{{- printf "%s-config" (include "agentbay.fullname" .) -}}
{{- end -}}
