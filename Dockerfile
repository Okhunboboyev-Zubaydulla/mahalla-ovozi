FROM node:24-bookworm-slim AS base
RUN corepack enable && corepack prepare pnpm@10.34.1 --activate
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
WORKDIR /app

# Stage 1: Install dependencies with BuildKit pnpm store cache mount
FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/api-contracts/package.json ./packages/api-contracts/
COPY apps/backend/package.json ./apps/backend/
COPY apps/web/package.json ./apps/web/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# Stage 2: Build contracts and web SPA
FROM deps AS builder
COPY tsconfig.base.json tsconfig.json ./
COPY packages/ ./packages/
COPY apps/ ./apps/

# Build shared contracts first, then build web frontend assets
RUN pnpm --filter @mahalla-ovozi/api-contracts build && \
    pnpm --filter @mahalla-ovozi/web build

# Stage 3: Production backend and worker runner (no MTProto client)
FROM base AS runner
WORKDIR /app

# Install curl, ca-certificates, and pgbackrest for secure HTTPS, healthchecks, and verified backups
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates pgbackrest && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /pnpm /app/deploy/backup && chown -R node:node /pnpm

COPY --chown=node:node --from=builder /app /app

# The HTTP API and the worker never open an MTProto connection. The userbot client is a
# userbot-runtime dependency, so it is excluded here and carried only by userbot-runner.
RUN rm -rf /app/node_modules/.pnpm/teleproto@* /app/apps/backend/node_modules/teleproto

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV NODE_OPTIONS="--dns-result-order=ipv4first"

USER node

CMD ["pnpm", "--filter", "@mahalla-ovozi/backend", "exec", "node", "--import", "tsx/esm", "src/entrypoints/http.ts"]

# Stage 3b: Production userbot runner (carries the userbot-only MTProto client)
FROM base AS userbot-runner
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /pnpm && chown -R node:node /pnpm

# Built from the same builder output as runner, but without the exclusion step, so this image
# is the only one that resolves the MTProto client at runtime.
COPY --chown=node:node --from=builder /app /app

ENV NODE_ENV=production
ENV NODE_OPTIONS="--dns-result-order=ipv4first"

USER node

CMD ["pnpm", "--filter", "@mahalla-ovozi/backend", "exec", "node", "--import", "tsx/esm", "src/entrypoints/userbot.ts"]

# Stage 4: Production Caddy reverse proxy serving built SPA and proxying API
FROM caddy:2-alpine AS caddy
COPY --from=builder /app/apps/web/dist /srv/web
COPY deploy/compose/Caddyfile /etc/caddy/Caddyfile
EXPOSE 80 443
