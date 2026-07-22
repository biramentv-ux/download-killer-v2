---
title: DyrakArmy Unified Platform
emoji: 🎛️
colorFrom: indigo
colorTo: cyan
sdk: docker
app_port: 7860
pinned: false
license: mit
---

# DyrakArmy Unified Platform

Public Docker Space mirror of the DyrakArmy web platform, software catalog, Telegram integration, Control Center and Games 1–10.

The canonical source repository is GitHub: `biramentv-ux/download-killer-v2`.

Every verified push to `main` is staged and synchronized to this Space by GitHub Actions. Do not edit generated application files directly in the Space repository; changes must originate in GitHub.

## Runtime

The Space runs the existing TypeScript Worker through Wrangler's local compatibility runtime on port `7860`. D1, KV and Queue state use the configured local persistence directory. For durable production data, attach a Hugging Face Storage Bucket to `/data` before switching traffic.

## Required Space settings

Add the sensitive values as **Secrets**, never as public Variables:

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

Recommended Variables:

- `PUBLIC_BASE_URL=https://dyrakarmy-dyrakarmy-platform.hf.space`
- `CORS_ORIGINS=https://dyrakarmy-dyrakarmy-platform.hf.space,https://dyrakarmy.eu,https://www.dyrakarmy.eu`
- `DYRAKARMY_PERSIST_ROOT=/data/dyrakarmy`
- `HF_SKIP_LOCAL_MIGRATIONS=0`
