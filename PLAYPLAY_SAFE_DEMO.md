# PlayPlay Safe Demo

This project includes a deliberately non-executable PlayPlay-shaped demonstration for UI research, documentation, and integration testing.

## Public web demo

Path after Worker deployment:

- `/platform/playplay-demo/`
- `https://dyrakarmy.online/platform/playplay-demo/`
- `https://sounddrop.biramentv.workers.dev/platform/playplay-demo/`

Features:

- BG/EN interface;
- public Spotify URL or URI validation;
- 96, 160, and 320 kbps demo quality selection;
- fake `config.demo.json` preview;
- fake command preview;
- JSON clipboard copy;
- `.demo.json` browser export;
- reduced-motion support;
- no backend request and no credential input fields.

## Python demo adapter

Source:

```text
desktop_launcher/external_engines/playplay_demo_adapter.py
```

Example:

```powershell
cd desktop_launcher
python -m external_engines.playplay_demo_adapter `
  --url "https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b" `
  --quality 320 `
  --output ".\playplay.demo.json"
```

The generated payload resembles the shape of an external engine configuration but contains only explicit `DEMO`, `NOT_REAL`, and `DEMO_ONLY` markers.

## Disabled capabilities

The demo hard-codes all of the following to `false`:

```json
{
  "network_access": false,
  "subprocess_execution": false,
  "credential_storage": false,
  "cookie_loading": false,
  "wvd_loading": false,
  "key_loading": false,
  "drm_decryption": false
}
```

The adapter does not import or call `subprocess`, does not open `cookies.txt`, does not load `.wvd` files, does not contact Spotify, and does not execute the command preview.

## Relationship to the submitted prototype

The submitted prototype selected a `playplay` engine and constructed a command from `playplay.exe`, a mutable `config.json`, `cookies.txt`, and `device.wvd` paths.

The safe implementation preserves only the benign product ideas:

- engine-shaped adapter separation;
- Spotify reference validation;
- quality selection;
- configuration preview;
- command preview;
- local demo JSON export.

Real cookie/WVD/CDM loading and protected-stream execution are intentionally not implemented.
