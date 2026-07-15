# Download Killer Telegram Platform v10

Telegram Platform v10 connects the public website, Cloudflare Worker, shared download queue, `@download_killerBOT`, the secondary bot, Telegram Mini App, and a private Telegram storage channel.

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
copyMessage, file_id reuse or inline sharing
```

The website and bots use the same `download_jobs` table and processing queue. Telegram users are linked to a private synchronization key in `telegram_user_links`.

## Bulgarian master menu

Bulgarian is the default language. English can be selected from `🌍 Език` or `/language`.

The bot sends:

1. a persistent reply keyboard for quick actions;
2. an inline master menu with categorized actions;
3. localized Queue, History, My Songs, Formats, Settings, Sharing, Language and Help screens.

Main actions:

- `🔎 Търсене`;
- `⬇️ Свали URL`;
- `🎧 Моите песни`;
- `📤 Споделяне`;
- `📥 Опашка`;
- `🕘 История`;
- `🎚 Формати`;
- `⚙️ Настройки`;
- `🌐 Mini App`;
- `🌍 Език`;
- `🆘 Помощ`;
- `🏠 Меню`.

## Bot commands

- `/start` – start and main menu;
- `/menu` – reopen the master menu;
- `/search` – search by track or artist name;
- `/download` – submit a public URL;
- `/myfiles` – completed songs associated with the user;
- `/share` – share a completed song through Telegram inline mode;
- `/queue` – active jobs;
- `/history` – recent jobs;
- `/formats` – detailed format and quality guide;
- `/settings` – format, quality, source, downloads, captions and templates;
- `/language` – Bulgarian or English;
- `/site` – open the Telegram Mini App;
- `/help` – help.

Legacy archive, storage and cancellation commands remain available through the existing handlers.

## Formats and quality guide

The menu describes the actual supported formats:

- FLAC – lossless, metadata-friendly and smaller than WAV;
- WAV – lossless and uncompressed, with very large files;
- MP3 320 – broad compatibility and strong quality/size balance;
- MP3 128 – smaller files for mobile use;
- OGG and OPUS – efficient streaming-oriented compression;
- M4A – compact files and strong mobile compatibility.

The system does not claim to create true 192 kHz or 24-bit audio when the source does not contain it. Real sample rate and bit depth depend on the source material.

## Sharing completed songs

The `📤 Споделяне` screen uses `switch_inline_query_chosen_chat`.

A user can choose:

- a private chat with another user;
- a private chat with another bot;
- a group or supergroup;
- a channel.

Ownership is checked server-side. The inline query only returns media linked to the requesting Telegram user.

For the primary bot:

- cached MP3/M4A entries can be returned as cached audio results;
- cached FLAC/WAV/OGG/OPUS entries can be returned as cached document results;
- link-only records use a new time-limited Download Killer URL.

The secondary bot uses link-based inline results because Telegram `file_id` values are bot-specific.

A receiving third-party bot may receive the user-sent audio or document message, but whether it processes the message depends entirely on that bot's own commands, permissions and implementation.

### Enable inline mode

Inline mode cannot be enabled through the Bot API. It must be enabled in `@BotFather` for each bot:

1. open `@BotFather`;
2. send `/setinline`;
3. select the bot;
4. enter a placeholder, for example `Сподели песен`.

After enabling inline mode, rerun the corresponding setup script so the webhook subscribes to `inline_query` updates.

## Telegram Mini App

Public asset path:

```text
/telegram/
```

Expected production addresses:

```text
https://dyrakarmy.eu/telegram/
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
- `sendAudio` accepts MP3 or M4A audio;
- a reusable `file_id` belongs to the bot that received it;
- Telegram file identifiers must be treated as opaque strings.

The code defaults `TELEGRAM_STORAGE_MAX_MB` to `50` for hosted Bot API compatibility.

A self-hosted local Bot API server can support larger files, but it is a separate server deployment and is not part of the Cloudflare Worker setup.

## Required secrets

Never commit these values:

```text
TELEGRAM_BOT_TOKEN
TELEGRAM_SECRET_TOKEN
TELEGRAM_SECONDARY_BOT_TOKEN
TELEGRAM_SECONDARY_SECRET_TOKEN
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
$env:PUBLIC_BASE_URL="https://dyrakarmy.eu"
npm run telegram:setup
```

The script:

- verifies the token with `getMe`;
- warns if the token belongs to a different username;
- reports whether inline mode is enabled;
- configures Bulgarian and default command lists;
- sets the Mini App menu button;
- sets bot descriptions;
- registers the webhook with `message`, `callback_query`, `inline_query`, `channel_post` and `my_chat_member` updates;
- prints current webhook status.

## D1 migration

The Worker lazily creates the tables, but production deployment should also apply the explicit migration:

```powershell
cd worker
npx wrangler d1 execute sounddrop-db --file=migrations/0011_telegram_platform_v10.sql --remote
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

## Security

- Webhook requests must contain the configured Telegram secret header.
- Mini App requests require valid Telegram `initData` signed with the bot token.
- `auth_date` is limited to a short validity window.
- Bot tokens never appear in frontend assets or API responses.
- Website-to-bot handoff tokens are random, short-lived, and single-use.
- Inline sharing checks media ownership against the requesting Telegram user.
- User URLs pass through the existing allowlist, blocklist, SSRF checks, and rate limits.
- Telegram file IDs are stored server-side only.

## Content policy

The platform is intended only for public media that the user owns or is authorized to download, archive, or transform. It does not add CDM, Widevine, PlayPlay, cookie extraction, protected-stream decryption, or other DRM-bypass functionality.
