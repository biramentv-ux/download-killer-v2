# SoundDrop v7

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
- `GET /api/job/:id`
- `GET /api/job/:id/events` (SSE)
- `GET /api/history?limit=&offset=`
- `GET /api/formats`
- `GET /api/file/:token`
- `GET /api/preferences?key=:sync_key`
- `POST /api/preferences` body: `{ key, language }`
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
- `POST /internal/playlist/resolve` body: `{ url, source }`
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

## Deployment status

Cloudflare account provisioning status:

- D1: created and schema applied.
- KV: created.
- Queues: created.
- R2: optional; currently blocked by account entitlement (`code: 10042`).

Production deploy is possible without R2. The only hard requirement is a public downloader host URL in `DOWNLOADER_API_URL`.

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

## Notes

- Queue lifecycle: `queued -> processing -> done|failed`
- Request dedupe: fingerprint (`url|format|quality`) in KV
- File dedupe: global SHA-256 cache in R2 (when enabled)
- Download links are tokenized and time-limited
- Playlist queueing has no app-level track-count cap; platform/API/runtime limits may still apply.
