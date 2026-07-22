# DyrakArmy Agent Operating Contract

## Source of truth

- Canonical repository: `biramentv-ux/download-killer-v2`.
- Production branch: `main`.
- Cloudflare Worker: `sounddrop`.
- Worker config: `worker/wrangler.jsonc`.
- Worker entrypoint: `worker/src/platform_v3.ts`.
- Static assets: `worker/public`.
- Public domains: `dyrakarmy.eu`, `www.dyrakarmy.eu`, `dyrakarmy.online`, `www.dyrakarmy.online`.

## Cloudflare toolchain

Use the MCP servers declared in `.mcp.json`:

1. `cloudflare-docs` for current official documentation.
2. `cloudflare-api` for account configuration, DNS, Workers, D1, KV, Queues and other Cloudflare APIs.
3. `cloudflare-builds` for build inspection and build configuration.
4. `cloudflare-observability` for logs, exceptions and runtime diagnosis.
5. `cloudflare-bindings` for binding-aware Worker development.

Interactive agent sessions must authenticate through Cloudflare OAuth. CI automation may use a narrowly scoped bearer token, never a Global API Key.

## Required operating mode

The default is **Git-first, preview-first, audited production**.

1. Read the live Cloudflare configuration before making changes.
2. Create or use a dedicated Git branch.
3. Modify repository code and configuration in GitHub.
4. Run all relevant tests and `wrangler deploy --dry-run`.
5. Use a preview upload or non-production branch build.
6. Inspect preview logs and endpoints.
7. Promote through `main` only after all gates are green.
8. Verify the public domains, Worker fallback, APIs, Telegram health and Games registry.
9. Record the change in the PR description or Cloudflare audit log.

Direct Cloudflare API edits are reserved for account-side configuration that cannot be represented in Git, such as OAuth grants, Build settings, DNS, routes, secrets and resource bindings.

## Approval boundaries

The agent may perform without additional approval:

- read-only inspection of Cloudflare account state;
- build and deployment log analysis;
- local tests and dry-runs;
- Git branches, commits and pull requests;
- preview deployments;
- non-destructive validation queries;
- documentation updates.

Explicit user approval is required immediately before:

- production DNS or route changes;
- changing Worker production bindings;
- applying remote D1 migrations;
- writing or rotating production secrets;
- purging production cache globally;
- changing WAF, TLS, Zero Trust or access policies;
- promoting a release to official stable;
- deleting Workers, D1 databases, KV namespaces, Queues, R2 buckets or zones.

Never expose secret values in source, logs, PR comments or chat.

## DyrakArmy bindings

- D1 binding: `DB`; database: `sounddrop-db`.
- KV binding: `CACHE`.
- Queue producer/consumer resources: `sounddrop-downloads`, `sounddrop-history-events`.
- Asset binding: `ASSETS`.

Use the binding name for migrations:

```bash
cd worker
npx wrangler d1 migrations list DB --remote --config wrangler.jsonc
npx wrangler d1 migrations apply DB --remote --config wrangler.jsonc
```

Do not apply remote migrations from preview builds.

## Mandatory validation

From `worker/`:

```bash
npm ci
npm run validate:single-bot
npm run typecheck
npm test
node scripts/landing-v16-simulation.mjs
node scripts/software-suite-simulation.mjs
node scripts/full-virtual-simulation.mjs
npx wrangler deploy --dry-run --config wrangler.jsonc
```

For Cloudflare-specific agent changes also run:

```bash
node scripts/validate-cloudflare-agent.mjs
```

## Release safety: DyrakArmySTUDIO v3.2.0-rc2

The current official release gate is **BLOCKED**. The agent may prepare and publish QA/beta artifacts and manifests, but must not label or promote `3.2.0-rc2` as an official stable release until all blocking gates are cleared:

- Windows Setup executed as a Windows process;
- Authenticode production signature;
- final physical ASIO/storage/controller wall-clock qualification;
- production Ed25519 update key replacing the QA development key.

Recording Digital Twin results replace repeated long CI recording tests, not final physical hardware qualification.

## Rollback

Before production mutation, capture the current Worker version, build configuration, routes, DNS records and binding identifiers. Keep Cloudflare rollback resources intact until the new deployment passes all public smoke tests.
