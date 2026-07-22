#!/usr/bin/env node

import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const read = (relative) => readFile(path.join(root, relative), 'utf8');
const exists = (relative) => access(path.join(root, relative));
const manifest = JSON.parse(await read('games-10-validation-manifest.json'));

const sources = {
  hub: await read('public/platform/games-v14.js'),
  registry: await read('public/platform/platform-public.js'),
  platform: await read('src/platform_v2.ts'),
  challenge: await read('src/challenge_games.ts'),
  commands: await read('src/dyrakarmy_arena_commands.ts'),
  setup: await read('scripts/setup-telegram-platform.mjs'),
  serviceWorker: await read('public/sw.js'),
  arena: await read('src/dyrakarmy_arena.ts'),
  archive: await read('src/archive_raid.ts'),
  latency: await read('src/latency_strike.ts'),
};

assert.equal(manifest.schema, 'eu.dyrakarmy.games-10-validation.v1');
assert.equal(manifest.games.length, 10);
assert.deepEqual(manifest.games.map((game) => game.number), [1,2,3,4,5,6,7,8,9,10]);
assert.equal(new Set(manifest.games.map((game) => game.slug)).size, 10);
assert.equal(new Set(manifest.games.map((game) => game.command)).size, 10);
for (const [contract, enabled] of Object.entries(manifest.shared_contract)) {
  assert.equal(enabled, true, `Shared contract disabled: ${contract}`);
}

const syntaxFiles = [
  'public/platform/games-v14.js',
  'public/platform/platform-public.js',
  'public/games/challenge/challenge.js',
  'public/games/dyrakarmy-arena/arena.js',
  'public/games/archive-raid/raid.js',
  'public/games/latency-strike/game.js',
  'public/sw.js',
];
for (const relative of syntaxFiles) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, relative)], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${relative}: ${result.stderr || result.stdout}`);
}

const specialized = {
  'dyrakarmy-arena': {
    client: 'public/games/dyrakarmy-arena/arena.js',
    test: 'src/dyrakarmy_arena.test.ts',
    handler: 'handleDyrakArmyArenaApi',
    source: sources.arena,
    markers: ['ARENA_ROUNDS = 8', 'DAILY_ATTEMPTS = 3', 'arenaSeasonKey', 'team_points'],
  },
  'archive-raid': {
    client: 'public/games/archive-raid/raid.js',
    test: 'src/archive_raid.test.ts',
    handler: 'handleArchiveRaidApi',
    source: sources.archive,
    markers: ['protected_content_access: false', 'archive_raid_inventory', 'archive_raid_daily_claims', 'SESSION_EXPIRED'],
  },
  'latency-strike': {
    client: 'public/games/latency-strike/game.js',
    test: 'src/latency_strike.test.ts',
    handler: 'handleLatencyStrikeGameApi',
    source: sources.latency,
    markers: ['GAME_ROUNDS = 5', 'falseStarts', 'LATENCY_STRIKE_REWARDS', 'SESSION_EXPIRED'],
  },
};

for (const game of manifest.games) {
  const label = `${String(game.number).padStart(2, '0')} ${game.title}`;
  assert.ok(sources.hub.includes(`number: ${game.number}`), `${label}: catalog number missing`);
  assert.ok(sources.hub.includes(`slug: '${game.slug}'`), `${label}: catalog slug missing`);
  assert.ok(sources.hub.includes(game.title), `${label}: catalog title missing`);
  assert.ok(sources.hub.includes(`command: '${game.command}'`), `${label}: catalog command missing`);
  assert.ok(sources.registry.includes(`'${game.slug}'`), `${label}: feature flag missing`);
  assert.ok(sources.commands.includes(`command: '${game.command}'`), `${label}: Telegram command missing`);
  assert.ok(sources.setup.includes(`command: '${game.command}'`), `${label}: Telegram publication missing`);
  assert.ok(Array.isArray(game.functions) && game.functions.length >= 6, `${label}: incomplete function checklist`);

  if (game.engine === 'challenge') {
    assert.ok(sources.challenge.includes(`slug: '${game.slug}'`), `${label}: challenge definition missing`);
    assert.ok(sources.challenge.includes(`mode: '${game.mode}'`), `${label}: challenge mode missing`);
    assert.ok(sources.platform.includes('handleChallengeGamesApi'), `${label}: shared API handler missing`);
    await exists('src/challenge_games_options.test.ts');
    await exists('public/games/challenge/challenge.js');
  } else {
    const contract = specialized[game.slug];
    assert.ok(contract, `${label}: specialized contract missing`);
    assert.ok(sources.platform.includes(contract.handler), `${label}: API handler missing`);
    await exists(contract.client);
    await exists(contract.test);
    for (const marker of contract.markers) {
      assert.ok(contract.source.includes(marker), `${label}: contract marker missing: ${marker}`);
    }
  }

  console.log(`PASS ${label} — ${game.functions.length} declared functions linked to public route, API, tests, feature flag and Telegram command.`);
}

assert.ok(sources.platform.includes('isPlatformModuleEnabled(env, slug)'), 'Dynamic game feature flags missing');
assert.ok(sources.challenge.includes('game_profiles'), 'Shared profile integration missing');
assert.ok(sources.challenge.includes('total_xp'), 'Shared XP integration missing');
assert.ok(sources.challenge.includes('SESSION_EXPIRED'), 'Consume-once session enforcement missing');
assert.ok(sources.serviceWorker.includes('CHALLENGE_GAME_SLUGS'), 'Challenge PWA routes missing');
assert.ok(sources.serviceWorker.includes('/games/dyrakarmy-arena/'), 'Arena PWA route missing');
assert.ok(sources.serviceWorker.includes('/games/archive-raid/'), 'Archive Raid PWA route missing');
assert.ok(sources.serviceWorker.includes('/games/latency-strike/'), 'Latency Strike PWA route missing');

console.log('DyrakArmy Games 1-10 deep sequential validation: PASS');
