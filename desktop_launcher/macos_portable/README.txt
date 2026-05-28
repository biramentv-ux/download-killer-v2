SoundDrop Desktop macOS Portable
================================

1) Open Terminal in this folder and run:
   zsh ./SoundDropDesktop.command
2) On first run it creates a local .venv and installs dependencies
3) Then it starts SoundDrop Desktop

Notes:
- Python 3 is required on macOS.
- The app downloads yt-dlp and ffmpeg locally on first media save.
- A persistent sync key is saved locally and appended to web URL (`?sync=...`) for language sync with web/mobile.
- The launcher also appends desktop client markers (`client=desktop`, `platform=macos`, `launcher=<version>`) so the web UI auto-adapts to desktop wrapper mode.
