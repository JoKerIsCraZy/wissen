/* ============================================================
   WISSen — Mobile / PWA front-end (shell)
   Hash-Router shell: login overlay, top app-bar, bottom-nav, scroll-mem,
   API client, fresh-marker observer, SSE live-status, service-worker
   registration. The actual view rendering lives in /mobile/views/*.js
   (loaded as plain script tags before this file in index.html).
   ============================================================ */

'use strict';

const STORAGE_TOKEN = 'wissen.authToken';
const API_BASE = ''; // same origin — no extra server config needed.

const $  = (sel, root) => (root || document).querySelector(sel);
const main = $('#main');
const titleEl = $('#appbarTitle');
const backBtn = $('#backBtn');
const refreshBtn = $('#refreshBtn');
const appbarLogo = $('#appbarLogo');
const bottomNav = $('#bottomNav');
const loginOverlay = $('#loginOverlay');
const loginForm = $('#loginForm');
const loginToken = $('#loginToken');
const loginStatus = $('#loginStatus');
const toastEl = $('#toast');

function getToken()   { try { return localStorage.getItem(STORAGE_TOKEN) || ''; } catch (_) { return ''; } }
function setToken(v)  { try { localStorage.setItem(STORAGE_TOKEN, v); } catch (_) {} }
function clearToken() { try { localStorage.removeItem(STORAGE_TOKEN); } catch (_) {} }

function showLogin(msg) {
  loginStatus.textContent = msg || '';
  loginOverlay.hidden = false;
  setTimeout(() => loginToken.focus(), 50);
}
function hideLogin() {
  loginOverlay.hidden = true;
  loginStatus.textContent = '';
  loginToken.value = '';
}

let toastTimer;
function toast(msg, type) {
  toastEl.textContent = msg;
  toastEl.className = 'm-toast' + (type === 'err' ? ' m-toast--err' : '');
  // Fehler interruptiv ankündigen (alert + assertive), Status höflich
  // (status + polite). Wir setzen die Attribute pro Toast neu, damit die
  // gleiche Live-Region beide Tonarten bedienen kann ohne zwei DOM-Knoten.
  if (type === 'err') {
    toastEl.setAttribute('role', 'alert');
    toastEl.setAttribute('aria-live', 'assertive');
  } else {
    toastEl.setAttribute('role', 'status');
    toastEl.setAttribute('aria-live', 'polite');
  }
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 3500);
}

/* ============================================================
   Tiny API client
   ============================================================ */
