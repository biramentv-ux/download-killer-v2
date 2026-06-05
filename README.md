# DyrakArmy

Cloudflare Worker backend + external downloader service (FastAPI + yt-dlp + ffmpeg).

## Project layout

- `worker/` - public backend (REST API, queue consumer, Telegram webhook, UI, D1 schema)
- `downloader/` - internal downloader API
- `infra/` - Docker Compose for downloader runtime
- `desktop_launcher/` - portable desktop launcher (Windows + macOS packaging flow)
- `mobile_expo/` - native mobile shell scaffold (Expo, iOS/Android)
- `.env.example` - shared env template

## Implemented upgrades (parallel)

1. Intelligent source fallback:
   - Spotify/Deezer/Apple download requests are mirrored to YouTube automatically.
   - Implemented in `downloader/app/main.py` (`fallback_used`, `resolved_url`).

2. Live status via SSE:
   - New endpoint: `GET /api/job/:id/events`.
   - Web UI now uses EventSource live updates (no polling loop).

3. Global content-hash cache in R2 (optional):
   - Queue worker computes SHA-256 for final audio when R2 binding is enabled.
   - Reuses `objects/<hash>.<ext>` in R2 if already present.

4. PWA mobile install:
   - `manifest.webmanifest` + `sw.js` + app icons added.
   - Install button in Settings tab supports Android `beforeinstallprompt` and iOS Add to Home Screen flow.

5. Cross-platform language sync (EN/BG):
   - New API: `GET/POST /api/preferences` for `sync` key language preference.
   - Web UI has EN/BG switch and `Copy Sync Link` for sharing the same sync key across devices.
   - Desktop launcher now persists a local sync key and appends it to startup URL (`?sync=...`).

6. Telegram quick access:
   - New API: `GET /api/telegram/info` returns bot deep links (when token is configured).
   - Settings tab shows `Open Telegram Bot` and `Download via Telegram` buttons when available.

7. Telegram bot UX (Bulgarian-first) + archive-aware lookup:
   - Telegram flow is now Bulgarian by default (commands, settings panel, queue statuses).
   - Added in-chat settings for default format/quality/source and archive-priority toggle.
   - Added Mini App menu button + BG command menu setup.
   - Added optional archive table lookup (`telegram_archive_tracks`) for instant reuse of previously seen links/tracks.
   - Added instant cache-hit behavior: if URL+format+quality already exists as `done`, Telegram/Web reuses the ready job immediately.

8. Browser extensions (Chrome + Firefox):
   - Added packaged browser extensions with popup + context-menu download flow.
   - Extensions connect to existing Worker API (`/api/download`, `/api/job/:id`) and support sync key + language sync.
   - Download packages are served from web settings: `SoundDrop-Extension-Chrome.zip` and `SoundDrop-Extension-Firefox.zip`.

9. Retro Wave redesign + shell sync:
   - Web UI updated with a full retro neon visual pass (new palette, transitions, CTA hierarchy).
   - Added always-visible topbar CTA for direct Windows portable EXE download.
   - Desktop launcher splash now follows the same Retro Wave visual identity.
   - Added Expo native shell scaffold wired to existing backend routes and sync model.

10. v8 reliability upgrade (parallel streams):
   - Multi-origin downloader failover with KV-backed health/circuit model (`DOWNLOADER_ORIGINS_JSON`).
   - Scheduled origin probes + warmup via Worker cron (`scheduled()` every 5 minutes).
   - Runtime config endpoint (`/api/runtime-config`) used by web/desktop/mobile/extension startup.
   - Playlist workflow tracking with workflow/job linkage table and progress endpoint (`/api/playlist/workflow/:id`).
   - Ops telemetry/alerts with token-protected ops summary (`/api/ops/summary`) and Telegram alert dedupe.

11. P2 Ops Admin panel + manual replay:
   - Ops summary now includes origin circuit state, queue backlog samples, recent workflow statuses, top errors, and failed jobs.
   - New protected replay endpoint for operators/admins: `POST /api/ops/replay`.
   - Web Settings includes replay controls (workflow replay, job-id replay, recent failed replay).

