#!/usr/bin/env bash
# Safe update: backup first, pull, rebuild. Migrations run automatically on start.
set -euo pipefail
cd "$(dirname "$0")/.."
./scripts/backup.sh || { echo "Backup failed - aborting update" >&2; exit 1; }
git pull --ff-only
docker compose up -d --build
docker compose ps
echo "Updated. Run: DOMAIN=<your domain> ./scripts/smoke.sh"
