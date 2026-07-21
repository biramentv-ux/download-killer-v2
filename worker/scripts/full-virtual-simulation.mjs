#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import vm from 'node:vm';

const workerRoot = process.cwd();
const repoRoot = path.resolve(workerRoot, '..');
const reportPath = path.join(workerRoot, 'full-virtual-simulation-report.json');
const results = [];
const GAME_SLUGS = [
  'queue-commander', 'beat-hunter', 'dyrakarmy-arena', 'format-forge',
  'server-defender', 'metadata-detective', 'link-runner', 'archive-raid',
  'latency-strike', 'bot-vs-human',
];

async function read(relative) {
  return readFile(path.join(repoRoot, relative), 'utf8');
}

async function runScenario(area, name, execute) {
  try {
    await execute();
    results.push({ area, scenario: name, passed: true, detail: '' });
    console.log(`[PASS] ${area} :: ${name}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ area, scenario: name, passed: false, detail });
    console.error(`[FAIL] ${area} :: ${name} — ${detail}`);
  }
}

async function validateUnifiedContracts() {
  const [
    html, landingCss, landingJs, gamesCss, gamesJs, publicJs,
    challengeHtml, challengeJs, controlHtml, controlJs,
    arenaHtml, arenaJs, raidHtml, raidJs, latencyJs,
    sw, manifestText, platformV2, controlTs, challengeTs, raidTs,
    arenaMigration, controlMigration, raidMigration, challengeMigration,
  ] = await Promise.all([
    read('worker/public/index.html'),
    read('worker/public/platform/landing-v13.css'),
    read('worker/public/platform/landing-v13.js'),
    read('worker/public/platform/games-v14.css'),
    read('worker/public/platform/games-v14.js'),
    read('worker/public/platform/platform-public.js'),
    read('worker/public/games/challenge/index.html'),
    read('worker/public/games/challenge/challenge.js'),
    read('worker/public/control/index.html'),
    read('worker/public/control/control.js'),
    read('worker/public/games/dyrakarmy-arena/index.html'),
    read('worker/public/games/dyrakarmy-arena/arena.js'),
    read('worker/public/games/archive-raid/index.html'),
    read('worker/public/games/archive-raid/raid.js'),
    read('worker/public/games/latency-strike/game.js'),
    read('worker/public/sw.js'),
    read('worker/public/manifest.webmanifest'),
    read('worker/src/platform_v2.ts'),
    read('worker/src/platform_control.ts'),
    read('worker/src/challenge_games.ts'),
    read('worker/src/archive_raid.ts'),
    read('worker/migrations/0013_dyrakarmy_arena_v1.sql'),
    read('worker/migrations/0014_platform_control_center_v1.sql'),
    read('worker/migrations/0015_archive_raid_v1.sql'),
    read('worker/migrations/0016_dyrakarmy_games_1_10.sql'),
  ]);

  for (const id of ['mobileNavToggle', 'mainNav', 'downloadForm', 'mediaUrl', 'sourceSelect', 'formatSelect', 'qualitySelect', 'launchBtn', 'jobFeed', 'historyList']) {
    assert.ok(html.includes(`id="${id}"`), `missing public element #${id}`);
  }
  assert.ok(html.includes('Responsive Design v13'), 'responsive landing marker missing');
  assert.ok(html.includes('tg://resolve?domain=dyrakarmy_bot'), 'native Telegram link missing');
  assert.ok(!html.includes('download_killerBOT'), 'retired bot leaked into public page');
  assert.ok(!html.includes('web.telegram.org'), 'browser Telegram link is forbidden');
  assert.ok(landingCss.includes('@media (max-width: 600px)'), 'mobile landing breakpoint missing');
  assert.ok(landingCss.includes('@media (prefers-reduced-motion: reduce)'), 'reduced-motion support missing');
  assert.ok(landingJs.includes("event.key === 'Escape'"), 'mobile navigation Escape handling missing');

  assert.ok(gamesCss.includes('.game-library-grid'), 'Games 1-10 grid style missing');
  assert.ok(gamesJs.includes('Една система. Десет игри.'), 'Games 1-10 heading missing');
  for (const slug of GAME_SLUGS) {
    assert.ok(gamesJs.includes(`slug: '${slug}'`), `Games Hub missing ${slug}`);
    assert.ok(publicJs.includes(`'${slug}'`), `public registry mapping missing ${slug}`);
  }

  assert.ok(challengeHtml.includes('SHARED GAME ENGINE'), 'shared challenge page missing');
  assert.ok(challengeJs.includes('/api/games/${slug}/'), 'challenge client is not slug-routed');
  assert.ok(challengeTs.includes('challenge_game_runs'), 'shared challenge ranked storage missing');
  assert.ok(platformV2.includes('CHALLENGE_SLUGS.map'), 'dynamic challenge routing missing');
  assert.ok(platformV2.includes('handleChallengeGamesApi'), 'challenge API is not wired');
  assert.ok(platformV2.includes('handleChallengeGamesTelegramWebhook'), 'challenge Telegram router is not wired');

  for (const marker of ['DyrakArmy Control Center', 'TELEGRAM_ADMIN_IDS', '/api/platform/control']) {
    assert.ok(`${controlHtml}\n${controlJs}\n${controlTs}`.includes(marker), `missing control marker ${marker}`);
  }
  for (const marker of ['DyrakArmy Arena', '/api/games/dyrakarmy-arena']) {
    assert.ok(`${arenaHtml}\n${arenaJs}\n${platformV2}`.includes(marker), `missing Arena marker ${marker}`);
  }
  for (const marker of ['Archive Raid', '/api/games/archive-raid', 'Army Exclusive']) {
    assert.ok(`${raidHtml}\n${raidJs}\n${raidTs}`.includes(marker), `missing Archive Raid marker ${marker}`);
  }
  assert.ok(latencyJs.includes('/api/games/latency-strike'), 'Latency Strike API link missing');

  assert.ok(arenaMigration.includes('CREATE TABLE IF NOT EXISTS arena_teams'), 'Arena migration missing');
  assert.ok(controlMigration.includes('CREATE TABLE IF NOT EXISTS platform_modules'), 'Control migration missing');
  assert.ok(raidMigration.includes('CREATE TABLE IF NOT EXISTS archive_raid_inventory'), 'Archive Raid migration missing');
  assert.ok(challengeMigration.includes('CREATE TABLE IF NOT EXISTS challenge_game_runs'), 'Challenge migration missing');

  assert.ok(sw.includes('download-killer-static-v15-games-1-10'), 'current PWA cache name missing');
  assert.ok(sw.includes('/games/challenge/challenge.js?v=1.0.0'), 'challenge engine not cached');
  assert.ok(sw.includes('/games/dyrakarmy-arena/arena.js?v=1.0.0'), 'Arena not cached');
  assert.ok(sw.includes('/games/archive-raid/raid.js?v=1.0.0'), 'Archive Raid not cached');
  assert.ok(sw.includes('/control/control.js?v=1.0.0'), 'Control Center not cached');

  const manifest = JSON.parse(manifestText);
  const shortcuts = new Set((manifest.shortcuts || []).map((shortcut) => shortcut.url));
  assert.ok(shortcuts.has('/games/dyrakarmy-arena/'), 'Arena PWA shortcut missing');
  assert.ok(shortcuts.has('/games/latency-strike/'), 'Latency Strike PWA shortcut missing');
  assert.ok(shortcuts.has('/games/archive-raid/'), 'Archive Raid PWA shortcut missing');
  assert.ok(shortcuts.has('/control/'), 'Control Center PWA shortcut missing');

  assert.ok(!controlTs.includes('eval('), 'Control Center contains eval');
  assert.ok(!challengeTs.includes('eval('), 'challenge engine contains eval');
  assert.ok(!challengeTs.includes('new Function('), 'challenge engine constructs executable code');
  assert.ok(!controlJs.includes('TELEGRAM_BOT_TOKEN'), 'browser Control Center leaks bot token name');
  assert.ok(raidTs.includes('protected_content_access: false'), 'Archive Raid safe boundary missing');
  assert.ok(!raidTs.toLowerCase().includes('widevine'), 'Archive Raid references Widevine');
  assert.ok(!raidTs.toLowerCase().includes('playplay'), 'Archive Raid references PlayPlay');
}

async function simulateStatusBackoff() {
  const source = await read('worker/public/platform/status-backoff.js');
  let now = 1_000_000;
  const calls = [];
  const responses = [];
  const delays = [];
  class FakeDate extends Date { static now() { return now; } }
  const nativeFetch = async (input) => {
    calls.push(input instanceof Request ? input.url : String(input));
    const response = responses.shift();
    return response instanceof Promise ? response : response || new Response(JSON.stringify({ status: 'processing' }), { status: 200 });
  };
  const window = { fetch: nativeFetch, setTimeout: (resolve, delay) => { delays.push(delay); resolve(); return 1; } };
  vm.runInNewContext(source, { console, window, Request, Response, URL, location: { href: 'https://dyrakarmy.eu/' }, Date: FakeDate, Map, Promise, Number, String }, { filename: 'status-backoff.js' });
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  responses.push(pending);
  const url = 'https://dyrakarmy.eu/api/job/123e4567-e89b-12d3-a456-426614174000';
  const first = window.fetch(url); const second = window.fetch(url);
  release(new Response(JSON.stringify({ status: 'processing' }), { status: 200 }));
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls.length, 1, 'status polling requests were not deduplicated');
  assert.equal((await a.json()).status, 'processing');
  assert.equal((await b.json()).status, 'processing');
  now += 6000;
  const retryUrl = 'https://dyrakarmy.eu/api/job/223e4567-e89b-12d3-a456-426614174000';
  responses.push(new Response('{}', { status: 429, headers: { 'Retry-After': '2' } }), new Response(JSON.stringify({ status: 'done' }), { status: 200 }));
  assert.equal((await (await window.fetch(retryUrl)).json()).status, 'done');
  assert.ok(delays.includes(2000), 'Retry-After delay was not respected');
}

