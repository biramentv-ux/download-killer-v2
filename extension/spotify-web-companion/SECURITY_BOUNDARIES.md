# Граници на интеграцията

## Включено от качените файлове

- Manifest V3 структура.
- Popup интерфейс.
- Настройки за формат и качество.
- Content script за четене на track URL адреси.
- Service-worker опашка.
- История и настройки чрез `chrome.storage.local`.
- Метаданни чрез съществуващия Download Killer `/api/preview`.
- Предаване на задачи към `/api/download`.
- Следене на `/api/job/{id}`.
- Опционално изтегляне на готовия backend резултат.

## Премахнато

- `utils/decryption.js`.
- `libs/re-unplayplay.js`.
- PlayPlay ключове.
- Widevine CDM.
- PSSH обработка.
- Подмяна на `window.fetch` и `XMLHttpRequest`.
- Прихващане на защитени Spotify аудио URL адреси.
- Симулирани ключове и аудио сегменти.
- Симулираният FFmpeg модул.

## Причини

Content scripts в Manifest V3 работят в изолиран JavaScript свят, затова
подмяната на `window.fetch` не променя `fetch` на Spotify Web Player.
Освен това Chrome Web Store изисква изпълнимият JavaScript/WASM код да бъде
пакетиран в разширението, а Spotify изрично забранява улесняване на download
или stream-ripping на Spotify съдържание.

FFmpeg остава в съществуващия изолиран backend, където обработва само разрешения
резултат от Download Killer workflow.
