---
title: DyrakArmy Unified Platform
emoji: 🎛️
colorFrom: indigo
colorTo: blue
sdk: docker
app_port: 7860
pinned: false
license: mit
---

# DyrakArmy Unified Platform

Public Docker Space for the complete DyrakArmy Web, Software Toolkit, Telegram integration, Control Center, downloader workflow and Games 1–10.

The canonical source repository is GitHub: `biramentv-ux/download-killer-v2`. Every verified push to `main` is staged and synchronized to this Space by GitHub Actions. Generated application files must not be edited directly in the Space repository.

## Runtime modes

### Safe migration mode

```text
HF_BACKEND_MODE=cloudflare-mirror
```

Hugging Face serves the complete UI while stateful API, file, queue and Telegram webhook requests remain Cloudflare-authoritative. This remains the rollback mode until the standalone cutover gate is complete.

### Full standalone mode

```text
HF_BACKEND_MODE=standalone
DYRAKARMY_PERSIST_ROOT=/data/dyrakarmy
HF_STATE_IMPORT_REQUIRED=1
HF_TELEGRAM_WEBHOOK_AUTOCONFIGURE=1
HF_CUTOVER_GENERATION=hf-v20
```

Standalone mode runs every existing TypeScript Worker component locally in the Docker Space: D1-compatible SQLite state, KV-compatible state, queue consumers, scheduled handlers, public assets, APIs, Telegram webhook, Governance, Software Suite and Games.

The container refuses to start in standalone mode unless:

1. a writable Hugging Face Storage Bucket is mounted at `/data`;
2. the Cloudflare D1/KV state import marker exists;
3. all production secrets are present;
4. `PUBLIC_BASE_URL` is HTTPS.

## Persistent volume

Attach a Storage Bucket read-write at:

```text
/data
```

The application stores all local runtime state below:

```text
/data/dyrakarmy
```

## State import bundle

Place the Cloudflare exports in the mounted bucket:

```text
/data/import/cloudflare/d1.sql
/data/import/cloudflare/kv-bulk.json
/data/import/cloudflare/files/        # optional
```

Then temporarily set:

```text
HF_IMPORT_ON_START=1
HF_STATE_IMPORT_DIR=/data/import/cloudflare
```

After a successful import, remove `HF_IMPORT_ON_START` or set it to `0`. The importer writes:

```text
/data/dyrakarmy/.cloudflare-state-imported
```

## Required Space Secrets

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_SECRET_TOKEN`
- `TELEGRAM_ADMIN_IDS`
- `DOWNLOADER_API_KEY`
- `DOWNLOAD_TOKEN_SECRET`
- `WEBHOOK_HMAC_SECRET`
- `OPS_READ_TOKEN`
- `OPS_OPERATOR_TOKEN`
- `OPS_ADMIN_TOKEN`
- `RELEASE_SIGNING_PRIVATE_KEY_PKCS8_BASE64`

Optional provider secrets:

- `AUDIUS_API_KEY`
- `JAMENDO_CLIENT_ID`

## Recommended Space Variables after cutover

```text
HF_BACKEND_MODE=standalone
HF_CUTOVER_GENERATION=hf-v20
HF_STATE_IMPORT_REQUIRED=1
HF_IMPORT_ON_START=0
HF_TELEGRAM_WEBHOOK_AUTOCONFIGURE=1
DYRAKARMY_PERSIST_ROOT=/data/dyrakarmy
PUBLIC_BASE_URL=https://dyrakarmy.eu
CORS_ORIGINS=https://dyrakarmy.eu,https://www.dyrakarmy.eu,https://dyrakarmy.online,https://www.dyrakarmy.online,https://dyrakarmy-dyrakarmy-platform.hf.space
TELEGRAM_STORAGE_ENABLED=1
TELEGRAM_CHANNEL_PUBLISH_ENABLED=1
TELEGRAM_CHANNEL_SEND_AUDIO=1
```

## Domain topology

Primary Space custom domain:

```text
dyrakarmy.eu
```

Secondary redirect Space:

```text
DyrakArmy/dyrakarmy-domain-redirect
custom domain: dyrakarmy.online
redirect target: https://dyrakarmy.eu
```

The redirect preserves path, query string and fragment. This avoids two independent stateful runtimes and prevents split-brain behavior.

## Cutover order

1. Attach `/data` Storage Bucket.
2. Add all Variables and Secrets.
3. Import D1 and KV state.
4. Run the standalone Docker persistence gate.
5. Activate `HF_BACKEND_MODE=standalone` on the native `.hf.space` URL.
6. Verify Web, APIs, downloader, queue, Telegram Mini App, Control Center and Games.
7. Move the Telegram webhook to the Hugging Face URL.
8. Add the primary custom domain.
9. Add the secondary redirect custom domain.
10. Keep Cloudflare in read-only rollback mode for at least seven days.
11. Remove Cloudflare routes, stateful resources and credentials only after final data parity and rollback-window approval.
