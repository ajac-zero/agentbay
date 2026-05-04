apiVersion: v1
kind: Secret
metadata:
  name: {{ include "agentbay.secretName" . }}
  labels:
    {{- include "agentbay.labels" . | nindent 4 }}
type: Opaque
stringData:
  {{- with .Values.secrets }}
  {{- if .slackSigningSecret }}
  SLACK_SIGNING_SECRET: {{ .slackSigningSecret | quote }}
  {{- end }}
  {{- if .slackBotToken }}
  SLACK_BOT_TOKEN: {{ .slackBotToken | quote }}
  {{- end }}
  {{- if .slackClientId }}
  SLACK_CLIENT_ID: {{ .slackClientId | quote }}
  {{- end }}
  {{- if .slackClientSecret }}
  SLACK_CLIENT_SECRET: {{ .slackClientSecret | quote }}
  {{- end }}
  {{- if .discordPublicKey }}
  DISCORD_PUBLIC_KEY: {{ .discordPublicKey | quote }}
  {{- end }}
  {{- if .discordBotToken }}
  DISCORD_BOT_TOKEN: {{ .discordBotToken | quote }}
  {{- end }}
  {{- if .telegramBotToken }}
  TELEGRAM_BOT_TOKEN: {{ .telegramBotToken | quote }}
  {{- end }}
  {{- if .githubWebhookSecret }}
  GITHUB_WEBHOOK_SECRET: {{ .githubWebhookSecret | quote }}
  {{- end }}
  {{- if .linearWebhookSecret }}
  LINEAR_WEBHOOK_SECRET: {{ .linearWebhookSecret | quote }}
  {{- end }}
  {{- if .googleChatVerificationToken }}
  GOOGLE_CHAT_VERIFICATION_TOKEN: {{ .googleChatVerificationToken | quote }}
  {{- end }}
  {{- if .whatsappVerifyToken }}
  WHATSAPP_VERIFY_TOKEN: {{ .whatsappVerifyToken | quote }}
  {{- end }}
  {{- if .whatsappAccessToken }}
  WHATSAPP_ACCESS_TOKEN: {{ .whatsappAccessToken | quote }}
  {{- end }}
  {{- if .microsoftTeamsAppId }}
  MICROSOFT_TEAMS_APP_ID: {{ .microsoftTeamsAppId | quote }}
  {{- end }}
  {{- if .microsoftTeamsAppPassword }}
  MICROSOFT_TEAMS_APP_PASSWORD: {{ .microsoftTeamsAppPassword | quote }}
  {{- end }}
  {{- end }}
