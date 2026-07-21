# Secondary Telegram bot: @dyrakarmy_bot

`@dyrakarmy_bot` is an optional second Telegram entry point to the same Download Killer platform.

It uses:

- the same Cloudflare Worker;
- the same D1 jobs and history;
- the same KV cache and handoff data;
- the same Cloudflare queues;
- the same Telegram file archive and storage channel;
- a separate Telegram bot token and webhook secret.

## Routes

Primary bot:

```text
POST /telegram/webhook
```

Secondary bot:

```text
POST /telegram/webhook/dyrakarmy
```

The optional secondary API namespace is:

```text
/api/telegram/v10-secondary/*
```

It is internally routed to the existing Telegram v10 handlers with the secondary bot environment.

## Required Cloudflare secrets

Run from `worker/`:

```powershell
npx wrangler secret put TELEGRAM_SECONDARY_BOT_TOKEN --name sounddrop
npx wrangler secret put TELEGRAM_SECONDARY_SECRET_TOKEN --name sounddrop
```

Never commit either value to GitHub.

## Configure commands and webhook

Set local environment variables without writing them to files:

```powershell
$secondaryToken = Read-Host "Secondary bot token" -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secondaryToken)
try {
  $env:TELEGRAM_SECONDARY_BOT_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
}
finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
}

$env:TELEGRAM_SECONDARY_SECRET_TOKEN = "YOUR_RANDOM_WEBHOOK_SECRET"
$env:TELEGRAM_SECONDARY_BOT_USERNAME = "dyrakarmy_bot"
$env:PUBLIC_BASE_URL = "https://dyrakarmy.online"

npm run telegram:setup:secondary
```

Expected output:

```text
Connected secondary bot: @dyrakarmy_bot (...)
Webhook: https://dyrakarmy.online/telegram/webhook/dyrakarmy
Public platform: https://dyrakarmy.online/
```

Then clear the local process environment:

```powershell
Remove-Item Env:TELEGRAM_SECONDARY_BOT_TOKEN
Remove-Item Env:TELEGRAM_SECONDARY_SECRET_TOKEN
Remove-Item Env:TELEGRAM_SECONDARY_BOT_USERNAME
```

## Deployment

```powershell
git pull origin main
cd worker
npm ci
npm run typecheck
npm test
npm run deploy
```

## Design note

The secondary bot opens the public Download Killer web platform instead of the personalized Telegram Mini App. Bot commands, queue, history, file delivery and archive reuse remain available through the webhook. This avoids accepting Mini App authentication data signed by one bot as if it came from another bot.
