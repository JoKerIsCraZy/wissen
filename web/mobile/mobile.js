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
const loginEyeBtn = $('#loginEyeBtn');
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
  // Token value wird hier geleert — nur auf SUCCESS-Pfad (hideLogin wird
  // nur nach erfolgreichem Login aufgerufen). Auf Login-Fehler bleibt der
  // Token-Wert im Input erhalten, damit der User korrigieren kann statt
  // alles neu zu tippen.
  loginToken.value = '';
}

let toastTimer;
let toastExitTimer;
/* toast(msg, type)
 * toast(msg, { type, actionLabel, onAction, duration })
 *
 * Backwards-compatible API: zweites Argument darf 'err' string sein
 * (Legacy-Calls). Mit Options-Objekt unterstützt der Toast einen Action-
 * Button (z. B. "Neu laden" für SW-Updates). Action-Toasts halten 8s
 * statt 3.5s — User braucht länger um eine Entscheidung zu treffen. */
function toast(msg, opts) {
  const isOptsObj = opts && typeof opts === 'object';
  const type = isOptsObj ? opts.type : opts;
  const actionLabel = isOptsObj ? opts.actionLabel : null;
  const onAction = isOptsObj ? opts.onAction : null;
  const duration = isOptsObj && opts.duration ? opts.duration : (actionLabel ? 8000 : 3500);

  // Body aufbauen — entweder reiner Text, oder Text + Action-Button.
  // Wir setzen den DOM, nicht innerHTML, damit msg-Strings sicher sind
  // (kein versehentliches XSS aus z. B. SSE-Status-Strings).
  toastEl.replaceChildren();
  const textNode = document.createElement('span');
  textNode.className = 'm-toast__text';
  textNode.textContent = msg;
  toastEl.append(textNode);
  if (actionLabel && typeof onAction === 'function') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'm-toast__action';
    btn.textContent = actionLabel;
    btn.addEventListener('click', () => {
      try { onAction(); } catch (_) {}
      // Toast sofort schließen nach Action
      clearTimeout(toastTimer);
      clearTimeout(toastExitTimer);
      toastEl.classList.add('m-toast--exiting');
      toastExitTimer = setTimeout(() => { toastEl.hidden = true; }, 240);
    });
    toastEl.append(btn);
  }

  toastEl.className = 'm-toast'
    + (type === 'err' ? ' m-toast--err' : '')
    + (actionLabel ? ' m-toast--action' : '');
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
  clearTimeout(toastExitTimer);
  toastTimer = setTimeout(() => {
    // Exit-Animation: erst Klasse setzen damit toastOut keyframe läuft,
    // nach 240ms hidden=true. Sonst poppt der Toast einfach weg.
    toastEl.classList.add('m-toast--exiting');
    toastExitTimer = setTimeout(() => { toastEl.hidden = true; }, 240);
  }, duration);
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
  // Offline-Glance: der Service-Worker markiert aus dem Cache gelieferte
  // Antworten mit X-WN-Offline: 1. Header VOR dem Body lesen (Body lässt
  // sich nur einmal konsumieren). Nach dem Parsen den globalen Banner-Zustand
  // setzen: zwischengespeicherter Stand → Banner zeigen (mit fetchedAt-Zeit
  // falls vorhanden), frische Online-Antwort → Banner ausblenden.
  const offlineStale = res.headers.get('X-WN-Offline') === '1';
  if (res.status === 204) {
    setOfflineGlance(offlineStale ? true : null);
    return null;
  }
  const data = await res.json();
  setOfflineGlance(offlineStale ? (data && data.fetchedAt ? data.fetchedAt : true) : null);
  return data;
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

/* Offline-Glance — absoluter, lesbarer Zeitstempel für den zwischen-
   gespeicherten Stand (de-CH). Anders als fmtRelativePast bewusst absolut
   ("Stand von 28.05., 14:07"): bei Offline-Daten will der User den konkreten
   Zeitpunkt sehen, nicht eine relative Spanne, die ohne Netz ohnehin
   einfriert. Gibt '' zurück wenn der ISO-String nicht parsebar ist — der
   Aufrufer fällt dann auf den generischen Text zurück. */
