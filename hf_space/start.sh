#!/usr/bin/env bash
set -euo pipefail

cd /app/worker

PORT="${PORT:-7860}"
REQUESTED_MODE="${HF_BACKEND_MODE:-free-public}"
BACKEND_MODE="free-public"
DEFAULT_PERSIST_ROOT="/tmp/dyrakarmy-free-public"

if [[ "${REQUESTED_MODE,,}" == "standalone" && -d /data && -w /data ]]; then
  BACKEND_MODE="standalone"
  DEFAULT_PERSIST_ROOT="/data/dyrakarmy"
else
  if [[ "${REQUESTED_MODE,,}" == "standalone" ]]; then
    echo "Paid persistent volume is unavailable; falling back safely to free-public mode."
  fi
  export HF_STATE_IMPORT_REQUIRED=0
  export HF_IMPORT_ON_START=0
  export HF_TELEGRAM_WEBHOOK_AUTOCONFIGURE=0
fi

export HF_BACKEND_MODE="$BACKEND_MODE"
PERSIST_ROOT="${DYRAKARMY_PERSIST_ROOT:-$DEFAULT_PERSIST_ROOT}"
if [[ "$BACKEND_MODE" == "free-public" ]]; then
  PERSIST_ROOT="$DEFAULT_PERSIST_ROOT"
fi
export DYRAKARMY_PERSIST_ROOT="$PERSIST_ROOT"
mkdir -p "$PERSIST_ROOT"

LOCAL_DOWNLOADER_ENABLED="${HF_LOCAL_DOWNLOADER_ENABLED:-1}"
LOCAL_DOWNLOADER_PORT="${HF_LOCAL_DOWNLOADER_PORT:-8081}"
if ! [[ "$LOCAL_DOWNLOADER_PORT" =~ ^[0-9]+$ ]] || (( LOCAL_DOWNLOADER_PORT < 1024 || LOCAL_DOWNLOADER_PORT > 65535 )); then
  echo "Invalid HF_LOCAL_DOWNLOADER_PORT=$LOCAL_DOWNLOADER_PORT" >&2
  exit 1
fi
export HF_LOCAL_DOWNLOADER_ENABLED="$LOCAL_DOWNLOADER_ENABLED"
export HF_LOCAL_DOWNLOADER_PORT="$LOCAL_DOWNLOADER_PORT"

if [[ "$LOCAL_DOWNLOADER_ENABLED" != "0" ]]; then
  if [[ -z "${DOWNLOADER_API_KEY:-}" ]]; then
    export DOWNLOADER_API_KEY="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"
  fi
  LOCAL_DOWNLOADER_BASE="http://127.0.0.1:${LOCAL_DOWNLOADER_PORT}"
  export DOWNLOADER_API_URL="$LOCAL_DOWNLOADER_BASE"
  export DOWNLOADER_ORIGINS_JSON="[{\"base_url\":\"${LOCAL_DOWNLOADER_BASE}\",\"priority\":0,\"id\":\"hf-local-private\"}]"
  export DOWNLOADER_BACKUP_API_URL=""
  export DOWNLOADER_TERTIARY_API_URL=""
  export DOWNLOADER_PUBLIC_BASE_URL="$LOCAL_DOWNLOADER_BASE"
  export DOWNLOADER_STORAGE_DIR="$PERSIST_ROOT/downloader/files"
  export DOWNLOADER_WORK_DIR="$PERSIST_ROOT/downloader/work"
  mkdir -p "$DOWNLOADER_STORAGE_DIR" "$DOWNLOADER_WORK_DIR"
  echo "Private Hugging Face downloader enabled at 127.0.0.1:${LOCAL_DOWNLOADER_PORT}."
fi

echo "Starting DyrakArmy Hugging Face runtime in $BACKEND_MODE mode on port $PORT."
node /app/hf/render-dev-vars.mjs

if [[ "$BACKEND_MODE" == "standalone" && "${HF_IMPORT_ON_START:-0}" == "1" ]]; then
  /app/hf/import-cloudflare-state.sh
fi

node /app/hf/standalone-preflight.mjs

npx wrangler d1 migrations apply sounddrop-db \
  --local \
  --persist-to "$PERSIST_ROOT" \
  --config wrangler.hf.jsonc

exec node /app/hf/standalone-supervisor.mjs