async function simulateServiceWorker() {
  const source = await read('worker/public/sw.js');
  const handlers = new Map();
  const stores = new Map();
  const deleted = [];
  let online = true;

  function openCache(name) {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name);
    return {
      put: async (request, response) => store.set(typeof request === 'string' ? request : request.url, response.clone()),
      match: async (request) => store.get(typeof request === 'string' ? request : request.url)?.clone(),
      keys: async () => Array.from(store.keys()).map((url) => new Request(new URL(url, 'https://dyrakarmy.eu/'))),
      delete: async (request) => store.delete(typeof request === 'string' ? request : request.url),
    };
  }

  const caches = {
    open: async (name) => openCache(name),
    keys: async () => [
      'old-cache', 'download-killer-static-v14-unified', 'download-killer-static-v15-archive-raid',
      'download-killer-static-v15-games-1-10', 'download-killer-offline-media-v2',
    ],
    delete: async (name) => { deleted.push(name); return true; },
    match: async (request) => {
      const key = typeof request === 'string' ? request : request.url;
      for (const store of stores.values()) {
        const response = store.get(key);
        if (response) return response.clone();
      }
      return undefined;
    },
  };

  const fetch = async () => {
    if (!online) throw new Error('offline');
    return new Response('network', { status: 200 });
  };
  const self = {
    location: { origin: 'https://dyrakarmy.eu' },
    addEventListener: (type, handler) => handlers.set(type, handler),
    skipWaiting: () => {},
    clients: { claim: () => {} },
  };
  vm.runInNewContext(source, { console, self, caches, fetch, Request, Response, URL, Promise }, { filename: 'sw.js' });

  let pending;
  handlers.get('install')({ waitUntil: (promise) => { pending = promise; } });
  await pending;
  const shell = stores.get('download-killer-static-v15-games-1-10');
  assert.ok(shell?.has('/platform/games-v14.js'), 'Games Hub was not installed');
  assert.ok(shell?.has('/games/challenge/challenge.js?v=1.0.0'), 'challenge engine was not installed');
  assert.ok(shell?.has('/games/dyrakarmy-arena/arena.js?v=1.0.0'), 'Arena was not installed');
  assert.ok(shell?.has('/games/archive-raid/raid.js?v=1.0.0'), 'Archive Raid was not installed');
  assert.ok(shell?.has('/control/control.js?v=1.0.0'), 'Control Center was not installed');

  handlers.get('activate')({ waitUntil: (promise) => { pending = promise; } });
  await pending;
  assert.deepEqual(deleted.sort(), ['download-killer-static-v14-unified', 'download-killer-static-v15-archive-raid', 'old-cache']);

  const challengeRequest = new Request('https://dyrakarmy.eu/games/queue-commander/?v=1.0.0');
  let responsePromise;
  handlers.get('fetch')({ request: challengeRequest, respondWith: (promise) => { responsePromise = promise; } });
  assert.equal(await (await responsePromise).text(), 'network');
  online = false;
  handlers.get('fetch')({ request: challengeRequest, respondWith: (promise) => { responsePromise = promise; } });
  assert.equal(await (await responsePromise).text(), 'network');

  const apiRequest = new Request('https://dyrakarmy.eu/api/platform/public');
  handlers.get('fetch')({ request: apiRequest, respondWith: (promise) => { responsePromise = promise; } });
  await assert.rejects(responsePromise, /offline/, 'API request was incorrectly served from static cache');
}

await runScenario('Unified Platform', 'site, Games 1-10, registry and Control Center contracts', validateUnifiedContracts);
await runScenario('Polling', 'dedupe and Retry-After simulation', simulateStatusBackoff);
await runScenario('PWA', 'Games 1-10 install, cache migration, offline fallback and API bypass', simulateServiceWorker);

const failed = results.filter((scenario) => !scenario.passed);
const report = {
  generated_at: new Date().toISOString(),
  mode: 'deterministic-virtual-simulation',
  total: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  external_network_used: false,
  scenarios: results,
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`\nVirtual simulation: ${report.passed}/${report.total} scenario groups passed.`);
console.log(`Report: ${reportPath}`);
if (failed.length) process.exit(1);
