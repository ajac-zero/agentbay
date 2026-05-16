# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=24
ARG OPENCODE_VERSION=1.14.50

FROM node:${NODE_VERSION}-slim
ARG OPENCODE_VERSION
ENV NODE_ENV=production
WORKDIR /workspace
RUN npm install -g opencode-ai@${OPENCODE_VERSION} \
  && npm cache clean --force \
  && chown -R node:node /workspace
USER node
EXPOSE 4096
CMD ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096"]
