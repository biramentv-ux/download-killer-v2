# dyrakarmy.eu mirror

`dyrakarmy.eu` and `www.dyrakarmy.eu` are configured as alternate custom domains for the existing `sounddrop` Cloudflare Worker.

## Architecture

All public addresses serve the same deployment and backend:

- `https://dyrakarmy.online/` — canonical address
- `https://www.dyrakarmy.online/`
- `https://dyrakarmy.eu/` — alternate mirror
- `https://www.dyrakarmy.eu/`
- `https://sounddrop.biramentv.workers.dev/` — infrastructure fallback

The mirror shares the same Worker, D1 database, KV namespace, queues, cron triggers, Telegram webhook, Mini App and downloader origins. It does not create a second database or a second backend.

## Required Cloudflare setup

1. In the same Cloudflare account that owns the `sounddrop` Worker, choose **Add a domain**.
2. Add `dyrakarmy.eu` as a full DNS zone.
3. At the domain registrar, replace the current nameservers with the two nameservers assigned by Cloudflare.
4. Wait until the Cloudflare zone status becomes **Active**.
5. Do not manually create A or CNAME records for the Worker custom domains unless Cloudflare explicitly requests them. Wrangler manages the custom-domain routing.

Both `dyrakarmy.eu` and `www.dyrakarmy.eu` must belong to the same active Cloudflare zone before deployment.

## Deploy

From the repository:

```powershell
cd "$HOME\Desktop\download-killer-v2\worker"
git pull origin main
npm install
npm run typecheck
npm test
npm run deploy
```

Successful deployment should list:

```text
https://sounddrop.biramentv.workers.dev
dyrakarmy.online
www.dyrakarmy.online
dyrakarmy.eu
www.dyrakarmy.eu
```

## Verification

```powershell
$urls = @(
  "https://dyrakarmy.online/",
  "https://www.dyrakarmy.online/",
  "https://dyrakarmy.eu/",
  "https://www.dyrakarmy.eu/",
  "https://sounddrop.biramentv.workers.dev/"
)

foreach ($url in $urls) {
  try {
    $response = Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 30
    "{0} -> HTTP {1}" -f $url, $response.StatusCode
  }
  catch {
    "{0} -> ERROR: {1}" -f $url, $_.Exception.Message
  }
}
```

The expected status is `HTTP 200` for every address.

## Canonical behavior

`dyrakarmy.online` remains the canonical public base URL used for generated download links, Telegram Mini App links and webhook configuration. `dyrakarmy.eu` is an alternate access mirror to the same service.

## Rollback

If the `.eu` zone is not active and deployment fails, remove the two `dyrakarmy.eu` route entries from `worker/wrangler.jsonc` or activate the zone before deploying again. The currently deployed `.online` Worker remains unchanged until a new deployment succeeds.
