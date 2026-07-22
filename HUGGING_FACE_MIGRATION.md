# DyrakArmy: Cloudflare → Hugging Face migration

## Target architecture

- **Canonical source and release history:** GitHub `biramentv-ux/download-killer-v2`.
- **Public application host:** Hugging Face Docker Space `DyrakArmy/dyrakarmy-platform`.
- **Automatic publication:** verified pushes to GitHub `main` are uploaded to the Space by `.github/workflows/hugging-face-space.yml`.
- **Authentication for publishing:** Hugging Face Trusted Publisher (GitHub Actions OIDC), without a long-lived `HF_TOKEN` in GitHub.
- **Application runtime:** the existing TypeScript Worker runs through Wrangler's local compatibility runtime on port `7860`.
- **Static interface:** unchanged `worker/public` DyrakArmy v17 PWA.
- **Software binaries:** remain canonical GitHub Release assets; the Space catalog continues to link to the latest GitHub releases.

## Migration stages

### Stage 1 — compatibility bridge

This repository already contains the Stage 1 runtime:

- `hf_space/Dockerfile`
- `hf_space/start.sh`
- `hf_space/render-dev-vars.mjs`
- `worker/wrangler.hf.jsonc`
- `.github/workflows/hugging-face-space.yml`

The bridge preserves the existing Worker fetch, queue and scheduled-handler code while replacing Cloudflare hosting with a Docker Space.

### Stage 2 — durable state

The Space filesystem is ephemeral by default. Before production cutover, attach a Hugging Face Storage Bucket as a read-write volume mounted at:

```text
/data
```

Set the Space Variable:

```text
DYRAKARMY_PERSIST_ROOT=/data/dyrakarmy
```

The compatibility runtime stores local D1, KV and Queue state below that directory.

For multi-replica or high-availability operation, replace the local compatibility bindings later:

| Cloudflare service | Stage 1 replacement | Long-term replacement |
|---|---|---|
| D1 | local D1/SQLite in attached bucket | managed PostgreSQL |
| KV | local Miniflare KV in attached bucket | Redis or PostgreSQL key-value table |
| Queues | local Miniflare Queues | Redis/BullMQ or PostgreSQL job queue |
| Cron triggers | manual compatibility calls during cutover | Hugging Face Scheduled Jobs or GitHub Actions schedule |
| Workers Static Assets | files in Docker image | files in Docker image or object bucket |

Stage 1 is single-instance compatible. Do not enable multiple Space replicas while local SQLite/KV/Queue state is authoritative.

### Stage 3 — data transfer and cutover

1. Freeze writes briefly on the Cloudflare deployment.
2. Export the remote D1 database from a trusted workstation:

```bash
cd worker
npx wrangler d1 export sounddrop-db --remote --output ../private-backup/sounddrop-db.sql --config wrangler.jsonc
```

3. Do **not** commit the SQL export to GitHub.
4. Import the SQL into the local Hugging Face persistence directory using Wrangler local execution or migrate the records into the selected managed PostgreSQL service.
5. Export required KV prefixes and active job state through an authenticated administrative export tool. Short-lived caches and expired sessions should not be migrated.
6. Run the full test matrix against the Space URL.
7. Update the Telegram webhook to the Space or custom-domain URL.
8. Switch DNS only after the Space and fallback URL both pass production smoke tests.
9. Keep Cloudflare read-only for a rollback window, then remove its routes and secrets.

## Create the public Docker Space

Create a new Space with these settings:

| Setting | Value |
|---|---|
| Owner | `DyrakArmy` |
| Name | `dyrakarmy-platform` |
| Visibility | Public |
| SDK | Docker |
| Port | `7860` |

Expected public URL:

```text
https://dyrakarmy-dyrakarmy-platform.hf.space
```

## Configure keyless GitHub publication

In the Hugging Face Space settings, open **Trusted Publishers** and add:

| Claim | Value |
|---|---|
| Provider | GitHub Actions |
| Repository | `biramentv-ux/download-killer-v2` |
| Branch | `main` |
| Workflow | `hugging-face-space.yml` |

In GitHub, add the repository variable:

```text
HF_SPACE_SYNC_ENABLED=true
```

No `HF_TOKEN` is required by the prepared workflow. Each successful push to `main` creates a deterministic Space bundle, uploads it and verifies the public URL.

## Hugging Face Space secrets

Add these as **Secrets** in the Space settings:

```text
TELEGRAM_BOT_TOKEN
TELEGRAM_SECRET_TOKEN
TELEGRAM_ADMIN_IDS
DOWNLOADER_API_KEY
DOWNLOAD_TOKEN_SECRET
WEBHOOK_HMAC_SECRET
OPS_READ_TOKEN
OPS_OPERATOR_TOKEN
OPS_ADMIN_TOKEN
RELEASE_SIGNING_PRIVATE_KEY_PKCS8_BASE64
```

Add these as public **Variables**:

```text
PUBLIC_BASE_URL=https://dyrakarmy-dyrakarmy-platform.hf.space
CORS_ORIGINS=https://dyrakarmy-dyrakarmy-platform.hf.space,https://dyrakarmy.eu,https://www.dyrakarmy.eu
DYRAKARMY_PERSIST_ROOT=/data/dyrakarmy
HF_SKIP_LOCAL_MIGRATIONS=0
```

Never copy Cloudflare API credentials into Hugging Face. The migration runtime does not require `CLOUDFLARE_API_TOKEN` or `CLOUDFLARE_ACCOUNT_ID`.

## Custom domain

A Hugging Face custom domain requires an eligible PRO, Team or Enterprise plan. Add the domain in the Space settings and point the required DNS CNAME to `hf.space`. Keep the default `*.hf.space` URL enabled as the operational fallback.

Recommended order:

1. Verify the default Space URL.
2. Attach and validate persistent storage.
3. Configure `dyrakarmy.eu` as the custom domain.
4. Replace `PUBLIC_BASE_URL` and `CORS_ORIGINS` with the final domain.
5. Reconfigure the Telegram webhook.
6. Execute final smoke tests.

## Required production verification

The migration is complete only when all of these pass on the Hugging Face URL and final custom domain:

- home page contains `DyrakArmy Interface v17`;
- `id="software"` exists;
- `/platform/software-suite.css` and `/platform/software-suite.js` load;
- `/api/software/releases` returns `ok=true` and the current release packages;
- `/api/platform/public` includes all ten games;
- `/api/platform/governance/health` returns healthy;
- `/api/telegram/v12/health` returns `username=dyrakarmy_bot`;
- Telegram `/software` and `/games` menus work;
- D1/KV/Queue state survives a Space restart;
- PWA installation and service-worker upgrade pass;
- no Cloudflare route remains authoritative after the rollback window.

## Rollback

Until durable state and all smoke tests are confirmed:

- keep the Cloudflare Worker unchanged;
- do not delete D1, KV or Queues;
- keep the old Telegram webhook details recorded securely;
- switch DNS back to Cloudflare if the Space fails persistence or webhook tests.
