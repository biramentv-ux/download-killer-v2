# DyrakArmy Cloudflare Agent Integration

This repository is prepared for direct, controlled Cloudflare work through Cloudflare's managed remote MCP servers.

## What becomes possible

After OAuth authorization, a compatible agent can:

- inspect the `sounddrop` Worker and its live deployments;
- inspect and update Workers Builds configuration;
- read runtime logs and exceptions;
- inspect and edit DNS, routes, bindings and account-side configuration;
- inspect D1, KV and Queue resources;
- create previews and verify public endpoints;
- apply approved Cloudflare API changes and read them back for confirmation.

Repository code remains Git-first. Source code and `wrangler.jsonc` changes must be committed and reviewed instead of being patched only in the live Worker.

## MCP configuration

The repository includes `.mcp.json` with:

```json
{
  "mcpServers": {
    "cloudflare-api": { "url": "https://mcp.cloudflare.com/mcp" },
    "cloudflare-builds": { "url": "https://builds.mcp.cloudflare.com/mcp" },
    "cloudflare-observability": { "url": "https://observability.mcp.cloudflare.com/mcp" },
    "cloudflare-docs": { "url": "https://docs.mcp.cloudflare.com/mcp" },
    "cloudflare-bindings": { "url": "https://bindings.mcp.cloudflare.com/mcp" }
  }
}
```

When the client opens these servers for the first time, Cloudflare redirects to OAuth. Select the DyrakArmy Cloudflare account and grant only the permissions needed for the requested operation.

## Recommended permission model

For normal development:

- Workers Scripts: Read/Write;
- Workers Builds: Read/Write;
- Workers Tail/Observability: Read;
- D1: Read, with Edit granted only for an approved migration;
- KV: Read, with Edit granted only when needed;
- Queues: Read, with Edit granted only when needed;
- Zone and DNS: Read.

Grant DNS Write, route changes, secret writes and destructive permissions only for the specific approved operation. Do not use the Global API Key.

## Agent workflow

1. Agent reads `AGENTS.md`, `.agents/skills/cloudflare-direct/SKILL.md` and `cloudflare/agent-policy.json`.
2. Agent connects to Cloudflare through OAuth.
3. Agent inspects the current live state before proposing a mutation.
4. Code changes go to a Git branch and PR.
5. `Cloudflare Agent Integration Gate` validates the complete Worker and policy.
6. A Cloudflare preview is inspected.
7. Production deployment occurs through the Git-connected `main` branch.
8. Account-side mutations are applied through `cloudflare-api` only when Git cannot represent them.
9. Public smoke tests and observability checks confirm the result.

## Direct live changes versus Git changes

Use GitHub for:

- Worker TypeScript;
- public HTML/CSS/JavaScript;
- `wrangler.jsonc` bindings and variables;
- migrations;
- tests and simulations;
- deployment workflows.

Use Cloudflare MCP for:

- Git repository/build connection settings;
- production branch and root directory settings;
- deploy hooks;
- OAuth and secret values;
- DNS and custom domains;
- reading live resource identifiers;
- build logs and runtime observability;
- approved emergency rollback.

## DyrakArmySTUDIO v3.2.0-rc2 restriction

The current release candidate may be staged only in QA or beta. The release gate remains BLOCKED until Windows process execution, Authenticode, final physical ASIO/storage/controller qualification and production Ed25519 key rotation are complete. The agent policy enforces this restriction.

## Current limitation of this ChatGPT session

The repository integration is complete, but this ChatGPT workspace does not currently expose the Cloudflare MCP connector as an installed app. The first direct account action requires connecting `https://mcp.cloudflare.com/mcp` in an MCP-compatible client and completing Cloudflare OAuth. After authorization, the repository skill and policy provide the operating rules for direct work.
