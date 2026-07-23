const CACHE_NAME = 'download-killer-static-v15-games-1-10';
const PRODUCT_CACHE_VERSION = 'dyrakarmy-product-system-v20';
const INTERFACE_CACHE_VERSION = 'download-killer-static-v16-dyrakarmy-dashboard';
const SOFTWARE_SUITE_VERSION = 'download-killer-static-v17-software-suite';
const MEDIA_CACHE_NAME = 'download-killer-offline-media-v2';
const CHALLENGE_GAME_SLUGS = [
  'queue-commander', 'beat-hunter', 'format-forge', 'server-defender',
  'metadata-detective', 'link-runner', 'bot-vs-human',
];
const APP_SHELL = [
  '/',
  '/index.html',
  '/favicon.svg',
  '/manifest.webmanifest',
  '/platform/product-redesign-v20.css?v=20.0.0',
  '/platform/product-redesign-v20.js?v=20.0.0',
  '/platform/games-v14.js',
  '/platform/platform-public.js',
  '/telegram/',
  '/telegram/index.html',
  '/telegram/telegram-product-v20.js?v=20.0.0',
  '/games/challenge/index.html',
  '/games/challenge/challenge.css?v=1.0.0',
  '/games/challenge/challenge.js?v=1.0.0',
  '/games/latency-strike/',
  '/games/latency-strike/index.html',
  '/games/latency-strike/game.css?v=1.0.0',
  '/games/latency-strike/native-bridge.js?v=1.0.0',
  '/games/latency-strike/game.js?v=1.0.0',
  '/games/dyrakarmy-arena/',
  '/games/dyrakarmy-arena/index.html',
  '/games/dyrakarmy-arena/arena.css?v=1.0.0',
  '/games/dyrakarmy-arena/arena.js?v=1.0.0',
  '/games/archive-raid/',
  '/games/archive-raid/index.html',
  '/games/archive-raid/raid.css?v=1.0.0',
  '/games/archive-raid/raid.js?v=1.0.0',
  '/control/',
  '/control/index.html',
  '/control/control.css?v=1.0.0',
  '/control/control.js?v=1.0.0',
  '/control-v2/',
  '/control-v2/index.html',
  '/control-v2/control-v2.css',
  '/control-v2/control-v2.js',
  '/control-v2/manifest.webmanifest',
  '/control-v2/sw.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

async function installAppShell() {
  const cache = await caches.open(CACHE_NAME);
  await Promise.allSettled(APP_SHELL.map(async (url) => {
    const response = await fetch(url, { cache: 'reload' });
    if (response.ok) await cache.put(url, response.clone());
  }));
}

self.addEventListener('install', (event) => {
  event.waitUntil(installAppShell());
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== CACHE_NAME && key !== MEDIA_CACHE_NAME).map((key) => caches.delete(key)),
    )),
  );
  self.clients.claim();
});

async function warmRecentCache(urls) {
  const cache = await caches.open(MEDIA_CACHE_NAME);
  const normalized = Array.isArray(urls) ? urls.slice(0, 60) : [];
  await Promise.allSettled(normalized.map(async (rawUrl) => {
    const url = new URL(String(rawUrl || ''), self.location.origin);
    if (url.origin !== self.location.origin) return;
    const request = new Request(url.toString(), { credentials: 'same-origin' });
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
  }));
}

async function networkFirstApp(request, offlineMessage, fallbackUrl = '') {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request, { cache: 'no-store' });
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request, { ignoreSearch: false })
      || await caches.match(request)
      || (fallbackUrl ? await caches.match(fallbackUrl) : null);
    if (cached) return cached;
    return new Response(offlineMessage, {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
}

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'WARM_RECENT_CACHE') event.waitUntil(warmRecentCache(data.urls));
  if (data.type === 'CLEAR_TELEGRAM_CACHE' || data.type === 'CLEAR_PLATFORM_CACHE') {
    event.waitUntil(caches.open(CACHE_NAME).then(async (cache) => {
      const keys = await cache.keys();
      await Promise.all(keys
        .filter((request) => {
          const pathname = new URL(request.url).pathname;
          return pathname.startsWith('/telegram/') || pathname.startsWith('/games/') || pathname.startsWith('/control/') || pathname.startsWith('/control-v2/');
        })
        .map((request) => cache.delete(request)));
    }));
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const isWarmableApi = url.pathname.startsWith('/api/file/') || url.pathname.startsWith('/api/archive/file/');
  const isTelegramAsset = url.pathname.startsWith('/telegram/');
  const isGameAsset = url.pathname.startsWith('/games/');
  const isControlAsset = url.pathname.startsWith('/control/') || url.pathname.startsWith('/control-v2/');
  const gameSlug = url.pathname.split('/').filter(Boolean)[1] || '';
  const isChallengeRoute = CHALLENGE_GAME_SLUGS.includes(gameSlug);

  if (isTelegramAsset || isGameAsset || isControlAsset) {
    let offlineMessage = 'DyrakArmy is temporarily offline. Reopen the experience when the connection returns.';
    let fallbackUrl = '';
    if (isGameAsset) offlineMessage = 'DyrakArmy Game is temporarily offline. Reopen it from the platform or Telegram.';
    if (isChallengeRoute) fallbackUrl = '/games/challenge/index.html';
    if (isControlAsset) offlineMessage = 'Your DyrakArmy profile needs a network connection.';
    event.respondWith(networkFirstApp(request, offlineMessage, fallbackUrl));
    return;
  }
  if (url.pathname.startsWith('/api/') && !isWarmableApi) {
    event.respondWith(fetch(request));
    return;
  }
  if (isWarmableApi && request.headers.has('range')) {
    event.respondWith(fetch(request));
    return;
  }
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(async () => (await caches.match('/index.html')) || new Response('Offline', { status: 503 })));
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const networkFetch = fetch(request).then((response) => {
        if (response.ok && url.origin === self.location.origin) {
          const copy = response.clone();
          const targetCache = isWarmableApi ? MEDIA_CACHE_NAME : CACHE_NAME;
          caches.open(targetCache).then((cache) => cache.put(request, copy));
        }
        return response;
      }).catch(() => cached);
      return cached || networkFetch;
    }),
  );
});
