#!/usr/bin/env bash
set -euo pipefail

cd /app/worker

PORT="${PORT:-7860}"
DEFAULT_PERSIST_ROOT="/data/dyrakarmy"
if [[ ! -d /data || ! -w /data ]]; then
  DEFAULT_PERSIST_ROOT="/tmp/dyrakarmy"
  echo "WARNING: /data is unavailable. Runtime state is ephemeral until a Hugging Face Storage Bucket is attached."
fi
PERSIST_ROOT="${DYRAKARMY_PERSIST_ROOT:-$DEFAULT_PERSIST_ROOT}"
mkdir -p "$PERSIST_ROOT"

node /app/hf/render-dev-vars.mjs

if [[ "${HF_SKIP_LOCAL_MIGRATIONS:-0}" != "1" ]]; then
  npx wrangler d1 migrations apply sounddrop-db \
    --local \
    --persist-to "$PERSIST_ROOT" \
    --config wrangler.hf.jsonc \
    --yes
fi

exec npx wrangler dev \
  --ip 0.0.0.0 \
  --port "$PORT" \
  --persist-to "$PERSIST_ROOT" \
  --config wrangler.hf.jsonc
