/**
 * server.js — Express HTTP-Server + Scheduler für Tocco WISS Scraper.
 *
 * Start:
 *   npm run serve
 *
 * Endpoints siehe README / Inline-Kommentare in den Route-Modulen.
 *
 * Diese Datei macht NUR drei Dinge:
 *   1. .env via shared/envLoader laden
 *   2. Express-App aus Modulen zusammensetzen
 *   3. HTTP-Server + Scheduler + Bot booten
 *
 * Die Logik selbst wohnt in:
 *   - src/auth.js          → Token-Bootstrap, Auth-Middleware
 *   - src/ratelimits.js    → 5 Rate-Limit-Layer (Factory)
 *   - src/scheduler.js     → computeNextRun, Wochen-Refresh, Timer
 *   - src/runScrape.js     → runScrapeCycle + maskSettings + Push
 *   - src/sse.js           → SSE-Broadcast, statusPayload, setPhase
 *   - src/state.js         → geteilter mutable State-Container
 *   - src/pushValidate.js  → Push-Subscription-Validator (SSRF-Whitelist)
 *   - src/routes/*.js      → einzelne Routen-Factories
 */

'use strict';

const path = require('node:path');
const http = require('node:http');

// ---------- .env → process.env (vor allen weiteren requires) ----------
// Lädt .env-Werte in process.env, ohne bereits gesetzte ENV-Vars zu überschreiben
// (Docker's env_file + shell-env haben Vorrang).
const { applyToProcess: applyEnv } = require('./shared/envLoader');
applyEnv(path.join(process.cwd(), '.env'));

const express = require('express');
const helmet = require('helmet');

const settings = require('./settings');
const logger = require('./logger');
const scraper = require('./scraper');
const db = require('./db');
const bot = require('./bot');

const state = require('./state');
const auth = require('./auth');
const ratelimitsFactory = require('./ratelimits');
const schedulerMod = require('./scheduler');
const sse = require('./sse');
const runScrapeMod = require('./runScrape');
const routes = require('./routes');
const { apiError } = require('./shared/apiError');

// web-push ist optional — wenn das Paket fehlt (z.B. nach git-clone ohne npm install)
// laufen Endpoints / Scrape-Block ohne Push weiter und loggen einen Hinweis.
let push;
try {
  push = require('./push');
  push.init();
  logger.log('🔔 Web-Push initialisiert (VAPID public ' + push.getPublicKey().slice(0, 12) + '…)');
} catch (e) {
  push = null;
  logger.log('⚠️  Web-Push deaktiviert: ' + (e && e.message ? e.message : 'unbekannt'), 'warn');
}

// settings.js darf über Logger warnen (UI-Patch-Drops, etc.)
if (typeof settings.setLogger === 'function') {
  settings.setLogger(logger);
}

// =============================================================
// Token + Env-Flags
// =============================================================

const { token: API_TOKEN, generated: API_TOKEN_GENERATED } = auth.ensureApiToken({ logger });
// ALLOW_UI_CREDENTIALS default: true seit v1.0.0. Secrets in settings.json
// werden mit AES-256-GCM verschlüsselt (siehe secretCrypto.js, Master-Key
// in data/.master-key). Damit ist der "Bequemlichkeit-vs-Sicherheit"-Trade-Off
// vertretbar verschoben: bei Backup-Leak von data/ (ohne .env) bleiben die
// Secrets unbrauchbar, weil der Master-Key zwar im selben Volume liegt aber
// im Backup-Pfad oft separat behandelt wird. Operatoren können explizit auf
// false setzen wenn sie Secrets nur via .env akzeptieren wollen.
const ALLOW_UI_CREDENTIALS = auth.parseBoolEnv(process.env.ALLOW_UI_CREDENTIALS, true);

// =============================================================
// Logger → SSE wiring
// =============================================================
sse.wireLoggerToSse(logger);

