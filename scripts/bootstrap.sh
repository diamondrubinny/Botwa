#!/usr/bin/env bash
# Phone-friendly installer: downloads the code straight from GitHub (no scp, no computer needed) and runs the wizard.
# Usage on the server (paste into any SSH app):
#   curl -fsSL https://raw.githubusercontent.com/diamondrubinny/Botwa/<branch>/scripts/bootstrap.sh | bash      # public repo
# Private repo: the token is requested interactively (hidden), used once, never written to disk or shell history.
set -euo pipefail
REPO="${BOTWA_REPO:-diamondrubinny/Botwa}"
REF="${BOTWA_REF:-claude/stoic-faraday-i0ave8}"
DEST="${BOTWA_DIR:-/opt/botwa}"
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"

# When run as `curl ... | bash`, stdin is the script itself, so prompts must come from the terminal device.
has_tty() { [ -r /dev/tty ] && (: </dev/tty) 2>/dev/null; }

auth=()
if [ -n "${GITHUB_TOKEN:-}" ]; then auth=(-H "Authorization: Bearer $GITHUB_TOKEN")
elif [ -n "${BOTWA_PUBLIC:-}" ]; then :   # public repo: no token, no prompt
elif has_tty; then
  read -rsp "GitHub read-only token (leave empty if the repo is public): " T </dev/tty; echo >/dev/tty
  [ -n "$T" ] && auth=(-H "Authorization: Bearer $T"); unset T
fi

if [ -f "$DEST/.env" ]; then echo "Existing install at $DEST (.env present) - updating code only, .env is kept."; fi
tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
echo "Downloading $REPO@$REF ..."
curl -fsSL "${auth[@]}" -o "$tmp" "https://api.github.com/repos/$REPO/tarball/$REF" \
  || { echo "Download failed: wrong token/permissions (needs Contents: Read), wrong repo/branch, or no internet." >&2; exit 1; }
unset GITHUB_TOKEN auth
$SUDO mkdir -p "$DEST"
$SUDO tar xzf "$tmp" --strip-components=1 -C "$DEST"
cd "$DEST"
[ -f setup.sh ] || { echo "Archive does not look like Botwa (setup.sh missing)" >&2; exit 1; }
if has_tty; then exec $SUDO bash setup.sh </dev/tty; else exec $SUDO bash setup.sh; fi
