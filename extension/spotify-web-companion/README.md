# Download Killer Companion for Spotify Web

Безопасна Manifest V3 интеграция на предоставените popup, content-script, queue,
storage и metadata идеи към съществуващия Download Killer backend.

## Как работи

1. Content script-ът открива публични Spotify track URL адреси в DOM.
2. Popup-ът или бутонът `DK` изпраща URL към extension service worker.
3. Service worker-ът записва задачата в `chrome.storage.local`.
4. Задачата се изпраща към `POST /api/download`.
5. Разширението следи `GET /api/job/{id}`.
6. При готов резултат показва линк и, само ако е включено, използва
   `chrome.downloads.download()`.

## Не е включено

- PlayPlay или Widevine декриптиране;
- PSSH, CDM профили или ключове;
- прихващане на Spotify аудио сегменти;
- `re-unplayplay.js`;
- FFmpeg върху защитен Spotify поток;
- remote-hosted JavaScript/WASM.

Разширението не изтегля или декриптира Spotify аудио. Spotify URL адресът се
използва като публична референция към твоя backend.

## Инсталиране

1. Разархивирай папката.
2. Отвори `chrome://extensions`.
3. Активирай **Developer mode**.
4. Избери **Load unpacked**.
5. Посочи папката `spotify-web-companion`.
6. Отвори `https://open.spotify.com`.

## Backend

Поддържани адреси:

- `https://dyrakarmy.online`
- `https://dyrakarmy.eu`
- `https://sounddrop.biramentv.workers.dev`

## Проверка

```bash
node scripts/validate.mjs
node --test tests/validators.test.mjs
python3 scripts/build_release.py
```