// =============================================================
// Scheduler + runScrapeCycle (zirkuläre Abhängigkeit auflösen)
// =============================================================
// scheduler braucht runScrapeCycle (Timer-Callback)
// runScrape braucht scheduler (post-cycle re-schedule)
// → Beide via Factory bauen, scheduler bekommt runScrapeCycle nachträglich
//   gesetzt; runScrapeCycle ruft scheduler.scheduleNext lazy.
let runScrapeCycleRef = null;
const scheduler = schedulerMod.init({
  state,
  settings,
  logger,
  runScrapeCycle: (reason) => runScrapeCycleRef(reason)
});
scheduler.bindSse(() => sse.broadcastStatus(settings, state));

const runScrape = runScrapeMod.create({
  state, db, scraper, bot, push, settings, logger, sse, scheduler
});
runScrapeCycleRef = runScrape.runScrapeCycle;
const runScrapeCycle = runScrape.runScrapeCycle;

// =============================================================
// Settings-Subscriber → Scheduler reschedule
// =============================================================
// Async-dispatch via queueMicrotask: PATCH /api/settings ruft settings.save(),
// das ruft alle Subscriber synchron — wenn wir hier scheduleNext() blocking
// machen, hängt die HTTP-Response bis der Reschedule durch ist. Mit microtask
// returnt PATCH sofort und der Reschedule läuft danach.
settings.subscribe((next, prev) => {
  const relevant = (prev.autoRun !== next.autoRun)
    || (prev.intervalMinutes !== next.intervalMinutes)
    || (prev.intervalTimeFrom !== next.intervalTimeFrom)
    || (prev.intervalTimeTo !== next.intervalTimeTo)
    || (prev.scheduleMode !== next.scheduleMode)
    || (JSON.stringify(prev.scheduleDays) !== JSON.stringify(next.scheduleDays))
    || (JSON.stringify(prev.scheduleTimes) !== JSON.stringify(next.scheduleTimes));
  if (relevant) {
    queueMicrotask(() => {
      try {
        logger.log(`🔧 Settings geändert — Scheduler reschedule (mode=${next.scheduleMode}, autoRun=${next.autoRun})`, 'info');
        scheduler.scheduleNext();
      } catch (e) {
        logger.log('⚠️  Subscribe-Listener (scheduleNext) Fehler: ' + (e && e.message ? e.message : e), 'warn');
      }
    });
  }
});

// =============================================================
// Express App
// =============================================================

const app = express();

// ---------- DB Singleton (open once, share across routes/bot/scrape/push) ----------
// Migrations + reclassifyOtherPruefungen laufen genau einmal beim Boot statt
// pro Request. WAL-Mode + ein einziger Writer (runScrape) macht das safe.
// Vorgezogen vor `/healthz/ready` damit der Handler-Closure die `database`-
// Variable garantiert assigned sieht (TDZ-frei) und der Boot-Race nicht
// existieren kann.
const database = db.openOnce();

// Prepared Statement für /healthz/ready DB-Ping einmal beim Boot bauen
// statt pro Request — spart ~1ms + GC-pressure unter Health-Probe-Last.
const _readyPingStmt = database.prepare('SELECT 1 AS ok');

// Constant-time-Token-Compare für /healthz/ready Auth-Gate (sensible Felder)
const _healthTokensMatch = auth.makeTokensMatch(API_TOKEN);

// ETag global deaktivieren. Hintergrund:
//   - /api/*-Responses sind dynamisch (status/noten/logs/version) und sollten
//     nie aus dem Cache kommen. Express setzt per Default einen ETag, was bei
//     Clients ohne If-None-Match-Roundtrip zu stale 304-Bodies via Proxies/SW
//     führen kann.
//   - Static-Assets liefern ihre eigenen Cache-Header (siehe routes/static.js,
//     SvelteKit-immutable + no-cache für sw.js/manifest). ETag würde da nur
//     unnötig Bytes erzeugen.
app.set('etag', false);

