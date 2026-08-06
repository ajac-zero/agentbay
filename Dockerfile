# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=24
ARG PNPM_VERSION=10.34.5

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
RUN groupadd --system --gid 10001 dispatch \
  && useradd --system --uid 10001 --gid dispatch --home-dir /app dispatch
COPY --from=production-dependencies --chown=dispatch:dispatch /app/node_modules ./node_modules
COPY --from=build --chown=dispatch:dispatch /app/dist ./dist
COPY --from=build --chown=dispatch:dispatch /app/package.json ./package.json
COPY --chown=dispatch:dispatch drizzle ./drizzle
USER 10001
EXPOSE 3000
CMD ["node", "dist/index.js"]
