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

function record(area, scenario, passed, detail = '') {
  results.push({ area, scenario, passed, detail });
  const icon = passed ? 'PASS' : 'FAIL';
  console.log(`[${icon}] ${area} :: ${scenario}${detail ? ` — ${detail}` : ''}`);
}

async function scenario(area, name, fn) {
  try {
    await fn();
    record(area, name, true);
  } catch (error) {
    record(area, name, false, error instanceof Error ? error.message : String(error));
  }
}

async function text(relative) {
  return readFile(path.join(repoRoot, relative), 'utf8');
}

class TinyEventTarget {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  dispatchEvent(event) {
    event.target ||= this;
    for (const listener of this.listeners.get(event.type) || []) listener.call(this, event);
  }
}

class TinyClassList {
  constructor() { this.values = new Set(); }
  add(...values) { values.forEach((value) => this.values.add(value)); }
  remove(...values) { values.forEach((value) => this.values.delete(value)); }
  toggle(value, force) {
    const enabled = force === undefined ? !this.values.has(value) : Boolean(force);
    if (enabled) this.values.add(value); else this.values.delete(value);
    return enabled;
  }
  contains(value) { return this.values.has(value); }
}

class TinyElement extends TinyEventTarget {
  constructor({ id = '', href = '', dataset = {}, textContent = '' } = {}) {
    super();
    this.id = id;
    this.dataset = { ...dataset };
    this.textContent = textContent;
    this.attributes = new Map();
    this.classList = new TinyClassList();
    this.children = [];
    this.parent = null;
    if (href) this.attributes.set('href', href);
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  append(child) { child.parent = this; this.children.push(child); }
  contains(node) {
    if (node === this) return true;
    return this.children.some((child) => child.contains(node));
  }
  querySelectorAll(selector) {
    const all = [];
    const visit = (node) => { for (const child of node.children) { all.push(child); visit(child); } };
    visit(this);
    if (selector === 'a') return all.filter((node) => node.getAttribute('href'));
    if (selector === 'a[href^="#"]') return all.filter((node) => String(node.getAttribute('href') || '').startsWith('#'));
    return [];
  }
}

async function simulateLanding() {
  const source = await text('worker/public/platform/landing-v13.js');
  const documentTarget = new TinyEventTarget();
  const body = new TinyElement();
  const root = new TinyElement();
  root.lang = 'bg';
  const toggle = new TinyElement({ id: 'mobileNavToggle' });
  toggle.setAttribute('aria-expanded', 'false');
  const nav = new TinyElement({ id: 'mainNav', dataset: { open: 'false' } });
  const homeLink = new TinyElement({ href: '#home' });
  const tutorialLink = new TinyElement({ href: '#tutorial' });
  nav.append(homeLink);
  nav.append(tutorialLink);
  const header = new TinyElement();
  const home = new TinyElement({ id: 'home' });
  const tutorial = new TinyElement({ id: 'tutorial' });
  const translated = new TinyElement({ dataset: { landingI18n: 'nav_home' }, textContent: 'old' });
  const selectors = new Map([
    ['#mobileNavToggle', toggle], ['#mainNav', nav], ['.topbar', header], ['#home', home], ['#tutorial', tutorial],
  ]);
  const elementsById = new Map([['home', home], ['tutorial', tutorial]]);
  const mutationCallbacks = [];
  const intersections = [];

  Object.assign(documentTarget, {
    documentElement: root,
    body,
    querySelector: (selector) => selectors.get(selector) || null,
    querySelectorAll: (selector) => selector === '[data-landing-i18n]' ? [translated] : [],
    getElementById: (id) => elementsById.get(id) || null,
  });

  class MutationObserver {
    constructor(callback) { this.callback = callback; }
    observe() { mutationCallbacks.push(this.callback); }
  }
  class IntersectionObserver {
    constructor(callback) { this.callback = callback; }
    observe(element) { intersections.push({ observer: this, element }); }
  }

  const windowTarget = new TinyEventTarget();
  const context = {
    console,
    document: documentTarget,
    window: windowTarget,
    addEventListener: (...args) => windowTarget.addEventListener(...args),
    MutationObserver,
    IntersectionObserver,
  };
  context.window.window = context.window;
  context.window.document = documentTarget;
  context.window.scrollY = 0;
  vm.runInNewContext(source, context, { filename: 'landing-v13.js' });

  documentTarget.dispatchEvent({ type: 'DOMContentLoaded' });
  assert.equal(translated.textContent, 'Начало');

  toggle.dispatchEvent({ type: 'click' });
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(nav.dataset.open, 'true');
  assert.equal(body.classList.contains('nav-open'), true);

  documentTarget.dispatchEvent({ type: 'keydown', key: 'Escape' });
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(nav.dataset.open, 'false');

  toggle.dispatchEvent({ type: 'click' });
  tutorialLink.dispatchEvent({ type: 'click' });
  assert.equal(nav.dataset.open, 'false');

  root.lang = 'en';
  mutationCallbacks.forEach((callback) => callback());
  assert.equal(translated.textContent, 'Home');

  assert.ok(intersections.length >= 2);
  const observer = intersections[0].observer;
  observer.callback([{ target: tutorial, isIntersecting: true, intersectionRatio: 0.8 }]);
  assert.equal(tutorialLink.classList.contains('active'), true);
  assert.equal(homeLink.classList.contains('active'), false);

  windowTarget.scrollY = 50;
  windowTarget.dispatchEvent({ type: 'scroll' });
  assert.equal(header.dataset.scrolled, 'true');
}

async function simulateStatusBackoff() {
  const source = await text('worker/public/platform/status-backoff.js');
  let now = 1_000_000;
  const calls = [];
  const queued = [];
  const delays = [];
  class FakeDate extends Date { static now() { return now; } }
  const nativeFetch = async (input) => {
    calls.push(String(input));
    const next = queued.shift();
    if (next instanceof Promise) return next;
    return next || new Response(JSON.stringify({ status: 'processing' }), { status: 200 });
  };
  const windowObject = {
    fetch: nativeFetch,
    setTimeout: (resolve, delay) => { delays.push(delay); resolve(); return 1; },
  };
  const context = {
    console,
    window: windowObject,
    Request,
    Response,
    URL,
    location: { href: 'https://dyrakarmy.eu/' },
    Date: FakeDate,
    Map,
    Promise,
    Number,
    String,
  };
  vm.runInNewContext(source, context, { filename: 'status-backoff.js' });

  queued.push(new Response('health', { status: 200 }));
  const ordinary = await windowObject.fetch('https://dyrakarmy.eu/api/health');
  assert.equal(await ordinary.text(), 'health');
  assert.equal(calls.length, 1);

  calls.length = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  queued.push(pending);
  const url = 'https://dyrakarmy.eu/api/job/123e4567-e89b-12d3-a456-426614174000';
  const first = windowObject.fetch(url);
  const second = windowObject.fetch(url);
  release(new Response(JSON.stringify({ status: 'processing' }), { status: 200 }));
  const [firstResponse, secondResponse] = await Promise.all([first, second]);
  assert.equal(calls.length, 1);
  assert.equal((await firstResponse.json()).status, 'processing');
  assert.equal((await secondResponse.json()).status, 'processing');

  const cached = await windowObject.fetch(url);
  assert.equal(calls.length, 1);
  assert.equal((await cached.json()).status, 'processing');

  now += 6_000;
  queued.push(new Response(JSON.stringify({ error: 'rate' }), { status: 429, headers: { 'Retry-After': '3' } }));
  const recovered = await windowObject.fetch(url);
  assert.equal(calls.length, 2);
  assert.equal((await recovered.json()).status, 'processing');

  const newUrl = 'https://dyrakarmy.eu/api/job/223e4567-e89b-12d3-a456-426614174000';
  queued.push(
    new Response(JSON.stringify({ error: 'rate' }), { status: 429, headers: { 'Retry-After': '2' } }),
    new Response(JSON.stringify({ status: 'done' }), { status: 200 }),
  );
  const retried = await windowObject.fetch(newUrl);
  assert.equal((await retried.json()).status, 'done');
  assert.ok(delays.includes(2000));
}

async function simulateServiceWorker() {
  const source = await text('worker/public/sw.js');
  const handlers = new Map();
  const cacheData = new Map();
  const deletedCaches = [];
  const network = [];

  function cache(name) {
    if (!cacheData.has(name)) cacheData.set(name, new Map());
    const store = cacheData.get(name);
    return {
      addAll: async (urls) => { urls.forEach((url) => store.set(String(url), new Response(`cached:${url}`))); },
      put: async (request, response) => { store.set(typeof request === 'string' ? request : request.url, response.clone()); },
      match: async (request) => store.get(typeof request === 'string' ? request : request.url)?.clone(),
      keys: async () => Array.from(store.keys()).map((url) => new Request(new URL(url, 'https://dyrakarmy.eu/'))),
      delete: async (request) => store.delete(typeof request === 'string' ? request : request.url),
    };
  }

  const caches = {
    open: async (name) => cache(name),
    keys: async () => ['old-cache', 'download-killer-static-v13-responsive', 'download-killer-offline-media-v2'],
    delete: async (name) => { deletedCaches.push(name); return true; },
    match: async (request) => {
      for (const store of cacheData.values()) {
        const found = store.get(typeof request === 'string' ? request : request.url);
        if (found) return found.clone();
      }
      return undefined;
    },
  };

  let fetchMode = 'ok';
  const fetch = async (request) => {
    network.push(typeof request === 'string' ? request : request.url);
    if (fetchMode === 'fail') throw new Error('offline');
    return new Response('network', { status: 200, headers: { 'Content-Type': 'text/plain' } });
  };
  const self = {
    location: { origin: 'https://dyrakarmy.eu' },
    addEventListener: (type, handler) => handlers.set(type, handler),
    skipWaiting: () => {},
    clients: { claim: () => {} },
  };
  vm.runInNewContext(source, { console, self, caches, fetch, Request, Response, URL, Promise }, { filename: 'sw.js' });

  let installPromise;
  handlers.get('install')({ waitUntil: (promise) => { installPromise = promise; } });
  await installPromise;
  const shell = cacheData.get('download-killer-static-v13-responsive');
  assert.ok(shell.has('/platform/landing-v13.css'));
  assert.ok(shell.has('/platform/landing-v13.js'));

  let activatePromise;
  handlers.get('activate')({ waitUntil: (promise) => { activatePromise = promise; } });
  await activatePromise;
  assert.deepEqual(deletedCaches, ['old-cache']);

  const telegramRequest = new Request('https://dyrakarmy.eu/telegram/?v=12.2.0');
  let responsePromise;
  handlers.get('fetch')({ request: telegramRequest, respondWith: (promise) => { responsePromise = promise; } });
  assert.equal(await (await responsePromise).text(), 'network');
  assert.ok(network.some((url) => url.includes('/telegram/')));

  fetchMode = 'fail';
  responsePromise = null;
  handlers.get('fetch')({ request: telegramRequest, respondWith: (promise) => { responsePromise = promise; } });
  assert.equal(await (await responsePromise).text(), 'network');

  const apiRequest = new Request('https://dyrakarmy.eu/api/health');
  responsePromise = null;
  handlers.get('fetch')({ request: apiRequest, respondWith: (promise) => { responsePromise = promise; } });
  await assert.rejects(responsePromise, /offline/);
}

async function validateContracts() {
  const [html, css, landingJs, platformJs, sw, wrangler, manifest, extensionManifest, mobile, telegramHtml] = await Promise.all([
    text('worker/public/index.html'),
    text('worker/public/platform/landing-v13.css'),
    text('worker/public/platform/landing-v13.js'),
    text('worker/public/platform/platform.js'),
    text('worker/public/sw.js'),
    text('worker/wrangler.jsonc'),
    text('worker/public/manifest.webmanifest'),
    text('extension/spotify-web-companion/manifest.json'),
    text('mobile_expo/App.tsx'),
    text('worker/public/telegram/index.html'),
  ]);

  const requiredIds = ['downloadForm', 'mediaUrl', 'sourceSelect', 'formatSelect', 'qualitySelect', 'launchBtn', 'jobFeed', 'historyList', 'edgeStatus', 'originStatus', 'formatStatus', 'latencyStatus', 'mobileNavToggle', 'mainNav'];
  for (const id of requiredIds) assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  assert.ok(html.includes('Responsive Design v13'));
  assert.ok(html.includes('tg://resolve?domain=dyrakarmy_bot'));
  assert.ok(!html.includes('download_killerBOT'));
  assert.ok(!html.includes('web.telegram.org'));

  for (const marker of ['@media (max-width: 1050px)', '@media (max-width: 820px)', '@media (max-width: 600px)', '@media (max-width: 390px)', '@media (prefers-reduced-motion: reduce)']) {
    assert.ok(css.includes(marker), `missing CSS marker ${marker}`);
  }
  assert.ok(css.includes('.process-flow'));
  assert.ok(css.includes('.feature-grid'));
  assert.ok(css.includes('.mobile-nav-toggle'));
  assert.ok(landingJs.includes("event.key === 'Escape'"));
  assert.ok(landingJs.includes('IntersectionObserver'));
  assert.ok(platformJs.includes('/download'));
  assert.ok(sw.includes('download-killer-static-v13-responsive'));
  assert.ok(sw.includes("url.pathname.startsWith('/telegram/')"));
  assert.ok(wrangler.includes('"TELEGRAM_BOT_USERNAME": "dyrakarmy_bot"'));
  assert.ok(wrangler.includes('"PUBLIC_BASE_URL": "https://dyrakarmy.eu"'));

  const pwa = JSON.parse(manifest);
  assert.ok(Array.isArray(pwa.icons) && pwa.icons.length >= 2);
  assert.ok((pwa.shortcuts || []).some((shortcut) => shortcut.url === '/telegram/'));

  const extension = JSON.parse(extensionManifest);
  assert.equal(extension.manifest_version, 3);
  assert.equal(extension.version, '1.2.0');
  assert.ok(extension.host_permissions.includes('https://dyrakarmy.eu/*'));
  assert.ok(!extension.permissions.includes('webRequest'));

  assert.ok(mobile.includes("const DEFAULT_API_BASE = 'https://dyrakarmy.eu'"));
  assert.ok(mobile.includes("const MIRROR_API_BASE = 'https://dyrakarmy.online'"));
  assert.ok(telegramHtml.includes('@dyrakarmy_bot'));
  assert.ok(!telegramHtml.includes('download_killerBOT'));
}

await scenario('Web UI', 'responsive and integration contracts', validateContracts);
await scenario('Web UI', 'mobile navigation and language simulation', simulateLanding);
await scenario('Polling', 'dedupe, cache and Retry-After simulation', simulateStatusBackoff);
await scenario('PWA', 'install, activate, Telegram network-first and API bypass', simulateServiceWorker);

const failures = results.filter((row) => !row.passed);
const summary = {
  generated_at: new Date().toISOString(),
  mode: 'deterministic-virtual-simulation',
  total: results.length,
  passed: results.length - failures.length,
  failed: failures.length,
  external_network_used: false,
  scenarios: results,
};
await writeFile(reportPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
console.log(`\nVirtual simulation: ${summary.passed}/${summary.total} scenario groups passed.`);
console.log(`Report: ${reportPath}`);
if (failures.length) process.exit(1);
