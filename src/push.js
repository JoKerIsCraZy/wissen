/**
 * WISSen — Web-Push Notification Layer.
 *
 * - VAPID-Keys werden bei Boot generiert wenn nicht in .env gesetzt
 *   (Fallback-Datei data/vapid.json — wird auch von .env überschrieben).
 * - Subscriptions in der SQLite-Tabelle push_subscriptions.
 * - sendToAll() ist best-effort: 410 (Gone) entfernt die Subscription.
 *
 * Das Modul ist defensiv geschrieben — wenn web-push nicht installiert ist,
 * wird es im Server.js bewusst optional geladen (try/catch). Hier setzen wir
 * voraus dass es verfügbar ist.
 */

// iOS-Safari: every push MUST have title+body. Do not introduce silent pushes —
// Apple revokes the permission as soon as a notification arrives without a
// user-visible payload, and the only way to recover is "unsubscribe + resubscribe"
// (i.e. losing every iOS device on the account). The PWA install prompt enforces
// `userVisibleOnly: true`, so all sendOne/sendToAll callers must keep providing
// a non-empty title and body field.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const webpush = require('web-push');
const db = require('./db');
// Direct import from the db sub-module — index.js doesn't re-export the new
// helpers (touchPushSubscription / getPushSubscriptionByEndpoint) and isn't in
// our file-ownership boundary for this task, so we hop straight to the source.
const dbPush = require('./db/push');

const VAPID_FILE = path.join(process.cwd(), 'data', 'vapid.json');
const VAPID_SUBJECT_PLACEHOLDER = 'mailto:admin@example.com';

let _keys = null;       // { publicKey, privateKey, subject }
let _initialized = false;
let _initError = null;  // string|null — surfaced via getStatus().lastInitError
let _initErrorLogged = false;
let _logger = null;     // optional logger injected via init({ logger })

// Diagnose-Zähler: Timestamps der letzten 24h, bei denen ein VAPID-Mismatch
// (401/403) aufgetreten ist. Wird nur in-memory gehalten (Reset bei Server-
// Restart) — bei dauerhaft hohen Werten deutet das auf einen VAPID-Key-Drift
// hin (z.B. data/vapid.json verloren gegangen).
//
// Semantik-Wechsel: Früher wurde dieser Counter nur dann inkrementiert wenn
// eine Subscription wegen 401/403 ENTFERNT wurde. Seit wir 401/403 NICHT mehr
// als "permanent dead" behandeln (siehe sendOne), zählt der Counter jetzt
// reine Mismatch-Events — keine tatsächlichen Removals mehr. Der Field-Name
// bleibt aus Kompatibilitätsgründen erhalten, die Bedeutung hat sich aber von
// "removed" zu "mismatch-event" verschoben.
const VAPID_MISMATCH_WINDOW_MS = 24 * 60 * 60 * 1000;
const PUSH_BODY_MAX_CHARS = 120;
const DEFAULT_PUSH_TTL = 86400;
let _vapidMismatchRemovals24h = [];

function _recordVapidMismatchRemoval() {
  const now = Date.now();
  _vapidMismatchRemovals24h.push(now);
  const cutoff = now - VAPID_MISMATCH_WINDOW_MS;
  _vapidMismatchRemovals24h = _vapidMismatchRemovals24h.filter(t => t >= cutoff);
}

// Body-Caps: Web-Push-Bodies werden in den meisten Browsern auf ~120 Zeichen
// abgeschnitten (Chrome desktop hat hier die strikteste Grenze, Safari iOS
// kürzt etwas später ab). Damit der Truncate nicht mitten in "(ZP1: 4.0→4.5)"
// landet, kappen wir bereits im Backend mit Ellipsis-Suffix.
function capBody(body, max) {
  const limit = typeof max === 'number' ? max : PUSH_BODY_MAX_CHARS;
  if (typeof body !== 'string') return body;
  if (body.length <= limit) return body;
  if (limit <= 1) return body.slice(0, limit);
  return body.slice(0, limit - 1) + '…';
}