12. Security + sync hardening:
   - Ops RBAC model (`viewer`/`operator`/`admin`) using separate bearer tokens.
   - Audit log for ops actions (`ops_summary`, `ops_replay`) persisted in D1 (`ops_audit_events`).
   - Rate-limit for manual replay requests to prevent replay abuse/spikes.
   - Preference sync v2 conflict resolution with revision + per-field timestamps.
   - Update channel metadata endpoint (`/api/updates`) for desktop/extension/mobile forced-update UX.
   - Synthetic smoke alerts upgraded with per-source fail + recovery Telegram notifications.

13. Share cards, discography aliases, source attempts, and onboarding:
   - Direct share aliases: `GET /api/share/:jobId` and `GET /api/share/:jobId/card.svg`.
   - Discography aliases: `GET /api/discography/search`, `GET /api/discography/release/:id/tracks`, `POST /api/discography/queue`.
   - Source fallback attempt tracking: `GET /api/jobs/:id/attempts`, `POST /api/jobs/:id/retry-next`, `POST /api/jobs/:id/attempt-result`.
   - New user tutorial deliverables live in `tutorials/` as PPTX, DOCX, and Markdown.

14. Metadata quality, scheduled downloads, and source health:
   - Metadata quality score for completed jobs with grade/report endpoints.
   - Scheduled downloads with one-time or recurring runs, privacy-preserving URL hashing, and queue integration.
   - Source health dashboard backed by KV + Analytics Engine events from real downloader attempts.
   - Automatic source recommendation endpoint for client-side fallback decisions.

## Runtime architecture

1. Web UI / Telegram call Worker endpoints.
2. Worker validates request, rate-limits, creates D1 job, pushes queue message.
3. Queue consumer calls downloader `/internal/download`.
4. Worker stores result in R2 when enabled, otherwise serves via downloader proxy.
5. Worker returns tokenized `/api/file/:token` link.

## Worker endpoints

- `POST /api/search` body: `{ query, source? }`
- `POST /api/download` body: `{ url, source?, format?, quality? }`
- `POST /api/playlist/resolve` body: `{ url, source? }`
- `POST /api/playlist/queue` body: `{ url, source?, format?, quality? }`
- `GET /api/playlist/workflow/:id`
- `POST /api/playlist/workflow/:id/pause`
- `POST /api/playlist/workflow/:id/resume`
- `POST /api/playlist/workflow/:id/cancel`
- `POST /api/playlist/workflow/:id/zip`
- `GET /api/job/:id`
- `GET /api/job/:id/events` (SSE)
- `GET /api/history?limit=&offset=`
- `GET /api/formats`
- `GET /api/file/:token`
- `GET /api/runtime-config`
- `GET /api/updates`
- `GET /api/releases/manifest`
- `POST /api/quality/score` body: `{ jobId }`
- `GET /api/quality/:jobId`
- `GET /api/quality/report?syncKey=:sync_key`
- `POST /api/quality/batch-score?syncKey=:sync_key`
- `GET /api/schedule?syncKey=:sync_key&status=pending|all`
- `POST /api/schedule` body: `{ url, syncKey, scheduledAt, format?, quality?, source?, recurrence?, wifiOnly? }`
- `PATCH /api/schedule/:id` body: `{ syncKey, scheduledAt?, recurrence?, wifiOnly? }`
- `DELETE /api/schedule/:id?syncKey=:sync_key`
- `GET /api/health/sources`
- `GET /api/health/sources/:source`
- `GET /api/health/recommend?format=mp3&quality=320`
- `POST /api/health/sources/:source/reset` (requires admin ops token)
- `GET /api/ops/summary` (requires `Authorization: Bearer <OPS_READ_TOKEN|OPS_OPERATOR_TOKEN|OPS_ADMIN_TOKEN>`)
- `POST /api/ops/replay` (requires `Authorization: Bearer <OPS_OPERATOR_TOKEN|OPS_ADMIN_TOKEN>`)
- `GET /api/preferences?key=:sync_key`
- `POST /api/preferences` body: `{ key, language, source, format, quality, download_directory, telegram_link_mode, base_revision?, client_updated_at?, client_id? }`
- `GET /api/telegram/info`
- `POST /telegram/webhook`
- `GET /api/health`

Error contract:

```json
{
  "error": {
    "code": "RATE_LIMITED",
    "message": "Too many download requests",
    "retryable": true
  }
}
```

## Downloader internal endpoints

All internal endpoints require header `X-API-Key`.

