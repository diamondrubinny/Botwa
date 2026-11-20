#!/usr/bin/env bash
# Server hardening for Botwa (Ubuntu / Debian): firewall, brute-force protection, automatic security updates,
# exposed-port check and antivirus status. Safe by design: it shows each step and asks first, and never closes SSH.
#   sudo ./scripts/harden.sh            interactive
#   sudo ./scripts/harden.sh --check    only report, change nothing
#   sudo ./scripts/harden.sh --host-av  also install ClamAV on the host with a weekly scan of the server's files
set -euo pipefail
CHECK=0; HOSTAV=0
for a in "$@"; do case "$a" in --check) CHECK=1 ;; --host-av) HOSTAV=1 ;; *) echo "unknown option: $a" >&2; exit 2 ;; esac; done
[ "$(id -u)" = 0 ] || { echo "Run with sudo." >&2; exit 1; }
cd "${BOTWA_DIR:-$(dirname "$0")/..}"
ok() { printf '  \033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
ask() { [ "$CHECK" = 1 ] && return 1; read -rp "  $1 [y/N] " r; [ "$r" = y ] || [ "$r" = Y ]; }

SSH_PORT="$( (sshd -T 2>/dev/null || true) | awk '/^port /{print $2; exit}')"; SSH_PORT="${SSH_PORT:-22}"
HESTIA=0; [ -d /usr/local/hestia ] && HESTIA=1
echo "Botwa server hardening (SSH port $SSH_PORT$([ $HESTIA = 1 ] && echo ', HestiaCP detected'))"

echo "1. Ports open to the internet"
EXPOSED="$(ss -ltnH 2>/dev/null | awk '{print $4}' | grep -E '^(0\.0\.0\.0|\*|\[::\]):(5432|3310|3000|3001|6379|9222)$' || true)"
if [ -n "$EXPOSED" ]; then warn "internal services listen on all addresses: $(echo "$EXPOSED" | tr '\n' ' ')- bind them to 127.0.0.1 (docker-compose ports) or block them"; else ok "database, scanner and app ports are not exposed"; fi
if command -v docker >/dev/null; then
  PUB="$(docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null | grep -E '0\.0\.0\.0:|:::' | grep -vE ':(80|443)->' || true)"
  [ -n "$PUB" ] && warn "containers publishing other ports (Docker bypasses ufw for these!): $PUB" || ok "containers publish only 80/443 (or nothing)"
fi

echo "2. Firewall"
if [ "$HESTIA" = 1 ]; then
  ok "HestiaCP manages the firewall (iptables). Do NOT enable ufw on a HestiaCP server."
  /usr/local/hestia/bin/v-list-firewall 2>/dev/null | head -20 || true
  echo "  In Hestia: Server > Firewall. Keep only SSH ($SSH_PORT), 80, 443 and the Hestia panel port open; limit the panel port to your IPs."
else
  if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
    ok "ufw is active"; ufw status numbered | sed 's/^/    /' | head -20
  else
    warn "no active firewall"
    if ask "Install/enable ufw: deny incoming, allow SSH $SSH_PORT, 80, 443?"; then
      apt-get update -qq && apt-get install -y -qq ufw
      ufw default deny incoming && ufw default allow outgoing
      ufw allow "$SSH_PORT"/tcp comment 'ssh' && ufw limit "$SSH_PORT"/tcp
      ufw allow 80/tcp comment 'http' && ufw allow 443/tcp comment 'https'
      ufw --force enable && ok "ufw enabled"
    fi
  fi
fi

echo "3. Brute-force protection (fail2ban)"
if systemctl is-active --quiet fail2ban 2>/dev/null; then ok "fail2ban is running ($(fail2ban-client status 2>/dev/null | awk -F: '/Jail list/{print $2}' | xargs))"
elif ask "Install fail2ban with an SSH jail (5 failures = 1 hour ban)?"; then
  apt-get install -y -qq fail2ban
  [ -f /etc/fail2ban/jail.d/botwa-sshd.conf ] || printf '[sshd]\nenabled = true\nport = %s\nmaxretry = 5\nfindtime = 10m\nbantime = 1h\n' "$SSH_PORT" > /etc/fail2ban/jail.d/botwa-sshd.conf
  systemctl enable --now fail2ban && ok "fail2ban enabled"
else warn "no fail2ban: repeated SSH password guesses are not blocked"
fi

echo "4. Automatic security updates"
if dpkg -s unattended-upgrades >/dev/null 2>&1 && grep -q '"1"' /etc/apt/apt.conf.d/20auto-upgrades 2>/dev/null; then ok "unattended-upgrades is on"
elif ask "Install and enable automatic security updates?"; then
  apt-get install -y -qq unattended-upgrades && printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > /etc/apt/apt.conf.d/20auto-upgrades && ok "enabled"
else warn "security updates are not installed automatically"
fi

echo "5. SSH"
SSHCFG="$(sshd -T 2>/dev/null || true)"
echo "$SSHCFG" | grep -q '^permitrootlogin no' && ok "root login disabled" || warn "root can log in over SSH (consider PermitRootLogin prohibit-password or no, after you have a sudo user with a key)"
echo "$SSHCFG" | grep -q '^passwordauthentication no' && ok "password login disabled (keys only)" || warn "SSH passwords are allowed (keys only is safer: PasswordAuthentication no)"

echo "6. Antivirus"
if [ -f docker-compose.yml ] && command -v docker >/dev/null; then
  if docker compose ps --status running clamav 2>/dev/null | grep -q clamav; then
    ok "Botwa's ClamAV scanner is running: $(docker compose exec -T clamav sh -c 'clamdscan --version 2>/dev/null || clamscan --version' 2>/dev/null | head -1)"
  else warn "Botwa's ClamAV scanner is not running: files from customers wait in quarantine. Start it: docker compose up -d clamav"; fi
fi
if [ "$HOSTAV" = 1 ]; then
  if ask "Install ClamAV on the host and scan /opt, /home, /var/www and /tmp every Sunday 03:30 (report only, nothing deleted)?"; then
    apt-get install -y -qq clamav clamav-freshclam && systemctl enable --now clamav-freshclam
    cat > /etc/cron.d/botwa-host-av <<'CRON'
30 3 * * 0 root nice -n 19 ionice -c3 clamscan -r -i --exclude-dir='^/var/lib/docker' /opt /home /var/www /tmp > /var/log/botwa-host-av.log 2>&1 || true
CRON
    ok "weekly host scan scheduled (log: /var/log/botwa-host-av.log)"
  fi
fi
echo "Done. Also see: Botwa panel > Settings > Security (panel firewall, antivirus status)."