function fmtOfflineStamp(iso) {
  if (!iso) return '';
  const norm = /Z|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso.replace(' ', 'T') + 'Z';
  const d = new Date(norm);
  if (!Number.isFinite(d.getTime())) return '';
  try {
    return d.toLocaleString('de-CH', {
      day: '2-digit', month: '2-digit',
      hour: '2-digit', minute: '2-digit'
    });
  } catch (_) {
    return '';
  }
}

/* Offline-Glance-Banner — eine einzige, globale, dünne Leiste unter der
   AppBar. Idempotent: das Element wird beim ersten Bedarf einmal erzeugt und
   danach nur noch sein Text/hidden-Zustand aktualisiert (nicht pro View neu).
   aria-live="polite" — der Hinweis ist informativ, nicht interruptiv.

   state === null      → Banner ausblenden (frische Online-Daten).
   state === true       → generischer Text (Header gesetzt, aber kein
                          fetchedAt im Body, z. B. bei 204).
   state = ISO-String   → "Offline · Stand von <Datum, Uhrzeit>". */
let offlineGlanceEl = null;

function ensureOfflineGlanceEl() {
  if (offlineGlanceEl) return offlineGlanceEl;
  const el = document.createElement('div');
  el.className = 'm-offline';
  el.id = 'offlineGlance';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.hidden = true;
  // Status nie nur über Farbe: ein Glyph trägt die "offline"-Bedeutung
  // zusätzlich zur warning-Tönung. aria-hidden, der Text sagt es schon.
  const glyph = document.createElement('span');
  glyph.className = 'm-offline__glyph';
  glyph.setAttribute('aria-hidden', 'true');
  glyph.textContent = '⌁';
  const label = document.createElement('span');
  label.className = 'm-offline__label';
  el.append(glyph, label);
  // Direkt nach der AppBar, vor dem Main-Container einhängen: schiebt den
  // Content sauber nach unten statt ihn zu überlagern, und verschwindet ohne
  // Platz zu reservieren, sobald hidden gesetzt ist ([hidden] → display:none).
  const appbar = document.querySelector('.m-appbar');
  if (appbar && appbar.parentNode) appbar.insertAdjacentElement('afterend', el);
  else if (main && main.parentNode) main.parentNode.insertBefore(el, main);
  offlineGlanceEl = el;
  return el;
}

function setOfflineGlance(state) {
  // Kein Banner nötig und noch nie eines erzeugt → nichts tun (kein DOM-Müll).
  if (state == null && !offlineGlanceEl) return;
  const el = ensureOfflineGlanceEl();
  if (state == null) {
    el.hidden = true;
    return;
  }
  const stamp = typeof state === 'string' ? fmtOfflineStamp(state) : '';
  const label = el.querySelector('.m-offline__label');
  label.textContent = stamp
    ? 'Offline · Stand von ' + stamp
    : 'Offline · zwischengespeicherter Stand';
  el.hidden = false;
}

function loadingShell() {
  main.innerHTML = '<div class="m-loading"><div class="m-spinner"></div>Lade…</div>';
}

/* Skeleton-Shells je View. Statt eines Spinners zeigen wir Silhouetten
 * der erwarteten Layouts — gefühlte Latenz sinkt, weil der User schon
 * sieht "wo was kommt". Shimmer respektiert prefers-reduced-motion (CSS).
 * Fällt für unbekannte Views auf den klassischen Spinner zurück. */