function loadOrGenerateKeys(envSubject) {
  // 1) Aus .env (höchste Priorität)
  const envPub = process.env.VAPID_PUBLIC_KEY;
  const envPriv = process.env.VAPID_PRIVATE_KEY;
  const envSubj = process.env.VAPID_SUBJECT || envSubject || VAPID_SUBJECT_PLACEHOLDER;
  if (envPub && envPriv) {
    return { publicKey: envPub, privateKey: envPriv, subject: envSubj };
  }

  // 2) Aus data/vapid.json — direkt lesen, kein existsSync (TOCTOU-frei).
  try {
    const j = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
    if (j.publicKey && j.privateKey) {
      return { publicKey: j.publicKey, privateKey: j.privateKey, subject: j.subject || envSubj };
    }
  } catch (e) {
    if (e && e.code && e.code !== 'ENOENT' && !(e instanceof SyntaxError)) {
      // Echter I/O-Fehler (Permission, EIO, …) — nicht silently regenerieren,
      // sonst überschreiben wir potenziell intakte Keys.
      throw e;
    }
    /* ENOENT / parse-error → regenerate */
  }

  // 3) Erst-Generierung — atomisches Create via O_EXCL (hardlink-rename), damit
  // ein paralleler Boot-Race nicht in zwei unterschiedliche Keypairs läuft.
  // Das Pattern spiegelt den Master-Key-Bootstrap (settings/secretCrypto):
  //   tmp schreiben → linkSync (atomisches "create exclusive") → tmp löschen.
  // Verlierer des Races bekommen EEXIST und lesen den Gewinner-File ein.
  const fresh = webpush.generateVAPIDKeys();
  const out = { publicKey: fresh.publicKey, privateKey: fresh.privateKey, subject: envSubj };
  try {
    fs.mkdirSync(path.dirname(VAPID_FILE), { recursive: true });
  } catch (_) { /* data dir-Erstellung darf hier scheitern — wir versuchen den write trotzdem */ }

  const tmp = VAPID_FILE + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
    try { fs.chmodSync(tmp, 0o600); } catch (_) { /* Windows: silent no-op */ }
    try {
      // O_EXCL-Semantik via linkSync: scheitert mit EEXIST falls VAPID_FILE
      // bereits durch einen parallelen Prozess geschrieben wurde.
      fs.linkSync(tmp, VAPID_FILE);
    } catch (e) {
      if (e && e.code === 'EEXIST') {
        // Race verloren — der Gewinner-File ist bereits da. Reload + return
        // damit beide Prozesse identische Keys benutzen.
        try {
          const winner = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
          if (winner && winner.publicKey && winner.privateKey) {
            return {
              publicKey: winner.publicKey,
              privateKey: winner.privateKey,
              subject: winner.subject || envSubj
            };
          }
        } catch (_) { /* fallthrough to in-memory keys */ }
      } else {
        throw e;
      }
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) { /* tmp may not exist if linkSync threw early */ }
    }
    return out;
  } catch (_) {
    // Persistierung gescheitert (read-only-volume, ENOSPC, …) — Keys leben nur
    // in-process. Beim nächsten Restart wird neu generiert.
    try { fs.unlinkSync(tmp); } catch (_) {}
    return out;
  }
}

function init(opts) {
  if (_initialized) return _keys;
  if (opts && opts.logger && typeof opts.logger.log === 'function') {
    _logger = opts.logger;
  }
  try {
    _keys = loadOrGenerateKeys(opts && opts.subject);
    webpush.setVapidDetails(_keys.subject, _keys.publicKey, _keys.privateKey);
    _initialized = true;
    _initError = null;
    if (_keys.subject === VAPID_SUBJECT_PLACEHOLDER && _logger && !_initErrorLogged) {
      _logger.log(
        '⚠️  VAPID_SUBJECT nicht gesetzt — FCM kann dich bei Abuse nicht kontaktieren',
        'warn'
      );
    }
    return _keys;
  } catch (e) {
    _initError = (e && e.message) ? e.message : String(e);
    if (!_initErrorLogged) {
      _initErrorLogged = true;
      if (_logger) {
        _logger.log('⚠️  Web-Push init fehlgeschlagen: ' + _initError, 'warn');
      }
    }
    throw e;
  }
}

function getPublicKey() {
  if (!_initialized) init();
  return _keys.publicKey;
}