- `POST /internal/search` body: `{ query, source, limit }`
- `POST /internal/download` body: `{ job_id, url, source, format, quality }`
- `POST /internal/smoke` body: `{ url, source, format, quality }`
- `POST /internal/playlist/resolve` body: `{ url, source }`
- `POST /internal/playlist/workflow/start` body: `{ workflow_id?, url, source, format, quality, batch_size? }`
- `GET /internal/playlist/workflow/:workflow_id`
- `POST /internal/playlist/workflow/:workflow_id/pause`
- `POST /internal/playlist/workflow/:workflow_id/resume`
- `POST /internal/playlist/workflow/:workflow_id/cancel`
- `POST /internal/playlist/zip` body: `{ workflow_id, source, files[] }`
- `GET /internal/files/:file_id`
- `GET /health`

## Local setup

### 1) Downloader

```bash
cd infra
docker compose up --build
```

### 2) Worker dependencies

```bash
cd worker
npm install
```

### 3) Configure Cloudflare resources

- D1 database: `sounddrop-db`
- KV namespace bound as `CACHE`
- Optional: R2 bucket bound as `FILES` (enables global object cache)
- Queue `sounddrop-downloads` + DLQ `sounddrop-downloads-dlq`

Update IDs in `worker/wrangler.jsonc`.

### 4) Apply schema

```bash
cd worker
npx wrangler d1 execute sounddrop-db --file=schema.sql
```

### 4.1) Optional: Import Telegram export archive index (for instant archive matches)

Build seed SQL from exported Telegram HTML files:

```bash
cd worker
node scripts/build-telegram-archive-seed.mjs --out telegram_archive_seed.sql "<path-to-messages.html>" "<path-to-messages2.html>"
```

Or via npm script:

```bash
npm run build:tg-archive-seed -- "<path-to-messages.html>" "<path-to-messages2.html>"
```

Apply seed:

```bash
npx wrangler d1 execute sounddrop-db --file=telegram_archive_seed.sql
```

### 4.2) Optional: Build browser extension packages (Chrome + Firefox)

```bash
cd browser_extensions/sounddrop_webext
powershell -ExecutionPolicy Bypass -File ./build.ps1
```

Generated and copied files:

- `browser_extensions/sounddrop_webext/dist/SoundDrop-Extension-Chrome.zip`
- `browser_extensions/sounddrop_webext/dist/SoundDrop-Extension-Firefox.zip`
- `worker/public/downloads/SoundDrop-Extension-Chrome.zip`
- `worker/public/downloads/SoundDrop-Extension-Firefox.zip`

### 5) Secrets and vars

Copy templates:

- root `.env.example`
- `worker/.dev.vars.example` -> `worker/.dev.vars`

