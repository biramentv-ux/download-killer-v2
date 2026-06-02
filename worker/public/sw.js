const CACHE_NAME = 'dyrakarmy-static-v4';
const MEDIA_CACHE_NAME = 'dyrakarmy-offline-media-v1';
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys
        .filter((key) => key !== CACHE_NAME && key !== MEDIA_CACHE_NAME)
        .map((key) => caches.delete(key)),
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
    if (response.ok) {
      await cache.put(request, response.clone());
    }
  }));
}

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'WARM_RECENT_CACHE') {
    event.waitUntil(warmRecentCache(data.urls));
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);
  const isWarmableApi = url.pathname.startsWith('/api/file/') || url.pathname.startsWith('/api/archive/file/');
  if (url.pathname.startsWith('/api/') && !isWarmableApi) {
    // API traffic should stay real-time and uncached.
    event.respondWith(fetch(request));
    return;
  }

  if (isWarmableApi && request.headers.has('range')) {
    event.respondWith(fetch(request));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => {
        const cached = await caches.match('/index.html');
        return cached || new Response('Offline', { status: 503 });
      }),
    );
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
