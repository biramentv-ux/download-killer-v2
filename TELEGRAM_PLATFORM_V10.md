# Download Killer Telegram Platform v10

Telegram Platform v10 connects the public website, Cloudflare Worker, download queue, `@download_killerBOT`, Telegram Mini App, and a private Telegram storage channel.

## User flow

```text
Website or Telegram Mini App
          ↓
Cloudflare Worker validation
          ↓
D1 download job + Cloudflare Queue
          ↓
FastAPI downloader + FFmpeg
          ↓
Telegram storage channel
          ↓
D1 file_id / channel message index
          ↓
copyMessage or file_id reuse for later users
```

The website and bot use the same `download_jobs` table and processing queue. Telegram users are linked to a private synchronization key in `telegram_user_links`.

## Bulgarian bot commands

- `/start` – start and main menu;
- `/search` – search by track or artist name;
- `/download` – submit a public URL;
- `/queue` – active jobs;
- `/history` – recent jobs;
- `/myfiles` – files associated with the user in the Telegram archive;
- `/formats` – formats and quality information;
- `/archive` – search the existing archive;
- `/site` – open the Telegram Mini App;
- `/language` – Bulgarian or English;
- `/storage` – archive statistics;
- `/cancel` – cancel the latest queued or paused job;
- `/settings` – advanced existing bot settings;
- `/help` – help.

The main reply keyboard also exposes search, URL download, queue, history, archive, formats, settings, storage statistics, and the Mini App.

## Telegram Mini App

Public asset path:

```text
/telegram/
```

Expected production addresses:

```text
https://dyrakarmy.online/telegram/
https://sounddrop.biramentv.workers.dev/telegram/
```

Features:

- server-side Telegram `initData` signature validation;
- Bulgarian and English UI;
- URL download form;
- search by title or artist;
- source, format, and quality selection;
- SSE live progress with polling fallback;
- personal queue and history;
- Telegram storage telemetry;
- direct delivery of completed jobs to the current Telegram chat;
- deep-link handoff from the public website to the bot or Mini App.

The bot token is never sent to browser JavaScript.

## Website-to-bot handoff

A completed website job can request:

```http
POST /api/telegram/v10/handoff
Content-Type: application/json

{
  "job_id": "JOB_ID"
}
```

The response contains temporary links:

```text
https://t.me/download_killerBOT?start=job_<temporary-token>
https://t.me/download_killerBOT?startapp=job_<temporary-token>
```

The token is stored in KV for one hour and is deleted after successful bot delivery.

## Storage model

A private Telegram channel acts as the durable Telegram-side file catalog. D1 remains the searchable metadata and ownership index.

For each completed job the Worker attempts, in order:

1. `sendAudio` by URL for supported small MP3/M4A files;
2. multipart `sendAudio` or `sendDocument` for files within the configured upload limit;
3. a channel message containing a time-limited web download link when the file cannot be uploaded.

The Worker stores:

- content hash or fingerprint storage key;
- Telegram `file_id` and `file_unique_id`;
- storage channel ID;
- channel message ID;
- job, title, artist, format, quality, duration, and size;
- fallback download URL.

For later requests it first uses `copyMessage` from the storage channel. If that fails it sends the stored `file_id`. Only then does it fall back to a download link.

## Telegram platform limits

With the hosted Bot API:

- sending a non-photo file by URL is limited to 20 MB;
- multipart upload through most media/file methods is limited to 50 MB;
- `sendAudio` accepts MP3 or M4A audio and currently documents a 50 MB limit;
- Bot API `getFile` downloads are limited to 20 MB;
- a reusable `file_id` is specific to the bot that received it;
- Telegram file identifiers should be treated as opaque strings.

The code defaults `TELEGRAM_STORAGE_MAX_MB` to `50` so it remains compatible with the hosted Bot API.

A self-hosted local Bot API server can allow uploads up to 2000 MB and unrestricted downloads, but that is a separate server deployment and not part of the free Cloudflare Worker setup.

## Required secrets

Never commit these values:

```text
TELEGRAM_BOT_TOKEN
TELEGRAM_SECRET_TOKEN
DOWNLOADER_API_KEY
DOWNLOAD_TOKEN_SECRET
```

Cloudflare setup examples:

```powershell
cd worker
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_SECRET_TOKEN
```

The webhook secret should be a random value containing only letters, numbers, underscore, or hyphen.

## Storage channel setup

1. Create a private Telegram channel.
2. Add `@download_killerBOT` as an administrator.
3. Permit the bot to post messages.
4. Obtain the numeric channel ID, normally beginning with `-100`.
5. Set `TELEGRAM_DOWNLOAD_CHANNEL_ID` in `worker/wrangler.jsonc` or as an environment-specific Worker variable.

The code can also capture the channel ID after the bot receives a `channel_post`, but explicit configuration is more predictable.

## Bot and webhook setup

After the Worker has been deployed and the secrets are available locally:

```powershell
cd worker
$env:TELEGRAM_BOT_TOKEN="<temporary local value>"
$env:TELEGRAM_SECRET_TOKEN="<webhook secret>"
$env:TELEGRAM_BOT_USERNAME="download_killerBOT"
$env:PUBLIC_BASE_URL="https://dyrakarmy.online"
npm run telegram:setup
```

The script:

- verifies the token with `getMe`;
- warns if the token belongs to a different username;
- configures Bulgarian and default command lists;
- sets the Mini App menu button;
- sets bot descriptions;
- registers the webhook with `secret_token`;
- prints current webhook status.

## D1 migration

The Worker lazily creates the tables, but production deployment should also apply the explicit migration:

```powershell
cd worker
npx wrangler d1 execute sounddrop-db --file=migrations/0011_telegram_platform_v10.sql
```

## Configuration variables

```text
TELEGRAM_BOT_USERNAME=download_killerBOT
TELEGRAM_DOWNLOAD_CHANNEL_ID=-100...
TELEGRAM_STORAGE_ENABLED=1
TELEGRAM_STORAGE_MAX_MB=50
TELEGRAM_MINIAPP_PATH=/telegram/
TELEGRAM_MINIAPP_AUTH_MAX_AGE_SECONDS=900
```

For a different bot username, update `TELEGRAM_BOT_USERNAME` before running the setup script.

## Security

- Webhook requests must contain the configured Telegram secret header.
- Mini App requests require valid Telegram `initData` signed with the bot token.
- `auth_date` is limited to a short validity window.
- Bot tokens never appear in frontend assets or API responses.
- Website-to-bot handoff tokens are random, short-lived, and single-use.
- User URLs pass through the existing allowlist, blocklist, SSRF checks, and rate limits.
- Telegram file IDs are stored server-side only.

## Content policy

The platform is intended only for public media that the user owns or is authorized to download, archive, or transform. It does not add CDM, Widevine, PlayPlay, cookie extraction, protected-stream decryption, or other DRM-bypass functionality.
