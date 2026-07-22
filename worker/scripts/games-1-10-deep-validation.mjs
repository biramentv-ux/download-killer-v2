#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const read = (relative) => readFile(path.join(root, relative), 'utf8');
const manifest = JSON.parse(await read('games-10-validation-manifest.json'));
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

assert.equal(manifest.games.length, 10);
assert.deepEqual(manifest.games.map((game) => game.number), [1,2,3,4,5,6,7,8,9,10]);
assert.equal(new Set(manifest.games.map((game) => game.slug)).size, 10);
assert.equal(new Set(manifest.games.map((game) => game.command)).size, 10);
for (const enabled of Object.values(manifest.shared_contract)) assert.equal(enabled, true);

const includes = (source, token, message) => assert.ok(source.includes(token), message);
const checkSyntax = (relative) => {
  const result = spawnSync(process.execPath, ['--check', path.join(root, relative)], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${relative}: ${result.stderr || result.stdout}`);
};

[
  'public/platform/games-v14.js',
  'public/platform/platform-public.js',
  'public/games/challenge/challenge.js',
  'public/games/dyrakarmy-arena/arena.js',
  'public/games/archive-raid/raid.js',
  'public/games/latency-strike/game.js',
  'public/sw.js',
].forEach(checkSyntax);

for (const game of manifest.games) {
  const label = `${String(game.number).padStart(2, '0')} ${game.title}`;
  includes(files.hub, `number: ${game.number}`, `${label}: number`);
  includes(files.hub, `slug: '${game.slug}'`, `${label}: slug`);
  includes(files.hub, game.title, `${label}: title`);
  includes(files.hub, `command: '${game.command}'`, `${label}: command`);
  includes(files.registry, `'${game.slug}'`, `${label}: feature flag`);
  includes(files.commands, `command: '${game.command}'`, `${label}: Telegram router`);
  includes(files.setup, `command: '${game.command}'`, `${label}: Telegram setup`);

  if (game.engine === 'challenge') {
    includes(files.challenge, `slug: '${game.slug}'`, `${label}: definition`);
    includes(files.challenge, `mode: '${game.mode}'`, `${label}: mode`);
    includes(files.challenge, `command: '${game.command}'`, `${label}: engine command`);
    includes(files.platform, 'handleChallengeGamesApi', `${label}: API router`);
    includes(files.platform, 'serveChallengeGamePage', `${label}: page router`);
    includes(files.challengeBot, 'isPlatformModuleEnabled', `${label}: Telegram flag`);
    for (const endpoint of ['/config', '/session', '/score', '/profile', '/leaderboard']) {
      includes(files.challengeClient, `'${endpoint}'`, `${label}: ${endpoint}`);
    }
  }

  if (game.engine === 'arena') {
    includes(files.platform, 'handleDyrakArmyArenaApi', `${label}: API`);
    for (const endpoint of ['/config', '/session', '/score', '/profile', '/team', '/leaderboard']) {
      includes(files.arenaClient, `'${endpoint}'`, `${label}: ${endpoint}`);
    }
    for (const action of ['create', 'join', 'leave']) includes(files.arenaClient, `'${action}'`, `${label}: ${action}`);
    for (const token of ['ARENA_ROUNDS = 8', 'DAILY_ATTEMPTS = 3', 'arenaSeasonKey', 'team_points']) {
      includes(files.arena, token, `${label}: ${token}`);
    }
  }

  if (game.engine === 'archive') {
    includes(files.platform, 'handleArchiveRaidApi', `${label}: API`);
    includes(files.archive, 'protected_content_access: false', `${label}: content boundary`);
    for (const route of ['scan', 'extract', 'breach']) includes(files.archive, `${route}: {`, `${label}: ${route}`);
    for (const endpoint of ['config', 'catalog', 'leaderboard', 'session', 'resolve', 'profile', 'daily-crate', 'equip']) {
      includes(files.archive, `/api/games/archive-raid/${endpoint}`, `${label}: server ${endpoint}`);
    }
    for (const call of ["api('catalog')", "api('profile'", "api('session'", "api('resolve'", "api('daily-crate'", "api('equip'", "api('leaderboard?"]) {
      includes(files.archiveClient, call, `${label}: client ${call}`);
    }
    includes(files.archive, 'archive_raid_inventory', `${label}: inventory`);
    includes(files.archive, 'archive_raid_daily_claims', `${label}: daily claims`);
  }

  if (game.engine === 'latency') {
    includes(files.platform, 'handleLatencyStrikeGameApi', `${label}: API`);
    includes(files.latency, 'const GAME_ROUNDS = 5', `${label}: rounds`);
    includes(files.latency, 'falseStarts', `${label}: false starts`);
    includes(files.latency, 'LATENCY_STRIKE_REWARDS', `${label}: rewards`);
    includes(files.latencyNative, 'setGameScore', `${label}: Telegram score`);
    for (const phase of ['QUEUED', 'PROCESSING', 'READY']) includes(files.latencyClient, phase, `${label}: ${phase}`);
  }

  assert.ok(Array.isArray(game.functions) && game.functions.length >= 6, `${label}: functions`);
  console.log(`PASS ${label} — ${game.functions.length} functions validated.`);
}

includes(files.platform, 'isPlatformModuleEnabled(env, slug)', 'feature flags');
includes(files.challenge, 'game_profiles', 'shared profile');
includes(files.challenge, 'total_xp', 'shared XP');
includes(files.challenge, 'SESSION_EXPIRED', 'single-use sessions');
includes(files.serviceWorker, 'CHALLENGE_GAME_SLUGS', 'challenge PWA');
includes(files.serviceWorker, '/games/dyrakarmy-arena/', 'Arena PWA');
includes(files.serviceWorker, '/games/archive-raid/', 'Archive PWA');
includes(files.serviceWorker, '/games/latency-strike/', 'Latency PWA');

console.log('DyrakArmy Games 1-10 deep sequential validation: PASS');
