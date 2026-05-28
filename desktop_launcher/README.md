# SoundDrop Desktop Launcher

Portable desktop launcher:

- Windows output: `dist/SoundDropDesktop.exe`
- macOS output (from macOS builder): `dist/SoundDropDesktop-macOS.zip`
- Built-in desktop bridge for local downloads:
  - Opens native **Save As** dialog.
  - Downloads and converts selected format/quality locally.
  - Playlist URLs open native **Folder picker** and batch-download tracks in the selected format/quality.
  - On first local download it auto-installs tools to local app data (`SoundDropDesktop/tools`):
    - Windows: `yt-dlp.exe`, `ffmpeg.exe`
    - macOS: `yt-dlp`, `ffmpeg`
  - Works even when cloud queue fallback is unavailable.
  - No app-level limit for playlist track count (platform/runtime limits may still apply).
- Native shell polish:
  - Branded launch splash screen while endpoint sync is initialized.
  - Auto language handoff (`lang=en|bg`) from OS locale, synced with web/PWA via shared `sync` key.
  - Explicit client markers appended to launch URL (`client=desktop`, `platform=windows|macos`, `launcher=<version>`), so web UI can adapt for desktop wrapper mode.

Optional environment variables for Spotify playlist extraction on strict networks:

- `SPOTIFY_CLIENT_ID`
- `SPOTIFY_CLIENT_SECRET`

## Runtime URL

Default production URL inside launcher:

- `https://sounddrop.biramentv.workers.dev`

Launcher startup behavior:

- Checks `/api/health` and picks the first healthy endpoint.
- Candidate order:
  1) `SOUNDDROP_URL` env var (if present)
  2) `sounddrop_desktop.url` (same folder as `.exe`)
  3) `sounddrop_desktop.json` (`url` + optional `fallback_urls`)
  4) built-in defaults (`sounddrop.biramentv.workers.dev`, then custom-domain fallbacks)

Override at launch:

```powershell
$env:SOUNDDROP_URL='https://your-real-url.workers.dev'; .\dist\SoundDropDesktop.exe
```

Language sync key behavior:

- Launcher persists a device sync key in `sounddrop_sync_key.txt` (same folder as launcher/source script).
- On startup it appends `?sync=<key>` to the web URL so language preference sync is shared with web/mobile when the same sync link is used.
- Optional override:

```powershell
$env:SOUNDDROP_SYNC_KEY='your_shared_sync_key'; .\dist\SoundDropDesktop.exe
```

Optional sidecar config in the same folder as `SoundDropDesktop.exe`:

`sounddrop_desktop.url`

```text
https://your-custom-domain.example
```

or `sounddrop_desktop.json`

```json
{
  "url": "https://your-custom-domain.example",
  "fallback_urls": [
    "https://sounddrop.biramentv.workers.dev"
  ]
}
```

## Rebuild (Windows)

```powershell
python -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements.txt
.\.venv\Scripts\pyinstaller --noconfirm --clean --onefile --noconsole --name SoundDropDesktop sounddrop_desktop.py
```

## Rebuild (macOS)

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python -m pip install pyobjc-framework-Cocoa
pyinstaller --noconfirm --clean --windowed --name SoundDropDesktop sounddrop_desktop.py
cd dist
ditto -c -k --sequesterRsrc --keepParent "SoundDropDesktop.app" "SoundDropDesktop-macOS.zip"
```

## CI artifacts

GitHub Actions workflow:

- `.github/workflows/build-desktop-portable.yml`

It builds both Windows and macOS portable artifacts and uploads them as downloadable run artifacts.
