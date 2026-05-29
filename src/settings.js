/**
 * settings.js — Persistente Server-Settings.
 *
 * Merge-Reihenfolge (niedrig → hoch):
 *   1. Hardcoded Defaults
 *   2. .env (MS_EMAIL, MS_PASSWORD, USER_PK, ...)
 *   3. settings.json (vom User via Web-UI editiert)
 *
 * Sicherheits-Allowlists:
 *   ALLOWED_UI_KEYS             — darf von /api/settings PATCH immer geändert werden
 *   ALLOWED_UI_CREDENTIAL_KEYS  — zusätzliche Keys wenn ALLOW_UI_CREDENTIALS=true
 *   URL-/Port-Keys              — env-only, PATCH wird ignoriert
 *
 * API:
 *   load()               → merged settings object
 *   save(patch)          → merged settings object (schreibt settings.json)
 *   subscribe(listener)  → unsubscribe fn; listener(new, old)
 *   getDefaults()        → hardcoded defaults
 *   filterUiPatch(body, allowCredentials) → gefilterter Patch für PATCH-Route
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseEnvFile } = require('./shared/envLoader');
const secretCrypto = require('./secretCrypto');

const DATA_DIR = path.join(process.cwd(), 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const ENV_FILE = path.join(process.cwd(), '.env');

// ---------- Defaults ----------
const DEFAULTS = Object.freeze({
  msEmail: '',
  msPassword: '',
  userPk: '',
  baseUrl: 'https://wiss.tocco.ch',
  notenUrl: 'https://wiss.tocco.ch/extranet/Meine-Bildung/Noten-f%C3%BCr-Studierende',
  stundenplanUrl: 'https://wiss.tocco.ch/extranet/Meine-Bildung/Stundenplan-f%C3%BCr-Studierende',
  absenzenUrl: 'https://wiss.tocco.ch/extranet/Meine-Bildung/Absenzen-f%C3%BCr-Studierenden',
  // Scheduler
  scheduleMode: 'interval',           // 'interval' | 'weekly'
  scheduleDays: [1, 2, 3, 4, 5],      // beide Modi: 0=So .. 6=Sa
  // Interval-Mode
  intervalMinutes: 60,
  intervalTimeFrom: '08:00',          // Zeitfenster Start (HH:MM)
  intervalTimeTo: '20:00',            // Zeitfenster Ende   (HH:MM)
  // Weekly-Mode
  scheduleTimes: ['08:00', '16:00'],
  autoRun: false,
  // Manueller Scrape: wenn true, zieht ein manuell ausgelöster Scrape ALLE
  // Moduldetails neu (wie der wöchentliche Voll-Refresh) statt nur geänderte/
  // neue Module. Betrifft NUR reason='manual' — Auto-Run bleibt unverändert.
  manualScrapeFullDetails: false,
  headless: true,
  slowMo: 0,
  // Detail-Page-Pool-Größe für parallele Modul-Detail-Scrapes
  // (siehe scraper.js createDetailPagePool). 1 = sequenziell wie vor
  // Stufe 2; 4 = Default-Konservativ; bis 8 erlaubt. Höher = schneller,
  // aber höherer RAM-Spike (~80-120 MB pro extra Page) und potenziell
  // mehr Tocco-Server-Last.
  detailScrapeConcurrency: 4,
  port: 3000,
  telegramEnabled: false,
  telegramToken: '',
  telegramAllowedUserId: null
});

// ---------- Allowlists ----------
// Keys, die das Web-UI IMMER per PATCH /api/settings setzen darf.
const ALLOWED_UI_KEYS = Object.freeze([
  'autoRun',
  'manualScrapeFullDetails',
  'intervalMinutes',
  'intervalTimeFrom',
  'intervalTimeTo',
  'scheduleMode',
  'scheduleDays',
  'scheduleTimes',
  'headless',
  'slowMo',
  'detailScrapeConcurrency',
  'telegramEnabled',
  'telegramAllowedUserId'
]);

// Zusätzliche Keys wenn ALLOW_UI_CREDENTIALS=true.
const ALLOWED_UI_CREDENTIAL_KEYS = Object.freeze([
  'msEmail',
  'msPassword',
  'telegramToken',
  'userPk'
]);

// URL- und Port-Keys sind env-only und werden aus PATCH silent gedroppt.
const ENV_ONLY_KEYS = Object.freeze([
  'baseUrl',
  'notenUrl',
  'stundenplanUrl',
  'absenzenUrl',
  'port'
]);

// Optionaler Logger-Hook (von server.js injiziert) für Warnungen.
let _logger = null;
let _cached = null;
let _cacheValid = false;
function setLogger(logger) {
  if (logger && typeof logger.log === 'function') {
    _logger = logger;
  }
}

function warn(msg) {
  if (_logger) {
    try { _logger.log(msg, 'warn'); } catch (_) { /* ignore */ }
  }
}

