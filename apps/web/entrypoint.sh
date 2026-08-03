#!/bin/sh
# Web container entrypoint (§3.1/§11):
#   1. pre-migrate SQLite snapshot (keep last 10) — a bad migration is a
#      file-copy away from rollback, on top of Litestream's replication
#   2. prisma migrate deploy (the orchestrator waits on this via its
#      depends_on: service_healthy)
#   3. idempotent seed (settings, allowlist, global secrets from env)
#   4. next start (Node runtime)
set -e

DB_FILE="${DB_FILE:-/data/waypoint.db}"
mkdir -p /data/backups /data/tasks

if [ -f "$DB_FILE" ]; then
  STAMP=$(date +%Y%m%d%H%M%S)
  echo "[entrypoint] snapshot -> /data/backups/pre-migrate-$STAMP.db"
  sqlite3 "$DB_FILE" ".backup /data/backups/pre-migrate-$STAMP.db"
  ls -1t /data/backups/pre-migrate-*.db 2>/dev/null | tail -n +11 | xargs -r rm --
fi

cd /app/packages/core
echo "[entrypoint] prisma migrate deploy"
bunx prisma migrate deploy
echo "[entrypoint] seed"
bunx tsx prisma/seed.ts

cd /app/apps/web
echo "[entrypoint] starting next"
exec bunx next start -p 3000