function addSubscription(database, sub, ua) {
  if (!_initialized) init();
  // Defense-in-depth: re-validate the endpoint/keys-shape at this layer too.
  // The route handler already calls validatePushSubscription, but a future
  // caller (CLI, internal tooling, …) could skip that check — keep the
  // whitelist enforcement in lock-step with the route.
  // Lazy require to avoid a top-level circular dependency on pushValidate.
  let validate;
  try { validate = require('./pushValidate').validatePushSubscription; }
  catch (_) { validate = null; }
  if (validate) {
    const reason = validate(sub);
    if (reason) {
      throw new Error('invalid subscription: ' + reason);
    }
  }
  db.addPushSubscription(database, sub, ua);
}

function removeSubscription(database, endpoint) {
  return db.removePushSubscription(database, endpoint);
}

function getSubscriptionByEndpoint(database, endpoint) {
  const d = database || db.getInstance();
  return dbPush.getPushSubscriptionByEndpoint(d, endpoint);
}

/**
 * Sendet ein Notification-Payload an EINE Subscription.
 * Returnt { ok: true } | { ok: false, gone: true } | { ok: false, error }.
 *
 * urgency=high signalisiert dem Push-Service (FCM/Mozilla/Apple), dass die
 * Nachricht zeitkritisch ist — wichtig auf Android, weil Chrome sonst im
 * Doze-Mode den Service-Worker nicht aufweckt und die Notification erst
 * sichtbar wird, wenn die PWA wieder geöffnet wird (genau das Symptom,
 * das ohne diesen Header reproduzierbar ist).
 *
 * Result-Felder:
 *   gone: true   — Subscription-Endpoint ist permanent ungültig (404/410).
 *                  Der Caller soll sie aus der DB entfernen.
 *   gone: false  — Send ist fehlgeschlagen, aber Subscription bleibt erhalten.
 *                  Inkludiert 401/403 (VAPID-Mismatch / transienter FCM-
 *                  Fehler) — diese betreffen potenziell ALLE subscriptions
 *                  gleichzeitig (z.B. wenn VAPID-keys rotiert haben oder die
 *                  JWT-Clock-Skew hat), also würden wir mit einem Schlag alle
 *                  Devices abkoppeln. Stattdessen: Mismatch-Counter inkre-
 *                  mentieren + Error loggen, aber Subscription behalten.
 *                  Wenn das Problem persistent ist, sieht's der Operator im
 *                  Log; wenn's transient war, funktioniert der nächste Push
 *                  wieder.
 *
 * Options:
 *   ttl — sekundengenauer TTL-Override für diesen Send (Default 86400 = 24h).
 *         Test-Pushes nutzen z.B. 60s, damit ein Operator-Test nicht 24h
 *         später erneut zugestellt wird falls das Device offline war.
 */
async function sendOne(subscription, payloadObj, options) {
  if (!_initialized) init();
  const payload = JSON.stringify(payloadObj);
  const ttl = options && Number.isFinite(options.ttl) && options.ttl > 0
    ? options.ttl
    : DEFAULT_PUSH_TTL;
  try {
    await webpush.sendNotification(subscription, payload, {
      TTL: ttl,
      urgency: 'high'
    });
    // Refresh last_seen on success — best-effort, never block the send-path.
    try {
      const d = db.getInstance();
      if (d && subscription && subscription.endpoint) {
        dbPush.touchPushSubscription(d, subscription.endpoint);
      }
    } catch (_) { /* DB nicht erreichbar / Singleton nicht init — best-effort */ }
    return { ok: true };
  } catch (err) {
    const status = err && err.statusCode;
    if (status === 404 || status === 410) {
      // Permanent failure: subscription is gone. Delete it.
      return { ok: false, gone: true, status };
    }
    if (status === 401 || status === 403) {
      // VAPID-Mismatch oder transienter FCM-Fehler. NICHT löschen —
      // ein 401/403 betrifft typischerweise ALLE subscriptions gleichzeitig
      // (z.B. wenn VAPID-keys rotiert haben oder die JWT-Clock-Skew hat),
      // also würden wir mit einem Schlag alle Devices abkoppeln.
      // Stattdessen: Mismatch-Counter inkrementieren + Error loggen, aber
      // Subscription behalten. Wenn das Problem persistent ist, sieht's der
      // Operator im Log; wenn's transient war, funktioniert der nächste
      // Push wieder.
      _recordVapidMismatchRemoval();
      return { ok: false, gone: false, status, transient: true, reason: 'vapid-mismatch', error: err && err.message };
    }
    // Other non-2xx → log but keep
    return { ok: false, gone: false, error: err && err.message, status };
  }
}