// ---------- .env Loader ----------
function loadEnv() {
  const out = parseEnvFile(ENV_FILE);
  // Mergen: process.env überschreibt optionale .env-Datei, damit Docker-ENV
  // immer gewinnt, aber Lokal-Dev weiter funktioniert.
  const ENV_KEYS = [
    'MS_EMAIL','MS_PASSWORD','USER_PK','TOCCO_BASE','NOTEN_URL','STUNDENPLAN_URL','ABSENZEN_URL',
    'HEADLESS','SLOW_MO','INTERVAL_MINUTES','AUTO_RUN','PORT',
    'TELEGRAM_TOKEN','TELEGRAM_ALLOWED_USER_ID','TELEGRAM_ENABLED'
  ];
  for (const k of ENV_KEYS) {
    if (process.env[k] != null && process.env[k] !== '') {
      out[k] = process.env[k];
    }
  }
  return out;
}

// ---------- Env → Settings-Shape ----------
function envToSettings(env) {
  const s = {};
  if (env.MS_EMAIL) s.msEmail = env.MS_EMAIL;
  if (env.MS_PASSWORD) s.msPassword = env.MS_PASSWORD;
  if (env.USER_PK) s.userPk = env.USER_PK;
  if (env.TOCCO_BASE) s.baseUrl = env.TOCCO_BASE;
  if (env.NOTEN_URL) s.notenUrl = env.NOTEN_URL;
  if (env.STUNDENPLAN_URL) s.stundenplanUrl = env.STUNDENPLAN_URL;
  if (env.ABSENZEN_URL) s.absenzenUrl = env.ABSENZEN_URL;
  if (env.HEADLESS != null) s.headless = env.HEADLESS !== 'false';
  if (env.SLOW_MO != null) {
    const n = parseInt(env.SLOW_MO, 10);
    if (!Number.isNaN(n)) s.slowMo = n;
  }
  if (env.INTERVAL_MINUTES != null) {
    const n = parseInt(env.INTERVAL_MINUTES, 10);
    if (!Number.isNaN(n) && n > 0) s.intervalMinutes = n;
  }
  if (env.AUTO_RUN != null) s.autoRun = env.AUTO_RUN === 'true';
  if (env.PORT != null) {
    const n = parseInt(env.PORT, 10);
    if (!Number.isNaN(n) && n > 0) s.port = n;
  }
  if (env.TELEGRAM_TOKEN) s.telegramToken = env.TELEGRAM_TOKEN;
  if (env.TELEGRAM_ALLOWED_USER_ID != null) {
    const n = parseInt(env.TELEGRAM_ALLOWED_USER_ID, 10);
    if (!Number.isNaN(n)) s.telegramAllowedUserId = n;
  }
  if (env.TELEGRAM_ENABLED != null) s.telegramEnabled = env.TELEGRAM_ENABLED === 'true';
  return s;
}

