#!/usr/bin/env bash
# Move Botwa to a new server, step 1 (on the OLD server): one encrypted file with the database, attachment files and settings.
# Usage: sudo ./scripts/migrate-export.sh            (from the Botwa folder, default /opt/botwa)
set -euo pipefail
cd "${BOTWA_DIR:-$(dirname "$0")/..}"
[ -f .env ] || { echo "Run this from the Botwa folder (no .env here)." >&2; exit 1; }
docker compose ps --status running server | grep -q server || { echo "The Botwa server is not running (docker compose up -d)." >&2; exit 1; }
echo "Choose a passphrase for the migration file (at least 12 characters). It is needed on the new server."
read -rsp "Passphrase: " P1; echo
read -rsp "Again: " P2; echo
[ "$P1" = "$P2" ] || { echo "The passphrases differ." >&2; exit 1; }
[ "${#P1}" -ge 12 ] || { echo "At least 12 characters, please." >&2; exit 1; }
NAME="botwa-migration-$(date +%Y%m%d-%H%M%S).bundle"
umask 077
# the passphrase goes through the environment (not the command line, so it never shows in the process list)
MIGRATION_PASSPHRASE="$P1" docker compose exec -T -e MIGRATION_PASSPHRASE server node dist/scripts/migration-export.js "/data/backups/$NAME" < .env
docker compose exec -T server cat "/data/backups/$NAME" > "./$NAME"
docker compose exec -T server rm -f "/data/backups/$NAME"
chmod 600 "./$NAME"
echo
echo "Done: $(pwd)/$NAME ($(du -h "./$NAME" | cut -f1))"
echo "Copy it to the new server, for example:  scp ./$NAME root@NEW-SERVER:/root/"
echo "Then on the new server: install Botwa (bootstrap), and run:  sudo /opt/botwa/scripts/migrate-import.sh /root/$NAME"
echo "Keep the passphrase safe. Delete the file from both servers when the move is done."
