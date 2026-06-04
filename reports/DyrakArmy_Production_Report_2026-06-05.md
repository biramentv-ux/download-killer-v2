# DyrakArmy Production Report — 05.06.2026

## 1. Обобщение
DyrakArmy е качен и активен в Cloudflare Workers с основен публичен домейн `https://dyrakarmy.online` и вторичен `https://www.dyrakarmy.online`. Активни са Worker backend, статичният web UI, D1 schema, queue consumer-и, cron trigger-и, Telegram интеграция, runtime config, history sync, webhook notifications, Release Radar и share card flow.

Последен production deploy след поправката на console warning-а:
- Worker: `sounddrop`
- Основен URL: `https://dyrakarmy.online`
- WWW URL: `https://www.dyrakarmy.online`
- Workers.dev fallback: `https://sounddrop.biramentv.workers.dev`
- Cloudflare Version ID: `5c74c320-c450-45f3-98e0-6e6d8d18a3a5`
- Последен Git commit: `5b6a973 Fix ops token password form warning`

## 2. Поправка в този turn
Проблем: Chromium показваше предупреждение, че password field не е във form. Засегнатото поле беше `opsTokenInput` в Settings/Ops секцията.

Поправка:
- `opsTokenInput` вече е вътре във `<form id="opsTokenForm" autocomplete="off" onsubmit="return false;">`.
- Ops бутоните получиха `type="button"`, за да няма implicit submit/reload.
- Backend/API логиката не е променяна.

Проверка:
- Local Browser smoke: `opsPasswordInForm=true`, `passwordFormWarnings=0`.
- Production Browser smoke: `opsPasswordInForm=true`, `passwordFormWarnings=0`, `warningCount=0`.
- Production `/api/health`: OK.

## 3. Инфраструктура
Cloudflare:
- Worker със static assets и API routing.
- Custom domains: `dyrakarmy.online`, `www.dyrakarmy.online`.
- Workers.dev fallback остава активен.
- D1 database: `sounddrop-db`.
- KV namespace за cache, sessions, preferences, URL snapshots и runtime cache.
- Queues: download queue и history-event queue.
- Cron triggers: 5-минутни ops/smoke/release checks и daily retention cleanup.
- Assets binding за web UI и downloadable packages.

Downloader origin:
- Primary: Render origin `https://dyrakarmy-downloader-primary.onrender.com`.
- Backup: trycloudflare/local tunnel origin в `DOWNLOADER_ORIGINS_JSON`.
- Worker има multi-origin failover и health/circuit model.

## 4. Backend/API — налични функции
Core API:
- `/api/health`
- `/api/runtime-config`
- `/api/search`
- `/api/download`
- `/api/job/:id`
- `/api/job/:id/events`
- `/api/history`
- `/api/formats`
- `/api/file/:token`
- `/api/preferences`
- `/api/telegram/info`

Playlist/batch:
- `/api/playlist/resolve`
- `/api/playlist/queue`
- `/api/playlist/workflow/:id`
- pause/resume/cancel controls
- ZIP/archive build flow за плейлисти
- structured playlist folder metadata

Sharing/discovery:
- Shareable track cards: `/api/share/preview`, `/share/:token`, `/api/share/card/:token.svg`.
- Artist discography queue: `/api/artist/discography/queue`.
- Release Radar endpoints: `/api/release-radar` GET/POST/DELETE.

Sync/history:
- Централен runtime config за всички клиенти.
- Preferences sync: език, source, формат, качество, директория, Telegram mode, privacy mode, webhook config.
- Export/import download history: JSON/CSV export, JSON import, requeue capability.
- Shared queue по sync key.

Webhook notifications:
- Потребителят може да зададе Zapier/n8n webhook URL.
- При `download.done` Worker изпраща POST.
- Payload включва job metadata, download URL, stream URL, expiry и sync key hash.
- Поддържа HMAC signature чрез `DOWNLOAD_WEBHOOK_HMAC_SECRET` или `WEBHOOK_HMAC_SECRET`.
- Валидира само публични HTTPS URL-и и блокира localhost/private/internal targets.

## 5. Telegram bot — налични функции
Bot: `@dyrakarmy_bot`.

Добавени/налични flow-ове:
- Българско меню и help.
- `/start`, `/menu`, `/settings`, `/help`.
- `/me` profile card със статистика и настройки.
- Format/quality picker flow.
- Archive-first search поведение.
- Release Radar чрез `/radar` и `/radar Artist Name`.
- Webhook настройка чрез `/webhook`, `/webhook https://...`, `/webhook off`.
- Auto-publish към Telegram канал при завършени downloads.
- Mini App вход.
- Channel status panel и auto-publish settings.
- Privacy Mode sync от Telegram settings.

## 6. Web UI — налични функции
Branding/UI:
- Видимият UI е ребрандиран към DyrakArmy.
- Responsive layout за desktop/tablet/mobile.
- DyrakArmy logo.
- Multi-language UI: English, Bulgarian, Spanish, Russian, German.

