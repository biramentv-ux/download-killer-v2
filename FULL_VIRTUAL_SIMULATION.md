# Download Killer Full Virtual Simulation

The repository-wide simulation is executed by `.github/workflows/full-virtual-simulation.yml`.

## Covered subsystems

- Cloudflare Worker typecheck, unit tests and Wrangler packaging dry-run.
- Responsive web contracts, mobile navigation, language switching and native Telegram links.
- Job status polling deduplication, cached-state recovery and `Retry-After` handling.
- PWA installation, cache activation, Telegram network-first behavior and API network bypass.
- Downloader Python tests, public Spotify normalization and protected-input rejection.
- Desktop Python entrypoints and external-engine adapter tests.
- Expo typecheck and export simulations for web, iOS and Android.
- Canonical Chrome extension validation, tests and deterministic ZIP packaging.
- Legacy Chrome and Firefox source and manifest validation.

## Deliberate exclusions

The deterministic simulation does not call production Cloudflare, Telegram, Render, Spotify, YouTube or other external services. It does not create real download jobs or messages. Production smoke tests remain a separate deployment gate because they require secrets and live infrastructure.

## Local command

```bash
cd worker
npm ci
npm run typecheck
npm test
npm run simulate:all
```

The simulator writes `worker/full-virtual-simulation-report.json`.