/**
 * Sendet ein Notification-Payload an ALLE registrierten Subscriptions.
 * Tote Subscriptions werden silently aus der DB entfernt.
 *
 * @param {{title:string, body:string, url?:string, tag?:string}} payload
 * @param {*} database optional — falls null wird der DB-Singleton via
 *   db.getInstance() benutzt. Im Server-Kontext ist der Singleton beim Boot
 *   initialisiert; für Tests kann der Caller einen Handle injizieren.
 * @param {{ttl?:number}} options optional — sendOne-Options durchgereicht.
 */
async function sendToAll(payload, database, options) {
  if (!_initialized) init();
  const d = database || db.getInstance();
  const subs = db.getAllPushSubscriptions(d);
  if (!subs.length) return { sent: 0, removed: 0, errors: [] };

  const tasks = subs.map(async (s) => {
    const subscription = {
      endpoint: s.endpoint,
      keys: { p256dh: s.p256dh, auth: s.auth }
    };
    const r = await sendOne(subscription, payload, options);
    // Subscription nur dann entfernen wenn der Endpoint tatsächlich permanent
    // tot ist (404/410). 401/403 und andere transiente Fehler werden NICHT
    // entfernt — sonst würde ein einzelner FCM-403 alle Devices abkoppeln.
    if (r.gone === true) {
      try { db.removePushSubscription(d, s.endpoint); } catch (_) {}
    }
    return r;
  });

  const results = await Promise.allSettled(tasks);
  let sent = 0, removed = 0;
  const errors = [];
  results.forEach((r) => {
    if (r.status !== 'fulfilled') {
      errors.push({ message: r.reason && r.reason.message });
      return;
    }
    if (r.value.ok) sent++;
    else if (r.value.gone) removed++;
    else if (r.value.error) errors.push({ status: r.value.status, message: r.value.error });
  });
  return { sent, removed, errors };
}

/**
 * Wie sendToAll, aber nur an EINEN konkreten Endpoint. Wird von
 * /api/push/test benutzt, damit ein Operator-Trigger nicht zur DoS-Amplifikation
 * gegen alle Devices wird (s. OPTIMIZE BE-7 HIGH#2).
 */
async function sendToEndpoint(payload, endpoint, database, options) {
  if (!_initialized) init();
  const d = database || db.getInstance();
  const row = dbPush.getPushSubscriptionByEndpoint(d, endpoint);
  if (!row) return { sent: 0, removed: 0, errors: [{ status: 404, reason: 'subscription-not-found' }] };

  const subscription = {
    endpoint: row.endpoint,
    keys: { p256dh: row.p256dh, auth: row.auth }
  };
  const r = await sendOne(subscription, payload, options);
  if (r.gone === true) {
    try { db.removePushSubscription(d, row.endpoint); } catch (_) {}
    return { sent: 0, removed: 1, errors: [] };
  }
  if (r.ok) return { sent: 1, removed: 0, errors: [] };
  return {
    sent: 0,
    removed: 0,
    errors: [{
      status: r.status || 0,
      reason: r.reason || (r.transient ? 'transient' : 'send-failed')
    }]
  };
}

/* ============================================================
   High-level helpers — formatieren Diff-Events aus saveNoten /
   saveStundenplan in lesbare Push-Notifications.
   ============================================================ */

