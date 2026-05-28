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
Name of the ServiceAccount used by the optional agentbay-authz Deployment.
*/}}
{{- define "agentbay.aiGatewayAuthz.serviceAccountName" -}}
{{- if .Values.aiGatewayAuthz.authz.serviceAccount.create -}}
{{- default (printf "%s-authz" (include "agentbay.fullname" .)) .Values.aiGatewayAuthz.authz.serviceAccount.name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- default "default" .Values.aiGatewayAuthz.authz.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/*
Selector labels for the optional agentbay-authz Deployment.
*/}}
{{- define "agentbay.aiGatewayAuthz.selectorLabels" -}}
app.kubernetes.io/name: {{ include "agentbay.name" . }}-authz
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: ai-gateway-authz
{{- end -}}

{{/*
Name of the ServiceAccount used by sandbox Pods for projected gateway tokens.
*/}}
{{- define "agentbay.aiGatewayAuthz.sandboxServiceAccountName" -}}
{{- default "sandbox-runtime" .Values.aiGatewayAuthz.sandboxServiceAccount.name -}}
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
Selector labels for the in-cluster Postgres Deployment.
*/}}
{{- define "agentbay.postgres.selectorLabels" -}}
app.kubernetes.io/name: {{ include "agentbay.name" . }}-postgres
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: postgres
{{- end -}}

{{/*
Name of the in-cluster Postgres Service and Secret.
*/}}
{{- define "agentbay.postgres.fullname" -}}
{{- printf "%s-postgres" (include "agentbay.fullname" .) | trunc 63 | trimSuffix "-" -}}
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

{{/*
Resolve which Postgres URL strategy is active. Output is one of:
  "in-cluster"        - use the chart's Postgres Deployment
  "external-url"      - use the literal value from database.external.url
  "external-secret"   - use a key from an existing Secret
  "none"              - no chart-managed database URL
*/}}
{{- define "agentbay.database.mode" -}}
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
{{- define "agentbay.databaseEnv" -}}
{{- $databaseMode := include "agentbay.database.mode" . -}}
{{- if eq $databaseMode "in-cluster" }}
- name: AGENTBAY_DATABASE_HOST
  value: "{{ include "agentbay.postgres.fullname" . }}.{{ .Release.Namespace }}.svc"
- name: AGENTBAY_DATABASE_PORT
  value: "5432"
- name: AGENTBAY_DATABASE_NAME
  value: {{ .Values.database.auth.database | quote }}
- name: AGENTBAY_DATABASE_USER
  value: {{ .Values.database.auth.username | quote }}
- name: AGENTBAY_DATABASE_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "agentbay.postgres.fullname" . }}
      key: POSTGRES_PASSWORD
{{- else if eq $databaseMode "external-url" }}
- name: AGENTBAY_DATABASE_URL
  value: {{ .Values.database.external.url | quote }}
{{- else if eq $databaseMode "external-secret" }}
- name: AGENTBAY_DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ .Values.database.external.existingSecret }}
      key: {{ .Values.database.external.existingSecretKey }}
{{- end }}
{{- if .Values.database.ssl }}
- name: AGENTBAY_DATABASE_SSL
  value: "true"
{{- end }}
{{- end -}}

{{/*
Default migration hook timing. External databases can migrate before install.
Chart-managed Postgres migrations are rendered as a normal Job so the app can
stay unready until the schema exists without deadlocking Helm post-install hooks.
*/}}
{{- define "agentbay.migrations.hookEvents" -}}
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
{{- define "agentbay.migrations.jobName" -}}
{{- $hookEvents := include "agentbay.migrations.hookEvents" . | trim -}}
{{- if $hookEvents -}}
{{- printf "%s-migrate" (include "agentbay.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $base := printf "%s-migrate" (include "agentbay.fullname" .) | trunc 50 | trimSuffix "-" -}}
{{- printf "%s-%d" $base .Release.Revision | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{/*
Name of the ServiceAccount used by the reconciler CronJob.
*/}}
{{- define "agentbay.reconciler.serviceAccountName" -}}
{{- if .Values.reconciler.serviceAccount.create -}}
{{- default (printf "%s-reconciler" (include "agentbay.fullname" .)) .Values.reconciler.serviceAccount.name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- default "default" .Values.reconciler.serviceAccount.name -}}
{{- end -}}
{{- end -}}