function skeletonShell(viewName) {
  if (!main) return;
  let html = '';
  if (viewName === 'noten') {
    html =
      '<div class="m-skel m-skel--hero"></div>' +
      '<div class="m-skel m-skel--sem"></div>' +
      '<div class="m-skel-chips">' +
        '<div class="m-skel m-skel--chip"></div>' +
        '<div class="m-skel m-skel--chip"></div>' +
        '<div class="m-skel m-skel--chip"></div>' +
        '<div class="m-skel m-skel--chip"></div>' +
      '</div>' +
      '<div class="m-skel m-skel--card"></div>' +
      '<div class="m-skel m-skel--card"></div>' +
      '<div class="m-skel m-skel--card"></div>';
  } else if (viewName === 'stundenplan') {
    html =
      '<div class="m-skel m-skel--day"></div>' +
      '<div class="m-skel m-skel--plan"></div>' +
      '<div class="m-skel m-skel--plan"></div>' +
      '<div class="m-skel m-skel--day"></div>' +
      '<div class="m-skel m-skel--plan"></div>';
  } else if (viewName === 'aktuell') {
    html =
      '<div class="m-skel m-skel--now"></div>' +
      '<div class="m-skel-tiles">' +
        '<div class="m-skel m-skel--tile"></div>' +
        '<div class="m-skel m-skel--tile"></div>' +
      '</div>';
  } else if (viewName === 'stats') {
    // Stats-Skeleton: 2×2-Hero-KPIs, dann zwei Karten-Silhouetten für
    // Spark + Modul-Statistik. IPA-Rechner darunter wird durch eine
    // dritte Card-Silhouette angedeutet. Reuse die existing m-skel-Tokens
    // damit der Shimmer konsistent bleibt.
    html =
      '<div class="m-skel m-skel--hero"></div>' +
      '<div class="m-skel m-skel--card"></div>' +
      '<div class="m-skel m-skel--card"></div>' +
      '<div class="m-skel m-skel--card"></div>';
  } else {
    // Unbekannte View → klassischer Spinner als Fallback
    loadingShell();
    return;
  }
  main.innerHTML = '<div class="m-skel-wrap" aria-busy="true" aria-label="Lädt…">' + html + '</div>';
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
  // Defensive cleanup: connectSSE() wird auch von Login-Success + boot()
  // aufgerufen. Ohne diesen Guard sammeln sich parallele EventSources mit
  // duplicate Listenern → handleSseEvent feuert N-mal pro Event.
  if (sse) {
    try { sse.close(); } catch (_) {}
    sse = null;
  }
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
  // Wenn ein Scrape gerade beendet wurde und wir die Noten/Stundenplan-View
  // gerade offen haben → einmal frisch laden.
  if (wasRunning && !status.running && !status.lastError) {
    const { path } = parseHash();
    if (path === '/noten' || path === '/stundenplan' || path === '/stats') {
      saveCurrentScroll();
      const reload = path === '/noten'
        ? renderNoten()
        : path === '/stundenplan'
          ? renderStundenplan()
          : renderStats();
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
    // Scope = "/mobile/" — explicit so SW only intercepts /mobile/* requests.
    const reg = await navigator.serviceWorker.register('/mobile/sw.js', { scope: '/mobile/' });
    lastSWError = null;
    return reg;
  } catch (e) {
    lastSWError = (e && e.message) ? e.message : String(e);
    console.warn('SW registration failed:', e);
    return null;
  }
}

/* SW-Update-Listener + Proaktive Update-Checks
 * =============================================
 *
 * Der neue Service Worker postet { type: 'sw-update' } sobald er nach
 * clients.claim() die alten Caches abgeräumt hat. Wir zeigen einen
 * Action-Toast mit "Neu laden" — User entscheidet selbst wann er
 * refresht (kein erzwungenes location.reload, das einen laufenden Login
 * oder ungesicherten State zerstören würde).
 *
 * Proaktive Update-Checks (sonst hängt ein langer Tab in der alten SW-
 * Generation fest weil der Browser nur einmal pro Navigation prüft):
 *
 *   1. visibilitychange → reg.update() wenn Tab wieder sichtbar wird
 *      (typisch nach App-Switch / Display-Off-Phase)
 *   2. focus → reg.update() bei Window-Focus (Desktop)
 *   3. 15min-Interval → periodischer Check während offener Tab
 *
 * Alle Calls sind no-op wenn keine SW-Registration existiert (HTTP-only,
 * Browser unterstützt's nicht, etc.) — kein Boot-Lärm. 30s-Throttle damit
 * vielfach-feuernde visibilitychange/focus-Events den Browser nicht spammen. */
if ('serviceWorker' in navigator) {
  try {
    navigator.serviceWorker.addEventListener('message', (ev) => {
      const data = ev && ev.data;
      if (data && data.type === 'sw-update') {
        toast('Update verfügbar — Tab neu laden', {
          actionLabel: 'Neu laden',
          onAction: () => { try { location.reload(); } catch (_) {} }
        });
      }
    });
  } catch (_) { /* iOS Safari hat hier vereinzelt Errors — ignorieren */ }

  let lastUpdateCheck = 0;
  function checkForSwUpdate() {
    const now = Date.now();
    if (now - lastUpdateCheck < 30 * 1000) return;
    lastUpdateCheck = now;
    navigator.serviceWorker.getRegistration('/mobile/')
      .then((reg) => { if (reg) reg.update().catch(() => {}); })
      .catch(() => {});
  }

  // Composite Update-Check: SW-Registration-Update + App-Version-Check.
  // Läuft periodisch und on-demand über den "Update prüfen"-Button.
  //
  // MUSS in diesem Block definiert sein: checkForSwUpdate ist hier
  // block-scoped (strict mode). Stünde runAllUpdateChecks auf Top-Level,
  // würde der Bezeichner `checkForSwUpdate` stattdessen auf die globale
  // window.checkForSwUpdate auflösen — und die zeigt auf runAllUpdateChecks
  // selbst → Endlos-Rekursion (RangeError: Maximum call stack size).
  function runAllUpdateChecks() {
    checkForSwUpdate();
    checkForAppRelease();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') runAllUpdateChecks();
  });
  window.addEventListener('focus', runAllUpdateChecks);
  setInterval(runAllUpdateChecks, 15 * 60 * 1000);

  // Expose composite check für expliziten "Update prüfen"-Button in Settings.
  window.checkForSwUpdate = runAllUpdateChecks;
}

