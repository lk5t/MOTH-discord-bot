# syntax=docker/dockerfile:1.7
# ─── MOTH multi-target image: `--target bot` or `--target dashboard` ───
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/bot/package.json apps/bot/
COPY apps/dashboard/package.json apps/dashboard/
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

FROM deps AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY apps/bot apps/bot
COPY apps/dashboard apps/dashboard
RUN npm run build -w @moth/core \
 && npm run build -w @moth/bot \
 && npm run build -w @moth/dashboard

# Production dependencies for the bot only (excludes Next.js/React).
FROM ${NODE_IMAGE} AS bot-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/bot/package.json apps/bot/
COPY apps/dashboard/package.json apps/dashboard/
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --no-audit --no-fund -w @moth/core -w @moth/bot

# ─── Bot (its image also runs database migrations) ───
FROM ${NODE_IMAGE} AS bot
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=bot-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages/core/package.json packages/core/
COPY --from=build --chown=node:node /app/packages/core/dist packages/core/dist
COPY --from=build --chown=node:node /app/packages/core/migrations packages/core/migrations
COPY --from=build --chown=node:node /app/apps/bot/package.json apps/bot/
COPY --from=build --chown=node:node /app/apps/bot/dist apps/bot/dist
USER node
EXPOSE 4100
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4100/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/bot/dist/index.js"]

# ─── Dashboard (Next.js standalone server) ───
FROM ${NODE_IMAGE} AS dashboard
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /app/apps/dashboard/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/dashboard/.next/static apps/dashboard/.next/static
COPY --from=build --chown=node:node /app/apps/dashboard/public apps/dashboard/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/dashboard/server.js"]
