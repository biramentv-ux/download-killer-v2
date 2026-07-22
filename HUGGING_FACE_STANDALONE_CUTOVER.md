# DyrakArmy — Hugging Face Standalone Cutover

## Objective

Move every public DyrakArmy runtime component to Hugging Face while retaining GitHub as the canonical source and keeping Cloudflare only as a temporary rollback source during the observation window.

## Target topology

```text
GitHub main
  ├─ publish → DyrakArmy/dyrakarmy-platform
  │             ├─ Web/PWA
  │             ├─ Control Center
  │             ├─ Software Suite
  │             ├─ Games 1–10
  │             ├─ API and downloader orchestration
  │             ├─ Telegram Mini App and webhook
  │             ├─ local D1-compatible SQLite
  │             ├─ local KV-compatible state
  │             ├─ local queue consumers
  │             └─ scheduled handlers
  │
  └─ publish → DyrakArmy/dyrakarmy-domain-redirect
                └─ path-preserving redirect for the secondary domain

HF Storage Bucket mounted at /data
  └─ /data/dyrakarmy — persistent runtime state
```

## Domain model

- Primary application domain: `dyrakarmy.eu`
- Secondary public domain: `dyrakarmy.online`
- Primary Space: `DyrakArmy/dyrakarmy-platform`
- Secondary redirect Space: `DyrakArmy/dyrakarmy-domain-redirect`

Only one stateful Space is allowed. The secondary domain redirects to the primary domain while preserving path, query string and hash. This prevents duplicate Telegram webhooks, duplicate queues and split-brain databases.

## Hugging Face account prerequisites

1. PRO, Team or Enterprise plan for custom domains.
2. Paid always-on CPU hardware for the primary Space.
3. Storage Bucket attached read-write at `/data`.
4. Trusted Publisher for both GitHub workflows.
5. Production Secrets and Variables configured in the primary Space.

## Required Secrets

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

Optional:

```text
AUDIUS_API_KEY
JAMENDO_CLIENT_ID
OPS_ALERT_CHAT_ID
TELEGRAM_DOWNLOAD_CHANNEL_ID
```

## Required Variables for standalone mode

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

## Cloudflare state export package

The import bundle mounted in the Storage Bucket must contain:

```text
/data/import/cloudflare/d1.sql
/data/import/cloudflare/kv-bulk.json
/data/import/cloudflare/files/        # optional
```

The D1 file must be a Wrangler D1 SQL export. The KV file must use Wrangler `kv bulk put` JSON format.

## Import sequence

1. Keep `HF_BACKEND_MODE=cloudflare-mirror`.
2. Upload the export package to the attached bucket.
3. Set `HF_IMPORT_ON_START=1`.
4. Rebuild the Space.
5. Confirm `/data/dyrakarmy/.cloudflare-state-imported` exists.
6. Set `HF_IMPORT_ON_START=0`.
7. Run the standalone Docker persistence CI gate.
8. Change `HF_BACKEND_MODE=standalone` on the native `.hf.space` hostname.
9. Verify all public endpoints before DNS changes.

## Mandatory pre-DNS validation

- homepage and PWA assets;
- Software Suite catalog and release links;
- multi-source search catalog;
- downloader queue creation and completion;
- file delivery and Telegram archive reuse;
- Telegram Mini App health;
- Governance, roles, device-link and owner permissions;
- Games 1–10;
- scheduler and cleanup jobs;
- D1/KV state survives a Space restart;
- no request is proxied to Cloudflare;
- Telegram webhook reports the Hugging Face hostname.

## Telegram cutover

When `HF_TELEGRAM_WEBHOOK_AUTOCONFIGURE=1`, the standalone supervisor sets:

```text
https://dyrakarmy.eu/telegram/webhook
```

The bot token and webhook secret remain Hugging Face Secrets. Only one webhook authority is allowed.

## Custom domains

### Primary Space

In the primary Space Settings → Custom Domain, register `dyrakarmy.eu`, then point its DNS record to `hf.space`.

### Secondary Space

Create the public static Space `DyrakArmy/dyrakarmy-domain-redirect`, configure its Trusted Publisher, enable the GitHub variable:

```text
HF_REDIRECT_SPACE_SYNC_ENABLED=true
```

Register `dyrakarmy.online` as the redirect Space custom domain and point it to `hf.space`.

For DNS providers that cannot place a CNAME at the zone apex, use ALIAS/ANAME/CNAME-flattening or redirect the apex to a `www` custom domain.

## Observation and Cloudflare retirement

Keep Cloudflare read-only for at least seven days after DNS and Telegram cutover. During this window:

- do not write new application state to Cloudflare;
- compare user, job, archive and governance counts;
- retain the final D1/KV exports;
- keep a tested DNS rollback path.

After the observation window and final approval:

1. delete Cloudflare Worker routes;
2. disable Cloudflare Git Builds;
3. revoke Worker/D1/KV/Queue tokens;
4. export and archive the final Cloudflare state;
5. delete Cloudflare queues, KV and D1 only after an offline backup is verified;
6. remove Cloudflare-specific production workflows from GitHub.

## Non-negotiable safety rules

- Never enable standalone mode without `/data` persistence.
- Never run both Telegram webhook authorities.
- Never point the two domains to independent stateful runtimes.
- Never delete Cloudflare state before restart persistence and data-parity tests pass.
- Never store production secrets in GitHub files or Space Variables; use Space Secrets.