/* ============================================================
   Release-Update Modal (GitHub-Upstream-Check)
   ============================================================
   Pollt /api/version. Wenn der Server meldet dass eine neuere Version
   auf GitHub veröffentlicht ist (upstream.tag > installierte Version,
   semver-verglichen serverseitig), zeigen wir ein Modal-Popup MAX 1×
   pro Release-Tag. Tag-Dismiss wird in localStorage gespeichert —
   sobald GitHub einen NEUEN Release published kommt das Modal wieder.

   30s-Throttle + token-Gate. Polling-only — funktioniert auch ohne SW. */
const RELEASE_DISMISS_KEY = 'wissen.dismissedReleaseTag';
let releaseModalShown = false;
let lastVersionCheck = 0;

function getDismissedReleaseTag() {
  try { return localStorage.getItem(RELEASE_DISMISS_KEY) || null; } catch (_) { return null; }
}
function setDismissedReleaseTag(tag) {
  try { localStorage.setItem(RELEASE_DISMISS_KEY, tag); } catch (_) {}
}

function showReleaseUpdateModal(versionData) {
  if (releaseModalShown) return;
  if (!versionData || !versionData.upstream || !versionData.upstream.tag) return;
  releaseModalShown = true;

  const overlay = document.createElement('div');
  overlay.className = 'm-release-overlay';
  overlay.setAttribute('role', 'presentation');

  const modal = document.createElement('div');
  modal.className = 'm-release';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'm-release-title');

  const published = versionData.upstream.publishedAt
    ? new Date(versionData.upstream.publishedAt).toLocaleDateString('de-CH', {
        day: '2-digit', month: '2-digit', year: 'numeric'
      })
    : '';
  const releaseName = (versionData.upstream.name && versionData.upstream.name !== versionData.upstream.tag)
    ? versionData.upstream.name : '';
  const body = (versionData.upstream.body || '').trim();

  // textContent für User-controlled Strings (XSS-safe) — innerHTML nur für
  // statisches Markup + SVG. Body-Strings werden via DOM-API gesetzt.
  modal.innerHTML =
    '<header class="m-release__head">' +
      '<div class="m-release__icon" aria-hidden="true">' +
        '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
          '<polyline points="20 6 9 17 4 12"/>' +
        '</svg>' +
      '</div>' +
      '<h2 id="m-release-title" class="m-release__title">Neue Version verfügbar</h2>' +
      '<button type="button" class="m-release__close" aria-label="Schließen">' +
        '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>' +
        '</svg>' +
      '</button>' +
    '</header>' +
    '<div class="m-release__body">' +
      '<div class="m-release__versions">' +
        '<div class="m-release__version-row"><span>Installiert</span><strong></strong></div>' +
        '<div class="m-release__version-row m-release__version-row--new"><span>Neueste</span><strong></strong></div>' +
      '</div>' +
      '<p class="m-release__release-name" hidden></p>' +
      '<p class="m-release__published" hidden></p>' +
      '<div class="m-release__notes" hidden>' +
        '<div class="m-release__notes-label">Release-Notes</div>' +
        '<div class="m-release__notes-body"></div>' +
      '</div>' +
    '</div>' +
    '<footer class="m-release__foot">' +
      '<a class="m-release__btn m-release__btn--primary" target="_blank" rel="noopener noreferrer">Auf GitHub ansehen' +
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="margin-left:4px;vertical-align:-1px;">' +
          '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>' +
          '<polyline points="15 3 21 3 21 9"/>' +
          '<line x1="10" y1="14" x2="21" y2="3"/>' +
        '</svg>' +
      '</a>' +
      '<button type="button" class="m-release__btn m-release__btn--ghost">Später</button>' +
    '</footer>';

  // User-controlled Strings sicher via textContent setzen
  const rows = modal.querySelectorAll('.m-release__version-row strong');
  rows[0].textContent = 'v' + (versionData.version || 'unknown');
  rows[1].textContent = versionData.upstream.tag;
  if (releaseName) {
    const el = modal.querySelector('.m-release__release-name');
    el.textContent = releaseName;
    el.hidden = false;
  }
  if (published) {
    const el = modal.querySelector('.m-release__published');
    el.textContent = 'Veröffentlicht am ' + published;
    el.hidden = false;
  }
  // Markdown-Rendering: bodyHtml ist server-seitig via marked schon
  // gerendertes HTML (trusted source = unser eigener GitHub-Releases).
  // Fallback auf raw body als textContent wenn bodyHtml fehlt
  // (z.B. wenn marked beim parsen failed).
  const bodyHtml = versionData.upstream.bodyHtml;
  if (bodyHtml || body) {
    const wrap = modal.querySelector('.m-release__notes');
    const bodyEl = wrap.querySelector('.m-release__notes-body');
    if (bodyHtml) {
      bodyEl.innerHTML = bodyHtml;
      bodyEl.classList.add('m-release__notes-body--rendered');
    } else {
      bodyEl.textContent = body;
      bodyEl.classList.add('m-release__notes-body--raw');
    }
    wrap.hidden = false;
  }
  modal.querySelector('.m-release__btn--primary').href = versionData.upstream.url;

  overlay.append(modal);
  document.body.append(overlay);

  const prevOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';

  function close() {
    setDismissedReleaseTag(versionData.upstream.tag);
    overlay.classList.add('is-closing');
    document.body.style.overflow = prevOverflow;
    document.removeEventListener('keydown', onKey);
    setTimeout(() => { try { overlay.remove(); } catch (_) {} }, 220);
  }
  function onKey(e) { if (e.key === 'Escape') close(); }

  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  modal.querySelector('.m-release__close').addEventListener('click', close);
  modal.querySelector('.m-release__btn--ghost').addEventListener('click', close);
  document.addEventListener('keydown', onKey);

  // Auto-focus close für Tastatur/SR-User
  requestAnimationFrame(() => {
    const closeBtn = modal.querySelector('.m-release__close');
    if (closeBtn) closeBtn.focus({ preventScroll: true });
  });
}