Set required worker secrets:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_SECRET_TOKEN`
- `DOWNLOADER_API_KEY`
- `DOWNLOAD_TOKEN_SECRET`
- `OPS_READ_TOKEN` (for `/api/ops/summary`)
- `OPS_ALERT_CHAT_ID` (optional: Telegram alerts destination)

Rotate and bulk-apply worker secrets (Cloudflare Secrets only):

```bash
cd worker
npm run secrets:rotate
```

Dry-run without applying:

```bash
node scripts/rotate-secrets.mjs --generate-missing
```

### 6) Run worker locally

```bash
cd worker
npm run dev
```

UI is served from Worker assets (`worker/public/index.html`).

## Desktop EXE (portable)

- Ready build: `desktop_launcher/dist/SoundDropDesktop.exe`
- No install needed. Double click to run.
- Uses production endpoint health-check (`/api/health`) and auto-fallback URLs.
- In desktop mode, download action opens native Save dialog and saves selected format/quality locally.
- In desktop mode, playlist URLs open native folder picker and batch-download all resolved tracks.
- Desktop toolchain (`yt-dlp.exe`, `ffmpeg.exe`) auto-downloads on first local save to `%LOCALAPPDATA%/SoundDropDesktop/tools`.
- Optional Spotify playlist credentials for strict environments:
  - `SPOTIFY_CLIENT_ID`
  - `SPOTIFY_CLIENT_SECRET`
- Build instructions: `desktop_launcher/README.md`
- macOS portable bundle available at `/downloads/SoundDropDesktop-macOS.zip` (bootstrap launcher).
- CI workflow for native Windows + macOS artifacts: `.github/workflows/build-desktop-portable.yml`

## Tests

### Worker

```bash
cd worker
npm run typecheck
npm run test
```

### Downloader

```bash
cd downloader
python -m venv .venv
. .venv/Scripts/Activate.ps1
pip install -r requirements.txt
pytest -q
```

## CI/CD release pipeline

- Workflow: `.github/workflows/release-assets.yml`
- Trigger:
  - push tag `v*`
  - manual `workflow_dispatch` (optional custom tag + prerelease flag)
- Publishes GitHub Release assets automatically:
  - `SoundDropDesktop.exe`
  - `SoundDropDesktop-macOS.zip`
  - `SoundDrop-Extension-Chrome.zip`
  - `SoundDrop-Extension-Firefox.zip`
  - `SoundDrop-Expo-Web.zip`
  - `SoundDrop-Expo-Native-Update.zip`

## Deployment status

Cloudflare account provisioning status:

- D1: created and schema applied.
- KV: created.
- Queues: created.
- R2: optional; currently blocked by account entitlement (`code: 10042`).

Production deploy is possible without R2. The only hard requirement is a public downloader host URL in `DOWNLOADER_API_URL`.

## DNS/NS finalization (`dyrakarmy.online`)

Current blocker for custom domain traffic is nameserver delegation at registrar level.

Expected Cloudflare nameservers:

- `courtney.ns.cloudflare.com`
- `dax.ns.cloudflare.com`

If registrar still shows `ns295.superhosting.bg` / `ns296.superhosting.bg`, switch to the two Cloudflare nameservers above and wait for propagation.

Live verifier script:

```bash
cd infra
powershell -ExecutionPolicy Bypass -File .\check-dns-propagation.ps1 -Domain dyrakarmy.online
```

The script checks:

- Cloudflare zone status (`pending` vs `active`)
- NS/A propagation across multiple resolvers
- Worker health endpoint on active domain (or workers.dev fallback while pending)

## Free mode (trycloudflare)

If you want to stay fully free (no VPS), run:

```powershell
powershell -ExecutionPolicy Bypass -File .\infra\run-free-mode.ps1
```

or double-click:

`infra/run-free-mode.cmd`

This script:

1. builds/starts downloader container,
2. starts a fresh `trycloudflare` tunnel,
3. captures the generated tunnel URL,
4. updates `worker/wrangler.jsonc` `DOWNLOADER_API_URL`,
5. deploys the Worker and runs a health smoke test.

Important limitation:

- `trycloudflare` is not guaranteed 24/7 production uptime.
- If tunnel restarts, URL changes; rerun `run-free-mode` to resync and redeploy.

## Always-on backup origin (Render)

`render.yaml` includes two downloader web services:

- `sounddrop-downloader-primary`
- `sounddrop-downloader-backup`

After Render creates both URLs (for example `https://sounddrop-downloader-primary.onrender.com` and `https://sounddrop-downloader-backup.onrender.com`), set Worker vars:

- `DOWNLOADER_API_URL` = primary URL
- `DOWNLOADER_BACKUP_API_URL` = backup URL
- `DOWNLOADER_ORIGINS_JSON` with both origins in priority order

Example:

```json
[
  { "id": "primary", "base_url": "https://sounddrop-downloader-primary.onrender.com", "priority": 0 },
  { "id": "backup", "base_url": "https://sounddrop-downloader-backup.onrender.com", "priority": 1 }
]
```

Then deploy Worker:

```bash
cd worker
npx wrangler deploy --config wrangler.jsonc
```

## v8 runtime/env additions

Worker vars/secrets:

