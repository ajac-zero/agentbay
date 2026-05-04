apiVersion: v1
kind: Service
metadata:
  name: {{ include "agentbay.fullname" . }}
  labels:
    {{- include "agentbay.labels" . | nindent 4 }}
spec:
  type: {{ .Values.service.type }}
  selector:
    {{- include "agentbay.selectorLabels" . | nindent 4 }}
  ports:
    - name: http
      port: {{ .Values.service.port }}
      targetPort: http
      protocol: TCP
