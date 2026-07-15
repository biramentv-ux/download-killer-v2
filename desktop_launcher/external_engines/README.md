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

## Protected inputs demo

`protected_inputs_demo.py` is a separate BG/EN demonstration window showing the expected UI/schema shape for sensitive configuration categories:

- CDM profile path;
- `.wvd` file marker;
- Widevine key ID and content-key placeholders;
- PlayPlay binary path;
- Spotify cookie placeholder;
- account password placeholder;
- account token placeholder.

All displayed values are deliberately fake and contain markers such as `DEMO`, `EXAMPLE`, `PLACEHOLDER`, `NOT_REAL`, or `NOT_USED`. The demo:

- performs no network requests;
- starts no subprocesses;
- loads no keys, WVD files, CDM profiles, or PlayPlay binaries;
- stores no credentials;
- performs no DRM decryption;
- exports only a non-functional example JSON file.

Run it from source:

```powershell
cd desktop_launcher
python .\external_engines\protected_inputs_demo.py
```

The matching static example is:

```text
external_engines/protected-inputs.demo.json
```

Do not replace the placeholders with real cookies, passwords, tokens, device profiles, or keys.

## Run the external engine GUI from source

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

## unplayplay metadata-only research profile

`unplayplay_research_profile.py` validates the seven supplied root metadata/build descriptor files by byte size and SHA-256 only. It never imports the upstream package, invokes `node-gyp`/CMake, loads a native addon, or calls a key routine.

```powershell
cd desktop_launcher
python -m external_engines.unplayplay_research_profile `
  --source "C:\Users\USER\Desktop\unplayplay"
```

The matching web profile is served from `/platform/playplay-demo/unplayplay-profile.json`. All runtime capabilities in the profile are fixed to `false`.