// ---------- settings.json Loader ----------
// Disk-Format: secrets (msPassword, telegramToken) sind als
// "enc:v1:<iv>:<ciphertext>:<tag>"-Blobs gespeichert (siehe secretCrypto.js).
// readSettingsFile entschlüsselt beim Lesen → coerce/merge/save arbeiten in
// plaintext. writeSettingsFile verschlüsselt vor dem Serialisieren.
//
// Backwards-Compat: Plaintext-Werte (kein "enc:v1:"-Prefix) werden beim Read
// durchgereicht, beim NÄCHSTEN save() automatisch verschlüsselt — lazy
// Migration ohne separates Script.
function readSettingsFile() {
  if (!fs.existsSync(SETTINGS_FILE)) return {};
  let raw;
  try {
    raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
  } catch (e) {
    // File missing or unreadable → ENOENT als empty behandeln, andere Read-
    // Errors (Permissions, EIO) propagieren, damit Operator sie sieht.
    if (e && e.code === 'ENOENT') return {};
    throw new Error('settings.json unreadable: ' + (e && e.message ? e.message : e), { cause: e });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    // JSON-parse error → korrupte Datei. NICHT silent {} zurückgeben — sonst
    // würde der nächste save() die korrupte Datei mit frischen Defaults
    // überschreiben und ggf. salvageable Daten zerstören. Lieber laut
    // failen, damit Operator inspizieren kann.
    throw new Error('settings.json invalid JSON: ' + (e && e.message ? e.message : e), { cause: e });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  // Decrypt failures (korrupter Master-Key, tampered Ciphertext) propagieren
  // aus decryptSettings. Wir fangen sie hier NICHT — silent re-encrypten von
  // frischen Defaults würde die User-Secrets zerstören. Lieber beim Boot
  // refusen und Operator-Backup-Restore erzwingen.
  try {
    return secretCrypto.decryptSettings(parsed);
  } catch (err) {
    warn('⚠️  settings.json Decrypt-Fehler: ' + (err && err.message ? err.message : err));
    throw err;
  }
}

function writeSettingsFile(obj) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Vor dem Schreiben verschlüsseln (idempotent — bereits verschlüsselte Werte
  // bleiben unverändert, kein Doppel-Encrypt-Risk).
  const encrypted = secretCrypto.encryptSettings(obj);
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(encrypted, null, 2), { encoding: 'utf8', mode: 0o600 });
  // chmod explizit, falls die Datei bereits existierte (writeFileSync "mode" gilt
  // nur bei Neuanlage). Auf Windows ignoriert der OS den Modus weitgehend,
  // daher try/catch.
  try { fs.chmodSync(SETTINGS_FILE, 0o600); } catch (_) { /* Windows compat */ }
}

