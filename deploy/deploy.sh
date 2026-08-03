#!/usr/bin/env bash
# On-VPS deploy: pull the freshly published images and roll the stack.
# Snapshot + migrations apply on web boot (entrypoint). Run from /opt/waypoint/deploy.
# Waypoint never restarts or mutates its own production containers — deploying
# merged changes is deliberately this manual step (§11).
set -euo pipefail
cd "$(dirname "$0")"

echo "==> refreshing deploy configs"
git pull --ff-only || echo "   (git pull skipped)"

echo "==> pulling images"
docker compose pull

echo "==> building caddy (rate-limit module)"
docker compose build caddy

echo "==> rolling the stack"
docker compose up -d

echo "==> pruning old images"
docker image prune -f

echo "==> done. status:"
docker compose ps
