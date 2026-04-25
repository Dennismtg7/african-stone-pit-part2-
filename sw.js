/* ============================================================
   Stone Pit – Chain Capture Pro  |  Service Worker  v1.0
   ============================================================ */

const APP_VERSION   = 'stonepit-v1.0';
const STATIC_CACHE  = `${APP_VERSION}-static`;
const DYNAMIC_CACHE = `${APP_VERSION}-dynamic`;
const OFFLINE_PAGE  = '/offline.html';

/* ── Files to pre-cache on install (app shell) ── */
const STATIC_FILES = [
  '/',
  '/index.html',
  '/manifest.json',
  '/offline.html',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  /* External fonts — cache on first fetch via dynamic cache */
];

/* ── External origins we are happy to cache dynamically ── */
const CACHEABLE_ORIGINS = [
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',
  'https://cdnjs.cloudflare.com',
];

/* ============================================================
   INSTALL — pre-cache the app shell
   ============================================================ */
self.addEventListener('install', event => {
  console.log('[SW] Installing Stone Pit v1.0…');
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => cache.addAll(STATIC_FILES))
      .then(() => {
        console.log('[SW] App shell cached ✓');
        return self.skipWaiting(); // activate immediately
      })
      .catch(err => console.warn('[SW] Pre-cache failed:', err))
  );
});

/* ============================================================
   ACTIVATE — delete old caches
   ============================================================ */
self.addEventListener('activate', event => {
  console.log('[SW] Activating…');
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== STATIC_CACHE && k !== DYNAMIC_CACHE)
          .map(k => {
            console.log('[SW] Deleting old cache:', k);
            return caches.delete(k);
          })
      )
    ).then(() => self.clients.claim()) // take control immediately
  );
});

/* ============================================================
   FETCH — Network-first for API calls, Cache-first for assets
   ============================================================ */
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  /* 1. Skip non-GET and browser-extension requests */
  if (request.method !== 'GET') return;
  if (url.protocol === 'chrome-extension:') return;

  /* 2. M-Pesa / IntaSend API — always network only (payment must be live) */
  if (url.hostname.includes('intasend.com') ||
      url.hostname.includes('mpesa') ||
      url.pathname.includes('/api/')) {
    event.respondWith(networkOnly(request));
    return;
  }

  /* 3. PeerJS signalling — always network */
  if (url.hostname.includes('peerjs') || url.hostname.includes('0.peerjs.com')) {
    event.respondWith(networkOnly(request));
    return;
  }

  /* 4. HTML pages — Network first, fall back to cache, then offline page */
  if (request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(networkFirstWithOfflineFallback(request));
    return;
  }

  /* 5. Static assets (JS, CSS, fonts, images) — Cache first, then network */
  if (isCacheableAsset(url)) {
    event.respondWith(cacheFirstWithNetworkFallback(request));
    return;
  }

  /* 6. Everything else — Network first */
  event.respondWith(networkFirstWithOfflineFallback(request));
});

/* ============================================================
   STRATEGIES
   ============================================================ */

/** Always fetch from network, never cache */
async function networkOnly(request) {
  try {
    return await fetch(request);
  } catch {
    return new Response(
      JSON.stringify({ error: 'Network unavailable' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/** Try network first; on failure serve cached version or offline page */
async function networkFirstWithOfflineFallback(request) {
  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      const cache = await caches.open(DYNAMIC_CACHE);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    // For navigation requests show offline page
    if (request.mode === 'navigate') {
      const offlinePage = await caches.match(OFFLINE_PAGE);
      if (offlinePage) return offlinePage;
    }
    return new Response('Offline', { status: 503 });
  }
}

/** Serve from cache immediately; update cache in background */
async function cacheFirstWithNetworkFallback(request) {
  const cached = await caches.match(request);
  if (cached) {
    // Background refresh (stale-while-revalidate)
    refreshCache(request);
    return cached;
  }
  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      const cache = await caches.open(DYNAMIC_CACHE);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch {
    return new Response('Asset unavailable offline', { status: 503 });
  }
}

/** Silently refresh a cached resource in the background */
function refreshCache(request) {
  fetch(request)
    .then(response => {
      if (response.ok) {
        caches.open(DYNAMIC_CACHE)
          .then(cache => cache.put(request, response));
      }
    })
    .catch(() => {}); // silent fail
}

/** Returns true for assets worth caching (fonts, scripts, styles, images) */
function isCacheableAsset(url) {
  const ext = url.pathname.split('.').pop().toLowerCase();
  const cacheableExtensions = ['js','css','woff','woff2','ttf','png','jpg','jpeg','svg','ico','webp'];
  if (cacheableExtensions.includes(ext)) return true;
  if (CACHEABLE_ORIGINS.some(origin => url.href.startsWith(origin))) return true;
  return false;
}

/* ============================================================
   PUSH NOTIFICATIONS (future use)
   ============================================================ */
self.addEventListener('push', event => {
  if (!event.data) return;
  const data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.title || 'Stone Pit', {
      body:    data.body    || "It's your turn!",
      icon:    '/icons/icon-192.png',
      badge:   '/icons/icon-96.png',
      vibrate: [200, 100, 200],
      data:    { url: data.url || '/' },
      actions: [
        { action: 'play', title: '▶ Play Now' },
        { action: 'dismiss', title: 'Dismiss' }
      ]
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'dismiss') return;
  const targetUrl = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(windowClients => {
        for (const client of windowClients) {
          if (client.url === targetUrl && 'focus' in client) {
            return client.focus();
          }
        }
        if (clients.openWindow) return clients.openWindow(targetUrl);
      })
  );
});

/* ============================================================
   BACKGROUND SYNC (for queued moves when offline)
   ============================================================ */
self.addEventListener('sync', event => {
  if (event.tag === 'sync-game-moves') {
    event.waitUntil(syncGameMoves());
  }
});

async function syncGameMoves() {
  // Placeholder: in future, sync offline moves to server
  console.log('[SW] Background sync: game moves');
}

console.log('[SW] Stone Pit Service Worker loaded ✓');