// Trust-Proxy aus env-var, default 'loopback' (nur einem Proxy auf 127.0.0.1
// wird geglaubt). Wichtig damit rate-limit die echte Client-IP sieht (sonst
// zählen alle User hinter dem Proxy auf einen Counter). Hinter einem Reverse-
// Proxy auf demselben Host passt der Default; bei einem Proxy auf einer
// anderen Maschine TRUST_PROXY=1 setzen, bei Multi-Hop (z.B. CF → nginx → app)
// entsprechend 2. Akzeptiert auch 'true'/'false' oder eine CIDR-Liste.
const _trustProxy = auth.parseTrustProxy(process.env.TRUST_PROXY, logger);
// Sicherheits-Warnungen: TRUST_PROXY=true erlaubt IP-Spoofing über
// X-Forwarded-For (Rate-Limit-Counters per gefälschter IP umgehbar).
// Hop-Counts > 10 sind selten valide — wahrscheinlich Tippfehler.
if (_trustProxy === true) {
  logger.log('⚠️  TRUST_PROXY=true → ALLE X-Forwarded-For-Header werden vertraut. IP-Spoofing möglich, Rate-Limit pro IP wird wirkungslos. Setze stattdessen die Anzahl Hops (1, 2, …) oder eine CIDR-Liste.', 'warn');
}
if (typeof _trustProxy === 'number' && _trustProxy > 10) {
  logger.log(`⚠️  TRUST_PROXY=${_trustProxy} ist ungewöhnlich hoch (>10 Hops). Konfiguration prüfen.`, 'warn');
}
app.set('trust proxy', _trustProxy);

// ---------- Migrationshilfe für den TRUST_PROXY-Default ----------
// Bis v4 war der Default 1 Hop, d.h. X-Forwarded-For wurde blind übernommen.
// Der Default ist jetzt 'loopback'. Für Setups mit Reverse-Proxy auf einem
// ANDEREN Host ändert sich dadurch die als Client gesehene IP: alle Requests
// zählen dann auf den Bucket des Proxys statt auf den des echten Clients.
//
// Das ist sicher (ein direkter Client kann req.ip nicht mehr fälschen), aber
// der Operator soll es merken statt es stillschweigend zu erben. Diese
// Middleware feuert genau dann EINMAL, wenn ein Request einen XFF-Header
// mitbringt, den wir nicht honorieren — also exakt im betroffenen Fall.
let _xffWarned = false;
if (process.env.TRUST_PROXY == null || process.env.TRUST_PROXY === '') {
  app.use((req, _res, next) => {
    if (!_xffWarned && req.get('X-Forwarded-For')) {
      // req.ip === Socket-Peer bedeutet: der Header wurde NICHT angewandt.
      const peer = req.socket && req.socket.remoteAddress;
      if (peer && req.ip === peer) {
        _xffWarned = true;
        logger.log(
          `⚠️  X-Forwarded-For empfangen (von ${peer}), aber TRUST_PROXY ist nicht gesetzt — ` +
          `der Header wird ignoriert und Rate-Limits zählen auf die Proxy-IP. ` +
          `Steht ein Reverse-Proxy davor, setze TRUST_PROXY=1 (bzw. die Anzahl Hops ` +
          `oder eine CIDR-Liste deiner Proxies). Ohne Proxy ist der Default korrekt so.`,
          'warn'
        );
      }
    }
    next();
  });
}

