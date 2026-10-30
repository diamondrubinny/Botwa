#!/usr/bin/env bash
# Botwa installation wizard for an Ubuntu server.
#   sudo ./setup.sh            interactive
#   ./scripts/wizard.sh --help
# Non-interactive (automation/tests): WIZARD_NONINTERACTIVE=1 with variables WZ_DOMAIN, WZ_ADMIN_EMAIL, WZ_ADMIN_NAME,
# WZ_ADMIN_PASSWORD [WZ_TG_API_ID WZ_TG_API_HASH WZ_MEDIA=y|n WZ_RETENTION WZ_BACKUP_HOUR WZ_TZ]. WIZARD_DRY_RUN=1 stops before Docker.
# (Prompts are in English on purpose: many SSH terminals render Hebrew reversed.)
set -euo pipefail
cd "$(dirname "$0")/.."

[ "${1:-}" = "--help" ] && { sed -n 2,7p "$0" | sed 's/^# \{0,1\}//'; exit 0; }

NI="${WIZARD_NONINTERACTIVE:-}"
DRY="${WIZARD_DRY_RUN:-}"
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
b=$'\033[1m'; g=$'\033[32m'; y=$'\033[33m'; r=$'\033[31m'; n=$'\033[0m'
step() { printf '\n%s== %s ==%s\n' "$b" "$*" "$n"; }
ok()   { printf '  %s✔%s %s\n' "$g" "$n" "$*"; }
warn() { printf '  %s!%s %s\n' "$y" "$n" "$*"; }
die()  { printf '  %s✘ %s%s\n' "$r" "$*" "$n" >&2; exit 1; }

# ask VAR "Prompt" "default" [validator-regex] [error]   (non-interactive: takes WZ_<VAR>)
ask() {
  local var="$1" prompt="$2" def="${3:-}" re="${4:-.*}" err="${5:-Invalid value}" val ev="WZ_$1"
  while true; do
    if [ -n "$NI" ]; then val="${!ev:-$def}"; else read -rp "  $prompt${def:+ [$def]}: " val; val="${val:-$def}"; fi
    if [[ "$val" =~ $re ]]; then printf -v "$var" '%s' "$val"; return; fi
    [ -n "$NI" ] && die "$err ($var='$val')"
    warn "$err"
  done
}
yesno() { # yesno VAR "Prompt" default(y|n)
  local var="$1" prompt="$2" def="$3" val ev="WZ_$1"
  if [ -n "$NI" ]; then val="${!ev:-$def}"; else read -rp "  $prompt [$def]: " val; val="${val:-$def}"; fi
  [[ "$val" =~ ^[Yy] ]] && printf -v "$var" y || printf -v "$var" n
}
secret() { # secret VAR "Prompt" minlen
  local var="$1" prompt="$2" min="$3" a c ev="WZ_$1"
  while true; do
    if [ -n "$NI" ]; then a="${!ev:-}"; c="$a"; else read -rsp "  $prompt: " a; echo; read -rsp "  Repeat: " c; echo; fi
    if [ "$a" = "$c" ] && [ "${#a}" -ge "$min" ]; then printf -v "$var" '%s' "$a"; return; fi
    [ -n "$NI" ] && die "$var too short or mismatch"
    warn "Passwords must match and be at least $min characters"
  done
}

printf '%s\n  Botwa – support inbox installer\n  WhatsApp/Telegram QR • self-hosted • Docker + HTTPS\n%s\n' "$b" "$n"

