// Service Worker for Digital Canteen Book PWA
const CACHE_NAME = 'canteen-book-v2';
const STATIC_ASSETS = [
  '/',
  '/style.css',
  '/logo.svg',
  '/manifest.json',
];

// Install - cache static assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activate - clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch - network first, fallback to cache (for API calls use network only)
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // API calls - always network
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // SSE - always network
  if (event.request.headers.get('Accept') === 'text/event-stream') {
    event.respondWith(fetch(event.request));
    return;
  }

  // Static assets - cache first, then network
  event.respondWith(
    caches.match(event.request).then(cached => {
      const fetched = fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached);
      return cached || fetched;
    })
  );
});