async function checkForAppRelease() {
  if (!getToken()) return;
  if (releaseModalShown) return;
  const now = Date.now();
  if (now - lastVersionCheck < 30 * 1000) return;
  lastVersionCheck = now;
  try {
    const data = await apiFetch('/api/version');
    if (!data || !data.updateAvailable || !data.upstream || !data.upstream.tag) return;
    if (getDismissedReleaseTag() === data.upstream.tag) return;
    showReleaseUpdateModal(data);
  } catch (_) { /* silent — apiFetch zeigt selbst Login bei fehlendem Token */ }
}

// Falls 'serviceWorker' nicht im navigator existiert (= der SW-Block oben
// hat seine Listener nicht registriert), brauchen wir hier eigene Triggers
// für den App-Version-Check.
if (!('serviceWorker' in navigator)) {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkForAppRelease();
  });
  window.addEventListener('focus', checkForAppRelease);
  setInterval(checkForAppRelease, 15 * 60 * 1000);
  window.checkForSwUpdate = checkForAppRelease;
}

// Initial Baseline-Stash: einmal beim Boot. Wenn der User noch nicht
// eingeloggt ist, ist's ein No-op (getToken() ist leer) — der erste
// echte Stash passiert dann nach dem Login auf dem nächsten periodic
// check.
checkForAppRelease();