// Hilfsfunktion: formatiert eine ZP/LB-Diff-Liste als Body-Suffix.
// "ZP1: 4.0→4.5; LB2: 5.0→5.5". Hält den Push-Body kompakt, weil Web-Push-
// Bodies in den meisten Browsern auf ~120 Zeichen abgeschnitten werden.
function formatPruefungenDiffSuffix(changes) {
  if (!changes || !changes.length) return '';
  const sorted = [...changes].sort((a, b) => {
    const order = { ZP: 0, LB: 1, OTHER: 2 };
    const oa = order[a.pruefung_typ] != null ? order[a.pruefung_typ] : 9;
    const ob = order[b.pruefung_typ] != null ? order[b.pruefung_typ] : 9;
    if (oa !== ob) return oa - ob;
    return (a.pruefung_nr || 0) - (b.pruefung_nr || 0);
  });
  const parts = sorted.map((p) => {
    const label = p.pruefung_typ === 'OTHER'
      ? (p.bezeichnung || ('Prüfung ' + (p.pruefung_nr || '')))
      : (p.pruefung_typ + (p.pruefung_nr || ''));
    const prev = p.prev_bewertung != null ? Number(p.prev_bewertung).toFixed(1) : '—';
    const next = p.new_bewertung != null ? Number(p.new_bewertung).toFixed(1) : '—';
    return label + ': ' + prev + '→' + next;
  });
  return ' (' + parts.join('; ') + ')';
}

function notifyGradeChanges(gradeChanges, database, pruefungenChangesByKuerzel) {
  if (!Array.isArray(gradeChanges) || !gradeChanges.length) return Promise.resolve(null);
  const news = gradeChanges.filter(g => g.type === 'new');
  const upd  = gradeChanges.filter(g => g.type === 'changed');

  // Bei wenigen Events: Detail-Push pro Modul.
  // Bei vielen: ein zusammenfassendes Push (sonst Notification-Spam).
  if (gradeChanges.length <= 3) {
    const tasks = gradeChanges.map((c) => {
      const subj = (c.fach_name || c.kuerzel_code || 'Modul');
      const note = c.new_note != null ? c.new_note.toFixed(1) : '—';
      const title = c.type === 'new'
        ? '🆕 Neue Note: ' + subj
        : '✏️ Note geändert: ' + subj;
      const prev = c.prev_note != null ? c.prev_note.toFixed(1) : '—';
      let body = c.type === 'new'
        ? 'Neue Bewertung: ' + note
        : 'Von ' + prev + ' → ' + note;
      // Diff-Suffix mit den ZP/LB-Wert-Änderungen, die diesen Schnitt-
      // Wechsel verursacht haben. Ergibt z.B.: "Von 4.7 → 4.85 (ZP1: 4.0→4.5)"
      const pc = pruefungenChangesByKuerzel && pruefungenChangesByKuerzel[c.kuerzel_id];
      if (pc && pc.length) body += formatPruefungenDiffSuffix(pc);
      body = capBody(body);
      return sendToAll({
        title, body,
        url: '/mobile/#/modul/' + encodeURIComponent(c.kuerzel_id) + '?code=' + encodeURIComponent(c.kuerzel_code || ''),
        tag: 'grade-' + c.kuerzel_id
      }, database);
    });
    return Promise.allSettled(tasks);
  }
  return sendToAll({
    title: '📚 Notenupdate',
    body: capBody(news.length + ' neue · ' + upd.length + ' geändert'),
    url: '/mobile/#/noten',
    tag: 'grade-summary'
  }, database);
}

// Standalone-Push wenn nur ZP/LB-Werte sich geändert haben, der Modul-Schnitt
// aber gerundet identisch geblieben ist. Wird vom runScrape ausgelöst nachdem
// die "main" gradeChanges-Pushes raus sind, mit Modulen die NICHT in
// gradeChanges enthalten waren.
function notifyPruefungenChanges(report, database) {
  if (!Array.isArray(report) || !report.length) return Promise.resolve(null);
  const totalChanged = report.reduce((s, m) => s + (m.changed ? m.changed.length : 0), 0);
  if (!totalChanged) return Promise.resolve(null);

  if (report.length <= 3) {
    const tasks = report.map((m) => {
      const subj = m.fach_name || m.kuerzel_code || 'Modul';
      const title = '✏️ Prüfung aktualisiert: ' + subj;
      const body = capBody('Schnitt unverändert' + formatPruefungenDiffSuffix(m.changed));
      return sendToAll({
        title, body,
        url: '/mobile/#/modul/' + encodeURIComponent(m.kuerzel_id) + '?code=' + encodeURIComponent(m.kuerzel_code || ''),
        tag: 'pruef-' + m.kuerzel_id
      }, database);
    });
    return Promise.allSettled(tasks);
  }
  return sendToAll({
    title: '✏️ Prüfungen aktualisiert',
    body: capBody(totalChanged + ' ZP/LB in ' + report.length + ' Modulen geändert'),
    url: '/mobile/#/noten',
    tag: 'pruef-summary'
  }, database);
}