- `DOWNLOADER_ORIGINS_JSON` - ordered array of downloader origins for automatic failover.
- `DOWNLOADER_BACKUP_API_URL`, `DOWNLOADER_TERTIARY_API_URL` - simple backup origin env overrides.
- `ORIGIN_HEALTH_TIMEOUT_MS`, `ORIGIN_FAIL_THRESHOLD`, `ORIGIN_RECOVERY_SECONDS` - circuit settings.
- `OPS_QUEUE_BACKLOG_THRESHOLD` - queue backlog alert threshold.
- `OPS_READ_TOKEN`, `OPS_OPERATOR_TOKEN`, `OPS_ADMIN_TOKEN` - ops RBAC bearer tokens.
- `OPS_REPLAY_RATE_LIMIT_PER_MINUTE` - base replay rate-limit fallback.
- `OPS_REPLAY_RATE_LIMIT_OPERATOR_PER_MINUTE`, `OPS_REPLAY_RATE_LIMIT_ADMIN_PER_MINUTE` - per-role replay rate-limits.
- `OPS_REPLAY_RATE_LIMIT_IP_PER_MINUTE` - per-IP replay ceiling across roles.
- `OPS_REPLAY_MAX_TARGETS_OPERATOR`, `OPS_REPLAY_MAX_TARGETS_ADMIN` - per-role max jobs per replay request.
- `SMOKE_TEST_YOUTUBE_URL`, `SMOKE_TEST_SPOTIFY_URL`, `SMOKE_TEST_FORMAT`, `SMOKE_TEST_QUALITY` - scheduled smoke monitor inputs (every 5 minutes).
- `OPS_SMOKE_ALERT_COOLDOWN_SECONDS` - per-source smoke alert dedupe window.
- `OPS_SMOKE_CONSECUTIVE_ALERT_THRESHOLD` - per-source consecutive failure threshold for immediate alert.
- `OPS_SMOKE_FAILURES_1H_ALERT_THRESHOLD` - aggregate 1h smoke failure threshold.
- `MIN_CLIENT_WEB`, `MIN_CLIENT_DESKTOP_WINDOWS`, `MIN_CLIENT_DESKTOP_MACOS`, `MIN_CLIENT_MOBILE_EXPO`, `MIN_CLIENT_EXTENSION` - cross-client version gate.
- `LATEST_DESKTOP_WINDOWS_VERSION`, `LATEST_DESKTOP_MACOS_VERSION`, `LATEST_MOBILE_EXPO_VERSION`, `LATEST_EXTENSION_VERSION`, `RELEASE_CHANNEL` - update channel metadata for forced-update flows.
- `RELEASE_SIGNING_KEY_ID` - public key id label embedded in `/api/releases/manifest`.
- `RELEASE_MANIFEST_CACHE_TTL_SECONDS` - cache TTL for generated release manifests.
- `RELEASE_SIGNING_PRIVATE_KEY_PKCS8_BASE64` (secret) - Ed25519 PKCS#8 private key used to sign the release manifest payload.
- `SYNC_KEY_EMAIL_REQUIRED` - require email when claiming/protecting a sync key (`0` by default).
- `SYNC_KEY_TURNSTILE_REQUIRED` - require Cloudflare Turnstile token for `/api/sync/claim` (`0` by default).
- `SYNC_KEY_TURNSTILE_SITE_KEY` - public Turnstile site key exposed through `/api/runtime-config`.
- `SYNC_KEY_TURNSTILE_SECRET` (secret) - Turnstile secret used server-side by `/api/sync/claim`.
- `JOB_RETENTION_ENABLED`, `JOB_RETENTION_DAYS`, `JOB_RETENTION_BATCH_SIZE` - daily cron cleanup for terminal jobs, dead-letter audit rows, old playlist workflows, and unreferenced R2 files.
- `KV_CLEANUP_PREFIXES`, `KV_CLEANUP_MAX_KEYS` - stale KV cleanup scope for keys accidentally written without TTL.
- `API_JSON_COMPRESSION_ENABLED` - optional Worker-side JSON compression flag. Keep `0` unless edge responses have been validated with correct `Content-Encoding` headers.

Downloader vars:

- `PLAYLIST_WORKFLOW_BATCH_SIZE` - batch size for workflow chunk processing.
- `PLAYLIST_WORKFLOW_RETENTION_SECONDS` - retention window for in-memory workflow status.
- `TEMPORAL_NAMESPACE`, `TEMPORAL_ADDRESS`, `TEMPORAL_API_KEY` - Temporal Cloud config (optional; local workflow mode remains available when unset).

## Notes

- Queue lifecycle: `queued -> processing -> done|failed`
- Request dedupe: fingerprint (`url|format|quality`) in KV
- File dedupe: global SHA-256 cache in R2 (when enabled)
- Retention cleanup: daily cron deletes only terminal `done/failed` jobs older than the retention window and deletes R2 objects only after DB references are gone.
- Download links are tokenized and time-limited
- Playlist queueing has no app-level track-count cap; platform/API/runtime limits may still apply.
