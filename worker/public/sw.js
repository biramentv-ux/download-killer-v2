const CACHE_NAME = 'download-killer-static-v14-unified';
const LEGACY_CACHE_NAME = 'download-killer-static-v13-responsive';
const LEGACY_V12_CACHE_NAME = 'download-killer-static-v12.2.0';
const MEDIA_CACHE_NAME = 'download-killer-offline-media-v2';
const APP_SHELL = [
  '/',
  '/index.html',
  '/favicon.svg',
  '/manifest.webmanifest',
  '/platform/platform.css',
  '/platform/landing-v13.css',
  '/platform/games-v14.css',
  '/platform/platform-public.css',
  '/platform/status-backoff.js',
  '/platform/site-defaults.js',
  '/platform/landing-v13.js',
  '/platform/platform.js',
  '/platform/games-v14.js',
  '/platform/platform-public.js',
  '/media-lab/media-lab.css',
  '/media-lab/media-lab.js',
  '/games/latency-strike/',
  '/games/latency-strike/index.html',
  '/games/latency-strike/game.css?v=1.0.0',
  '/games/latency-strike/native-bridge.js?v=1.0.0',
  '/games/latency-strike/game.js?v=1.0.0',
  '/games/dyrakarmy-arena/',
  '/games/dyrakarmy-arena/index.html',
  '/games/dyrakarmy-arena/arena.css?v=1.0.0',
  '/games/dyrakarmy-arena/arena.js?v=1.0.0',
  '/control/',
  '/control/index.html',
  '/control/control.css?v=1.0.0',
  '/control/control.js?v=1.0.0',
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

async function networkFirstApp(request, offlineMessage) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request, { cache: 'no-store' });
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request, { ignoreSearch: false }) || await caches.match(request);
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
          return pathname.startsWith('/telegram/')
            || pathname.startsWith('/games/latency-strike/')
            || pathname.startsWith('/games/dyrakarmy-arena/')
            || pathname.startsWith('/control/');
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
  const isLatencyStrikeAsset = url.pathname.startsWith('/games/latency-strike/');
  const isArenaAsset = url.pathname.startsWith('/games/dyrakarmy-arena/');
  const isControlAsset = url.pathname.startsWith('/control/');

  if (isTelegramAsset || isLatencyStrikeAsset || isArenaAsset || isControlAsset) {
    let offlineMessage = 'Telegram Mini App is temporarily offline. Reopen it from the bot.';
    if (isLatencyStrikeAsset) offlineMessage = 'Latency Strike is temporarily offline. Reopen the game from @dyrakarmy_bot.';
    if (isArenaAsset) offlineMessage = 'DyrakArmy Arena is temporarily offline. Reopen it from @dyrakarmy_bot.';
    if (isControlAsset) offlineMessage = 'Control Center needs a network connection and a valid Telegram administrator session.';
    event.respondWith(networkFirstApp(request, offlineMessage));
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
