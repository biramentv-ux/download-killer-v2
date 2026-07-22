# DyrakArmy — Hugging Face Free Public Deployment

## Target

Deploy the complete DyrakArmy interface and Games 1–10 to the native public Space URL:

```text
https://dyrakarmy-dyrakarmy-platform.hf.space
```

This profile uses:

- public Docker Space `DyrakArmy/dyrakarmy-platform`;
- Docker port `7860`;
- free CPU Basic hardware;
- GitHub Actions Trusted Publisher/OIDC;
- no personal domain;
- no redirect Space;
- no PRO subscription;
- no Cloudflare proxy or application-state authority.

## Runtime variables

The bundle contains safe defaults, so account-side variables are optional:

```text
HF_BACKEND_MODE=free-public
PUBLIC_BASE_URL=https://dyrakarmy-dyrakarmy-platform.hf.space
DYRAKARMY_PERSIST_ROOT=/tmp/dyrakarmy-free-public
HF_STATE_IMPORT_REQUIRED=0
HF_IMPORT_ON_START=0
HF_TELEGRAM_WEBHOOK_AUTOCONFIGURE=0
```

Any obsolete non-standalone backend mode is normalized to `free-public` during startup.

## Deployment path

1. Changes are committed to GitHub.
2. Pull-request gates validate type safety, tests, Docker build, every game route and every game config.
3. After merge to `main`, `.github/workflows/hf-publish-ledger.yml` obtains a short-lived repository-scoped token through Hugging Face Trusted Publisher OIDC.
4. The deterministic Docker bundle is uploaded to `DyrakArmy/dyrakarmy-platform`.
5. The workflow waits for the Space to wake/build and validates the public runtime plus Games 1–10.

## Game validation order

1. Queue Commander
2. Beat Hunter
3. DyrakArmy Arena
4. Format Forge
5. Server Defender
6. Metadata Detective
7. Link Runner
8. Archive Raid
9. Latency Strike
10. Bot vs Human

The deep gate checks each game independently for:

- catalog number, slug, title and Telegram command;
- public route and API config;
- Control Center feature flag;
- Telegram router and setup registration;
- practice/ranked contracts;
- shared profile, XP and leaderboard integration;
- one-time server session and server-side score logic;
- PWA route and client syntax;
- authored mechanics, options and safety boundaries.

For the seven shared challenge games, every selectable option in every authored question is submitted to the deterministic scoring engine during tests.

## Required live health contract

```text
GET /api/hf-runtime/health
```

The free profile must return:

```json
{
  "ok": true,
  "mode": "free-public",
  "state_authority": "hugging-face-ephemeral",
  "storage": "ephemeral-disk",
  "cloudflare_dependency": false,
  "cloudflare_proxy_enabled": false
}
```

## Honest free-tier boundary

The public host and CPU runtime are free, but the local filesystem is not a durable production database. A free Space can sleep when idle, and its local state can reset after restart, rebuild or host replacement.

Therefore:

- the complete interface and all practice game modes can be public for free;
- temporary local sessions, scores and leaderboards work while the runtime state survives;
- durable cross-restart XP, ranks, teams, inventories and leaderboards require a separate persistent datastore in a later zero-cost database integration;
- Telegram webhook ownership remains disabled in the default free profile because a sleeping host is not guaranteed to receive updates continuously.

These limitations are surfaced by the health endpoint and are not hidden by the deployment pipeline.
