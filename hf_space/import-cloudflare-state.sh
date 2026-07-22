#!/usr/bin/env bash
set -euo pipefail

cd /app/worker

PERSIST_ROOT="${DYRAKARMY_PERSIST_ROOT:-/data/dyrakarmy}"
IMPORT_ROOT="${HF_STATE_IMPORT_DIR:-/data/import/cloudflare}"
MARKER="$PERSIST_ROOT/.cloudflare-state-imported"
LOCK="$PERSIST_ROOT/.state-import-lock"
D1_FILE="$IMPORT_ROOT/d1.sql"
KV_FILE="$IMPORT_ROOT/kv-bulk.json"
FILES_DIR="$IMPORT_ROOT/files"

mkdir -p "$PERSIST_ROOT"
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "Another state import is already running." >&2
  exit 73
fi
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

if [[ -f "$MARKER" && "${HF_FORCE_STATE_IMPORT:-0}" != "1" ]]; then
  echo "State import already completed: $MARKER"
  exit 0
fi

if [[ ! -s "$D1_FILE" ]]; then
  echo "Missing Cloudflare D1 export: $D1_FILE" >&2
  exit 66
fi

npx wrangler d1 migrations apply sounddrop-db \
  --local \
  --persist-to "$PERSIST_ROOT" \
  --config wrangler.hf.jsonc

npx wrangler d1 execute sounddrop-db \
  --local \
  --persist-to "$PERSIST_ROOT" \
  --config wrangler.hf.jsonc \
  --file "$D1_FILE"

if [[ -s "$KV_FILE" ]]; then
  npx wrangler kv bulk put "$KV_FILE" \
    --binding CACHE \
    --local \
    --persist-to "$PERSIST_ROOT" \
    --config wrangler.hf.jsonc
else
  echo "KV bulk export not found; continuing with an empty local cache."
fi

if [[ -d "$FILES_DIR" ]]; then
  mkdir -p "$PERSIST_ROOT/imported-files"
  cp -a "$FILES_DIR"/. "$PERSIST_ROOT/imported-files"/
fi

D1_SHA="$(sha256sum "$D1_FILE" | awk '{print $1}')"
KV_SHA="none"
if [[ -s "$KV_FILE" ]]; then KV_SHA="$(sha256sum "$KV_FILE" | awk '{print $1}')"; fi

cat > "$MARKER" <<EOF
{
  "imported_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "source": "cloudflare",
  "d1_sha256": "$D1_SHA",
  "kv_sha256": "$KV_SHA"
}
EOF
chmod 600 "$MARKER"

npx wrangler d1 execute sounddrop-db \
  --local \
  --persist-to "$PERSIST_ROOT" \
  --config wrangler.hf.jsonc \
  --command "PRAGMA integrity_check; SELECT COUNT(*) AS platform_users FROM platform_users; SELECT COUNT(*) AS download_jobs FROM download_jobs;" \
  --json

echo "Cloudflare state import completed and verified."
