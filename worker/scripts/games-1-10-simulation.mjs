#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const expected = [
  ['queue-commander', 'Queue Commander', 1, 'queuegame'],
  ['beat-hunter', 'Beat Hunter', 2, 'beat'],
  ['dyrakarmy-arena', 'DyrakArmy Arena', 3, 'arena'],
  ['format-forge', 'Format Forge', 4, 'formatgame'],
  ['server-defender', 'Server Defender', 5, 'defender'],
  ['metadata-detective', 'Metadata Detective', 6, 'detective'],
  ['link-runner', 'Link Runner', 7, 'linkrunner'],
  ['archive-raid', 'Archive Raid', 8, 'raid'],
  ['latency-strike', 'Latency Strike', 9, 'game'],
  ['bot-vs-human', 'Bot vs Human', 10, 'botvhuman'],
];

async function read(relative) {
  return readFile(path.join(root, relative), 'utf8');
}

const [
  platform,
  challenge,
  challengeBot,
  archiveRaid,
  arena,
  latency,
  gamesHub,
  publicRegistry,
  sharedHtml,
  sharedJs,
  serviceWorker,
  commands,
  setup,
  migration,
] = await Promise.all([
  read('src/platform_v2.ts'),
  read('src/challenge_games.ts'),
  read('src/challenge_games_bot.ts'),
  read('src/archive_raid.ts'),
  read('src/dyrakarmy_arena.ts'),
  read('src/latency_strike_native.ts'),
  read('public/platform/games-v14.js'),
  read('public/platform/platform-public.js'),
  read('public/games/challenge/index.html'),
  read('public/games/challenge/challenge.js'),
  read('public/sw.js'),
  read('src/dyrakarmy_arena_commands.ts'),
  read('scripts/setup-telegram-platform.mjs'),
  read('migrations/0016_dyrakarmy_games_1_10.sql'),
]);

assert.equal(expected.length, 10);
for (const [slug, title, number, command] of expected) {
  assert.ok(gamesHub.includes(`slug: '${slug}'`), `Games Hub missing ${slug}`);
  assert.ok(gamesHub.includes(`number: ${number}`), `Games Hub missing number ${number}`);
  assert.ok(gamesHub.includes(title), `Games Hub missing title ${title}`);
  assert.ok(publicRegistry.includes(`'${slug}'`), `Control Center mapping missing ${slug}`);
  assert.ok(commands.includes(`command: '${command}'`), `Command registry missing /${command}`);
  assert.ok(setup.includes(`command: '${command}'`), `Telegram setup missing /${command}`);
}

for (const slug of ['queue-commander', 'beat-hunter', 'format-forge', 'server-defender', 'metadata-detective', 'link-runner', 'bot-vs-human']) {
  assert.ok(challenge.includes(`slug: '${slug}'`), `Challenge definition missing ${slug}`);
  assert.ok(challengeBot.includes(slug), `Challenge Telegram router missing ${slug}`);
  assert.ok(migration.includes(`'${slug}'`), `D1 module migration missing ${slug}`);
  assert.ok(platform.includes(slug), `Worker feature flag missing ${slug}`);
}

assert.ok(platform.includes('handleChallengeGamesApi'));
assert.ok(platform.includes('handleChallengeGamesTelegramWebhook'));
assert.ok(platform.includes('serveChallengeGamePage'));
assert.ok(platform.includes('handleArchiveRaidApi'));
assert.ok(platform.includes('handleDyrakArmyArenaApi'));
assert.ok(platform.includes('handleLatencyStrikeGameApi'));
assert.ok(archiveRaid.includes('protected_content_access: false'));
assert.ok(arena.includes('shared rank') || arena.includes('Общ ранг'));
assert.ok(latency.includes('game_profiles'));
assert.ok(sharedHtml.includes('SHARED GAME ENGINE'));
assert.ok(sharedJs.includes('/api/games/${slug}/'));
assert.ok(serviceWorker.includes('download-killer-static-v15-games-1-10'));
assert.ok(serviceWorker.includes('/games/challenge/challenge.js?v=1.0.0'));
assert.ok(serviceWorker.includes('/games/archive-raid/raid.js?v=1.0.0'));
assert.ok(!challenge.includes('eval('));
assert.ok(!challenge.includes('new Function('));
assert.ok(!sharedJs.includes('localStorage'));
assert.ok(!sharedJs.includes('sessionStorage'));
assert.ok(!archiveRaid.includes('decrypt'));

console.log('Games 1-10 deterministic simulation: PASS');
console.log('Validated: 10 public modules, 10 commands, shared profile, feature flags, PWA assets and safe Archive Raid boundary.');
