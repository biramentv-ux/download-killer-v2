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
const retiredBot = 'download_killer' + 'BOT';
const telegramWeb = 'web.telegram' + '.org';

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

class EventTargetMock {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, callback) {
    const callbacks = this.listeners.get(type) || [];
    callbacks.push(callback);
    this.listeners.set(type, callbacks);
  }
  dispatchEvent(event) {
    if (!event.target) event.target = this;
    for (const callback of this.listeners.get(event.type) || []) callback.call(this, event);
  }
}

class ClassListMock {
  constructor() { this.values = new Set(); }
  add(...values) { values.forEach((value) => this.values.add(value)); }
  remove(...values) { values.forEach((value) => this.values.delete(value)); }
  contains(value) { return this.values.has(value); }
  toggle(value, force) {
    const enabled = force === undefined ? !this.values.has(value) : Boolean(force);
    if (enabled) this.values.add(value); else this.values.delete(value);
    return enabled;
  }
}

class ElementMock extends EventTargetMock {
  constructor({ id = '', href = '', dataset = {}, textContent = '' } = {}) {
    super();
    this.id = id;
    this.dataset = { ...dataset };
    this.textContent = textContent;
    this.classList = new ClassListMock();
    this.attributes = new Map();
    this.children = [];
    if (href) this.attributes.set('href', href);
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  append(child) { this.children.push(child); }
  contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
  querySelectorAll(selector) {
    const descendants = [];
    const visit = (element) => {
      for (const child of element.children) { descendants.push(child); visit(child); }
    };
    visit(this);
    if (selector === 'a') return descendants.filter((node) => node.getAttribute('href'));
    if (selector === 'a[href^="#"]') return descendants.filter((node) => String(node.getAttribute('href') || '').startsWith('#'));
    return [];
  }
}

async function validateUnifiedContracts() {
  const files = await Promise.all([
    read('worker/public/index.html'),
    read('worker/public/platform/landing-v13.css'),
    read('worker/public/platform/landing-v13.js'),
    read('worker/public/platform/games-v14.css'),
    read('worker/public/platform/games-v14.js'),
    read('worker/public/platform/platform-public.js'),
    read('worker/public/control/index.html'),
    read('worker/public/control/control.js'),
    read('worker/public/games/dyrakarmy-arena/index.html'),
    read('worker/public/games/dyrakarmy-arena/arena.js'),
    read('worker/public/games/archive-raid/index.html'),
    read('worker/public/games/archive-raid/raid.js'),
    read('worker/public/sw.js'),
    read('worker/public/manifest.webmanifest'),
    read('worker/src/platform_v2.ts'),
    read('worker/src/platform_control.ts'),
    read('worker/src/dyrakarmy_arena.ts'),
    read('worker/src/archive_raid.ts'),
    read('worker/migrations/0013_dyrakarmy_arena_v1.sql'),
    read('worker/migrations/0014_platform_control_center_v1.sql'),
    read('worker/migrations/0015_archive_raid_v1.sql'),
  ]);
  const [html, css, landing, gamesCss, gamesJs, publicJs, controlHtml, controlJs, arenaHtml, arenaJs, raidHtml, raidJs, sw, manifestText, platformV2, controlTs, arenaTs, raidTs, arenaMigration, controlMigration, raidMigration] = files;

  for (const id of ['mobileNavToggle', 'mainNav', 'downloadForm', 'mediaUrl', 'sourceSelect', 'formatSelect', 'qualitySelect', 'launchBtn', 'jobFeed', 'historyList', 'edgeStatus', 'originStatus', 'formatStatus', 'latencyStatus']) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
  assert.ok(html.includes('Responsive Design v13'));
  assert.ok(html.includes('tg://resolve?domain=dyrakarmy_bot'));
  assert.ok(!html.includes(retiredBot));
  assert.ok(!html.includes(telegramWeb));
  assert.ok(css.includes('@media (max-width: 600px)'));
  assert.ok(css.includes('@media (prefers-reduced-motion: reduce)'));
  assert.ok(landing.includes("event.key === 'Escape'"));
  assert.ok(gamesCss.includes('.game-showcase'));
  assert.ok(gamesJs.includes('DyrakArmy Arena'));
  assert.ok(gamesJs.includes('Archive Raid'));
  assert.ok(publicJs.includes('/api/platform/public'));
  assert.ok(publicJs.includes('data-platform-hidden'));
  assert.ok(publicJs.includes('archive-raid'));

  for (const marker of ['DyrakArmy Control Center', 'TELEGRAM_ADMIN_IDS', '/api/platform/control']) {
    assert.ok(`${controlHtml}\n${controlJs}\n${controlTs}`.includes(marker), `missing control marker ${marker}`);
  }
  for (const marker of ['DyrakArmy Arena', '/api/games/dyrakarmy-arena', 'arena_teams', 'arena_runs']) {
    assert.ok(`${arenaHtml}\n${arenaJs}\n${arenaTs}\n${arenaMigration}`.includes(marker), `missing Arena marker ${marker}`);
  }
  for (const marker of ['Archive Raid', '/api/games/archive-raid', 'archive_raid_inventory', 'Army Exclusive']) {
    assert.ok(`${raidHtml}\n${raidJs}\n${raidTs}\n${raidMigration}`.includes(marker), `missing Archive Raid marker ${marker}`);
  }
  for (const marker of ['handlePlatformControlApi', 'handlePlatformControlTelegramWebhook', 'isPlatformModuleEnabled', 'handleDyrakArmyArenaApi', 'handleArchiveRaidApi', 'handleArchiveRaidTelegramWebhook']) {
    assert.ok(platformV2.includes(marker), `missing Worker marker ${marker}`);
  }
  assert.ok(controlMigration.includes('CREATE TABLE IF NOT EXISTS platform_modules'));
  assert.ok(controlMigration.includes('CREATE TABLE IF NOT EXISTS platform_audit'));
  assert.ok(raidMigration.includes('protected_content_access'));
  assert.ok(sw.includes('download-killer-static-v15-archive-raid'));
  assert.ok(sw.includes('/games/dyrakarmy-arena/arena.js?v=1.0.0'));
  assert.ok(sw.includes('/games/archive-raid/raid.js?v=1.0.0'));
  assert.ok(sw.includes('/control/control.js?v=1.0.0'));

  const manifest = JSON.parse(manifestText);
  const shortcuts = new Set((manifest.shortcuts || []).map((shortcut) => shortcut.url));
  assert.ok(shortcuts.has('/games/dyrakarmy-arena/'));
  assert.ok(shortcuts.has('/games/latency-strike/'));
  assert.ok(shortcuts.has('/games/archive-raid/'));
  assert.ok(shortcuts.has('/control/'));
  assert.ok(!controlTs.includes('eval('));
  assert.ok(!controlTs.includes('new Function('));
  assert.ok(!controlJs.includes('TELEGRAM_BOT_TOKEN'));
  assert.ok(raidTs.includes('protected_content_access: false'));
  assert.ok(!raidTs.toLowerCase().includes('widevine'));
  assert.ok(!raidTs.toLowerCase().includes('playplay'));
}

async function simulateLandingNavigation() {
  const source = await read('worker/public/platform/landing-v13.js');
  const document = new EventTargetMock();
  const body = new ElementMock();
  const root = new ElementMock();
  root.lang = 'bg';
  const toggle = new ElementMock({ id: 'mobileNavToggle' });
  toggle.setAttribute('aria-expanded', 'false');
  const nav = new ElementMock({ id: 'mainNav', dataset: { open: 'false' } });
  const homeLink = new ElementMock({ href: '#home' });
  const tutorialLink = new ElementMock({ href: '#tutorial' });
  nav.append(homeLink); nav.append(tutorialLink);
  const header = new ElementMock();
  const home = new ElementMock({ id: 'home' });
  const tutorial = new ElementMock({ id: 'tutorial' });
  const translated = new ElementMock({ dataset: { landingI18n: 'nav_home' }, textContent: 'old' });
  const mutationCallbacks = [];
  const observed = [];
  Object.assign(document, {
    documentElement: root,
    body,
    querySelector: (selector) => new Map([['#mobileNavToggle', toggle], ['#mainNav', nav], ['.topbar', header]]).get(selector) || null,
    querySelectorAll: (selector) => selector === '[data-landing-i18n]' ? [translated] : [],
    getElementById: (id) => new Map([['home', home], ['tutorial', tutorial]]).get(id) || null,
  });
  class MutationObserverMock { constructor(callback) { this.callback = callback; } observe() { mutationCallbacks.push(this.callback); } }
  class IntersectionObserverMock { constructor(callback) { this.callback = callback; } observe(element) { observed.push({ observer: this, element }); } }
  const window = new EventTargetMock();
  Object.assign(window, { window, document, scrollY: 0, IntersectionObserver: IntersectionObserverMock, MutationObserver: MutationObserverMock });
  vm.runInNewContext(source, { console, document, window, addEventListener: (...args) => window.addEventListener(...args), MutationObserver: MutationObserverMock, IntersectionObserver: IntersectionObserverMock, Map, Array, String }, { filename: 'landing-v13.js' });
  document.dispatchEvent({ type: 'DOMContentLoaded' });
  assert.equal(translated.textContent, 'Начало');
  assert.equal(observed.length, 2);
  toggle.dispatchEvent({ type: 'click' });
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  document.dispatchEvent({ type: 'keydown', key: 'Escape' });
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  root.lang = 'en'; mutationCallbacks.forEach((callback) => callback());
  assert.equal(translated.textContent, 'Home');
  observed[0].observer.callback([{ target: tutorial, isIntersecting: true, intersectionRatio: 0.8 }]);
  assert.ok(tutorialLink.classList.contains('active'));
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
  assert.equal(calls.length, 1);
  assert.equal((await a.json()).status, 'processing');
  assert.equal((await b.json()).status, 'processing');
  now += 6000;
  const retryUrl = 'https://dyrakarmy.eu/api/job/223e4567-e89b-12d3-a456-426614174000';
  responses.push(new Response('{}', { status: 429, headers: { 'Retry-After': '2' } }), new Response(JSON.stringify({ status: 'done' }), { status: 200 }));
  assert.equal((await (await window.fetch(retryUrl)).json()).status, 'done');
  assert.ok(delays.includes(2000));
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
      addAll: async (urls) => urls.forEach((url) => store.set(String(url), new Response(`cached:${url}`))),
      put: async (request, response) => store.set(typeof request === 'string' ? request : request.url, response.clone()),
      match: async (request) => store.get(typeof request === 'string' ? request : request.url)?.clone(),
      keys: async () => Array.from(store.keys()).map((url) => new Request(new URL(url, 'https://dyrakarmy.eu/'))),
      delete: async (request) => store.delete(typeof request === 'string' ? request : request.url),
    };
  }
  const caches = {
    open: async (name) => openCache(name),
    keys: async () => ['old-cache', 'download-killer-static-v14-unified', 'download-killer-static-v15-archive-raid', 'download-killer-offline-media-v2'],
    delete: async (name) => { deleted.push(name); return true; },
    match: async (request) => {
      const key = typeof request === 'string' ? request : request.url;
      for (const store of stores.values()) { const response = store.get(key); if (response) return response.clone(); }
      return undefined;
    },
  };
  const fetch = async () => { if (!online) throw new Error('offline'); return new Response('network', { status: 200 }); };
  const self = { location: { origin: 'https://dyrakarmy.eu' }, addEventListener: (type, handler) => handlers.set(type, handler), skipWaiting: () => {}, clients: { claim: () => {} } };
  vm.runInNewContext(source, { console, self, caches, fetch, Request, Response, URL, Promise }, { filename: 'sw.js' });
  let pending;
  handlers.get('install')({ waitUntil: (promise) => { pending = promise; } }); await pending;
  const shell = stores.get('download-killer-static-v15-archive-raid');
  assert.ok(shell.has('/platform/games-v14.js'));
  assert.ok(shell.has('/games/dyrakarmy-arena/arena.js?v=1.0.0'));
  assert.ok(shell.has('/games/archive-raid/raid.js?v=1.0.0'));
  assert.ok(shell.has('/control/control.js?v=1.0.0'));
  handlers.get('activate')({ waitUntil: (promise) => { pending = promise; } }); await pending;
  assert.deepEqual(deleted.sort(), ['download-killer-static-v14-unified', 'old-cache']);
  const raidRequest = new Request('https://dyrakarmy.eu/games/archive-raid/?v=1.0.0');
  let responsePromise;
  handlers.get('fetch')({ request: raidRequest, respondWith: (promise) => { responsePromise = promise; } });
  assert.equal(await (await responsePromise).text(), 'network');
  online = false;
  handlers.get('fetch')({ request: raidRequest, respondWith: (promise) => { responsePromise = promise; } });
  assert.equal(await (await responsePromise).text(), 'network');
  const apiRequest = new Request('https://dyrakarmy.eu/api/platform/public');
  handlers.get('fetch')({ request: apiRequest, respondWith: (promise) => { responsePromise = promise; } });
  await assert.rejects(responsePromise, /offline/);
}

await runScenario('Unified Platform', 'site, three games, registry and Control Center contracts', validateUnifiedContracts);
await runScenario('Web UI', 'mobile navigation and language simulation', simulateLandingNavigation);
await runScenario('Polling', 'dedupe and Retry-After simulation', simulateStatusBackoff);
await runScenario('PWA', 'v15 install, Archive Raid cache and API bypass', simulateServiceWorker);

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
