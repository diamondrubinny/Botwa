#!/usr/bin/env bash
# Move Botwa to a new server, step 2 (on the NEW server, after a normal install): restores the database, attachment files
# and settings from the migration file. THIS REPLACES everything on this server.
# Usage: sudo ./scripts/migrate-import.sh /root/botwa-migration-YYYYMMDD-HHMMSS.bundle
set -euo pipefail
BUNDLE="${1:-}"
[ -n "$BUNDLE" ] && [ -f "$BUNDLE" ] || { echo "Usage: $0 <migration .bundle file>" >&2; exit 1; }
BUNDLE="$(readlink -f "$BUNDLE")"
cd "${BOTWA_DIR:-$(dirname "$0")/..}"
[ -f .env ] || { echo "Run this from the Botwa folder of a working installation (no .env here)." >&2; exit 1; }
docker compose ps --status running server | grep -q server || { echo "Start Botwa first: docker compose up -d" >&2; exit 1; }
echo "This REPLACES the database, attachment files and settings of THIS server with the ones in the file."
read -rp "Type MOVE to continue: " OK; [ "$OK" = "MOVE" ] || { echo "Cancelled."; exit 1; }
read -rsp "Passphrase of the migration file: " P; echo
STAGE="/data/backups/.migration-$$"
umask 077
docker compose exec -T server sh -c "cat > /data/backups/.incoming.bundle" < "$BUNDLE"
cleanup() { docker compose exec -T server rm -rf "$STAGE" /data/backups/.incoming.bundle >/dev/null 2>&1 || true; }
trap cleanup EXIT
# 1. decrypt + check, and build the new settings file (old secrets, this machine's address and database password)
MIGRATION_PASSPHRASE="$P" docker compose exec -T -e MIGRATION_PASSPHRASE server node dist/scripts/migration-import.js open /data/backups/.incoming.bundle "$STAGE" < .env > .env.migrated
[ -s .env.migrated ] || { echo "Could not open the file (wrong passphrase?)." >&2; rm -f .env.migrated; exit 1; }
cp -p .env ".env.before-migration-$(date +%Y%m%d-%H%M%S)"
mv .env.migrated .env && chmod 600 .env
# 2. stop the app, restore with the moved settings, start again (migrations for newer versions run on start)
docker compose stop server
docker compose run --rm --no-deps -T server node dist/scripts/migration-import.js restore "$STAGE"
docker compose up -d
trap - EXIT; cleanup
echo
echo "Done. Botwa now runs with the moved data. Sign in with the same users as on the old server."
echo "WhatsApp: a QR-linked number can be active on one server only. Stop the old server before testing:  (on the old server) docker compose stop"
echo "Keep the previous settings file (.env.before-migration-*) until everything works, then delete it and the .bundle file."