// ---------- Security Headers ----------
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // 'unsafe-inline' zugelassen, weil SvelteKit (dist/index.html) einen
      // inline-Bootstrap-Block schreibt (lädt /_app/immutable/entry/*.js).
      // TODO(csp-nonce): adapter-static prerendert das HTML zur Build-Zeit,
      // d.h. ein per-Request-Nonce kann nicht in die fertige Datei injiziert
      // werden. Migrationspfade:
      //   a) HTML-Rewrite-Middleware vor express.static (regex-Injektion, fragil)
      //   b) SvelteKit csp.mode='hash' → SHA256-Hashes via <meta>-Tag im Build
      //   c) Wechsel zu adapter-node mit serverseitigem Rendering
      // Single-User-Tool ohne user-generated HTML → 'unsafe-inline' bleibt
      // ein akzeptables Trade-off bis (b) oder (c) umgesetzt sind.
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      // Helmet Default aktiviert upgrade-insecure-requests — zwingt Browser
      // alle http:// Subresources auf https: umzubiegen. Bei LAN/HTTP-Deployments
      // bricht das CSS/JS mit ERR_SSL_PROTOCOL_ERROR. Entfernen via null.
      upgradeInsecureRequests: null
    }
  },
  // HSTS deaktivieren — LAN/HTTP-Default ohne TLS würde sonst den Browser
  // auf https: zwingen (ERR_SSL_PROTOCOL_ERROR). Reverse-Proxy setzt HSTS selbst.
  strictTransportSecurity: false
}));

// Push-, Seen- und Dismiss-Endpoints haben kleine, well-formed Bodies — engerer
// Limit schützt vor Spam-Subscriptions/Replay. Settings ebenfalls eng gekappt
// (auch volle UI-Config ist <2 KB JSON). Globaler Default 8 KB ist ausreichend
// für alle übrigen API-Bodies und schützt vor accidental-large-paste.
app.use('/api/push', express.json({ limit: '4kb' }));
app.use('/api/seen', express.json({ limit: '4kb' }));
app.use('/api/dismiss', express.json({ limit: '4kb' }));
app.use('/api/settings', express.json({ limit: '4kb' }));
app.use(express.json({ limit: '8kb' }));

