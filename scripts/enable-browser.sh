#!/usr/bin/env bash
# Turns on the headless browser (separate, locked-down container) used to read pages that are built by JavaScript.
# Usage (in the install directory, e.g. /opt/botwa):  bash scripts/enable-browser.sh
# Safe to run again: keeps an existing token. Adds "browser" to COMPOSE_PROFILES, sets BROWSER_URL and BROWSER_TOKEN in .env, rebuilds.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || { echo ".env not found: run this inside the Botwa install directory." >&2; exit 1; }
DOCKER="docker"; docker info >/dev/null 2>&1 || DOCKER="sudo docker"
getv() { grep -E "^$1=" .env | tail -1 | cut -d= -f2- || true; }
setv() { if grep -qE "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else printf '%s=%s\n' "$1" "$2" >> .env; fi; }
tok="$(getv BROWSER_TOKEN)"
if [ "${#tok}" -lt 24 ]; then tok="$(head -c 36 /dev/urandom | base64 | tr -d '/+=\n' | head -c 40)"; setv BROWSER_TOKEN "$tok"; fi
setv BROWSER_URL "http://browser:3100"
prof="$(getv COMPOSE_PROFILES)"
case ",$prof," in *,browser,*) ;; *) setv COMPOSE_PROFILES "${prof:+$prof,}browser" ;; esac
echo "Building and starting the browser service (the first build downloads Chromium, a few minutes)..."
$DOCKER compose up -d --build
$DOCKER compose ps
echo "Done. In the knowledge base page the line 'דפדפן לטעינת דפים' should say 'פעיל' within a minute."
