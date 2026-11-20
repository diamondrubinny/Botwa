#!/usr/bin/env bash
# One-shot installer for an Ubuntu server (run from the repo root as a user in the docker group, or with sudo for apt/ufw).
#   DOMAIN=support.example.com ./scripts/install.sh
# Idempotent: never overwrites an existing .env; safe to re-run. DRY_RUN=1 only prepares .env (used by tests).
set -euo pipefail
cd "$(dirname "$0")/.."

: "${DOMAIN:?Usage: DOMAIN=support.example.com ./scripts/install.sh}"
[[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || { echo "Invalid DOMAIN" >&2; exit 1; }
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"

say() { printf '\n==> %s\n' "$*"; }

if [ -z "${DRY_RUN:-}" ]; then
  if ! command -v docker >/dev/null 2>&1; then
    say "Installing Docker"
    curl -fsSL https://get.docker.com | $SUDO sh
    $SUDO usermod -aG docker "$USER" || true
  fi
  if command -v ufw >/dev/null 2>&1; then
    say "Firewall: allow SSH, 80, 443"
    $SUDO ufw allow OpenSSH >/dev/null && $SUDO ufw allow 80,443/tcp >/dev/null && $SUDO ufw --force enable >/dev/null
  fi
fi

if [ -f .env ]; then
  say ".env exists - keeping it (secrets are NOT regenerated)"
else
  say "Creating .env with fresh secrets"
  umask 077
  cp .env.example .env
  rand() { openssl rand -base64 "$1" | tr -d '\n'; }
  dbpw="$(rand 24 | tr -d '/+=')"
  key="$(rand 32)"
  # '|' is not in base64 / hostnames, so it is a safe sed delimiter
  sed -i "s|^DOMAIN=.*|DOMAIN=$DOMAIN|; s|^APP_ORIGIN=.*|APP_ORIGIN=https://$DOMAIN|; s|^DB_PASSWORD=.*|DB_PASSWORD=$dbpw|; s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$key|" .env
  chmod 600 .env
  say "BACK UP ENCRYPTION_KEY NOW (password manager). Without it sessions and backups cannot be decrypted:"
  echo "    $key"
fi

[ -n "${DRY_RUN:-}" ] && { say "DRY_RUN: stopping before docker"; exit 0; }

say "Building and starting (first build takes a few minutes)"
if docker info >/dev/null 2>&1; then DOCKER="docker"; else DOCKER="$SUDO docker"; fi
$DOCKER compose up -d --build

say "Waiting for the app to become healthy"
for _ in $(seq 1 60); do
  s="$($DOCKER compose ps --format '{{.Service}} {{.Health}}' | awk '$1=="server"{print $2}')"
  [ "$s" = "healthy" ] && break
  sleep 5
done
$DOCKER compose ps

cat <<MSG

Done. Next steps:
  1. Create the first admin (the password is read without echo):
       ./scripts/create-admin.sh you@example.com "Your Name"
  2. Open https://$DOMAIN  (DNS A record must point to this server; HTTPS certificate is issued automatically)
  3. Verify:  DOMAIN=$DOMAIN ./scripts/smoke.sh
MSG
