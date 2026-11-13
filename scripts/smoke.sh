#!/usr/bin/env bash
# Post-deploy smoke test. Usage: DOMAIN=support.example.com ./scripts/smoke.sh
set -uo pipefail
cd "$(dirname "$0")/.."
: "${DOMAIN:?set DOMAIN}"
fail=0
ok()  { printf 'PASS  %s\n' "$1"; }
bad() { printf 'FAIL  %s\n' "$1"; fail=1; }
chk() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$name"; else bad "$name"; fi; }

hdrs="$(curl -sSI --max-time 15 "https://$DOMAIN/" 2>&1)"
if echo "$hdrs" | grep -qi '^HTTP/[0-9.]* 200'; then ok "HTTPS serves the panel (200)"; else
  bad "HTTPS did not return 200 (DNS / certificate / app?)"
  # what this server reaches for the name, and which certificate answers there (a self-signed one = another vhost or /etc/hosts)
  ip="$(getent hosts "$DOMAIN" | awk '{print $1; exit}')"
  echo "      $DOMAIN resolves here to: ${ip:-nothing}$(grep -qE "^[^#]*[[:space:]]$DOMAIN([[:space:]]|$)" /etc/hosts 2>/dev/null && echo ' (set in /etc/hosts)')"
  if command -v openssl >/dev/null 2>&1; then
    echo | timeout 10 openssl s_client -connect "${ip:-$DOMAIN}:443" -servername "$DOMAIN" 2>/dev/null | openssl x509 -noout -subject -issuer -enddate 2>/dev/null | sed 's/^/      certificate /'
  fi
fi
echo "$hdrs" | grep -qi '^strict-transport-security' && ok "HSTS header present" || bad "HSTS header missing"
echo "$hdrs" | grep -qi '^content-security-policy' && ok "CSP header present" || bad "CSP header missing"
curl -sS --max-time 15 "https://$DOMAIN/healthz" | grep -q '"ok":true' && ok "/healthz ok (app + database)" || bad "/healthz failed"
loc="$(curl -sSI --max-time 15 "http://$DOMAIN/" | tr -d '\r' | awk 'tolower($1)=="location:"{print $2}')"
[[ "$loc" == https://* ]] && ok "HTTP redirects to HTTPS" || bad "HTTP does not redirect to HTTPS"
[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://$DOMAIN/users")" = "401" ] && ok "API requires login (401)" || bad "unauthenticated /users not 401"
[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST -H 'content-type: application/json' -d '{}' "https://$DOMAIN/auth/login")" = "403" ] && ok "POST without Origin header is rejected (403)" || bad "POST without Origin was not rejected with 403"

# nothing but SSH/HTTP/HTTPS should listen on public interfaces
if command -v ss >/dev/null 2>&1; then
  exposed="$(ss -ltnH 2>/dev/null | awk '{print $4}' | grep -vE '^(127\.|\[::1\]|::1)' | grep -E ':(3000|5432|3310)$' || true)"
  [ -z "$exposed" ] && ok "app/db/clamav ports not exposed publicly" || bad "exposed ports: $exposed"
fi
docker compose ps --format '{{.Service}} {{.State}} {{.Health}}' 2>/dev/null | awk '{ if ($2!="running") print "FAIL  container " $1 " is " $2; else print "PASS  container " $1 " running " $3 }'
[ -f .env ] && [ "$(stat -c %a .env)" = "600" ] && ok ".env permissions are 600" || bad ".env missing or not 600"
echo; [ $fail -eq 0 ] && echo "ALL CHECKS PASSED" || echo "SOME CHECKS FAILED"; exit $fail
