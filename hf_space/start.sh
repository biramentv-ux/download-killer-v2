#!/usr/bin/env bash
set -euo pipefail

cd /app/worker

PORT="${PORT:-7860}"
BACKEND_MODE="${HF_BACKEND_MODE:-cloudflare-mirror}"
DEFAULT_PERSIST_ROOT="/data/dyrakarmy"

if [[ "$BACKEND_MODE" == "cloudflare-mirror" ]]; then
  DEFAULT_PERSIST_ROOT="/tmp/dyrakarmy-mirror"
  export HF_SKIP_LOCAL_MIGRATIONS=1
  echo "Starting DyrakArmy Hugging Face in cloudflare-mirror mode."
  echo "Cloudflare remains authoritative until the standalone cutover gate passes."
elif [[ ! -d /data || ! -w /data ]]; then
  echo "ERROR: standalone mode requires a writable Hugging Face Storage Bucket mounted at /data." >&2
  exit 70
fi

PERSIST_ROOT="${DYRAKARMY_PERSIST_ROOT:-$DEFAULT_PERSIST_ROOT}"
export DYRAKARMY_PERSIST_ROOT="$PERSIST_ROOT"
mkdir -p "$PERSIST_ROOT"

node /app/hf/render-dev-vars.mjs

if [[ "$BACKEND_MODE" == "standalone" && "${HF_IMPORT_ON_START:-0}" == "1" ]]; then
  /app/hf/import-cloudflare-state.sh
fi

node /app/hf/standalone-preflight.mjs

if [[ "${HF_SKIP_LOCAL_MIGRATIONS:-0}" != "1" ]]; then
  npx wrangler d1 migrations apply sounddrop-db \
    --local \
    --persist-to "$PERSIST_ROOT" \
    --config wrangler.hf.jsonc
fi

exec node /app/hf/standalone-supervisor.mjs
