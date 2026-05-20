# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=24
ARG PNPM_VERSION=11.1.2

FROM node:${NODE_VERSION}-slim AS package-manager
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
ENV pnpm_config_pm_on_fail=ignore
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

FROM package-manager AS build-base
RUN apt-get update \
  && apt-get install -y --no-install-recommends g++ make python3 \
  && rm -rf /var/lib/apt/lists/*

FROM build-base AS dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM build-base AS production-dependencies
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM dependencies AS build
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM node:${NODE_VERSION}-slim AS runtime
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app
RUN groupadd --system --gid 10001 agentbay \
  && useradd --system --uid 10001 --gid agentbay --home-dir /app agentbay
COPY --from=production-dependencies --chown=agentbay:agentbay /app/node_modules ./node_modules
COPY --from=build --chown=agentbay:agentbay /app/dist ./dist
COPY --from=build --chown=agentbay:agentbay /app/package.json ./package.json
COPY --chown=agentbay:agentbay drizzle ./drizzle
USER 10001
EXPOSE 3000
CMD ["node", "dist/index.js"]
