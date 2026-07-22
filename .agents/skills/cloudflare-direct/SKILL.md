# Cloudflare Direct Operations Skill

Use this skill when the user asks to inspect, repair, configure, preview, deploy or edit the DyrakArmy Cloudflare environment.

## MCP connections

Connect through `.mcp.json`. Prefer:

- `cloudflare-api` for account mutations;
- `cloudflare-builds` for Workers Builds;
- `cloudflare-observability` for live diagnostics;
- `cloudflare-docs` for current product behavior;
- `cloudflare-bindings` for D1/KV/Queues/R2/AI bindings.

OAuth is preferred for interactive sessions. Request only the minimum permissions needed for the current operation.

## Project map

- Repository: `biramentv-ux/download-killer-v2`
- Worker: `sounddrop`
- Config: `worker/wrangler.jsonc`
- Entrypoint: `worker/src/platform_v3.ts`
- Assets: `worker/public`
- D1: binding `DB`, database `sounddrop-db`
- KV: binding `CACHE`
- Queues: `sounddrop-downloads`, `sounddrop-history-events`
- Public hosts: `dyrakarmy.eu`, `www.dyrakarmy.eu`, `dyrakarmy.online`, `www.dyrakarmy.online`, `sounddrop.biramentv.workers.dev`

## Execution sequence

### Read and diagnose

1. Inspect Worker metadata, latest deployments and Builds configuration.
2. Inspect routes, custom domains, D1/KV/Queue bindings and non-secret variable names.
3. Read recent build failures and runtime exceptions.
4. Compare live deployment state with `main` and `worker/wrangler.jsonc`.

### Change repository code

1. Create a branch.
2. Edit repository files.
3. Run the validation commands in `AGENTS.md`.
4. Open a PR and wait for all gates.
5. Use the Cloudflare PR preview when available.
6. Merge only after preview verification.

### Change Cloudflare account configuration

1. Search the Cloudflare API MCP schema for the exact endpoint.
2. Read current state and retain a rollback snapshot.
3. Present the exact intended mutation before high-impact production changes.
4. Execute the smallest possible patch.
5. Read back the resource and verify the result.
6. Check observability and public endpoints.

## Production rules

- Code changes deploy through the Git-connected `main` branch.
- Preview builds must not apply remote D1 migrations.
- Production migrations use binding `DB` and run only after schema review.
- Never delete or recreate stateful resources to fix a binding mismatch.
- Never print Cloudflare tokens, Telegram secrets, signing keys or secret values.
- Never use the Global API Key.
- Do not change nameservers, zone ownership or billing.
- Do not disable WAF, TLS enforcement, access controls or security rules as a shortcut.

## Required public smoke tests

Verify both `https://dyrakarmy.eu` and `https://sounddrop.biramentv.workers.dev`:

- homepage contains the expected current interface version;
- software CSS/JS assets return 200;
- `/api/software/releases` returns `ok=true`;
- `/api/platform/public` returns all ten game slugs;
- `/api/platform/governance/health` returns `ok=true`;
- `/api/telegram/v12/health` identifies `dyrakarmy_bot`;
- no legacy secondary Telegram bot marker is present.

## Release gate

`DyrakArmySTUDIO v3.2.0-rc2` is QA/beta only while the official release gate is BLOCKED. Direct Cloudflare work may stage the update endpoint and QA assets, but cannot promote them as stable until Windows execution, Authenticode, physical ASIO/storage/controller qualification and production Ed25519 key rotation are complete.