async function apiFetch(path, opts) {
  const token = getToken();
  if (!token) { showLogin(); throw new Error('no-token'); }
  const headers = Object.assign({}, (opts && opts.headers) || {}, {
    'Authorization': 'Bearer ' + token,
    'Accept': 'application/json'
  });
  if (opts && opts.body && typeof opts.body !== 'string') {
    headers['Content-Type'] = 'application/json';
    opts = Object.assign({}, opts, { body: JSON.stringify(opts.body) });
  }
  const res = await fetch(API_BASE + path, Object.assign({}, opts || {}, { headers }));
  if (res.status === 401) {
    clearToken();
    showLogin('Token ungültig — bitte neu eingeben');
    const e = new Error('Unauthorized'); e.silent = true; throw e;
  }
  if (res.status === 429) {
    let msg = 'Zu viele Anfragen — kurz warten';
    try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (_) {}
    toast(msg, 'err');
    throw new Error(msg);
  }
  if (!res.ok) {
    let msg = 'Fehler ' + res.status;
    try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (_) {}
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  return res.json();
}

/* ============================================================
   Shared helpers (used by view files)
   ============================================================ */
function gradeClass(n) {
  if (n == null) return 'm-grade--none';
  if (n >= 5.0) return 'm-grade--excellent';
  if (n >= 4.0) return 'm-grade--good';
  return 'm-grade--fail';
}
function fmtGrade(n) {
  if (n == null) return '–';
  return n.toFixed(1);
}
function modulNummerOf(kuerzel_code) {
  if (!kuerzel_code) return null;
  const parts = kuerzel_code.split('-');
  if (!parts.length) return null;
  const last = parts[parts.length - 1];
  if (isNaN(parseInt(last, 10)) && parts.length >= 2) {
    const prev = parts[parts.length - 2];
    if (!/^S\d+$/.test(prev)) return prev + '-' + last;
  }
  return last;
}
function buildTitle(kuerzel_code, fach_name) {
  const num = modulNummerOf(kuerzel_code);
  return num ? num + ' — ' + (fach_name || 'Modul') : (fach_name || 'Modul');
}

/* "vor 12 Min", "vor 3h", "vor 2 Tg", "vor 3 Wo", "vor 4 Mt", "vor 1 J".
   Buckets escalate so a 6-week-old timestamp doesn't read as "vor 42 Tg". */
function fmtRelativePast(iso, refMs) {
  if (!iso) return '';
  // SQLite CURRENT_TIMESTAMP comes without 'Z' — normalise to UTC.
  const norm = /Z|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso.replace(' ', 'T') + 'Z';
  const t = new Date(norm).getTime();
  if (!Number.isFinite(t)) return '';
  const diffMs = (refMs || Date.now()) - t;
  if (diffMs < 0) return 'gerade eben';
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'gerade eben';
  if (minutes < 60) return 'vor ' + minutes + ' Min';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return 'vor ' + hours + 'h';
  const days = Math.floor(hours / 24);
  if (days < 14) return 'vor ' + days + ' Tg';
  const weeks = Math.floor(days / 7);
  if (weeks < 9) return 'vor ' + weeks + ' Wo';
  const months = Math.floor(days / 30);
  if (months < 12) return 'vor ' + months + ' Mt';
  const years = Math.floor(days / 365);
  return 'vor ' + years + ' J';
}

/* "in 12 Min", "in 3h 20m" (under 24h gets minute precision), then bucket
   up to "in X Tg / Wo / Mt / J". Mirrors the V2 dashboard so both surfaces
   describe the future the same way. */
function fmtRelativeFuture(targetMs, refMs) {
  const ref = refMs || Date.now();
  const diffMs = targetMs - ref;
  if (diffMs <= 0) return 'jetzt';
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return 'jetzt';
  if (minutes < 60) return 'in ' + minutes + ' Min';
  const totalH = Math.floor(minutes / 60);
  if (totalH < 24) {
    const m = minutes - totalH * 60;
    return m === 0 ? 'in ' + totalH + 'h' : 'in ' + totalH + 'h ' + m + 'm';
  }
  const days = Math.floor(totalH / 24);
  if (days < 14) return 'in ' + days + ' Tg';
  const weeks = Math.floor(days / 7);
  if (weeks < 9) return 'in ' + weeks + ' Wo';
  const months = Math.floor(days / 30);
  if (months < 12) return 'in ' + months + ' Mt';
  const years = Math.floor(days / 365);
  return 'in ' + years + ' J';
}

function loadingShell() {
  main.innerHTML = '<div class="m-loading"><div class="m-spinner"></div>Lade…</div>';
}
function errorShell(msg) {
  const div = document.createElement('div');
  div.className = 'm-error';
  div.textContent = msg;
  main.replaceChildren(div);
}

/* ============================================================
   Frisch-Markierung — IntersectionObserver-Batch
   Sammelt IDs aller .is-fresh Items, die kurz im Viewport waren, und
   sendet sie gebündelt an POST /api/seen. Nach 24h fällt das Item per
   IS_FRESH_SQL serverseitig automatisch aus der Highlight-Logik raus,
   ohne dass der Client weiter etwas tun muss.
   ============================================================ */
const _seenQueue = { noten: new Set(), stundenplan: new Set() };
let _seenFlushTimer = null;
let _seenObserver = null;

function _flushSeen() {
  _seenFlushTimer = null;
  ['noten', 'stundenplan'].forEach((kind) => {
    const set = _seenQueue[kind];
    if (!set.size) return;
    const ids = Array.from(set);
    set.clear();
    apiFetch('/api/seen', { method: 'POST', body: { kind, ids } }).catch(() => {});
  });
}

function _scheduleFlush() {
  if (_seenFlushTimer) return;
  _seenFlushTimer = setTimeout(_flushSeen, 1500);
}

function observeFresh(rootEl) {
  if (typeof IntersectionObserver === 'undefined' || !rootEl) return;
  if (!_seenObserver) {
    _seenObserver = new IntersectionObserver((entries, obs) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const el = entry.target;
        const kind = el.dataset.freshKind;
        const id = el.dataset.freshId;
        if ((kind === 'noten' || kind === 'stundenplan') && id) {
          _seenQueue[kind].add(id);
          _scheduleFlush();
        }
        // Einmalig genügt — Item wurde gesehen, nicht weiter beobachten.
        obs.unobserve(el);
      });
    }, { threshold: 0.6 });
  }
  rootEl.querySelectorAll('[data-fresh-id]').forEach((el) => _seenObserver.observe(el));
}

