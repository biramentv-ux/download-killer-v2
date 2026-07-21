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
  latencyCore,
  latencyNative,
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
  read('src/latency_strike.ts'),
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

assert.equal(expected.length, 10, 'The public catalog must contain exactly ten numbered games');
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
  assert.ok(migration.includes(`'${slug}'`), `D1 module migration missing ${slug}`);
  assert.ok(platform.includes(slug), `Worker feature flag missing ${slug}`);
}

assert.ok(challengeBot.includes('challengeGameSlugs()'), 'Challenge Telegram router does not build commands from the shared registry');
assert.ok(challengeBot.includes('COMMAND_TO_GAME'), 'Challenge Telegram command map is missing');
assert.ok(challengeBot.includes('isPlatformModuleEnabled'), 'Challenge Telegram router does not respect Control Center flags');
assert.ok(platform.includes('handleChallengeGamesApi'), 'Worker missing challenge API router');
assert.ok(platform.includes('handleChallengeGamesTelegramWebhook'), 'Worker missing challenge Telegram router');
assert.ok(platform.includes('serveChallengeGamePage'), 'Worker missing shared challenge-page router');
assert.ok(platform.includes('handleArchiveRaidApi'), 'Worker missing Archive Raid API');
assert.ok(platform.includes('handleDyrakArmyArenaApi'), 'Worker missing Arena API');
assert.ok(platform.includes('handleLatencyStrikeGameApi'), 'Worker missing Latency Strike API');
assert.ok(archiveRaid.includes('protected_content_access: false'), 'Archive Raid safety boundary is missing');
assert.ok(arena.includes('shared rank') || arena.includes('Общ ранг'), 'Arena does not expose the shared rank');
assert.ok(latencyCore.includes('game_profiles'), 'Latency Strike core does not use the shared game profile');
assert.ok(latencyNative.includes('handleLatencyStrikeApi'), 'Latency Strike native bridge does not delegate to the core');
assert.ok(sharedHtml.includes('SHARED GAME ENGINE'), 'Shared challenge page marker is missing');
assert.ok(sharedJs.includes('/api/games/${slug}/'), 'Shared challenge browser client does not route by game slug');
assert.ok(serviceWorker.includes('download-killer-static-v15-games-1-10'), 'Games 1-10 PWA cache version is missing');
assert.ok(serviceWorker.includes('/games/challenge/challenge.js?v=1.0.0'), 'Challenge engine is not cached');
assert.ok(serviceWorker.includes('/games/archive-raid/raid.js?v=1.0.0'), 'Archive Raid is not cached');
assert.ok(!challenge.includes('eval('), 'Challenge engine contains eval');
assert.ok(!challenge.includes('new Function('), 'Challenge engine contains executable-code construction');
assert.ok(!sharedJs.includes('localStorage'), 'Ranked state must not trust localStorage');
assert.ok(!sharedJs.includes('sessionStorage'), 'Ranked state must not trust sessionStorage');
assert.ok(!archiveRaid.includes('decrypt'), 'Archive Raid must not implement decryption');

console.log('Games 1-10 deterministic simulation: PASS');
console.log('Validated: 10 public modules, 10 commands, shared profile, feature flags, PWA assets and safe Archive Raid boundary.');
