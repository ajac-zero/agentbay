{{/*
Expand the name of the chart.
*/}}
{{- define "dispatch.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Create a fully qualified app name. Truncate to 63 chars because some
Kubernetes name fields are limited to this.
*/}}
{{- define "dispatch.fullname" -}}
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
{{- define "dispatch.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Common labels applied to every chart-managed resource.
*/}}
{{- define "dispatch.labels" -}}
helm.sh/chart: {{ include "dispatch.chart" . }}
{{ include "dispatch.selectorLabels" . }}
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
{{- define "dispatch.selectorLabels" -}}
app.kubernetes.io/name: {{ include "dispatch.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
Name of the ServiceAccount used by the orchestrator.
*/}}
{{- define "dispatch.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "dispatch.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/*
Name of the ServiceAccount used by the optional dispatch-authz Deployment.
*/}}
{{- define "dispatch.aiGatewayAuthz.serviceAccountName" -}}
{{- if .Values.aiGatewayAuthz.authz.serviceAccount.create -}}
{{- default (printf "%s-authz" (include "dispatch.fullname" .)) .Values.aiGatewayAuthz.authz.serviceAccount.name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- default "default" .Values.aiGatewayAuthz.authz.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/*
Selector labels for the optional dispatch-authz Deployment.
*/}}
{{- define "dispatch.aiGatewayAuthz.selectorLabels" -}}
app.kubernetes.io/name: {{ include "dispatch.name" . }}-authz
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: ai-gateway-authz
{{- end -}}

{{/*
Name of the ServiceAccount used by sandbox Pods for projected gateway tokens.
*/}}
{{- define "dispatch.aiGatewayAuthz.sandboxServiceAccountName" -}}
{{- default "sandbox-runtime" .Values.aiGatewayAuthz.sandboxServiceAccount.name -}}
{{- end -}}

{{/*
Namespace where SandboxClaims are created. Defaults to the release namespace.
*/}}
{{- define "dispatch.claimsNamespace" -}}
{{- default .Release.Namespace .Values.claims.namespace -}}
{{- end -}}

{{/*
Name of the Secret read by the orchestrator. Either the chart-managed
Secret or the user-provided existing Secret.
*/}}
{{- define "dispatch.secretName" -}}
{{- if .Values.secrets.existingSecret -}}
{{- .Values.secrets.existingSecret -}}
{{- else -}}
{{- include "dispatch.fullname" . -}}
{{- end -}}
{{- end -}}

{{/*
Selector labels for the in-cluster Postgres Deployment.
*/}}
{{- define "dispatch.postgres.selectorLabels" -}}
app.kubernetes.io/name: {{ include "dispatch.name" . }}-postgres
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: postgres
{{- end -}}

{{/*
Name of the in-cluster Postgres Service and Secret.
*/}}
{{- define "dispatch.postgres.fullname" -}}
{{- printf "%s-postgres" (include "dispatch.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Resolve which Postgres URL strategy is active. Output is one of:
  "in-cluster"        - use the chart's Postgres Deployment
  "external-url"      - use the literal value from database.external.url
  "external-secret"   - use a key from an existing Secret
  "none"              - no chart-managed database URL
*/}}
{{- define "dispatch.database.mode" -}}
{{- if .Values.database.enabled -}}
in-cluster
{{- else if .Values.database.external.url -}}
external-url
{{- else if .Values.database.external.existingSecret -}}
external-secret
{{- else -}}
none
{{- end -}}
{{- end -}}

{{/*
Database environment variables shared by the orchestrator and migration Job.
*/}}
{{- define "dispatch.databaseEnv" -}}
{{- $databaseMode := include "dispatch.database.mode" . -}}
{{- if eq $databaseMode "in-cluster" }}
- name: DISPATCH_DATABASE_HOST
  value: "{{ include "dispatch.postgres.fullname" . }}.{{ .Release.Namespace }}.svc"
- name: DISPATCH_DATABASE_PORT
  value: "5432"
- name: DISPATCH_DATABASE_NAME
  value: {{ .Values.database.auth.database | quote }}
- name: DISPATCH_DATABASE_USER
  value: {{ .Values.database.auth.username | quote }}
- name: DISPATCH_DATABASE_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "dispatch.postgres.fullname" . }}
      key: POSTGRES_PASSWORD
{{- else if eq $databaseMode "external-url" }}
- name: DISPATCH_DATABASE_URL
  value: {{ .Values.database.external.url | quote }}
{{- else if eq $databaseMode "external-secret" }}
- name: DISPATCH_DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ .Values.database.external.existingSecret }}
      key: {{ .Values.database.external.existingSecretKey }}
{{- end }}
{{- if .Values.database.ssl }}
- name: DISPATCH_DATABASE_SSL
  value: "true"
{{- end }}
{{- end -}}

{{/*
Default migration hook timing. External databases can migrate before install.
Chart-managed Postgres migrations are rendered as a normal Job so the app can
stay unready until the schema exists without deadlocking Helm post-install hooks.
*/}}
{{- define "dispatch.migrations.hookEvents" -}}
{{- if .Values.migrations.hookEvents -}}
{{- join "," .Values.migrations.hookEvents -}}
{{- else if .Values.database.enabled -}}
{{- else -}}
pre-install,pre-upgrade
{{- end -}}
{{- end -}}

{{/*
Name for the migration Job. Hook Jobs can reuse a stable name because Helm
deletes them before recreation; regular Jobs include the release revision so
upgrades can create a new immutable Job spec.
*/}}
{{- define "dispatch.migrations.jobName" -}}
{{- $hookEvents := include "dispatch.migrations.hookEvents" . | trim -}}
{{- if $hookEvents -}}
{{- printf "%s-migrate" (include "dispatch.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $base := printf "%s-migrate" (include "dispatch.fullname" .) | trunc 50 | trimSuffix "-" -}}
{{- printf "%s-%d" $base .Release.Revision | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{/*
Name of the ServiceAccount used by the reconciler CronJob.
*/}}
{{- define "dispatch.reconciler.serviceAccountName" -}}
{{- if .Values.reconciler.serviceAccount.create -}}
{{- default (printf "%s-reconciler" (include "dispatch.fullname" .)) .Values.reconciler.serviceAccount.name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- default "default" .Values.reconciler.serviceAccount.name -}}
{{- end -}}
{{- end -}}