/* ============================================================
   Boot
   ============================================================ */
backBtn.addEventListener('click', () => {
  if (window.history.length > 1) window.history.back();
  else window.location.hash = '#/aktuell';
});
/* Refresh-Button: visuelles Feedback (Spin + aria-busy) während route()
 * läuft. try/finally garantiert dass der Spin-State auch bei Errors wieder
 * aufgeräumt wird — sonst dreht sich der Button für immer. */
refreshBtn.addEventListener('click', async () => {
  refreshBtn.classList.add('m-appbar__icon--spinning');
  refreshBtn.setAttribute('aria-busy', 'true');
  try {
    await route();
  } finally {
    refreshBtn.classList.remove('m-appbar__icon--spinning');
    refreshBtn.removeAttribute('aria-busy');
  }
});

bottomNav.addEventListener('click', (ev) => {
  const a = ev.target.closest('.m-tab');
  if (!a) return;
  // Let the browser handle the hash change; route() runs on hashchange.
});

window.addEventListener('hashchange', route);

// Eye-Button: Token-Sichtbarkeit togglen. aria-pressed spiegelt den State
// wider, die zwei SVGs (eye-on / eye-off) wechseln per [hidden]-Attribut —
// kein zweites Img-Asset, alles inline.
if (loginEyeBtn) {
  loginEyeBtn.addEventListener('click', () => {
    const nowVisible = loginToken.type === 'password'; // wird sichtbar nach toggle
    loginToken.type = nowVisible ? 'text' : 'password';
    loginEyeBtn.setAttribute('aria-pressed', String(nowVisible));
    loginEyeBtn.setAttribute('aria-label', nowVisible ? 'Token verbergen' : 'Token anzeigen');
    const on = loginEyeBtn.querySelector('.m-login__eye-on');
    const off = loginEyeBtn.querySelector('.m-login__eye-off');
    // eye-on (offenes Auge) zeigt "klick um zu sehen" → sichtbar wenn versteckt
    // eye-off (durchgestrichen) zeigt "klick um zu verstecken" → sichtbar wenn sichtbar
    if (on)  on.hidden  = nowVisible;
    if (off) off.hidden = !nowVisible;
  });
}

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
    // Token-Eingabe bleibt erhalten, damit der User korrigieren statt
    // alles neu eintippen muss. apiFetch räumt bei 401 selbst auf
    // (clearToken + showLogin); bei anderen Fehlern lassen wir den
    // (möglicherweise gültigen) Token in localStorage stehen.
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