Потребителски flow-ове:
- Search или direct URL input.
- Source filters: All, YouTube, Spotify, SoundCloud, Deezer, Apple Music, Podcast/RSS.
- Format/quality picker.
- Queue и job status rendering.
- SSE/live job events където е приложимо.
- History tab с export/import и hide-done controls.
- Settings tab със sync, runtime config, platform downloads, extensions, Telegram, webhook и privacy mode.
- Archive tab със server archive browsing, folders/images/audio entries и online player.
- Studio tab с audio preview, metadata lookup и live stats.
- Voice search чрез Web Speech API.
- Smart format selector и shared queue controls.

## 7. Desktop/Mobile/Extension артефакти
Публичните download бутони/runtime config включват:
- Windows portable EXE/package links.
- macOS portable ZIP/package links.
- Android/iOS Expo package links.
- Chrome extension ZIP.
- Firefox extension ZIP.
- Legacy imported packages за съвместимост.

Важно уточнение:
- Web/PWA/mobile shell е live.
- Пълно App Store / Play Store публикуване изисква store accounts, signing credentials, metadata, compliance и platform-specific build pipeline.

## 8. Security/Reliability
Security:
- URL allowlist/blocklist за download targets.
- SSRF reduction: private/local domains blocked за download и webhook inputs.
- Raw source URL hashing; оригиналните URL-и са short-lived в KV при нужда.
- HMAC helper за trusted webhooks.
- Telegram webhook token/JWT capability.
- Rate limits за API/status и Telegram flows.
- Ops token protected admin endpoints.
- Privacy Mode: успешни jobs могат да се изчистват от D1 след completion, със short-lived KV snapshot.
- KV cleanup cron за stale keys.
- Retention cleanup за стари jobs/files.

Reliability:
- Queue lifecycle: `queued -> processing -> done/failed`.
- Retry с exponential backoff + jitter.
- Dead-letter queue support.
- Multi-origin downloader failover и health probing.
- Synthetic smoke/ops hooks и Telegram alert plumbing.
- D1 schema използва additive `CREATE IF NOT EXISTS` подход.

## 9. Последна production проверка
Команди:
- `npm.cmd run typecheck` — успешно.
- `npm.cmd test` — 7 test files, 48 tests успешно.
- `wrangler deploy` — успешно.

Production checks:
- `https://dyrakarmy.online/api/health` връща `{ ok: true, service: "dyrakarmy-worker" }`.
- `https://dyrakarmy.online/` връща HTTP 200 и съдържа DyrakArmy title.
- `https://www.dyrakarmy.online/` връща HTTP 200 и съдържа DyrakArmy title.
- `https://sounddrop.biramentv.workers.dev/` връща HTTP 200 и съдържа DyrakArmy title.
- Browser console след fix-а: няма password form warning и няма warnings/errors в проверената production сесия.
- DOCX рапортът е валидиран програмно: файлът се отваря през `python-docx`, има 11 основни секции и няма повредени Unicode символи. PNG render QA не беше изпълнен, защото локалната среда няма LibreOffice/`soffice`.

## 10. Оставащи рискове и ограничения
- Render free tier може да има cold-start и rate-limit/bot-gate проблеми от upstream media платформи.
- YouTube/Spotify mirror downloading не може да бъде гарантирано 100% на free/shared hosting заради външни anti-bot политики.
- trycloudflare backup е полезен за тестове, но не е постоянен always-on origin, ако локалният PC/tunnel спре.
- Native iOS/macOS App Store-ready builds изискват Apple signing, macOS runner, Apple Developer account, metadata и review compliance.
- Android Play Store publishing изисква signing key management, Play Console setup, privacy/data safety forms и release track.
- Browser extension store publishing изисква Chrome Web Store / AMO accounts и policy review.
- Public достъп до локална Telegram Downloads папка от PC не е възможен, когато PC е offline, освен ако файловете не се mirror-нат към server/R2/Render storage.
- Всички token-и/ключове, споделяни исторически в чат, трябва да бъдат ротирани и да стоят само в Cloudflare secrets или equivalent secret storage.

## 11. Препоръчани следващи стъпки
P0:
- Ротация на всички исторически expose-нати secrets/tokens.
- Стабилизиране на реален always-on downloader origin извън free tunnel fallback.
- Реален scheduled monitor за Spotify + YouTube с Telegram alert confirmation.
- Mirror на локалната archive папка към server/R2, ако трябва да е достъпна при offline PC.

P1:
- Webhook delivery retries и delivery history UI.
- Release pipeline за signed Windows/macOS artifacts и extension store builds.
- Native mobile CI/CD за Android/iOS store artifacts.
- Admin dashboard controls за webhook deliveries, origin failover, queue backlog и replay audit.

P2:
- По-добри observability charts.
- User-facing webhook test button.
- Exportable full ops report от web UI.