// ---------- Coercion ----------
// Bringt Werte aus .env/JSON in die erwarteten Typen (Schutz vor "true"/"false" Strings etc.)
// ENTFERNT Keys, die nicht in DEFAULTS definiert sind (strip unknown / proto pollution).
function coerce(patch) {
  // Start mit null-Prototyp damit __proto__/constructor-Tricks nicht greifen.
  const out = Object.create(null);
  if (!patch || typeof patch !== 'object') return out;

  // Nur bekannte Keys übernehmen.
  const knownKeys = new Set(Object.keys(DEFAULTS));
  for (const k of Object.keys(patch)) {
    if (knownKeys.has(k)) out[k] = patch[k];
  }

  if ('intervalMinutes' in out) {
    const n = Number(out.intervalMinutes);
    out.intervalMinutes = (Number.isFinite(n) && n > 0) ? Math.floor(n) : DEFAULTS.intervalMinutes;
  }
  if ('slowMo' in out) {
    const n = Number(out.slowMo);
    out.slowMo = (Number.isFinite(n) && n >= 0) ? Math.floor(n) : 0;
  }
  if ('detailScrapeConcurrency' in out) {
    const n = parseInt(out.detailScrapeConcurrency, 10);
    if (Number.isFinite(n)) {
      // Clamp [1, 8]. 1 = sequenzielles Verhalten (Pool-Größe 1).
      // Hard-Cap 8 weil mehr parallele Tocco-DWR-Calls aus einer Session
      // unrealistisch sind und Memory schnell knapp wird.
      out.detailScrapeConcurrency = Math.max(1, Math.min(8, n));
    } else {
      // Nicht-numerisch oder leer → silent drop (kein Override).
      delete out.detailScrapeConcurrency;
    }
  }
  if ('port' in out) {
    const n = Number(out.port);
    out.port = (Number.isFinite(n) && n > 0) ? Math.floor(n) : DEFAULTS.port;
  }
  // Strict-Boolean-Coercion: nur explizite truthy-Marker akzeptieren. Mit
  // Boolean(out.autoRun) wäre `Boolean("false") === true` ein latenter Bug
  // — String-Booleans aus dem JSON-/Env-Pfad würden fälschlich true. Lieber
  // konservativ true nur bei true/'true'/1/'1', sonst false.
  if ('autoRun' in out) {
    out.autoRun = out.autoRun === true || out.autoRun === 'true' || out.autoRun === 1 || out.autoRun === '1';
  }
  if ('manualScrapeFullDetails' in out) {
    out.manualScrapeFullDetails = out.manualScrapeFullDetails === true || out.manualScrapeFullDetails === 'true' || out.manualScrapeFullDetails === 1 || out.manualScrapeFullDetails === '1';
  }
  if ('headless' in out) {
    out.headless = out.headless === true || out.headless === 'true' || out.headless === 1 || out.headless === '1';
  }
  if ('telegramEnabled' in out) {
    out.telegramEnabled = out.telegramEnabled === true || out.telegramEnabled === 'true' || out.telegramEnabled === 1 || out.telegramEnabled === '1';
  }
  if ('scheduleMode' in out) {
    out.scheduleMode = (out.scheduleMode === 'weekly') ? 'weekly' : 'interval';
  }
  if ('scheduleDays' in out) {
    if (!Array.isArray(out.scheduleDays)) out.scheduleDays = [];
    out.scheduleDays = out.scheduleDays
      .map(n => Number(n))
      .filter(n => Number.isInteger(n) && n >= 0 && n <= 6);
    out.scheduleDays = [...new Set(out.scheduleDays)].sort((a, b) => a - b);
  }
  if ('scheduleTimes' in out) {
    if (!Array.isArray(out.scheduleTimes)) out.scheduleTimes = [];
    out.scheduleTimes = out.scheduleTimes
      .map(t => String(t || '').trim())
      .filter(t => /^\d{1,2}:\d{2}$/.test(t))
      .map(t => {
        const [h, m] = t.split(':').map(n => parseInt(n, 10));
        if (h < 0 || h > 23 || m < 0 || m > 59) return null;
        return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
      })
      .filter(Boolean);
    out.scheduleTimes = [...new Set(out.scheduleTimes)].sort();
  }
  for (const k of ['intervalTimeFrom', 'intervalTimeTo']) {
    if (k in out) {
      const v = String(out[k] || '').trim();
      if (/^\d{1,2}:\d{2}$/.test(v)) {
        const [h, m] = v.split(':').map(n => parseInt(n, 10));
        if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
          out[k] = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
        } else {
          out[k] = DEFAULTS[k];
        }
      } else {
        out[k] = DEFAULTS[k];
      }
    }
  }
  if ('telegramAllowedUserId' in out) {
    if (out.telegramAllowedUserId == null || out.telegramAllowedUserId === '') {
      out.telegramAllowedUserId = null;
    } else {
      const n = Number(out.telegramAllowedUserId);
      out.telegramAllowedUserId = (Number.isFinite(n) && n > 0) ? Math.floor(n) : null;
    }
  }
  for (const k of ['msEmail', 'msPassword', 'userPk', 'baseUrl', 'notenUrl', 'stundenplanUrl', 'absenzenUrl', 'telegramToken']) {
    if (k in out && out[k] != null) out[k] = String(out[k]);
  }
  return out;
}

