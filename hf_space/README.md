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

Every verified push to `main` is staged and synchronized to this Space by GitHub Actions. Generated application files must not be edited directly in the Space repository.

## Safe parallel production mode

The default runtime mode is:

```text
HF_BACKEND_MODE=cloudflare-mirror
```

In this mode:

- Hugging Face serves the complete DyrakArmy Interface v17, PWA, Software Toolkit and Games assets;
- same-origin API, file and Telegram webhook requests are forwarded server-side to `https://dyrakarmy.eu`;
- Cloudflare remains authoritative for D1, KV, Queues, file storage and the single `@dyrakarmy_bot` webhook;
- Hugging Face does not start a competing Telegram webhook or create split local production state;
- Cloudflare DNS, routes, bindings and deployment remain unchanged.

Mirror health endpoint:

```text
/api/hf-mirror/health
```

## Standalone cutover mode

After a Storage Bucket, production secrets and state migration are verified, set:

```text
HF_BACKEND_MODE=standalone
DYRAKARMY_PERSIST_ROOT=/data/dyrakarmy
HF_SKIP_LOCAL_MIGRATIONS=0
```

Standalone mode runs the existing TypeScript Worker through Wrangler's local compatibility runtime on port `7860`. Attach a Hugging Face Storage Bucket at `/data` before enabling it for production traffic.

## Secrets required only for standalone mode

Add sensitive values as **Secrets**, never as public Variables:

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

## Recommended Variables

- `HF_BACKEND_MODE=cloudflare-mirror`
- `HF_CLOUDFLARE_UPSTREAM=https://dyrakarmy.eu`
- `HF_MIRROR_FALLBACK_LOCAL=0`
- `PUBLIC_BASE_URL=https://dyrakarmy-dyrakarmy-platform.hf.space`
- `CORS_ORIGINS=https://dyrakarmy-dyrakarmy-platform.hf.space,https://dyrakarmy.eu,https://www.dyrakarmy.eu`

Do not set the Telegram webhook to the Space while mirror mode is active. The Cloudflare webhook remains the single production authority until the final standalone cutover.
