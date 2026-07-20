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
  contains(node) {
    return node === this || this.children.some((child) => child.contains(node));
  }
  querySelectorAll(selector) {
    const descendants = [];
    const visit = (element) => {
      for (const child of element.children) {
        descendants.push(child);
        visit(child);
      }
    };
    visit(this);
    if (selector === 'a') return descendants.filter((node) => node.getAttribute('href'));
    if (selector === 'a[href^="#"]') {
      return descendants.filter((node) => String(node.getAttribute('href') || '').startsWith('#'));
    }
    return [];
  }
}

async function validateContracts() {
  const [html, css, landing, platform, serviceWorker, wrangler, pwaText, extensionText, mobile, telegram] = await Promise.all([
    read('worker/public/index.html'),
    read('worker/public/platform/landing-v13.css'),
    read('worker/public/platform/landing-v13.js'),
    read('worker/public/platform/platform.js'),
    read('worker/public/sw.js'),
    read('worker/wrangler.jsonc'),
    read('worker/public/manifest.webmanifest'),
    read('extension/spotify-web-companion/manifest.json'),
    read('mobile_expo/App.tsx'),
    read('worker/public/telegram/index.html'),
  ]);

  const requiredIds = [
    'mobileNavToggle', 'mainNav', 'downloadForm', 'mediaUrl', 'sourceSelect',
    'formatSelect', 'qualitySelect', 'launchBtn', 'jobFeed', 'historyList',
    'edgeStatus', 'originStatus', 'formatStatus', 'latencyStatus',
  ];
  for (const id of requiredIds) assert.ok(html.includes(`id="${id}"`), `missing #${id}`);

  for (const marker of [
    'Responsive Design v13',
    'tg://resolve?domain=dyrakarmy_bot',
    '/platform/landing-v13.css',
    '/platform/landing-v13.js',
  ]) assert.ok(html.includes(marker), `missing HTML marker ${marker}`);
  assert.ok(!html.includes(retiredBot));
  assert.ok(!html.includes(telegramWeb));

  for (const marker of [
    '@media (max-width: 1050px)', '@media (max-width: 820px)',
    '@media (max-width: 600px)', '@media (max-width: 390px)',
    '@media (prefers-reduced-motion: reduce)', '.process-flow',
    '.feature-grid', '.mobile-nav-toggle',
  ]) assert.ok(css.includes(marker), `missing CSS marker ${marker}`);

  assert.ok(landing.includes("event.key === 'Escape'"));
  assert.ok(landing.includes('IntersectionObserver'));
  assert.ok(platform.includes('/download'));
  assert.ok(serviceWorker.includes('download-killer-static-v13-responsive'));
  assert.ok(serviceWorker.includes("url.pathname.startsWith('/telegram/')"));
  assert.ok(wrangler.includes('"TELEGRAM_BOT_USERNAME": "dyrakarmy_bot"'));
  assert.ok(wrangler.includes('"PUBLIC_BASE_URL": "https://dyrakarmy.eu"'));

  const pwa = JSON.parse(pwaText);
  assert.ok(Array.isArray(pwa.icons) && pwa.icons.length >= 2);
  assert.ok((pwa.shortcuts || []).some((shortcut) => shortcut.url === '/telegram/'));

  const extension = JSON.parse(extensionText);
  assert.equal(extension.manifest_version, 3);
  assert.equal(extension.version, '1.2.0');
  assert.ok(extension.host_permissions.includes('https://dyrakarmy.eu/*'));
  assert.ok(!extension.permissions.includes('webRequest'));

  assert.ok(mobile.includes("const DEFAULT_API_BASE = 'https://dyrakarmy.eu'"));
  assert.ok(mobile.includes("const MIRROR_API_BASE = 'https://dyrakarmy.online'"));
  assert.ok(telegram.includes('@dyrakarmy_bot'));
  assert.ok(!telegram.includes(retiredBot));
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
  nav.append(homeLink);
  nav.append(tutorialLink);
  const header = new ElementMock();
  const homeSection = new ElementMock({ id: 'home' });
  const tutorialSection = new ElementMock({ id: 'tutorial' });
  const translated = new ElementMock({ dataset: { landingI18n: 'nav_home' }, textContent: 'old' });

  const selectors = new Map([
    ['#mobileNavToggle', toggle], ['#mainNav', nav], ['.topbar', header],
  ]);
  const ids = new Map([['home', homeSection], ['tutorial', tutorialSection]]);
  const mutationCallbacks = [];
  const observed = [];

  Object.assign(document, {
    documentElement: root,
    body,
    querySelector: (selector) => selectors.get(selector) || null,
    querySelectorAll: (selector) => selector === '[data-landing-i18n]' ? [translated] : [],
    getElementById: (id) => ids.get(id) || null,
  });

  class MutationObserverMock {
    constructor(callback) { this.callback = callback; }
    observe() { mutationCallbacks.push(this.callback); }
  }
  class IntersectionObserverMock {
    constructor(callback) { this.callback = callback; }
    observe(element) { observed.push({ observer: this, element }); }
  }

  const window = new EventTargetMock();
  window.window = window;
  window.document = document;
  window.scrollY = 0;
  window.IntersectionObserver = IntersectionObserverMock;
  window.MutationObserver = MutationObserverMock;

  vm.runInNewContext(source, {
    console,
    document,
    window,
    addEventListener: (...args) => window.addEventListener(...args),
    MutationObserver: MutationObserverMock,
    IntersectionObserver: IntersectionObserverMock,
    Map,
    Array,
    String,
  }, { filename: 'landing-v13.js' });

  document.dispatchEvent({ type: 'DOMContentLoaded' });
  assert.equal(translated.textContent, 'Начало');
  assert.equal(observed.length, 2);

  toggle.dispatchEvent({ type: 'click' });
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(nav.dataset.open, 'true');
  assert.ok(body.classList.contains('nav-open'));

  document.dispatchEvent({ type: 'keydown', key: 'Escape' });
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');

  toggle.dispatchEvent({ type: 'click' });
  tutorialLink.dispatchEvent({ type: 'click' });
  assert.equal(nav.dataset.open, 'false');

  root.lang = 'en';
  mutationCallbacks.forEach((callback) => callback());
  assert.equal(translated.textContent, 'Home');

  observed[0].observer.callback([
    { target: tutorialSection, isIntersecting: true, intersectionRatio: 0.8 },
  ]);
  assert.ok(tutorialLink.classList.contains('active'));
  assert.ok(!homeLink.classList.contains('active'));

  window.scrollY = 50;
  window.dispatchEvent({ type: 'scroll' });
  assert.equal(header.dataset.scrolled, 'true');
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
    return response instanceof Promise
      ? response
      : response || new Response(JSON.stringify({ status: 'processing' }), { status: 200 });
  };
  const window = {
    fetch: nativeFetch,
    setTimeout: (resolve, delay) => { delays.push(delay); resolve(); return 1; },
  };

  vm.runInNewContext(source, {
    console, window, Request, Response, URL,
    location: { href: 'https://dyrakarmy.eu/' },
    Date: FakeDate, Map, Promise, Number, String,
  }, { filename: 'status-backoff.js' });

  responses.push(new Response('health', { status: 200 }));
  assert.equal(await (await window.fetch('https://dyrakarmy.eu/api/health')).text(), 'health');

  calls.length = 0;
  let resolvePending;
  const pending = new Promise((resolve) => { resolvePending = resolve; });
  responses.push(pending);
  const jobUrl = 'https://dyrakarmy.eu/api/job/123e4567-e89b-12d3-a456-426614174000';
  const first = window.fetch(jobUrl);
  const second = window.fetch(jobUrl);
  resolvePending(new Response(JSON.stringify({ status: 'processing' }), { status: 200 }));
  const [firstResponse, secondResponse] = await Promise.all([first, second]);
  assert.equal(calls.length, 1);
  assert.equal((await firstResponse.json()).status, 'processing');
  assert.equal((await secondResponse.json()).status, 'processing');

  assert.equal((await (await window.fetch(jobUrl)).json()).status, 'processing');
  assert.equal(calls.length, 1);

  now += 6_000;
  responses.push(new Response('{}', { status: 429, headers: { 'Retry-After': '3' } }));
  assert.equal((await (await window.fetch(jobUrl)).json()).status, 'processing');

  const newJobUrl = 'https://dyrakarmy.eu/api/job/223e4567-e89b-12d3-a456-426614174000';
  responses.push(
    new Response('{}', { status: 429, headers: { 'Retry-After': '2' } }),
    new Response(JSON.stringify({ status: 'done' }), { status: 200 }),
  );
  assert.equal((await (await window.fetch(newJobUrl)).json()).status, 'done');
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
    keys: async () => ['old-cache', 'download-killer-static-v13-responsive', 'download-killer-offline-media-v2'],
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

  vm.runInNewContext(source, {
    console, self, caches, fetch, Request, Response, URL, Promise,
  }, { filename: 'sw.js' });

  let pending;
  handlers.get('install')({ waitUntil: (promise) => { pending = promise; } });
  await pending;
  const shell = stores.get('download-killer-static-v13-responsive');
  assert.ok(shell.has('/platform/landing-v13.css'));
  assert.ok(shell.has('/platform/landing-v13.js'));

  handlers.get('activate')({ waitUntil: (promise) => { pending = promise; } });
  await pending;
  assert.deepEqual(deleted, ['old-cache']);

  const telegramRequest = new Request('https://dyrakarmy.eu/telegram/?v=12.2.0');
  let responsePromise;
  handlers.get('fetch')({ request: telegramRequest, respondWith: (promise) => { responsePromise = promise; } });
  assert.equal(await (await responsePromise).text(), 'network');

  online = false;
  handlers.get('fetch')({ request: telegramRequest, respondWith: (promise) => { responsePromise = promise; } });
  assert.equal(await (await responsePromise).text(), 'network');

  const apiRequest = new Request('https://dyrakarmy.eu/api/health');
  handlers.get('fetch')({ request: apiRequest, respondWith: (promise) => { responsePromise = promise; } });
  await assert.rejects(responsePromise, /offline/);
}

await runScenario('Web UI', 'responsive and integration contracts', validateContracts);
await runScenario('Web UI', 'mobile navigation and language simulation', simulateLandingNavigation);
await runScenario('Polling', 'dedupe, cache and Retry-After simulation', simulateStatusBackoff);
await runScenario('PWA', 'install, activate, Telegram network-first and API bypass', simulateServiceWorker);

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
