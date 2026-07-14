# DyrakArmy Platform v9

DyrakArmy Platform v9 adds a public animated platform portal on top of the existing Cloudflare Worker and FastAPI downloader architecture.

## Public surfaces

- Platform portal: `https://dyrakarmy.online/platform/`
- Free Cloudflare subdomain fallback: `https://sounddrop.biramentv.workers.dev/platform/`
- Classic application: `https://dyrakarmy.online/`
- Telegram: `https://t.me/dyrakarmy_bot`

The custom domain requires the `dyrakarmy.online` zone to remain active in Cloudflare. The `workers.dev` address is the free hosting and subdomain fallback.

## Platform portal

Files:

- `worker/public/platform/index.html`
- `worker/public/platform/platform.css`
- `worker/public/platform/platform.js`

Features:

- responsive animated design with canvas signal network;
- BG/EN language switch;
- real `/api/download` submission form;
- EventSource/SSE job updates with resilient polling fallback;
- public health, runtime configuration, format and latency cards;
- recent job history;
- engine and architecture visualization;
- links to the classic web app, desktop package, extensions and Telegram;
- reduced-motion accessibility support;
- public URL validation and safe error rendering.

## Backend path

```text
Web / Desktop / Extension / Telegram
                  |
                  v
        Cloudflare Worker API
       D1 + KV + Queues + SSE
                  |
                  v
    Authenticated downloader origin
         FastAPI + yt-dlp + FFmpeg
```

The portal does not receive or process DRM keys, CDM profiles, account credentials or encrypted Spotify streams. It submits only public HTTP/HTTPS references to the existing validated API.

## CI/CD

Workflow:

- `.github/workflows/deploy-web-platform.yml`

Pull requests run:

- Worker TypeScript typecheck;
- Worker tests;
- JavaScript syntax validation;
- HTML/CSS/API integration marker validation.

Pushes to `main` deploy through Cloudflare Wrangler when these repository secrets are present:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

After deployment, the workflow checks the custom domain, `www` domain and free `workers.dev` fallback for the platform title.

## Local run

```powershell
cd worker
npm ci
npm run dev
```

Then open:

```text
http://localhost:8787/platform/
```
