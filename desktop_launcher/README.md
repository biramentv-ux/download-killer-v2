# DyrakArmy Desktop Launcher

Portable desktop launcher:

- Windows output: `dist/DyrakArmyDesktop.exe`
- macOS output (from macOS builder): `dist/DyrakArmyDesktop-macOS.zip`
- Separate optional Windows external-engine GUI: `dist/DyrakArmySpotifyOggMp4Engine.exe`
- Built-in desktop bridge for local downloads:
  - Opens native **Save As** dialog.
  - Supports synced preferred download directory from web settings (`download_directory`) as initial dialog location.
  - Downloads and converts selected format/quality locally.
  - Playlist URLs open native **Folder picker** and batch-download tracks in the selected format/quality.
  - On first local download it auto-installs tools to local app data (`DyrakArmyDesktop/tools`):
    - Windows: `yt-dlp.exe`, `ffmpeg.exe`
    - macOS: `yt-dlp`, `ffmpeg`
  - Works even when cloud queue fallback is unavailable.
  - No app-level limit for playlist track count (platform/runtime limits may still apply).
- Native shell polish:
  - Branded launch splash screen while endpoint sync is initialized.
  - Auto language handoff (`lang=en|bg|es|ru|de`) from OS locale, synced with web/PWA via shared `sync` key.
  - Explicit client markers appended to launch URL (`client=desktop`, `platform=windows|macos`, `launcher=<version>`), so web UI can adapt for desktop wrapper mode.

Optional environment variables for Spotify playlist extraction on strict networks:

- `SPOTIFY_CLIENT_ID`
- `SPOTIFY_CLIENT_SECRET`

## Separate Spotify OGG/MP4 external engine GUI

The optional `DyrakArmySpotifyOggMp4Engine.exe` provides a BG/EN Tkinter interface for launching a separately installed copy of `spotify-oggmp4-dl`.

Features:

- select the external engine's `main.py`;
- select an explicit Python interpreter or use `py -3`;
- enter Spotify URL, URI, or ID;
- choose supported MP4/OGG quality;
- select output directory;
- live logs, debug flag, engine check, and stop control;
- non-secret settings stored under the user's DyrakArmy Desktop config folder.

The executable does not bundle or configure CDM files, Widevine profiles, PlayPlay binaries, decryption keys, cookies, or account credentials. The external engine must be installed and configured independently.

Source and detailed instructions:

- `external_engines/spotify_oggmp4_gui.py`
- `external_engines/README.md`

## Runtime URL

Default production URL inside launcher:

- `https://dyrakarmy.online`

Launcher startup behavior:

- Checks `/api/health` and picks the first healthy endpoint.
- Candidate order:
  1) `DYRAKARMY_URL` env var (or legacy `SOUNDDROP_URL`)
  2) `dyrakarmy_desktop.url` (same folder as `.exe`)
  3) `dyrakarmy_desktop.json` (`url` + optional `fallback_urls`)
  4) built-in defaults (`dyrakarmy.online`, then fallback URLs)

Override at launch:

```powershell
$env:DYRAKARMY_URL='https://your-real-url.workers.dev'; .\dist\DyrakArmyDesktop.exe
```

Language sync key behavior:

- Launcher persists a device sync key in `dyrakarmy_sync_key.txt` (same folder as launcher/source script).
- On startup it appends `?sync=<key>` to the web URL so language preference sync is shared with web/mobile when the same sync link is used.
- Optional override:

```powershell
$env:DYRAKARMY_SYNC_KEY='your_shared_sync_key'; .\dist\DyrakArmyDesktop.exe
```

Optional sidecar config in the same folder as `DyrakArmyDesktop.exe`:

`dyrakarmy_desktop.url`

```text
https://your-custom-domain.example
```

or `dyrakarmy_desktop.json`

```json
{
  "url": "https://your-custom-domain.example",
  "fallback_urls": [
    "https://dyrakarmy.online"
  ]
}
```

## Rebuild (Windows)

```powershell
python -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements.txt
.\.venv\Scripts\pyinstaller --noconfirm --clean --onefile --noconsole --name DyrakArmyDesktop sounddrop_desktop.py
.\.venv\Scripts\pyinstaller --noconfirm --clean --onefile --noconsole --name DyrakArmySpotifyOggMp4Engine .\external_engines\spotify_oggmp4_gui.py
```

## Rebuild (macOS)

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python -m pip install pyobjc-framework-Cocoa
pyinstaller --noconfirm --clean --windowed --name DyrakArmyDesktop sounddrop_desktop.py
cd dist
ditto -c -k --sequesterRsrc --keepParent "DyrakArmyDesktop.app" "DyrakArmyDesktop-macOS.zip"
```

## CI artifacts

GitHub Actions workflows:

- `.github/workflows/build-desktop-portable.yml` builds the main desktop app and the separate Windows OGG/MP4 engine GUI.
- `.github/workflows/release-assets.yml` includes the engine GUI in tagged/manual release assets.
