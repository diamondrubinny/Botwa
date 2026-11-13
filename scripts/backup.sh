#!/usr/bin/env bash
# Daily PostgreSQL backup. Run from the repo directory (cron example in docs/DEPLOY.md).
# Optional: BACKUP_GPG_RECIPIENT=<key id> encrypts the dump (RECOMMENDED – it contains customer messages).
set -euo pipefail
cd "$(dirname "$0")/.."
DEST="${BACKUP_DIR:-/var/backups/botwa}"
KEEP_DAYS="${KEEP_DAYS:-14}"
umask 077
mkdir -p "$DEST"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$DEST/botwa-$STAMP.sql.gz"

docker compose exec -T db pg_dump -U botwa --no-owner botwa | gzip -9 > "$OUT"
if [ -n "${BACKUP_GPG_RECIPIENT:-}" ]; then
  gpg --batch --yes --encrypt --recipient "$BACKUP_GPG_RECIPIENT" "$OUT" && shred -u "$OUT"
  OUT="$OUT.gpg"
fi
[ -s "$OUT" ] || { echo "backup is empty, aborting" >&2; exit 1; }
find "$DEST" -name 'botwa-*' -mtime +"$KEEP_DAYS" -delete
echo "backup ok: $OUT"