/* ============================================================
   Hash-router
   ============================================================ */
const routes = {
  '/aktuell':     { title: 'Aktuell',       render: renderAktuell,     tab: 'aktuell',     hasBack: false },
  '/noten':       { title: 'Noten',         render: renderNoten,       tab: 'noten',       hasBack: false },
  '/stundenplan': { title: 'Stundenplan',   render: renderStundenplan, tab: 'stundenplan', hasBack: false },
  '/stats':       { title: 'Statistik',     render: renderStats,       tab: 'stats',       hasBack: false },
  '/absenzen':    { title: 'Absenzen',      render: renderAbsenzen,    tab: 'absenzen',    hasBack: false },
  '/settings':    { title: 'Einstellungen', render: renderSettings,    tab: 'settings',    hasBack: false }
};

function parseHash() {
  const h = window.location.hash || '#/aktuell';
  const raw = h.slice(1);
  const [pathPart, queryPart] = raw.split('?');
  const params = new URLSearchParams(queryPart || '');
  return { path: pathPart || '/noten', params };
}

// Scroll position memory per route, so going back from a Modul-Detail view
// returns the user to where they were instead of jumping to the top.
const scrollPositions = new Map();
let currentRoutePath = null;

// Disable the browser's own scroll-restoration: with a hash router that
// rebuilds the DOM on every nav, the browser's guess is wrong (and races
// our own restore). We do it manually below.
if ('scrollRestoration' in window.history) {
  try { window.history.scrollRestoration = 'manual'; } catch (_) {}
}

function readScrollY() {
  return window.scrollY
      || window.pageYOffset
      || document.documentElement.scrollTop
      || document.body.scrollTop
      || 0;
}
function saveCurrentScroll() {
  if (currentRoutePath) {
    scrollPositions.set(currentRoutePath, readScrollY());
  }
}
function restoreScroll(path) {
  const y = scrollPositions.get(path);
  const target = y != null ? y : 0;
  // Wait two frames so the freshly rendered list has a final layout height
  // before we scroll — otherwise the browser clamps to a too-small max.
  // Then re-assert once more after a short delay to beat any late layout
  // shift (image loads, font swap, sticky header re-measure).
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      window.scrollTo(0, target);
      setTimeout(() => window.scrollTo(0, target), 50);
    });
  });
}

// Eagerly save the current scroll position the moment the user taps
// anything that will trigger a hash change (e.g. a Modul-Card link, the
// bottom-nav tabs). This runs in the capture phase BEFORE the browser
// updates the URL, so window.scrollY is guaranteed to still hold the
// position the user actually saw.
document.addEventListener('click', (ev) => {
  const a = ev.target && ev.target.closest && ev.target.closest('a[href]');
  if (!a) return;
  const href = a.getAttribute('href') || '';
  if (href.charAt(0) !== '#') return;
  saveCurrentScroll();
}, true);

/* Tab-Transition Trigger.
 *
 * Triggert die CSS-Animation '.m-main--enter' (siehe shell.css) NACH dem
 * View-Render. Der Trick:
 *   1. classList.remove() — alte Animation killen, falls noch laufend
 *      (consecutive Tab-Switches: User klickt schnell mehrere Tabs).
 *   2. void el.offsetHeight — Force-Reflow. Ohne diesen Read-Access
 *      wuerde der Browser remove + add im selben Frame zusammenfassen
 *      und gar keine Animation rendern.
 *   3. classList.add() — Animation startet sauber neu.
 *
 * Warum nicht document.startViewTransition? Wuerde Promise-Chains rund
 * um die scrollRestore-Logik (zwei rAF + setTimeout) verkomplizieren
 * und ist kein "drastically reduced" Pattern wie es Tab-Switches mit
 * >100/Tag-Frequenz brauchen. CSS-Only ist hier praeziser. */
