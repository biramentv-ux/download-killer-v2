#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const read = (relative) => readFile(path.join(root, relative), 'utf8');
const manifest = JSON.parse(await read('games-10-validation-manifest.json'));

assert.equal(manifest.schema, 'eu.dyrakarmy.games-10-validation.v1');
assert.equal(manifest.games.length, 10, 'Exactly ten games are required');
assert.deepEqual(manifest.games.map((game) => game.number), [1,2,3,4,5,6,7,8,9,10]);
assert.equal(new Set(manifest.games.map((game) => game.slug)).size, 10, 'Game slugs must be unique');
assert.equal(new Set(manifest.games.map((game) => game.command)).size, 10, 'Telegram commands must be unique');

const files = {
  hub: await read('public/platform/games-v14.js'),
  registry: await read('public/platform/platform-public.js'),
  platform: await read('src/platform_v2.ts'),
  challenge: await read('src/challenge_games.ts'),
  challengeBot: await read('src/challenge_games_bot.ts'),
  arena: await read('src/dyrakarmy_arena.ts'),
  archive: await read('src/archive_raid.ts'),
  latency: await read('src/latency_strike.ts'),
  latencyNative: await read('src/latency_strike_native.ts'),
  commands: await read('src/dyrakarmy_arena_commands.ts'),
  setup: await read('scripts/setup-telegram-platform.mjs'),
  serviceWorker: await read('public/sw.js'),
  challengeClient: await read('public/games/challenge/challenge.js'),
  arenaClient: await read('public/games/dyrakarmy-arena/arena.js'),
  archiveClient: await read('public/games/archive-raid/raid.js'),
  latencyClient: await read('public/games/latency-strike/game.js'),
};

const shared = manifest.shared_contract;
for (const [key, enabled] of Object.entries(shared)) assert.equal(enabled, true, `Shared contract ${key} must stay enabled`);

function includes(haystack, needle, message) {
  assert.ok(haystack.includes(needle), message || `Missing ${needle}`);
}

