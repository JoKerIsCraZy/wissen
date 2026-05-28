/* ============================================================
   WISSen — Service Worker
   Strategy:
   - App shell (HTML/CSS/JS/Icons): cache-first, refreshed in background
   - API responses (/api/*): network-only — never cache (always fresh,
     never serve auth-protected JSON from cache by accident)
   ============================================================ */
'use strict';

const VERSION = 'wn-9';
const SHELL_CACHE = 'wn-shell-' + VERSION;

const SHELL_URLS = [
  '/mobile/',
  '/mobile/index.html',
  '/mobile/css/base.css',
  '/mobile/css/shell.css',
  '/mobile/css/cards.css',
  '/mobile/css/views.css',
  '/mobile/css/now.css',
  '/mobile/css/stats.css',
  '/mobile/css/responsive.css',
  '/mobile/mobile.js',
  '/mobile/views/aktuell.js',
  '/mobile/views/noten.js',
  '/mobile/views/stundenplan.js',
  '/mobile/views/modul.js',
  '/mobile/views/modul-sheet.js',
  '/mobile/views/scrape.js',
  '/mobile/views/push.js',
  '/mobile/views/settings.js',
  '/mobile/views/stats.js',
  '/mobile/manifest.webmanifest',
  '/floorplans/data.js',
  '/floorplans/raumview.js',
  '/floorplans/raumview.css',
  '/assets/logo.webp',
  '/assets/icon-192.png',
  '/assets/icon-512.png',
  '/assets/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  // Pro URL einzeln cachen — eine 404 darf den ganzen Install nicht killen.
  // (cache.addAll() ist all-or-nothing und das hat in der Vergangenheit
  // PWA-Install verhindert wenn ein einziges Asset fehlte.)
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await Promise.all(SHELL_URLS.map(async (url) => {
      try {
        const res = await fetch(url, { cache: 'reload' });
        if (res && res.ok) await cache.put(url, res);
      } catch (_) { /* skip silently */ }
    }));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== SHELL_CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
    // Notify all open clients that a new SW has taken over → der Client
    // zeigt einen Reload-Toast. Wir broadcasten nur wenn alte Caches
    // tatsächlich entfernt wurden (Indikator: es gab andere Cache-Keys),
    // damit der erste Install keinen falschen Update-Toast triggert.
    const hadOldCaches = keys.some((k) => k !== SHELL_CACHE);
    if (hadOldCaches) {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      clients.forEach((c) => {
        try { c.postMessage({ type: 'sw-update', version: VERSION }); } catch (_) {}
      });
    }
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Same-origin only
  if (url.origin !== self.location.origin) return;

  // API: never cache. Let it go to network so 401/429 surface correctly.
  if (url.pathname.startsWith('/api/')) return;

  // Shell: cache-first, then update in background.
  event.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const cached = await cache.match(req, { ignoreSearch: true });
    const networkPromise = fetch(req).then((res) => {
      // Only cache successful, basic responses
      if (res && res.status === 200 && res.type === 'basic') {
        cache.put(req, res.clone()).catch(() => {});
      }
      return res;
    }).catch(() => null);

    if (cached) {
      // Refresh in background, return cached immediately.
      networkPromise.catch(() => {});
      return cached;
    }
    const fresh = await networkPromise;
    if (fresh) return fresh;
    // Last fallback: shell index for navigation requests (offline)
    if (req.mode === 'navigate') {
      const idx = await cache.match('/mobile/index.html');
      if (idx) return idx;
    }
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  })());
});

/* ----- Push notification handler (placeholder) -----
   Will receive payloads { title, body, url } from the server once
   web-push is wired up. Safe to ship now: no-op if no push subscription
   exists yet.
   --------------------------------------------------- */
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) {
    try { data = { title: 'WISSen', body: event.data ? event.data.text() : '' }; } catch (__) {}
  }
  const title = data.title || 'WISSen';
  const body  = data.body  || '';
  const url   = data.url   || '/mobile/';
  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: '/assets/icon-192.png',
    badge: '/assets/icon-192.png',
    data: { url },
    tag: data.tag || 'wissen'
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/mobile/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.indexOf(target) !== -1) { c.focus(); return; }
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});
