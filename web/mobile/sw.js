/* ============================================================
   WISSen — Service Worker
   Strategy:
   - App shell (HTML/CSS/JS/Icons): cache-first, refreshed in background
   - API responses (/api/*): network-only — never cache (always fresh,
     never serve auth-protected JSON from cache by accident)
   - Ausnahme „Offline-Glance": die 3 read-only-GET-Endpoints
     /api/noten, /api/stundenplan, /api/stats sind network-first mit
     cache-fallback. Online = immer frisch (401/429/Fehler tauchen normal
     auf, nur 200 wird gecacht), offline = letzter Stand mit X-WN-Offline.
   ============================================================ */
'use strict';

const VERSION = 'wn-26';
const SHELL_CACHE = 'wn-shell-' + VERSION;
const API_CACHE = 'wn-api-' + VERSION;

// Nur diese read-only-GETs sind offline-fähig (exakte pathname-Gleichheit).
// Eigene Noten auf dem eigenen Gerät → threat-model-konform.
const OFFLINE_GLANCE_PATHS = ['/api/noten', '/api/stundenplan', '/api/stats', '/api/absenzen'];

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
  '/mobile/views/absenz-sheet.js',
  '/mobile/views/absenzen.js',
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
    // SHELL_CACHE und API_CACHE der aktuellen VERSION behalten, alles andere löschen.
    await Promise.all(
      keys.filter(k => k !== SHELL_CACHE && k !== API_CACHE).map(k => caches.delete(k))
    );
    await self.clients.claim();
    // Notify all open clients that a new SW has taken over → der Client
    // zeigt einen Reload-Toast. Wir broadcasten nur wenn alte Caches
    // tatsächlich entfernt wurden (Indikator: es gab andere Cache-Keys),
    // damit der erste Install keinen falschen Update-Toast triggert.
    const hadOldCaches = keys.some((k) => k !== SHELL_CACHE && k !== API_CACHE);
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

  // Offline-Glance: nur die 3 read-only-GETs sind network-first + cache-fallback.
  // Online → immer frisch (nur 200 wird gecacht, 401/429/Fehler tauchen normal auf).
  // Offline → letzter gecachter Stand, markiert via X-WN-Offline, damit der Client
  // „Stand von ..." anzeigen kann. match() inkl. query → pro Filter eigener Eintrag.
  if (OFFLINE_GLANCE_PATHS.includes(url.pathname)) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.status === 200) {
          (await caches.open(API_CACHE)).put(req, fresh.clone()).catch(() => {});
        }
        return fresh;
      } catch (_) {
        const cache = await caches.open(API_CACHE);
        const cached = await cache.match(req);
        if (cached) {
          const buf = await cached.clone().arrayBuffer();
          const headers = new Headers(cached.headers);
          headers.set('X-WN-Offline', '1');
          return new Response(buf, { status: 200, statusText: 'OK (cache)', headers });
        }
        return new Response(JSON.stringify({ error: 'offline' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json', 'X-WN-Offline': '1' }
        });
      }
    })());
    return;
  }

  // API: never cache. Let it go to network so 401/429 surface correctly.
  // Alle übrigen /api/* bleiben unverändert network-only.
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
  const raw = (event.notification.data && event.notification.data.url) || '/mobile/';
  // Same-Origin-Gate: die Ziel-URL kommt aus dem Push-Payload. Wer den
  // VAPID-Private-Key hält, könnte sonst beliebige externe URLs unter
  // App-Optik öffnen (Phishing). Relative Pfade bleiben erlaubt, fremde
  // Origins fallen auf die App-Root zurück.
  let target = '/mobile/';
  try {
    const u = new URL(raw, self.location.origin);
    if (u.origin === self.location.origin) target = u.pathname + u.search + u.hash;
  } catch (_) { /* kaputte URL → Fallback /mobile/ */ }
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.indexOf(target) !== -1) { c.focus(); return; }
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});
