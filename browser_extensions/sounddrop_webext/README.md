# DyrakArmy Browser Extensions (Chrome + Firefox)

This package contains working browser extensions for the DyrakArmy queue/download flow.

## Included features

- Popup UI for URL download with format, quality and source selection.
- Settings sync fields: API URL, sync key, language and auto-download.
- Right-click context menu:
  - Download link with DyrakArmy.
  - Download audio/video with DyrakArmy.
  - Download current page with DyrakArmy.
- Spotify Web Player integration:
  - Adds a small DyrakArmy queue button next to detected track rows.
  - Extracts only the public `open.spotify.com/track/...` reference.
  - Uses a bounded queue with up to three parallel API submissions.
  - Reuses the normal Worker API and existing browser download flow.
- Opens the native browser download/save flow when a job is ready.
- Reuses existing Worker API:
  - `POST /api/download`
  - `GET /api/job/:id`
  - `POST /api/preferences`

## Security boundary

The Web Player content script does not intercept Spotify CDN requests and does not collect encrypted media segments, File IDs, AES keys, PSSH, CDM, Widevine or PlayPlay data. Audio resolution and FFmpeg processing remain in the existing backend pipeline.

## Build packages

```powershell
cd browser_extensions\sounddrop_webext
powershell -ExecutionPolicy Bypass -File .\build.ps1
```

Generated files:

- `dist/DyrakArmy-Extension-Legacy-Chrome.zip`
- `dist/DyrakArmy-Extension-Firefox.zip`

They are also copied to:

- `worker/public/downloads/DyrakArmy-Extension-Legacy-Chrome.zip`
- `worker/public/downloads/DyrakArmy-Extension-Firefox.zip`

The maintained `extension/spotify-web-companion` package exclusively owns the
canonical `DyrakArmy-Extension-Chrome.zip` name. This legacy package uses a
different Chrome filename so parallel CI builds cannot overwrite it.

## Install locally (developer mode)

### Chrome

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select `browser_extensions/sounddrop_webext/dist/chrome`.

### Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click `Load Temporary Add-on`.
3. Select `browser_extensions/sounddrop_webext/dist/firefox/manifest.json`.
