# SoundDrop Browser Extensions (Chrome + Firefox)

This package contains working browser extensions for quick SoundDrop queue/download flow.

## Included features

- Popup UI for URL download (format/quality/source)
- Settings sync fields (`API URL`, `sync key`, `language`, auto-download)
- Right-click context menu:
  - Download link with SoundDrop
  - Download audio/video with SoundDrop
  - Download current page with SoundDrop
- Opens native browser download/save flow when job is ready
- Reuses existing Worker API:
  - `POST /api/download`
  - `GET /api/job/:id`
  - `POST /api/preferences` (language sync)

## Build packages

```powershell
cd browser_extensions\sounddrop_webext
powershell -ExecutionPolicy Bypass -File .\build.ps1
```

Generated files:

- `dist/SoundDrop-Extension-Chrome.zip`
- `dist/SoundDrop-Extension-Firefox.zip`

They are also copied to:

- `worker/public/downloads/SoundDrop-Extension-Chrome.zip`
- `worker/public/downloads/SoundDrop-Extension-Firefox.zip`

## Install locally (developer mode)

### Chrome

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select `browser_extensions/sounddrop_webext/dist/chrome`

### Firefox

1. Open `about:debugging#/runtime/this-firefox`
2. Click `Load Temporary Add-on`
3. Select `browser_extensions/sounddrop_webext/dist/firefox/manifest.json`