// Web-Push für den Detail-Check-Report: NEUE ZP/LB die KEIN gradeChange-Push
// abdeckt (Modulnote unverändert). Läuft beim täglichen Voll-Refresh (letzter
// Lauf) + Sa-Backstop. Spiegelt notifyPruefungenChanges, aber für `added`
// (neue Prüfungen) statt `changed`. Bisher nur Telegram → jetzt auch Web-Push (#12).
function notifyWeeklyDetailReport(report, database) {
  if (!Array.isArray(report) || !report.length) return Promise.resolve(null);
  const totalAdded = report.reduce((s, m) => s + (m.added ? m.added.length : 0), 0);
  if (!totalAdded) return Promise.resolve(null);

  if (report.length <= 3) {
    const tasks = report.map((m) => {
      const subj = m.fach_name || m.kuerzel_code || 'Modul';
      const n = m.added ? m.added.length : 0;
      const title = '🔍 Neue Prüfung: ' + subj;
      const body = capBody(n + ' neue ZP/LB · Modulnote unverändert');
      return sendToAll({
        title, body,
        url: '/mobile/#/modul/' + encodeURIComponent(m.kuerzel_id) + '?code=' + encodeURIComponent(m.kuerzel_code || ''),
        tag: 'weekly-' + m.kuerzel_id
      }, database);
    });
    return Promise.allSettled(tasks);
  }
  return sendToAll({
    title: '🔍 Neue Prüfungen',
    body: capBody(totalAdded + ' neue ZP/LB in ' + report.length + ' Modulen'),
    url: '/mobile/#/noten',
    tag: 'weekly-summary'
  }, database);
}

// Anzeige-Wort einer Absenz-Kategorie für die Push-Texte. "Abwesend X%" zeigt
// den echten Roh-Wortlaut (status_raw), sonst die feste Kategorie-Bezeichnung.
function absenzKategorieLabel(lek) {
  if (lek.status_cat === 'abwesend_unentschuldigt') return 'unentschuldigt';
  if (lek.status_cat === 'abwesend_prozent') return lek.status_raw || 'abwesend';
  if (lek.status_cat === 'abwesend_entschuldigt') return 'entschuldigt';
  return lek.status_cat || '';
}

// Formatiert einen einzelnen newAbwesend-Eintrag als Push-Body-Zeile.
// statusChanged === true → "Status geändert: <kategorie>"; sonst je nach
// Kategorie differenziert. Mirror der Telegram-Variante (bot/notify.js), aber
// als reiner Text ohne HTML (Web-Push-Body).
function absenzLektionLine(lek) {
  const termin = lek.termin_raw || lek.termin_iso || '';
  if (lek.statusChanged) {
    return termin + ': Status geändert → ' + absenzKategorieLabel(lek);
  }
  if (lek.status_cat === 'abwesend_unentschuldigt') {
    return termin + ': UNENTSCHULDIGT abwesend';
  }
  if (lek.status_cat === 'abwesend_prozent') {
    return termin + ': ' + (lek.status_raw || 'abwesend');
  }
  return termin + ': abwesend (entschuldigt)';
}

/**
 * Web-Push bei neuer/geänderter Absenz (Nicht-Teilnahme). Spiegelt
 * notifyPruefungenChanges: ≤3 Module → Detail-Push pro Modul, >3 → Summary.
 *
 * report: Array von { kuerzel_code, bezeichnung, lektionen: newAbwesend[] }
 *   newAbwesend = { termin_iso, termin_raw, zeit_von, zeit_bis, status_cat,
 *                   statusChanged? }
 * Leerer Report oder 0 Lektionen → kein Push.
 */