// ---------- UI-Patch Filter ----------
// Wendet Allowlist an, bevor der Patch an save() gegeben wird.
// Entfernt unerlaubte Keys still; loggt eine Warnung wenn etwas gedroppt wurde.
function filterUiPatch(body, allowCredentials) {
  const safe = Object.create(null);
  if (!body || typeof body !== 'object') return safe;

  const allowed = new Set(ALLOWED_UI_KEYS);
  if (allowCredentials) {
    for (const k of ALLOWED_UI_CREDENTIAL_KEYS) allowed.add(k);
  }

  const droppedCredentials = [];
  const droppedUnknown = [];
  for (const k of Object.keys(body)) {
    // Proto-pollution Schutz
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (allowed.has(k)) {
      safe[k] = body[k];
    } else {
      // URL-/Port-Keys: silent drop (env-only).
      // Credential-Keys bei allowCredentials=false: warn.
      if (ENV_ONLY_KEYS.includes(k)) {
        // silent
      } else if (ALLOWED_UI_CREDENTIAL_KEYS.includes(k) && !allowCredentials) {
        droppedCredentials.push(k);
      } else {
        // Unbekannter Key → sammeln, einmal pro Request loggen.
        droppedUnknown.push(k);
      }
    }
  }

  if (droppedCredentials.length) {
    warn('⚠️  /api/settings: ' + droppedCredentials.length + ' credential-Key(s) gedroppt (ALLOW_UI_CREDENTIALS=false): ' + droppedCredentials.join(', '));
  }
  if (droppedUnknown.length) {
    warn('⚠️  /api/settings: ' + droppedUnknown.length + ' unbekannte Key(s) gedroppt: ' + droppedUnknown.join(', '));
  }

  // Secret-Guard: leere oder rein-whitespace Strings für Secrets NICHT
  // persistieren (sonst werden gesetzte Passwörter durch ein leeres oder
  // " "-Form-Feld überschrieben). Symmetrisch auf msPassword, telegramToken,
  // msEmail und userPk anwenden.
  for (const k of ['msPassword', 'telegramToken', 'msEmail', 'userPk']) {
    if (k in safe && (typeof safe[k] !== 'string' || safe[k].trim().length === 0)) {
      delete safe[k];
    }
  }

  return safe;
}

// ---------- Kern-Merge ----------
function computeMerged() {
  const env = loadEnv();
  const fromEnv = envToSettings(env);
  const fromFile = readSettingsFile();
  const merged = {
    ...DEFAULTS,
    ...coerce(fromEnv),
    ...coerce(fromFile)
  };
  return merged;
}

// ---------- Subscriber ----------
const listeners = new Set();

function emit(newSettings, oldSettings) {
  for (const l of listeners) {
    try { l(newSettings, oldSettings); }
    catch (e) {
      // Listener-Fehler dürfen andere Listener nicht stoppen, aber stille
      // Swallows verstecken Bugs in Subscriber-Code. Warn-loggen, nicht
      // throwen.
      _logger?.log('settings subscriber threw: ' + (e && e.message ? e.message : e), 'warn');
    }
  }
}

function subscribe(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ---------- Public API ----------
function load() {
  if (_cacheValid && _cached) return _cached;
  _cached = computeMerged();
  _cacheValid = true;
  return _cached;
}

function save(patch) {
  // computeMerged() direkt — nicht load() — damit der oldMerged-Snapshot
  // den Cache nicht mit Pre-Save-Daten kontaminiert.
  const oldMerged = computeMerged();

  const fileState = readSettingsFile();
  const cleanPatch = coerce(patch || {});
  const newFileState = { ...fileState, ...cleanPatch };

  try {
    writeSettingsFile(newFileState);
    // Cache invalidieren: nächster load() liest frischen Stand.
    _cached = null;
    _cacheValid = false;
  } catch (e) {
    // Write failed — DO NOT continue. Caller (routes/settings.js) muss das
    // als Error sehen. Sonst würden wir Subscriber-Events mit State emittieren,
    // der NICHT persistiert ist, die HTTP-Layer würde 200 mit "neuen" Settings
    // zurückgeben und der User hat keine Indikation, dass die Änderung beim
    // nächsten Boot revertet. Silent data loss für Telegram-Token / msPassword.
    _logger?.log('settings save FAILED: ' + (e && e.message ? e.message : e), 'error');
    // Cache invalidieren, damit nachfolgende reads wenigstens neu-aus-disk
    // lesen statt einen halb-aktuellen Cache-Snapshot zu servieren.
    _cached = null;
    _cacheValid = false;
    throw e;
  }

  const newMerged = load(); // baut Cache neu auf
  emit(newMerged, oldMerged);
  return newMerged;
}

function getDefaults() {
  return { ...DEFAULTS };
}

module.exports = {
  load,
  save,
  subscribe,
  getDefaults,
  setLogger,
  filterUiPatch,
  ALLOWED_UI_KEYS,
  ALLOWED_UI_CREDENTIAL_KEYS,
  ENV_ONLY_KEYS,
  coerce  // for testing
};