# ---------- 1. preflight ----------
step "1/6  Checking this server"
[ -f /etc/os-release ] && . /etc/os-release || true
if [ "${ID:-}" = "ubuntu" ]; then ok "Ubuntu ${VERSION_ID:-?}"; else warn "Not Ubuntu (${PRETTY_NAME:-unknown}) - untested, continuing"; fi
mem_mb=$(awk '/MemTotal/{printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)
disk_gb=$(df -Pk . | awk 'NR==2{printf "%d", $4/1024/1024}')
[ "$mem_mb" -ge 1500 ] && ok "RAM ${mem_mb} MB" || warn "RAM ${mem_mb} MB is low (>= 2 GB recommended; the Docker build may fail)"
[ "$disk_gb" -ge 10 ] && ok "Free disk ${disk_gb} GB" || warn "Only ${disk_gb} GB free (>= 10 GB recommended)"
if command -v ss >/dev/null 2>&1; then
  busy=$(ss -ltnH 2>/dev/null | awk '{print $4}' | grep -E ':(80|443)$' || true)
  [ -z "$busy" ] && ok "Ports 80 and 443 are free" || warn "Something already listens on: $(echo "$busy" | tr '\n' ' ') - Caddy needs 80/443 (stop nginx/apache first)"
fi
[ -f .env ] && warn ".env already exists - the wizard will NOT overwrite it. Remove it first for a fresh install." && EXISTING=1 || EXISTING=0

# ---------- 2. questions ----------
if [ "$EXISTING" = 0 ]; then
step "2/6  Your site"
ask DOMAIN "Domain name for the panel (DNS A record must point to this server)" "" '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$' "Enter a valid domain, e.g. support.example.com"
pub_ip="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
dns_ip="$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1; exit}' || true)"
if [ -z "$dns_ip" ]; then warn "$DOMAIN does not resolve yet - create the DNS A record${pub_ip:+ to $pub_ip} or HTTPS certificate issuance will fail"
elif [ -n "$pub_ip" ] && [ "$dns_ip" != "$pub_ip" ]; then warn "$DOMAIN resolves to $dns_ip but this server is $pub_ip"
else ok "DNS looks right ($DOMAIN -> ${dns_ip})"; fi

step "3/6  First administrator"
ask ADMIN_EMAIL "Admin e-mail" "" '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' "Enter a valid e-mail"
ask ADMIN_NAME "Admin display name" "Admin" '^.{1,100}$' "1-100 characters"
secret ADMIN_PASSWORD "Admin password (min 12 chars; MFA will be required at first login)" 12

step "4/6  Options"
ask RETENTION "Delete messages after how many days (0 = never)" "365" '^[0-9]{1,4}$' "Enter a number"
ask TZ "Time zone for reports/business hours" "Asia/Jerusalem" '^[A-Za-z_]+(/[A-Za-z_+-]+)+$|^UTC$' "Use an IANA name like Asia/Jerusalem"
yesno MEDIA "Enable attachments (images/PDF/voice) with ClamAV antivirus? needs ~3 GB extra RAM" "$([ "$mem_mb" -ge 3500 ] && echo y || echo n)"
yesno TG "Enable Telegram user-account login (needs api_id/api_hash from my.telegram.org)?" "n"
TG_API_ID=""; TG_API_HASH=""
if [ "$TG" = y ]; then
  ask TG_API_ID "Telegram api_id" "" '^[0-9]{3,12}$' "Digits only"
  ask TG_API_HASH "Telegram api_hash" "" '^[0-9a-fA-F]{20,64}$' "Hex string from my.telegram.org"
fi
ask BACKUP_HOUR "Hour (0-23) for the automatic daily encrypted backup (blank = manual only)" "3" '^([01]?[0-9]|2[0-3])?$' "0-23 or blank"

# ---------- 3. write .env ----------
step "5/6  Writing configuration"
rand() { openssl rand -base64 "$1" | tr -d '\n'; }
DB_PASSWORD="$(rand 24 | tr -d '/+=')"
ENC_KEY="$(rand 32)"
umask 077
cp .env.example .env
setv() { # setv KEY VALUE  (values never contain '|' or newlines: validated above / base64)
  if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else printf '%s=%s\n' "$1" "$2" >> .env; fi
}
setv DOMAIN "$DOMAIN"; setv APP_ORIGIN "https://$DOMAIN"
setv DB_PASSWORD "$DB_PASSWORD"; setv ENCRYPTION_KEY "$ENC_KEY"
setv MESSAGE_RETENTION_DAYS "$RETENTION"; setv REPORT_TZ "$TZ"
setv BACKUP_AUTO_HOUR "$BACKUP_HOUR"
if [ "$MEDIA" = y ]; then setv CLAMAV_HOST clamav; setv COMPOSE_PROFILES media; else setv CLAMAV_HOST ""; fi
[ "$TG" = y ] && { setv TELEGRAM_API_ID "$TG_API_ID"; setv TELEGRAM_API_HASH "$TG_API_HASH"; }
chmod 600 .env
ok ".env written (permissions 600)"
fi

if [ -n "$DRY" ]; then step "Dry run - stopping before Docker"; exit 0; fi

# ---------- 4. install & start ----------
step "6/6  Installing Docker, firewall and starting Botwa (first build: several minutes)"
if ! command -v docker >/dev/null 2>&1; then curl -fsSL https://get.docker.com | $SUDO sh; $SUDO usermod -aG docker "${SUDO_USER:-$USER}" || true; fi
if command -v ufw >/dev/null 2>&1; then $SUDO ufw allow OpenSSH >/dev/null; $SUDO ufw allow 80,443/tcp >/dev/null; $SUDO ufw --force enable >/dev/null; ok "Firewall: SSH, 80, 443 only"; fi
if docker info >/dev/null 2>&1; then DOCKER=docker; else DOCKER="$SUDO docker"; fi
$DOCKER compose up -d --build
printf '  waiting for the app'
healthy=""
for _ in $(seq 1 72); do
  st="$($DOCKER compose ps --format '{{.Service}} {{.Health}}' | awk '$1=="server"{print $2}')"
  [ "$st" = healthy ] && { healthy=1; break; }; printf '.'; sleep 5
done; echo
[ -n "$healthy" ] || { $DOCKER compose logs --tail=40 server; die "App did not become healthy. Fix the error above and re-run: docker compose up -d --build"; }
ok "App is healthy"

if [ -n "${ADMIN_EMAIL:-}" ]; then
  $DOCKER compose exec -T -e ADMIN_EMAIL="$ADMIN_EMAIL" -e ADMIN_NAME="$ADMIN_NAME" -e ADMIN_PASSWORD="$ADMIN_PASSWORD" server node dist/scripts/create-admin.js >/dev/null && ok "Admin $ADMIN_EMAIL created"
fi
unset ADMIN_PASSWORD

DOM="$(grep '^DOMAIN=' .env | cut -d= -f2-)"
if [ -x scripts/smoke.sh ]; then DOMAIN="$DOM" bash scripts/smoke.sh || warn "Some smoke checks failed (HTTPS may need a minute after DNS is ready) - re-run: DOMAIN=$DOM ./scripts/smoke.sh"; fi

KEY="$(grep '^ENCRYPTION_KEY=' .env | cut -d= -f2-)"
cat <<MSG

${b}Installation finished.${n}
  Open:  https://$DOM      (log in as ${ADMIN_EMAIL:-your admin}; you will be asked to set up 2-step verification)

${b}${r}SAVE THIS NOW (password manager, NOT only on this server):${n}
  ENCRYPTION_KEY=$KEY
  Without it, linked WhatsApp/Telegram sessions and backups cannot be decrypted.

Next: Channels -> New channel -> "Link / start" -> scan the QR from the phone.
Updates:  ./scripts/update.sh        Backups: Settings -> Backups (panel)
Guide:    docs/USER_GUIDE.he.md      Production checklist: docs/PRODUCTION_CHECKLIST.md
MSG
