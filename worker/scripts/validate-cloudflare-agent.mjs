import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');

const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const readText = (path) => readFileSync(resolve(root, path), 'utf8');

for (const path of [
  '.mcp.json',
  'AGENTS.md',
  '.agents/skills/cloudflare-direct/SKILL.md',
  'cloudflare/agent-policy.json',
  'cloudflare/releases/DyrakArmySTUDIO_v3.2.0-rc2.json',
  'worker/wrangler.jsonc'
]) {
  assert.equal(existsSync(resolve(root, path)), true, `Missing ${path}`);
}

const mcp = readJson('.mcp.json');
const expectedServers = {
  'cloudflare-api': 'https://mcp.cloudflare.com/mcp',
  'cloudflare-builds': 'https://builds.mcp.cloudflare.com/mcp',
  'cloudflare-observability': 'https://observability.mcp.cloudflare.com/mcp',
  'cloudflare-docs': 'https://docs.mcp.cloudflare.com/mcp',
  'cloudflare-bindings': 'https://bindings.mcp.cloudflare.com/mcp'
};
for (const [name, url] of Object.entries(expectedServers)) {
  assert.equal(mcp.mcpServers?.[name]?.url, url, `Invalid MCP server ${name}`);
}

const policy = readJson('cloudflare/agent-policy.json');
assert.equal(policy.mode, 'git-first-preview-first-audited-production');
assert.equal(policy.worker.name, 'sounddrop');
assert.equal(policy.resources.d1.binding, 'DB');
assert.equal(policy.resources.d1.database_name, 'sounddrop-db');
assert.equal(policy.resources.kv.binding, 'CACHE');
assert.equal(policy.release_gate.status, 'BLOCKED');
assert.equal(policy.release_gate.blocked_channel, 'stable');
assert.ok(policy.approval_required.includes('remote_d1_migration'));
assert.ok(policy.approval_required.includes('production_secret_write_or_rotation'));
assert.ok(policy.forbidden.includes('expose_secret_values'));
assert.ok(policy.forbidden.includes('apply_remote_migrations_in_preview'));

const release = readJson('cloudflare/releases/DyrakArmySTUDIO_v3.2.0-rc2.json');
assert.equal(release.official_release_status, 'BLOCKED');
assert.equal(release.channel, 'beta');
assert.equal(release.artifacts.length, 5);
assert.match(release.agent_rule, /Must not publish or label.*official stable/i);

const wrangler = readText('worker/wrangler.jsonc');
for (const marker of [
  '"name": "sounddrop"',
  '"main": "src/platform_v3.ts"',
  '"binding": "DB"',
  '"database_name": "sounddrop-db"',
  '"binding": "CACHE"',
  '"queue": "sounddrop-downloads"',
  '"queue": "sounddrop-history-events"'
]) {
  assert.match(wrangler, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

const agents = readText('AGENTS.md');
assert.match(agents, /Cloudflare toolchain/);
assert.match(agents, /Explicit user approval is required/);
assert.match(agents, /official release gate is \*\*BLOCKED\*\*/);
assert.doesNotMatch(agents, /Bearer\s+[A-Za-z0-9._-]{20,}/);

console.log('Cloudflare agent integration validation: PASS');