function syntaxCheck(relative) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, relative)], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${relative} syntax failed: ${result.stderr || result.stdout}`);
}

syntaxCheck('public/platform/games-v14.js');
syntaxCheck('public/platform/platform-public.js');
syntaxCheck('public/games/challenge/challenge.js');
syntaxCheck('public/games/dyrakarmy-arena/arena.js');
syntaxCheck('public/games/archive-raid/raid.js');
syntaxCheck('public/games/latency-strike/game.js');
syntaxCheck('public/sw.js');

for (const game of manifest.games) {
  const label = `${String(game.number).padStart(2, '0')} ${game.title}`;
  includes(files.hub, `number: ${game.number}`, `${label}: public number missing`);
  includes(files.hub, `slug: '${game.slug}'`, `${label}: public slug missing`);
  includes(files.hub, game.title, `${label}: public title missing`);
  includes(files.hub, `command: '${game.command}'`, `${label}: public command missing`);
  includes(files.registry, `'${game.slug}'`, `${label}: Control Center feature flag missing`);
  includes(files.commands, `command: '${game.command}'`, `${label}: Telegram command router missing`);
  includes(files.setup, `command: '${game.command}'`, `${label}: Telegram command publisher missing`);

  if (game.engine === 'challenge') {
    includes(files.challenge, `slug: '${game.slug}'`, `${label}: challenge definition missing`);
    includes(files.challenge, `mode: '${game.mode}'`, `${label}: challenge mode missing`);
    includes(files.challenge, `command: '${game.command}'`, `${label}: challenge command mismatch`);
    includes(files.platform, 'handleChallengeGamesApi', `${label}: API router missing`);
    includes(files.platform, 'serveChallengeGamePage', `${label}: page router missing`);
    includes(files.challengeBot, 'isPlatformModuleEnabled', `${label}: Telegram feature flag missing`);
    includes(files.challengeClient, "'/config'", `${label}: config client missing`);
    includes(files.challengeClient, "'/session'", `${label}: session client missing`);
    includes(files.challengeClient, "'/score'", `${label}: score client missing`);
    includes(files.challengeClient, "'/profile'", `${label}: profile client missing`);
    includes(files.challengeClient, "'/leaderboard'", `${label}: leaderboard client missing`);
  } else if (game.engine === 'arena') {
    includes(files.platform, 'handleDyrakArmyArenaApi', `${label}: Arena API missing`);
    for (const endpoint of ['/config', '/session', '/score', '/profile', '/team', '/leaderboard']) {
      includes(files.arenaClient, `'${endpoint}'`, `${label}: client endpoint ${endpoint} missing`);
    }
    for (const feature of ['create', 'join', 'leave']) includes(files.arenaClient, `'${feature}'`, `${label}: team action ${feature} missing`);
  } else if (game.engine === 'archive') {
    includes(files.platform, 'handleArchiveRaidApi', `${label}: Archive API missing`);
    includes(files.archive, 'protected_content_access: false', `${label}: protected-content boundary missing`);
    for (const route of ['scan', 'extract', 'breach']) includes(files.archive, `${route}: {`, `${label}: route ${route} missing`);
    for (const endpoint of ['/config', '/catalog', '/session', '/score', '/profile', '/inventory', '/claim', '/leaderboard']) {
      includes(files.archiveClient, endpoint, `${label}: client endpoint ${endpoint} missing`);
    }
    assert.ok(!files.archive.includes('decrypt('), `${label}: decryption must not be implemented`);
  } else if (game.engine === 'latency') {
    includes(files.platform, 'handleLatencyStrikeGameApi', `${label}: Latency API missing`);
    includes(files.latency, 'const GAME_ROUNDS = 5', `${label}: five-round contract missing`);
    includes(files.latency, 'falseStarts', `${label}: false-start scoring missing`);
    includes(files.latency, 'LATENCY_STRIKE_REWARDS', `${label}: rewards missing`);
    includes(files.latencyNative, 'setGameScore', `${label}: native Telegram score sync missing`);
    for (const state of ['QUEUED', 'PROCESSING', 'READY']) includes(files.latencyClient, state, `${label}: state ${state} missing`);
  } else {
    assert.fail(`${label}: unsupported engine ${game.engine}`);
  }

  assert.ok(Array.isArray(game.functions) && game.functions.length >= 6, `${label}: function checklist is incomplete`);
  console.log(`PASS ${label} — ${game.functions.length} declared functions, route, API, Telegram, profile and safety contracts validated.`);
}

includes(files.platform, 'isPlatformModuleEnabled(env, slug)', 'Dynamic per-game feature flags are missing');
includes(files.challenge, 'game_profiles', 'Shared game profile is missing');
includes(files.challenge, 'total_xp', 'Shared XP update is missing');
includes(files.challenge, 'SESSION_EXPIRED', 'Consume-once session rejection is missing');
includes(files.serviceWorker, 'CHALLENGE_GAME_SLUGS', 'Shared challenge PWA routes are missing');
includes(files.serviceWorker, '/games/dyrakarmy-arena/', 'Arena PWA route is missing');
includes(files.serviceWorker, '/games/archive-raid/', 'Archive Raid PWA route is missing');
includes(files.serviceWorker, '/games/latency-strike/', 'Latency Strike PWA route is missing');

for (const source of [files.challenge, files.archive, files.arena, files.latency]) {
  assert.ok(!source.includes('eval('), 'Game server code must not use eval');
  assert.ok(!source.includes('new Function('), 'Game server code must not construct executable code');
}
for (const client of [files.challengeClient, files.arenaClient, files.archiveClient, files.latencyClient]) {
  assert.ok(!client.includes('javascript:'), 'Game client must not emit javascript: URLs');
  assert.ok(!client.includes('data:text/html'), 'Game client must not emit executable data URLs');
}

console.log('DyrakArmy Games 1–10 deep sequential validation: PASS');
