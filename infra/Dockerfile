# syntax=docker/dockerfile:1.25@sha256:0adf442eae370b6087e08edc7c50b552d80ddf261576f4ebd6421006b2461f12

ARG NODE_VERSION=24

FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS dependencies
WORKDIR /app

# Copy manifests first so dependency installation remains cacheable. package*.json
# includes package-lock.json when it is present.
COPY package*.json ./
COPY apps/server/package*.json apps/server/
COPY apps/web/package*.json apps/web/
COPY packages/shared/package*.json packages/shared/

RUN --mount=type=cache,id=flightmap-npm-full,target=/root/.npm,sharing=locked \
    if [ -f package-lock.json ]; then npm ci; else npm install; fi

FROM dependencies AS build
WORKDIR /app
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
COPY apps/server apps/server

# The root build intentionally orders the workspace builds shared -> web -> server.
RUN npm run build

FROM node:${NODE_VERSION}-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS production-dependencies
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
COPY apps/server/package*.json apps/server/
COPY apps/web/package*.json apps/web/
COPY packages/shared/package*.json packages/shared/

RUN --mount=type=cache,id=flightmap-npm-production,target=/root/.npm,sharing=locked \
    if [ -f package-lock.json ]; then \
      npm ci --omit=dev --ignore-scripts \
        --workspace @flightmap/server \
        --workspace @flightmap/shared; \
    else \
      npm install --omit=dev --ignore-scripts \
        --workspace @flightmap/server \
        --workspace @flightmap/shared; \
    fi

FROM node:${NODE_VERSION}-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    APP_HOST=0.0.0.0 \
    APP_PORT=8080 \
    WEB_DIST_DIR=/app/apps/web/dist \
    NPM_CONFIG_CACHE=/tmp/.npm \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    TZ=UTC

COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=production-dependencies --chown=node:node /app/package.json ./
COPY --from=production-dependencies --chown=node:node /app/apps/server/package.json ./apps/server/package.json
COPY --from=production-dependencies --chown=node:node /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build --chown=node:node /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=node:node /app/packages/shared/dist ./packages/shared/dist
COPY --chown=node:node infra/docker-entrypoint.sh infra/healthcheck.mjs ./infra/

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "infra/healthcheck.mjs", "live"]

CMD ["./infra/docker-entrypoint.sh"]
