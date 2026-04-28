{{- define "wolfgang.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "wolfgang.fullname" -}}
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

{{- define "wolfgang.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "wolfgang.labels" -}}
helm.sh/chart: {{ include "wolfgang.chart" . }}
app.kubernetes.io/name: {{ include "wolfgang.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "wolfgang.selectorLabels" -}}
app.kubernetes.io/name: {{ include "wolfgang.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "wolfgang.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "wolfgang.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "wolfgang.namespace" -}}
{{- default .Release.Namespace .Values.config.namespace -}}
{{- end -}}

{{- define "wolfgang.sandboxRouterUrl" -}}
{{- if .Values.config.sandboxRouterUrl -}}
{{- .Values.config.sandboxRouterUrl -}}
{{- else -}}
{{- printf "http://sandbox-router.%s.svc.cluster.local:8080" (include "wolfgang.namespace" .) -}}
{{- end -}}
{{- end -}}

{{- define "wolfgang.secretName" -}}
{{- printf "%s-secrets" (include "wolfgang.fullname" .) -}}
{{- end -}}

{{- define "wolfgang.configMapName" -}}
{{- printf "%s-config" (include "wolfgang.fullname" .) -}}
{{- end -}}
