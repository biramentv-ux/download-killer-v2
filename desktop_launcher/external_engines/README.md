# External engines

## Spotify OGG/MP4 GUI

`spotify_oggmp4_gui.py` is a bilingual BG/EN desktop launcher for a separately installed copy of `spotify-oggmp4-dl`.

It provides:

- Spotify URL, URI, or ID input;
- MP4 and OGG quality selection;
- external `main.py` path selection;
- configurable Python command or interpreter;
- output directory selection;
- live stdout/stderr logs;
- engine check through `main.py --help`;
- start and stop controls;
- locally persisted non-secret settings.

The launcher intentionally does not bundle or configure CDM files, Widevine profiles, PlayPlay binaries, decryption keys, cookies, or account credentials. The external engine must be installed and configured separately by the user.

## Run from source

```powershell
cd desktop_launcher
python .\external_engines\spotify_oggmp4_gui.py
```

On Windows the default Python command is `py -3`. It can be replaced with an explicit `python.exe` path from the GUI.

## Build

```powershell
cd desktop_launcher
pyinstaller --noconfirm --clean --onefile --noconsole `
  --name DyrakArmySpotifyOggMp4Engine `
  .\external_engines\spotify_oggmp4_gui.py
```

The main desktop build workflow also produces this executable as a separate artifact file.