function triggerEnterAnimation() {
  if (!main) return;
  main.classList.remove('m-main--enter');
  // eslint-disable-next-line no-unused-expressions
  void main.offsetHeight;
  main.classList.add('m-main--enter');
}

async function route() {
  if (!getToken()) { showLogin(); return; }
  const { path, params } = parseHash();

  // Snapshot scroll of the outgoing route before we tear down the DOM.
  saveCurrentScroll();

  // Dynamic /modul/:id route
  const modulMatch = path.match(/^\/modul\/(.+)$/);
  if (modulMatch) {
    const id = decodeURIComponent(modulMatch[1]);
    const codeHint = params.get('code') || null;
    setBackButton(true);
    setActiveTab(null);
    appbarLogo.hidden = true;
    refreshBtn.hidden = true;
    currentRoutePath = path;
    await renderModul(id, codeHint);
    // Animation NACH dem Render: sonst sieht der User noch den alten
    // Content waehrend des Fade-Ins. Vor restoreScroll triggern, damit
    // beide Effekte (Fade + Scroll) parallel zum Frame-Start laufen.
    triggerEnterAnimation();
    restoreScroll(path);
    return;
  }

  const r = routes[path];
  if (!r) { window.location.hash = '#/aktuell'; return; }

  setBackButton(false);
  setActiveTab(r.tab);
  appbarLogo.hidden = false;
  refreshBtn.hidden = false;
  currentRoutePath = path;
  await r.render();
  // Tab-Transition: Fade-In nachdem die View ihren neuen DOM gemounted
  // hat. Bei consecutive Switches (schnelles Klicken durch die Tabs)
  // killt triggerEnterAnimation() die alte Animation per remove + reflow
  // und startet sauber neu — kein gestapelter Wackel-Effekt.
  triggerEnterAnimation();
  // Deep-link with ?focus=<id>: the view will scroll the focused card into
  // view itself. Skip restoreScroll so its scrollTo doesn't race / override
  // the view's scrollIntoView.
  if (!params.has('focus')) restoreScroll(path);
}

function setActiveTab(tab) {
  bottomNav.querySelectorAll('.m-tab').forEach((el) => {
    if (tab && el.dataset.route === tab) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  });
}
function setBackButton(visible) {
  backBtn.hidden = !visible;
}

/* ============================================================
   SSE — Server-Sent Events für Live-Status. Pattern wie Dashboard.
   Reconnect mit exponentiellem Backoff. Token kommt via Query-String,
   weil EventSource keine Custom-Headers setzen kann.
   ============================================================ */
function connectSSE() {
  const token = getToken();
  if (!token) return;
  try {
    sse = new EventSource('/api/events?token=' + encodeURIComponent(token));
  } catch (_) {
    return;
  }
  sseEverOpened = false;

  sse.onopen = () => {
    sseReconnectDelay = 1000;
    sseEverOpened = true;
  };
  sse.onerror = () => {
    const wasClosed = sse && sse.readyState === 2;
    try { if (sse) sse.close(); } catch (_) {}
    sse = null;
    // Wenn der erste Connect schon scheitert: nicht ewig spammen
    if (!sseEverOpened && wasClosed) return;
    setTimeout(connectSSE, sseReconnectDelay);
    sseReconnectDelay = Math.min(sseReconnectDelay * 2, 15000);
  };
  sse.onmessage = (evt) => handleSseEvent(evt.data);
  ['status', 'log', 'progress'].forEach((name) => {
    sse.addEventListener(name, (evt) => handleSseEvent(evt.data, name));
  });
}

function handleSseEvent(raw, typeHint) {
  let payload;
  try { payload = JSON.parse(raw); } catch (_) { return; }
  if (typeHint === 'log') return;     // Logs interessieren uns mobile nicht
  if (typeHint === 'progress' || typeHint === 'status' || (typeHint == null && payload && (payload.running != null || payload.currentPhase != null))) {
    updateStatus(payload);
  }
}

