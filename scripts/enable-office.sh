#!/usr/bin/env bash
# Turns on Word -> PDF conversion for digital forms: builds the isolated LibreOffice converter (apps/office-converter) and points
# the server at it. Usage (in the install directory, e.g. /opt/botwa):  sudo bash scripts/enable-office.sh
# Safe to run again. Needs about 1 GB of disk for the image; the first build takes a few minutes.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || { echo ".env not found: run this inside the Botwa install directory." >&2; exit 1; }
DOCKER="docker"; docker info >/dev/null 2>&1 || DOCKER="sudo docker"
getv() { grep -E "^$1=" .env | tail -1 | cut -d= -f2- || true; }
setv() { if grep -qE "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else printf '%s=%s\n' "$1" "$2" >> .env; fi; }
disk_gb=$(df -Pk . | awk 'NR==2{printf "%d", $4/1024/1024}')
[ "$disk_gb" -ge 2 ] || { echo "Not enough free disk (needs about 2 GB)." >&2; exit 1; }
setv OFFICE_CONVERTER_URL "http://office:8090"
prof="$(getv COMPOSE_PROFILES)"
case ",$prof," in *,office,*) ;; *) setv COMPOSE_PROFILES "${prof:+$prof,}office" ;; esac
echo "  Building the Word converter (LibreOffice, a few minutes the first time)..."
$DOCKER compose build office
$DOCKER compose up -d office
for _ in $(seq 1 30); do [ "$($DOCKER compose ps --format '{{.Service}} {{.Health}}' | awk '$1=="office"{print $2}')" = healthy ] && break; sleep 2; done
$DOCKER compose up -d --no-build --force-recreate server
cat <<MSG

  Done. In the panel: Forms -> Templates: Word files (.docx) can now be uploaded or imported; they are turned into PDF first.
  To turn it off: docker compose stop office, then remove "office" from COMPOSE_PROFILES and OFFICE_CONVERTER_URL from .env.
MSG
