/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

/**
 * WISSen v2 Service Worker.
 *
 * Strategy mirrors the legacy /mobile/ SW:
 * - App shell (HTML/CSS/JS/icons): cache-first, refreshed in background.
 * - /api/*: network-only — never cache (auth/rate-limit must surface).
 * - /floorplans/*: network-first with cache fallback (user edits data.js).
 *
 * SvelteKit injects build/files/version via the $service-worker virtual
 * module. With adapter-static the SW lands at /v2/service-worker.js.
 */

import { build, files, version } from '$service-worker';

const sw = self as unknown as ServiceWorkerGlobalScope;

const CACHE = `tm-v2-${version}`;
const SHELL: readonly string[] = [...build, ...files];

sw.addEventListener('install', (event: ExtendableEvent) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Cache shell, but tolerate failures (a single 404 must not kill install).
    await Promise.all(SHELL.map(async (url) => {
      try {
        const res = await fetch(url, { cache: 'reload' });
        if (res.ok) await cache.put(url, res);
      } catch (_err) {
        /* skip silently */
      }
    }));
    await sw.skipWaiting();
  })());
});

sw.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
    );
    await sw.clients.claim();
  })());
});

sw.addEventListener('fetch', (event: FetchEvent) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Same-origin only — never intercept cross-origin requests.
  if (url.origin !== sw.location.origin) return;

  // /api/*: network-only. Let auth (401) and rate-limit (429) surface.
  if (url.pathname.startsWith('/api/')) return;

  // /floorplans/*: network-first, fall back to cache offline.
  // data.js gets edited via the offline editor; cache-first would
  // serve stale hotspots until a 2nd reload.
  if (url.pathname.startsWith('/floorplans/')) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const fresh = await fetch(req);
        if (fresh.ok && fresh.type === 'basic') {
          cache.put(req, fresh.clone()).catch(() => { /* ignore quota */ });
        }
        return fresh;
      } catch (_err) {
        const cached = await cache.match(req, { ignoreSearch: true });
        return cached ?? new Response('Offline', { status: 503, statusText: 'Offline' });
      }
    })());
    return;
  }

  // Shell: cache-first, then update in background.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: true });
    const networkPromise = fetch(req)
      .then((res) => {
        if (res.ok && res.type === 'basic') {
          cache.put(req, res.clone()).catch(() => { /* ignore quota */ });
        }
        return res;
      })
      .catch(() => null);

    if (cached) {
      // Refresh in background, return cached immediately.
      networkPromise.catch(() => { /* swallow background error */ });
      return cached;
    }
    const fresh = await networkPromise;
    if (fresh) return fresh;

    // Last fallback: shell index for navigation requests (offline).
    if (req.mode === 'navigate') {
      const fallback = await cache.match('/v2/');
      if (fallback) return fallback;
    }
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  })());
});

/* ---------- Web Push ----------
   Mirrors legacy /mobile/sw.js: payload `{ title, body, url, tag }`.
   No-op safe if no push subscription exists yet. */
interface PushPayload {
  title?: string;
  body?: string;
  url?: string;
  tag?: string;
}

sw.addEventListener('push', (event: PushEvent) => {
  let data: PushPayload = {};
  try {
    data = event.data ? (event.data.json() as PushPayload) : {};
  } catch (_err) {
    try {
      data = { title: 'WISSen', body: event.data ? event.data.text() : '' };
    } catch (_err2) {
      data = {};
    }
  }
  const title = data.title ?? 'WISSen';
  const body = data.body ?? '';
  const targetUrl = data.url ?? '/v2/';
  event.waitUntil(
    sw.registration.showNotification(title, {
      body,
      icon: '/assets/icon-192.png',
      badge: '/assets/icon-192.png',
      data: { url: targetUrl },
      tag: data.tag ?? 'wissen',
    })
  );
});

sw.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();
  const data = event.notification.data as { url?: string } | undefined;
  const raw = data?.url ?? '/v2/';
  // Same-Origin-Gate: die Ziel-URL kommt aus dem Push-Payload. Wer den
  // VAPID-Private-Key hält, könnte sonst beliebige externe URLs unter
  // App-Optik öffnen (Phishing). Fremde Origins fallen auf '/v2/' zurück.
  let target = '/v2/';
  try {
    const u = new URL(raw, sw.location.origin);
    if (u.origin === sw.location.origin) target = u.pathname + u.search + u.hash;
  } catch (_err) {
    /* kaputte URL → Fallback /v2/ */
  }
  event.waitUntil((async () => {
    const all = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.indexOf(target) !== -1) {
        await c.focus();
        return;
      }
    }
    if (sw.clients.openWindow) {
      await sw.clients.openWindow(target);
    }
  })());
});

export {};
