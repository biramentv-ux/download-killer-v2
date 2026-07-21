# DyrakArmy Platform Governance v2

Governance v2 extends the unified DyrakArmy platform without replacing the existing downloader, games, Telegram or public registry layers.

## Included

- D1-backed roles: `owner`, `admin`, `editor`, `moderator`, `user`.
- Telegram Mini App authentication and one-time `/link CODE` device linking.
- Opaque KV sessions for Web, PWA, Android, iOS and desktop clients.
- Shared platform profile connected to the existing `game_profiles` record.
- Role-aware module/content/settings operations through the existing safe Control API.
- Module reordering without deployment.
- Automatic and manual configuration snapshots.
- Owner-only rollback to any stored revision.
- Public change events through reconnecting SSE and JSON polling.
- Mobile-first installable Control Center v2 with an offline application shell.
- Private session and role audit records.

## Security boundaries

- No arbitrary HTML, JavaScript, SQL or executable code can be submitted from the Control Center.
- Existing input sanitizers remain the source of truth for module, content and setting writes.
- Session tokens are random opaque values; D1 stores only SHA-256 hashes and metadata.
- Telegram link codes expire after 10 minutes and are consumed once.
- Only `owner` can roll back versions or manage owner/admin roles.
- Public realtime events contain no session tokens, role history or private profile data.
- Archive Raid and downloader protected-content restrictions remain unchanged.

## Deployment sequence

1. Merge and validate Games 1-10.
2. Review the stacked Governance v2 pull request.
3. Run TypeScript, Vitest, deterministic simulation and Wrangler dry-run.
4. Apply migration `0017_platform_governance_v2.sql` to staging D1.
5. Deploy a staging Worker with production deploy disabled.
6. Test Telegram `/control`, `/link CODE`, role permissions, rollback and PWA offline startup.
7. Merge to `main` only after all staging checks pass.
8. Trigger production deployment manually through the protected production environment.

The dedicated GitHub Actions workflow is validation-only and cannot deploy to Cloudflare.
