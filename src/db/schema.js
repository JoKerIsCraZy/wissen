'use strict';

/**
 * SQLite-Schicht für WISSen — nutzt Nodes eingebautes node:sqlite (Node 22.5+).
 * Keine npm-Dependency, keine Build-Tools nötig.
 */

const path = require('node:path');
const fs = require('node:fs');
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  console.error('❌ node:sqlite nicht verfügbar. Node 22.5+ nötig.');
  console.error('   Führe das Script mit "npm start" aus (nutzt --experimental-sqlite).');
  console.error('   Oder direkt: node --experimental-sqlite cli.js');
  throw e;
}

const { reclassifyOtherPruefungen } = require('./pruefungen');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS noten (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kuerzel_id    TEXT NOT NULL UNIQUE,
  fach_code     TEXT,
  fach_name     TEXT,
  kuerzel_full  TEXT,
  kuerzel_code  TEXT,
  semester      TEXT,
  typ           TEXT,
  note          REAL,
  note_raw      TEXT,
  detail_id     TEXT,
  fetched_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_noten_fetched   ON noten(fetched_at);
CREATE INDEX IF NOT EXISTS idx_noten_semester  ON noten(semester);
-- idx_noten_detail wird nach der ALTER-Migration angelegt (siehe open()),
-- sonst schlägt CREATE INDEX auf bestehenden DBs fehl, in denen die
-- Spalte noch nicht existiert.

CREATE TABLE IF NOT EXISTS noten_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kuerzel_id    TEXT NOT NULL,
  fach_name     TEXT,
  note          REAL,
  note_raw      TEXT,
  recorded_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_hist_kuerzel ON noten_history(kuerzel_id, recorded_at);

-- Prüfungen pro Modul (LB / ZP / OTHER) — Detail-Scrape Result.
-- Ein Modul kann 0..n LB UND 0..n ZP haben, deshalb pruefung_typ als Spalte
-- statt zwei separate Tabellen.
CREATE TABLE IF NOT EXISTS noten_pruefungen (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kuerzel_id    TEXT NOT NULL,
  pruefung_typ  TEXT NOT NULL,
  pruefung_nr   INTEGER NOT NULL,
  bezeichnung   TEXT,
  gewicht       TEXT,
  gewicht_pct   REAL,
  bewertung     REAL,
  bewertung_raw TEXT,
  fetched_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(kuerzel_id, pruefung_typ, pruefung_nr)
);

CREATE INDEX IF NOT EXISTS idx_pruef_kuerzel ON noten_pruefungen(kuerzel_id);

-- Audit-Trail für ZP/LB-Bewertungs-Änderungen. Spiegelt das noten_history-
-- Pattern auf Prüfungs-Ebene: append-only Snapshots, geschrieben von
-- savePruefungen() bei jeder echten Wert-Änderung. Erlaubt der UI ein
-- "vorher 4.0 → jetzt 4.5" rendering pro Prüfung und gibt dem Push-System
-- die Diff-Daten für ZP/LB-Wert-Wechsel.
CREATE TABLE IF NOT EXISTS pruefungen_history (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  kuerzel_id     TEXT NOT NULL,
  pruefung_typ   TEXT NOT NULL,
  pruefung_nr    INTEGER NOT NULL,
  bezeichnung    TEXT,
  bewertung      REAL,
  bewertung_raw  TEXT,
  recorded_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pruef_hist_lookup
  ON pruefungen_history(kuerzel_id, pruefung_typ, pruefung_nr, recorded_at);

CREATE TABLE IF NOT EXISTS stundenplan (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  datum_iso     TEXT NOT NULL,
  zeit_von      TEXT,
  zeit_bis      TEXT,
  raum          TEXT,
  dozent        TEXT,
  klasse        TEXT,
  veranstaltung TEXT,
  fetched_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(datum_iso, zeit_von, veranstaltung, klasse)
);

CREATE INDEX IF NOT EXISTS idx_sp_datum   ON stundenplan(datum_iso);
CREATE INDEX IF NOT EXISTS idx_sp_datum_zeit ON stundenplan(datum_iso, zeit_von);
-- removed: no consumer query filters on dozent/klasse columns; dropped via
-- migration below to free UPSERT-maintenance cost on existing DBs.

-- Absenzen / Anwesenheits-Tracking — vierte Daten-Achse, gespiegelt am
-- Noten→Prüfungen-Vertikal. Übersicht (pro Modul) + Tagesdetail (pro Lektion).
-- kuerzel_code (Text) ist der Join-Key zwischen Übersicht und Detail — Absenzen
-- zeigt keine numerische Modul-ID, daher der Code statt einer kuerzel_id.
-- absenzen = soll - besucht (NICHT auf >=0 clampen; Tocco kann besucht>soll haben).
-- anwesenheit_pct = berechnet besucht/soll*100 (null bei soll=0); _scraped = der
-- vom Badge angezeigte Wert für den Rundungs-Abgleich.
CREATE TABLE IF NOT EXISTS absenzen (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  kuerzel_code             TEXT NOT NULL UNIQUE,
  typ                      TEXT,
  bezeichnung              TEXT,
  semester                 TEXT,
  soll                     REAL,
  besucht                  REAL,
  absenzen                 REAL,
  minimal_pct              REAL,
  anwesenheit_pct          REAL,
  anwesenheit_pct_scraped  REAL,
  detail_id                TEXT,
  fetched_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Tagesdetail pro Lektion. status ist die NORMALISIERTE Kategorie
-- (teilgenommen|offen|abwesend_entschuldigt|abwesend_unentschuldigt|unbekannt),
-- status_raw zusätzlich für die Anzeige. UNIQUE über (code, datum, von) —
-- Phase-0 ggf. um zeit_bis ergänzen falls (datum, von) nicht eindeutig.
CREATE TABLE IF NOT EXISTS absenzen_termine (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  kuerzel_code     TEXT NOT NULL,
  termin_iso       TEXT,
  zeit_von         TEXT,
  zeit_bis         TEXT,
  termin_raw       TEXT,
  lektionen_soll   REAL,
  lektionen_ist    REAL,
  anwesenheit_pct  REAL,
  status           TEXT,
  status_raw       TEXT,
  fetched_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(kuerzel_code, termin_iso, zeit_von)
);

-- Web-Push Subscriptions (PWA aufs Handy installiert).
-- endpoint ist der Push-Service-URL (FCM/Mozilla/Apple), pro Browser/Gerät unique.
-- p256dh + auth sind die Krypto-Keys aus PushSubscription.getKey().
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint    TEXT    NOT NULL UNIQUE,
  p256dh      TEXT    NOT NULL,
  auth        TEXT    NOT NULL,
  ua          TEXT,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

// SQLite kann ALTER TABLE ADD COLUMN nicht "IF NOT EXISTS" — daher prüfen
// wir vor dem ALTER, ob die Spalte schon existiert. Macht den Aufruf idempotent
// (Re-Open einer bereits migrierten DB ist no-op).
function ensureColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some(c => c.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  return true;
}

function open(filename) {
  const dataDir = path.join(process.cwd(), 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = filename || path.join(dataDir, 'wissen.db');

  // Auto-Migration: pre-rebrand installs hatten data/tocco.db. Falls nur die alte
  // existiert und kein expliziter filename übergeben wurde, verschieben statt
  // leer neu anlegen — sonst wären alle History-Daten verloren.
  if (!filename) {
    const legacyPath = path.join(dataDir, 'tocco.db');
    if (!fs.existsSync(dbPath) && fs.existsSync(legacyPath)) {
      fs.renameSync(legacyPath, dbPath);
      // WAL/SHM Sidecar-Files auch mitmigrieren, falls vorhanden
      for (const ext of ['-wal', '-shm']) {
        const legacySide = legacyPath + ext;
        const newSide = dbPath + ext;
        if (fs.existsSync(legacySide)) fs.renameSync(legacySide, newSide);
      }
    }
  }

  const d = new DatabaseSync(dbPath);
  const run = (sql) => d.exec(sql);
  run('PRAGMA journal_mode = WAL');
  run('PRAGMA foreign_keys = ON');
  run(SCHEMA);

  // Migrations für bestehende DBs (CREATE TABLE IF NOT EXISTS triggert kein ALTER).
  ensureColumn(d, 'noten', 'detail_id', 'detail_id TEXT');
  // detail_scraped_at: Cooldown für Detail-Scrape-Versuche — verhindert dass
  // Module mit 0 Prüfungen (parse-fail oder leere Tocco-Seite) bei jedem
  // Cycle erneut gescrapt werden.
  ensureColumn(d, 'noten', 'detail_scraped_at', 'detail_scraped_at DATETIME');
  // change_pending / change_seen_at: Frisch-Markierung. saveNoten/
  // saveStundenplan setzen change_pending=1 bei Diff (neue/geänderte Note,
  // Zimmerwechsel). Beim ersten Anschauen im UI wird change_seen_at gesetzt;
  // 24h danach gilt das Item nicht mehr als frisch (lazy ausgewertet beim
  // SELECT, kein Cron nötig).
  ensureColumn(d, 'noten', 'change_pending', 'change_pending INTEGER NOT NULL DEFAULT 0');
  ensureColumn(d, 'noten', 'change_seen_at', 'change_seen_at TEXT');
  ensureColumn(d, 'stundenplan', 'change_pending', 'change_pending INTEGER NOT NULL DEFAULT 0');
  ensureColumn(d, 'stundenplan', 'change_seen_at', 'change_seen_at TEXT');
  // Absenzen: Frisch-Marker analog noten/stundenplan. saveLektionen setzt
  // change_pending=1 auf die absenzen-Zeile bei neuer/geänderter Abwesenheit.
  // detail_scraped_at: Cooldown für den Detail-Scrape (12h), spiegelt noten.
  // Auf absenzen_termine sind die Marker optional (für Fresh-Pill pro Lektion),
  // werden hier aber idempotent mitgelegt, damit getLektionen darauf bauen kann.
  ensureColumn(d, 'absenzen', 'detail_scraped_at', 'detail_scraped_at DATETIME');
  ensureColumn(d, 'absenzen', 'change_pending', 'change_pending INTEGER NOT NULL DEFAULT 0');
  ensureColumn(d, 'absenzen', 'change_seen_at', 'change_seen_at TEXT');
  ensureColumn(d, 'absenzen_termine', 'change_pending', 'change_pending INTEGER NOT NULL DEFAULT 0');
  ensureColumn(d, 'absenzen_termine', 'change_seen_at', 'change_seen_at TEXT');
  // Index NACH der Migration anlegen — sonst schlägt das auf alten DBs fehl,
  // in denen detail_id noch nicht existiert.
  d.exec('CREATE INDEX IF NOT EXISTS idx_noten_detail ON noten(detail_id)');

  // Partial-Indizes für change_pending: dismissAll / "Letzte Änderung"-Feed
  // filtern ausschliesslich auf change_pending = 1. Partial-Index ist
  // erheblich kleiner als ein Full-Index (nur die wenigen pending-Zeilen
  // landen drin) und ermöglicht der SQLite-Engine einen Index-Scan statt
  // Full-Table-Scan.
  d.exec(
    'CREATE INDEX IF NOT EXISTS idx_noten_pending ON noten(change_pending) WHERE change_pending = 1'
  );
  d.exec(
    'CREATE INDEX IF NOT EXISTS idx_sp_pending ON stundenplan(change_pending) WHERE change_pending = 1'
  );

  // Absenzen-Indizes NACH der ensureColumn-Migration (detail_id/change_pending
  // existieren erst danach auf alten DBs). idx_absenzen_termine_code beschleunigt
  // den Join Übersicht↔Detail; der Partial-Index spiegelt idx_noten_pending.
  d.exec('CREATE INDEX IF NOT EXISTS idx_absenzen_detail ON absenzen(detail_id)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_absenzen_termine_code ON absenzen_termine(kuerzel_code)');
  d.exec(
    'CREATE INDEX IF NOT EXISTS idx_absenzen_pending ON absenzen(change_pending) WHERE change_pending = 1'
  );

  // Tote Indizes droppen — kein Konsument filtert auf dozent/klasse, der
  // UPSERT-Maintenance-Cost ist daher pure Verschwendung. IF EXISTS macht
  // den Aufruf idempotent (fresh DBs haben sie eh nicht mehr).
  d.exec('DROP INDEX IF EXISTS idx_sp_dozent');
  d.exec('DROP INDEX IF EXISTS idx_sp_klasse');

  // Daten-Migration: re-klassifiziert OTHER-Einträge die mit "LB"/"ZP" beginnen.
  // Frühere classifyPruefung-Version war zu strikt — Bezeichnungen wie "LB"
  // (ohne Zahl) oder "LB Praxisarbeit" landeten in OTHER. Über PRAGMA
  // user_version gegated, damit der unindexierte LIKE-Scan nur EINMAL pro
  // DB-Lifetime läuft statt bei jedem openOnce().
  const userVersion = d.prepare('PRAGMA user_version').get().user_version || 0;
  if (userVersion < 1) {
    reclassifyOtherPruefungen(d);
    d.exec('PRAGMA user_version = 1');
  }

  return d;
}

// Hint an SQLite, den WAL-Sidecar in die Haupt-DB zu spülen. PASSIVE-Modus
// blockiert weder Reader noch Writer — wenn gerade ein Writer aktiv ist,
// ist der Aufruf ein no-op und kehrt sofort zurück. Wird typischerweise am
// Ende eines Scrape-Cycles aufgerufen, damit der WAL-File nicht unbegrenzt
// wächst (SQLite checkpoints auto bei ~1000 Pages, expliziter Aufruf bringt
// das Window aber unter Kontrolle).
function checkpointWalIfNeeded(d) {
  if (!d) return;
  try { d.exec('PRAGMA wal_checkpoint(PASSIVE)'); } catch (_) { /* swallow */ }
}

// =============================================================
// Singleton-Layer
// =============================================================
// Server (server.js) öffnet die DB einmal beim Boot via openOnce() und teilt
// den Handle mit allen Routes / Bot-Screens / runScrape / push. SQLite ist
// im WAL-Mode multi-reader-safe; runScrape ist der einzige Writer.
// open() bleibt für cli.js erhalten (one-shot Script).
let _instance = null;
let _instancePath = null;

function openOnce(filename) {
  if (_instance) return _instance;
  _instance = open(filename);
  _instancePath = filename || null;
  return _instance;
}

function getInstance() {
  if (!_instance) {
    throw new Error('DB singleton not initialized — call openOnce() first');
  }
  return _instance;
}

function closeInstance() {
  if (!_instance) return;
  try { _instance.close(); } catch (_) { /* swallow during shutdown */ }
  _instance = null;
  _instancePath = null;
}

module.exports = {
  SCHEMA,
  ensureColumn,
  open,
  openOnce,
  getInstance,
  closeInstance,
  checkpointWalIfNeeded
};
