# Waypoint orchestrator image (§11).
# Build from the REPO ROOT:  docker build -f apps/orchestrator/Dockerfile -t waypoint-orchestrator .
FROM node:24-bookworm-slim
COPY --from=oven/bun:1 /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx

WORKDIR /app
COPY package.json bun.lock tsconfig.base.json ./
COPY packages/core/package.json packages/core/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/orchestrator/package.json apps/orchestrator/package.json
COPY apps/runner/package.json apps/runner/package.json
RUN bun install --frozen-lockfile

COPY packages/core packages/core
COPY apps/orchestrator apps/orchestrator
RUN cd packages/core && bunx prisma generate

ENV NODE_ENV=production
WORKDIR /app/apps/orchestrator
# heartbeat-Setting healthcheck script (§11 self-healing checklist)
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s \
  CMD ["bunx", "tsx", "src/healthcheck.ts"]
# tsx on the Node 24 runtime (better-sqlite3 native bindings, §1)
CMD ["bunx", "tsx", "src/index.ts"]