// Cache-Control für alle /api/*-Responses: no-store.
// Begründung: API-Responses sind dynamisch (Status, Noten-Liste, Logs)
// und sollten nicht von Browser-, Service-Worker- oder Reverse-Proxy-
// Caches gespeichert werden. ETag-basiertes 304 wäre theoretisch
// optimaler, aber unsere Clients senden kein If-None-Match → stattdessen
// würden sie das gecachte 304-Response mit altem Body sehen.
// `/healthz` ist explizit ausgenommen (für Docker-Healthcheck-Polling OK)
// — der Prefix `/api/` matched dort sowieso nicht.
app.use('/api/', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// ---------- Healthcheck (unauthenticated, BEFORE auth) ----------
//
// /healthz       → dumb liveness probe (Process läuft, Express antwortet)
// /healthz/ready → deep readiness probe (DB pingbar, Scrape nicht stuck,
//                  Scheduler-Zustand, last-Error) — Docker HEALTHCHECK soll
//                  diesen nutzen, externe Alerts auch. Antwortet 503 wenn was
//                  nicht stimmt (DB tot ODER Scrape > 10 min im selben Phase).
//
// Sensible Felder (nextRun, lastError, currentPhase, lastStats, phaseStartedAt)
// werden NUR mit gültigem Bearer-Token returned. Default-Payload bleibt
// minimal (ok, time, version) damit Docker-HEALTHCHECK ohne Auth funktioniert
// aber kein Internals an Unauthentifizierte leaked.
app.get('/healthz', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Health-Limiter VOR der Route mounten (path-prefix-scoped, damit normale
// /api/-Limiter unberührt bleiben).
const _healthRatelimits = ratelimitsFactory.create({ logger });
app.use('/healthz/ready', _healthRatelimits.healthLimiter);

app.get('/healthz/ready', (req, res) => {
  // Auth-Detection ohne harten 401-Bounce — Docker-Probe ohne Token darf
  // immer noch ein {ok, time, version} bekommen.
  let authed = false;
  const authHeader = req.get('Authorization');
  if (authHeader && /^Bearer\s+/i.test(authHeader)) {
    const provided = authHeader.replace(/^Bearer\s+/i, '').trim();
    authed = _healthTokensMatch(provided);
  }

  let ok = true;
  let dbStatus = 'ok';

  // 1) DB-Ping via hoisted prepared statement
  try {
    const row = _readyPingStmt.get();
    if (!row || row.ok !== 1) {
      dbStatus = 'unexpected_row';
      ok = false;
    }
  } catch (e) {
    dbStatus = 'error: ' + (e && e.message ? e.message : String(e));
    ok = false;
  }

  // 2) Scrape-Stuck-Check (always evaluated — affects ok-status)
  const stuckMs = state.running && state.phaseStartedAt
    ? Date.now() - Date.parse(state.phaseStartedAt)
    : 0;
  const scrapeStuck = state.running && stuckMs > 10 * 60 * 1000;
  if (scrapeStuck) ok = false;

  // 3) Version aus package.json (always public)
  let version = 'unknown';
  try {
    const pkg = require('../package.json');
    version = pkg.version || 'unknown';
  } catch (_) { /* swallow */ }

  // Minimal-Payload (immer)
  const payload = {
    ok,
    time: new Date().toISOString(),
    version
  };

  // Auth-gated: sensible Internals nur mit gültigem Bearer-Token
  if (authed) {
    payload.db = dbStatus;
    payload.scheduler = {
      nextRun: state.nextRun || null,
      autoRun: (() => {
        try { return Boolean(settings.load().autoRun); } catch (_) { return false; }
      })()
    };
    payload.scrape = {
      running: Boolean(state.running),
      phase: state.currentPhase || null,
      stuckForSec: Math.round(stuckMs / 1000),
      ...(scrapeStuck ? { warning: 'phase stuck > 10min' } : {})
    };
    payload.lastError = state.lastError || null;
    payload.lastRun = state.lastRun || null;
    payload.lastStats = state.lastStats || null;
  }

  res.status(ok ? 200 : 503).json(payload);
});

// ---------- Rate Limits (BEFORE auth) ----------
// WICHTIG: globalLimiter mit Path-Prefix `/api/` mounten, NICHT global.
// Global gemountet zählte jeder Static-Asset-Request (Mobile-CSS, Svelte
// Immutable-Chunks, /assets/*, /floorplans/*) gegen das 300/5min-Budget —
// ein einziger PWA-Cold-Load brannte 20-40 Slots. User hit 429 quickly,
// Static-Asset-429s waren dabei unsichtbar (broken CSS/JS, kein Toast).
// Die anderen Limiter (auth-failure, auth-brute-force, sse-failure) haben
// eigene `skip: !isApiPath(req.path)` Predicates — sie überspringen also alles
// AUSSERHALB von /api/ und greifen auf /api/ selbst. Dadurch sind sie
// path-safe und bleiben global gemountet, damit ihr internal-Routing greift.
// isApiPath() vergleicht case-normalisiert, damit der Geltungsbereich der
// Limiter deckungsgleich mit dem der (case-insensitiv matchenden) Router ist —
// byte-exakt liess sich der Lockout via `/API/...` komplett umgehen.
const ratelimits = ratelimitsFactory.create({ logger });
app.use('/api/', ratelimits.globalLimiter);
app.use(ratelimits.authFailureLimiter);
app.use(ratelimits.authBruteForceLockout);
app.use(ratelimits.sseFailureLimiter);

// ---------- Auth Middleware (protect /api/*) ----------
app.use(auth.requireAuth({ token: API_TOKEN, logger }));

// ---------- API routes ----------
routes.mountAll(app, {
  state, db, database, settings, logger, scraper, bot, push, sse,
  runScrapeCycle, ratelimits, ALLOW_UI_CREDENTIALS
});

// ---------- Static Web-UI Fallback ----------
require('./routes/static')(app);

// ---------- Error Handler ----------
// 4xx-aware: client-side errors (z.B. body-parser-Reject bei zu großem JSON
// oder Syntax-Error → 400) sollen NICHT als "Unhandled 500" geloggt werden
// und sollen dem Client die echte Fehlermeldung returnen statt einem
// generischen "Interner Fehler". Nur 5xx (echte Server-Bugs) loggen wir laut.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = (err && (err.status || err.statusCode)) || 500;
  if (status >= 500) {
    logger.log('❌ Unhandled: ' + (err && err.message ? err.message : err), 'error');
  }
  const message = status < 500
    ? (err && err.message ? err.message : 'Bad Request')
    : 'Interner Fehler';
  apiError(res, status, message);
});

// =============================================================
// Boot
// =============================================================

function bootBanner() {
  const s = settings.load();
  const masked = runScrapeMod.maskSettings(s, ALLOW_UI_CREDENTIALS);
  logger.log('─'.repeat(60), 'info');
  logger.log(`WISSen Server gestartet`, 'info');
  logger.log(`   Port:           ${s.port}`, 'info');
  logger.log(`   autoRun:        ${s.autoRun}`, 'info');
  logger.log(`   intervalMin:    ${s.intervalMinutes}`, 'info');
  logger.log(`   email:          ${masked.emailSet ? 'gesetzt' : '(leer)'}`, 'info');
  logger.log(`   password:       ${masked.passwordSet ? 'gesetzt' : '(leer)'}`, 'info');
  logger.log(`   baseUrl:        ${s.baseUrl}`, 'info');
  logger.log(`   allowUiCreds:   ${ALLOW_UI_CREDENTIALS}`, 'info');
  logger.log(`   API-Token:      ${API_TOKEN_GENERATED ? 'auto-generiert (data/.api-token)' : 'env (API_TOKEN)'}`, 'info');
  logger.log(`   DB-Pfad:        ${path.join(auth.DATA_DIR, 'wissen.db')}`, 'info');
  logger.log('─'.repeat(60), 'info');
}

const server = http.createServer(app);

const initial = settings.load();
server.listen(initial.port, '0.0.0.0', () => {
  bootBanner();
  logger.log(`🌍 Web-UI:  http://localhost:${initial.port}/`, 'info');
  logger.log(`🌍 LAN:      http://0.0.0.0:${initial.port}/  (auf allen Interfaces)`, 'info');
  if (initial.autoRun) {
    scheduler.scheduleNext();
  } else {
    logger.log('ℹ️  autoRun=false → kein Auto-Scheduler. Trigger via POST /api/scrape oder Web-UI.', 'info');
  }

  // Wöchentlicher Detail-Refresh läuft IMMER, unabhängig von autoRun.
  // Findet neue ZP/LB die durch den Modulnoten-Push übersehen wurden
  // (Edge-Case ZP=5.5 + LB=5.5 → Schnitt unverändert).
  scheduler.loadWeeklyDetailState();
  if (state.lastWeeklyDetailAt) {
    logger.log(`🗓️  Letzter Wochen-Check: ${schedulerMod.formatLocalDateTime(state.lastWeeklyDetailAt)}`, 'info');
  }
  scheduler.scheduleWeeklyDetailRefresh();

  // Telegram-Bot starten wenn aktiviert
  if (initial.telegramEnabled && initial.telegramToken && initial.telegramAllowedUserId) {
    bot.start({
      token: initial.telegramToken,
      allowedUserId: initial.telegramAllowedUserId,
      // null → privater Chat des Whitelist-Users (Default). Nur setzen, wenn
      // der Bot bewusst in einer Gruppe laufen soll.
      allowedChatId: initial.telegramAllowedChatId,
      logger,
      triggerScrape: async () => {
        if (state.running) return { triggered: false, reason: 'bereits aktiv' };
        runScrapeCycle('telegram').catch(() => {});
        return { triggered: true };
      },
      getStatus: () => ({
        running: state.running,
        lastRun: state.lastRun,
        nextRun: state.nextRun,
        lastError: state.lastError,
        enabled: settings.load().autoRun,
        intervalMinutes: settings.load().intervalMinutes,
        currentPhase: state.currentPhase,
        phaseStartedAt: state.phaseStartedAt,
        lastStats: state.lastStats,
        lastWeeklyDetailAt: state.lastWeeklyDetailAt,
        nextWeeklyRun: (() => {
          if (!state.weeklyTimer) return null;
          // Approximation: rechne den nächsten Slot
          return schedulerMod.nextWeeklyDetailRun().toISOString();
        })()
      })
    }).catch(e => logger.log('Telegram-Bot Start fehlgeschlagen: ' + e.message, 'error'));
  } else if (initial.telegramToken || initial.telegramAllowedUserId) {
    logger.log('ℹ️  Telegram teilweise konfiguriert — setze telegramEnabled=true, telegramToken, telegramAllowedUserId um zu aktivieren.', 'info');
  }
});

// =============================================================
// Graceful Shutdown
// =============================================================

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.log(`🛑 ${signal} empfangen — fahre Server runter...`, 'warn');
  scheduler.clearTimer();
  scheduler.clearWeeklyTimer();
  try { bot.stop(); } catch (_) {}

  // Auf laufenden Scrape warten (bis zu 30s). Ohne diesen Wait kappt der
  // alte 5s-force-exit jeden Scrape mitten in der Persist-Phase → Playwright-
  // Zombie + half-written storage.json + dirty WAL. Watchdog (runScrape.js)
  // limitiert Scrapes ohnehin auf SCRAPE_TIMEOUT_MS, plus der 35s-hard-exit
  // unten greift falls hier irgendwas hängt.
  if (state.running) {
    logger.log('⏳ Warte auf laufende Abfrage (bis 30s)...', 'info');
    const waitStart = Date.now();
    while (state.running && Date.now() - waitStart < 30000) {
      await new Promise(r => setTimeout(r, 500));
    }
    if (state.running) {
      logger.log('⚠️  Abfrage nach 30s noch aktiv — Shutdown fährt trotzdem fort', 'warn');
    } else {
      logger.log('✅ Abfrage rechtzeitig beendet', 'info');
    }
  }

  // SSE-Clients beenden
  for (const client of sse.sseClients) {
    try { client.end(); } catch (_) {}
  }
  sse.sseClients.clear();

  // DB-Singleton schließen (vor server.close, weil danach evtl. inflight
  // Handler noch auf den Handle zugreifen — aber WAL-Mode toleriert das).
  try { db.closeInstance(); } catch (_) {}

  server.close(() => {
    logger.log('👋 Server geschlossen.', 'info');
    process.exit(0);
  });

  // Fallback: harter Exit nach 35s (30s scrape-wait + 5s buffer)
  setTimeout(() => {
    logger.log('⏳ Forced exit nach 35s', 'warn');
    process.exit(1);
  }, 35000).unref();
}

