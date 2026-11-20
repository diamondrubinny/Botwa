#!/usr/bin/env bash
# Usage: ./scripts/create-admin.sh admin@example.com "Display Name"   (password prompted, never in shell history / argv)
set -euo pipefail
cd "$(dirname "$0")/.."
email="${1:?email required}"; name="${2:?display name required}"
read -rsp "Admin password (min 12 chars): " pw; echo
[ "${#pw}" -ge 12 ] || { echo "Password too short" >&2; exit 1; }
docker compose exec -T -e ADMIN_EMAIL="$email" -e ADMIN_NAME="$name" -e ADMIN_PASSWORD="$pw" server node dist/scripts/create-admin.js