function notifyNeueAbsenzen(report, database) {
  if (!Array.isArray(report) || !report.length) return Promise.resolve(null);
  const totalLektionen = report.reduce((s, m) => s + (m.lektionen ? m.lektionen.length : 0), 0);
  if (!totalLektionen) return Promise.resolve(null);

  if (report.length <= 3) {
    const tasks = report.map((m) => {
      const subj = m.bezeichnung || m.kuerzel_code || 'Modul';
      // Titel-Icon nach "schwerster" Kategorie im Modul: unentschuldigt /
      // "Abwesend X%" → ⚠️, Rest → ℹ️.
      const hasUnent = (m.lektionen || []).some(l =>
        l.status_cat === 'abwesend_unentschuldigt' || l.status_cat === 'abwesend_prozent');
      const title = (hasUnent ? '⚠️ Absenz: ' : 'ℹ️ Absenz: ') + subj;
      const body = capBody((m.lektionen || []).map(absenzLektionLine).join('; '));
      return sendToAll({
        title, body,
        url: '/mobile/#/absenzen?code=' + encodeURIComponent(m.kuerzel_code || ''),
        tag: 'absenz-' + (m.kuerzel_code || '')
      }, database);
    });
    return Promise.allSettled(tasks);
  }
  return sendToAll({
    title: '⚠️ Neue Absenzen',
    body: capBody(totalLektionen + ' Nicht-Teilnahmen in ' + report.length + ' Modulen'),
    url: '/mobile/#/absenzen',
    tag: 'absenz-summary'
  }, database);
}

function notifyRoomChanges(roomChanges, database) {
  if (!Array.isArray(roomChanges) || !roomChanges.length) return Promise.resolve(null);

  if (roomChanges.length <= 3) {
    const tasks = roomChanges.map((c) => {
      const arrow = c.wentOnline ? '🌐' : (c.wentOffline ? '🏫' : '🚪');
      const dateLabel = formatDay(c.datum_iso);
      const title = arrow + ' Zimmerwechsel: ' + (c.veranstaltung || 'Termin');
      const body = capBody(dateLabel + ' ' + (c.zeit_von || '') + ' · ' + c.prev_raum + ' → ' + c.new_raum);
      return sendToAll({
        title, body,
        url: '/mobile/#/stundenplan',
        tag: 'room-' + (c.datum_iso || '') + '-' + (c.zeit_von || '')
      }, database);
    });
    return Promise.allSettled(tasks);
  }
  return sendToAll({
    title: '🏫 Stundenplan-Änderungen',
    body: capBody(roomChanges.length + ' Zimmerwechsel — siehe Stundenplan'),
    url: '/mobile/#/stundenplan',
    tag: 'room-summary'
  }, database);
}

/**
 * Read-only Diagnose-Snapshot für den /api/push/status-Endpoint.
 * Liefert VAPID-Public-Key, aktuelle Subscription-Anzahl und Anzahl der
 * VAPID-Mismatch-Removals der letzten 24h (in-memory, Reset bei Restart).
 *
 * Defensiv: DB-Zugriff darf nicht crashen, falls der Singleton nicht
 * initialisiert ist (z.B. CLI-Modus ohne Server) — dann subscriptionCount = 0.
 */
function getStatus() {
  let publicKey = null;
  try { publicKey = getPublicKey(); } catch (_) { /* keys noch nicht init — _initError ist gesetzt */ }

  let subscriptionCount = 0;
  try {
    const d = db.getInstance();
    subscriptionCount = db.countPushSubscriptions(d);
  } catch (_) { /* DB nicht initialisiert — count bleibt 0 */ }

  return {
    enabled: Boolean(publicKey),
    publicKey,
    subscriptionCount,
    vapidMismatchRemovedIn24h: _vapidMismatchRemovals24h.length,
    lastInitError: _initError
  };
}

function formatDay(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'short' });
  } catch (_) {
    return iso;
  }
}

module.exports = {
  init,
  getPublicKey,
  getStatus,
  addSubscription,
  removeSubscription,
  getSubscriptionByEndpoint,
  sendOne,
  sendToAll,
  sendToEndpoint,
  notifyGradeChanges,
  notifyRoomChanges,
  notifyPruefungenChanges,
  notifyWeeklyDetailReport,
  notifyNeueAbsenzen,
  // nur für Tests — direkt das interne Recording triggern, damit der Counter
  // ohne Mock von web-push.sendNotification verifiziert werden kann.
  __test_recordVapidMismatchRemoval: _recordVapidMismatchRemoval,
  __test_capBody: capBody
};
