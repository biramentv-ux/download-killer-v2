# DyrakArmy Unified Platform Control

Download Killer, the Telegram bot, DyrakArmy Arena, Latency Strike, the website and public content use one shared platform registry.

## What can be changed from a phone

The protected Control Center at `/control/` supports:

- enabling or hiding website modules;
- enabling or disabling Arena, Latency Strike, downloads and Media Lab APIs;
- adding, editing and deleting public cards, announcements and navigation links;
- changing public colors, border radius, site title, footer and season label;
- reviewing an immutable-style audit trail of administrative changes;
- exporting the current registry as JSON.

Changes are stored in D1, cached briefly in KV and become public without a GitHub deployment.

Remote management deliberately does not accept arbitrary HTML, JavaScript or executable code. Code changes remain protected by GitHub review and CI.

## Administrator bootstrap

1. Open `@dyrakarmy_bot` in Telegram.
2. Send `/id`.
3. Copy the numeric Telegram ID returned by the bot.
4. Store it as the Cloudflare Worker secret `TELEGRAM_ADMIN_IDS`.

```powershell
cd "$HOME\Desktop\download-killer-v2\worker"
npx wrangler secret put TELEGRAM_ADMIN_IDS --name sounddrop
```

For multiple administrators, use comma-separated numeric IDs:

```text
123456789,987654321
```

Do not put bot tokens or Cloudflare API tokens in this value.

After the secret is stored, send `/control` to the bot and open the Web App button.

## Shared game identity

DyrakArmy Arena and Latency Strike use the same `game_profiles` row for:

- total XP;
- player rank;
- equipped profile frame;
- equipped icon;
- animated badge;
- waveform;
- color theme;
- profile title.

Arena adds teams, daily challenges, weekly leagues and monthly seasons without creating a second player identity.

## Public API

The website reads:

```text
GET /api/platform/public
```

Administrator actions use:

```text
POST /api/platform/control
```

The administrator endpoint accepts validated Telegram Mini App `initData`. An optional `OPS_ADMIN_TOKEN` bearer token remains available for operational automation, but it must never be embedded in browser code.

## Feature flags

System modules can be hidden but cannot be deleted. Custom modules can be added or removed.

Disabling these modules also disables the related public API:

- `dyrakarmy-arena`
- `latency-strike`
- `downloads`
- `media-lab`

This prevents a hidden feature from remaining usable through a direct API call.