process.on('SIGINT', () => { shutdown('SIGINT').catch(() => {}); });
process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => {}); });

// unhandledRejection: nicht-fatal loggen + Counter. Bei >5 in 60s wird der
// Prozess heruntergefahren (Docker `restart: unless-stopped` startet ihn sauber
// neu). So bleibt eine kurzlebige Reject-Storm nicht silent in undefined-state
// stecken.
let _unhandledRejectionsRecent = [];
process.on('unhandledRejection', (reason) => {
  logger.log('❌ unhandledRejection: ' + (reason && reason.message ? reason.message : reason), 'error');
  const now = Date.now();
  _unhandledRejectionsRecent.push(now);
  _unhandledRejectionsRecent = _unhandledRejectionsRecent.filter(t => now - t < 60000);
  if (_unhandledRejectionsRecent.length > 5) {
    logger.log('💥 >5 unhandledRejection in 60s — graceful shutdown wird ausgelöst', 'error');
    shutdown('unhandledRejection-storm').catch(() => {});
  }
});

// uncaughtException: undefined process state — Node 22 würde ohne Handler
// terminieren. Wir wollen aber kontrolliertes Shutdown (DB close, SSE close,
// Bot stop) + Docker-Restart statt sofortiges process.exit().
process.on('uncaughtException', (err) => {
  logger.log('❌ uncaughtException: ' + (err && err.message ? err.message : err), 'error');
  shutdown('uncaughtException').catch(() => {});
});
