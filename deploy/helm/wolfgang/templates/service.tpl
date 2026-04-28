apiVersion: v1
kind: Service
metadata:
  name: {{ include "wolfgang.fullname" . }}
  labels:
    {{- include "wolfgang.labels" . | nindent 4 }}
spec:
  type: {{ .Values.service.type }}
  selector:
    {{- include "wolfgang.selectorLabels" . | nindent 4 }}
  ports:
    - name: http
      port: {{ .Values.service.port }}
      targetPort: http
      protocol: TCP
