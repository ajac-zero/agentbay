# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS build
WORKDIR /app

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN npm install --global vite-plus@0.1.19
RUN vp install --frozen-lockfile

COPY tsconfig.json vite.config.ts ./
COPY src ./src
COPY scripts ./scripts

RUN vp build
RUN rm -rf node_modules && vp install --prod --frozen-lockfile --prefer-offline

FROM gcr.io/distroless/nodejs20-debian12:nonroot AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

USER nonroot:nonroot
EXPOSE 3000

CMD ["dist/main.js"]
