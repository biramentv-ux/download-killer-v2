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