function updateStatus(status) {
  const wasRunning = scrapeState.scraping;
  scrapeState.status = status;
  scrapeState.scraping = !!status.running;
  reRenderScrapeCardIfMounted();
  // Lauf gerade beendet? Bei MANUELLER Abfrage eine Bestätigung zeigen.
  if (wasRunning && !status.running && scrapeState.manualRunPending) {
    scrapeState.manualRunPending = false;
    if (status.lastError) toast('Abfrage fehlgeschlagen', 'err');
    else toast('Abfrage erfolgreich abgeschlossen');
  }
  // Wenn ein Scrape gerade beendet wurde und wir die Noten/Stundenplan-View
  // gerade offen haben → einmal frisch laden.
  if (wasRunning && !status.running && !status.lastError) {
    const { path } = parseHash();
    if (path === '/noten' || path === '/stundenplan') {
      saveCurrentScroll();
      const reload = path === '/noten' ? renderNoten() : renderStundenplan();
      Promise.resolve(reload).then(() => restoreScroll(path));
    }
  }
}

async function fetchInitialStatus() {
  try {
    const status = await apiFetch('/api/status');
    if (status) updateStatus(status);
  } catch (_) { /* Best-effort beim Boot */ }
}

/* ============================================================
   Service-Worker registration
   ============================================================ */
// Last SW-registration error (surfaced in Settings → Diagnose).
let lastSWError = null;

/* ============================================================
   Scrape state — gespeist aus /api/status (initial) + SSE 'status'
   Events. Rendered in Settings als Card (renderScrapeCard lebt in
   views/settings.js).
   ============================================================ */
const scrapeState = {
  status: null,            // letzter Snapshot von /api/status
  scraping: false,
  manualRunPending: false, // true ab manuellem "Jetzt abfragen" bis zur Bestätigung
  lastSeenRunId: null      // damit wir nach Scrape-Ende einmal Daten reloaden
};
let scrapeTimerHandle = null;

let sse = null;
let sseReconnectDelay = 1000;
let sseEverOpened = false;

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    lastSWError = 'serviceWorker API fehlt im navigator';
    return null;
  }
  try {
    // Scope = "/pwa-demo/mobile/" — explicit so SW only intercepts /mobile/* requests.
    const reg = await navigator.serviceWorker.register('/pwa-demo/mobile/sw.js', { scope: '/pwa-demo/mobile/' });
    lastSWError = null;
    return reg;
  } catch (e) {
    lastSWError = (e && e.message) ? e.message : String(e);
    console.warn('SW registration failed:', e);
    return null;
  }
}

/* ============================================================
   Boot
   ============================================================ */
backBtn.addEventListener('click', () => {
  if (window.history.length > 1) window.history.back();
  else window.location.hash = '#/aktuell';
});
refreshBtn.addEventListener('click', route);

bottomNav.addEventListener('click', (ev) => {
  const a = ev.target.closest('.m-tab');
  if (!a) return;
  // Let the browser handle the hash change; route() runs on hashchange.
});

window.addEventListener('hashchange', route);

loginForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const t = loginToken.value.trim();
  if (!t) { loginStatus.textContent = 'Bitte Token eingeben.'; return; }
  setToken(t);
  // Probe with /api/settings — cheap + auth-required.
  try {
    await apiFetch('/api/settings');
    hideLogin();
    if (!window.location.hash) window.location.hash = '#/aktuell';
    else route();
    // Nach erfolgreichem Login: Live-Status + SSE starten
    fetchInitialStatus();
    connectSSE();
  } catch (e) {
    clearToken();
    if (!e.silent) loginStatus.textContent = e.message || 'Login fehlgeschlagen';
  }
});

(function boot() {
  registerServiceWorker();
  if (!getToken()) { showLogin(); return; }
  if (!window.location.hash) window.location.hash = '#/aktuell';
  else route();
  // Initial-Status + SSE für Live-Updates der Scrape-Card
  fetchInitialStatus();
  connectSSE();
})();

/* ============================================================
   Cross-file linkage — declared here so static analysers (CodeQL) see
   that these top-level helpers + module-globals are intentionally
   consumed by sibling view files (views/*.js) loaded as separate
   <script>s. Without this, CodeQL flags each as "unused local"
   because single-file analysis can't see the cross-script use.
   ============================================================ */
void titleEl;
void gradeClass;
void fmtGrade;
void buildTitle;
void fmtRelativePast;
void fmtRelativeFuture;
void loadingShell;
void errorShell;
void observeFresh;
void scrapeTimerHandle;
