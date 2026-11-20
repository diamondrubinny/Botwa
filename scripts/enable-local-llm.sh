#!/usr/bin/env bash
# Installs and turns on the local language model (Ollama) that words the bot's answers from the knowledge base only.
# Usage (in the install directory, e.g. /opt/botwa):  bash scripts/enable-local-llm.sh
# Options (environment): LLM_MODEL=qwen2.5:3b-instruct  OLLAMA_VERSION=x.y.z  FORCE=1 (install even with little memory)
# Safe to run again: keeps the pinned version and model, pulls the model only if missing, restarts the server to read .env.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || { echo ".env not found: run this inside the Botwa install directory." >&2; exit 1; }
DOCKER="docker"; docker info >/dev/null 2>&1 || DOCKER="sudo docker"
getv() { grep -E "^$1=" .env | tail -1 | cut -d= -f2- || true; }
setv() { if grep -qE "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else printf '%s=%s\n' "$1" "$2" >> .env; fi; }
say() { printf '  %s\n' "$*"; }

# ---- 1. is this server big enough? (CPU only: the model lives in RAM) ----
mem_mb=$(awk '/MemTotal/{printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)
disk_gb=$(df -Pk . | awk 'NR==2{printf "%d", $4/1024/1024}')
model="${LLM_MODEL:-$(getv LOCAL_LLM_MODEL)}"
if [ -z "$model" ]; then
  if [ "$mem_mb" -ge 12000 ]; then model="qwen2.5:7b-instruct"; else model="qwen2.5:3b-instruct"; fi
fi
need_mb=6000; need_gb=7
case "$model" in *3b*|*1.5b*|*mini*) need_mb=3500; need_gb=4 ;; esac
say "Memory ${mem_mb} MB, free disk ${disk_gb} GB, model ${model}"
if [ "$mem_mb" -lt "$need_mb" ] && [ -z "${FORCE:-}" ]; then
  echo "Not enough memory for ${model} next to Botwa (needs about ${need_mb} MB in total). Try LLM_MODEL=qwen2.5:1.5b-instruct, or FORCE=1." >&2; exit 1
fi
[ "$disk_gb" -ge "$need_gb" ] || { echo "Not enough free disk (needs about ${need_gb} GB)." >&2; exit 1; }

# ---- 2. pin an Ollama release that has been out for at least two weeks (never a moving "latest") ----
ver="${OLLAMA_VERSION:-$(getv OLLAMA_VERSION)}"
if [ -z "$ver" ]; then
  cutoff=$(( $(date +%s) - 14*24*3600 ))
  ver="$(curl -fsSL --max-time 20 'https://api.github.com/repos/ollama/ollama/releases?per_page=30' 2>/dev/null | python3 -c '
import json, sys, datetime
cut = int(sys.argv[1])
for r in json.load(sys.stdin):
    if r.get("draft") or r.get("prerelease"): continue
    t = datetime.datetime.strptime(r["published_at"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc).timestamp()
    if t <= cut: print(r["tag_name"].lstrip("v")); break
' "$cutoff" 2>/dev/null || true)"
  [[ "$ver" =~ ^[0-9]+\.[0-9]+(\.[0-9]+)?$ ]] || { echo "Could not find an Ollama release on GitHub. Set OLLAMA_VERSION=x.y.z (see github.com/ollama/ollama/releases) and run again." >&2; exit 1; }
fi
say "Ollama ${ver}"

# ---- 3. settings ----
setv OLLAMA_VERSION "$ver"
setv LOCAL_LLM_URL "http://ollama:11434"
setv LOCAL_LLM_MODEL "$model"
[ -n "$(getv LOCAL_LLM_TIMEOUT_MS)" ] || setv LOCAL_LLM_TIMEOUT_MS "60000"
prof="$(getv COMPOSE_PROFILES)"
case ",$prof," in *,llm,*) ;; *) setv COMPOSE_PROFILES "${prof:+$prof,}llm" ;; esac

# ---- 4. start the service, download the model, restart the server so it reads the new settings ----
say "Starting Ollama..."
$DOCKER compose up -d ollama
for _ in $(seq 1 30); do $DOCKER compose exec -T ollama ollama list >/dev/null 2>&1 && break; sleep 2; done
if $DOCKER compose exec -T ollama ollama list 2>/dev/null | awk 'NR>1{print $1}' | grep -qxF "$model"; then
  say "Model ${model} already installed"
else
  say "Downloading ${model} (a few GB, can take several minutes)..."
  $DOCKER compose exec -T ollama ollama pull "$model"
fi
$DOCKER compose up -d --no-build --force-recreate server
say "Warming up the model (first answer)..."
$DOCKER compose exec -T ollama ollama run "$model" "שלום" >/dev/null 2>&1 || true
cat <<MSG

  Done. In the panel: Bot -> answers from the knowledge base -> "מודל שפה מקומי".
  The status line there should say the model is ready; try a question with "איך הבוט יענה?".
  To turn it off later: choose "ציטוט מהמאגר" in the panel (the service can stay), or stop it: docker compose stop ollama, then remove "llm" from COMPOSE_PROFILES.
MSG
