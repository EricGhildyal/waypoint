# Waypoint web image — Next.js app + migrate/seed entrypoint (§11).
# Build from the REPO ROOT:  docker build -f apps/web/Dockerfile -t waypoint-web .
FROM node:24-bookworm-slim AS base
COPY --from=oven/bun:1 /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx \
  && apt-get update \
  && apt-get install -y --no-install-recommends sqlite3 wget ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json bun.lock tsconfig.base.json ./
COPY packages/core/package.json packages/core/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/orchestrator/package.json apps/orchestrator/package.json
COPY apps/runner/package.json apps/runner/package.json
RUN bun install --frozen-lockfile

COPY packages/core packages/core
COPY apps/web apps/web

# generate the Prisma client, then build Next (no DB access at build time)
RUN cd packages/core && bunx prisma generate
ENV NEXT_TELEMETRY_DISABLED=1
RUN cd apps/web && bunx next build

COPY apps/web/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV NODE_ENV=production
EXPOSE 3000
# entrypoint: pre-migrate snapshot → prisma migrate deploy → seed → next start (§11)
ENTRYPOINT ["/entrypoint.sh"]
