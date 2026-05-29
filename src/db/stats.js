'use strict';

const { round1 } = require('./parsers');

// ---------- Memo-Cache ----------
// /api/stats wird vom Dashboard bei jedem Focus + nach jedem SSE-Reconnect
// gepollt — ohne Cache landen wir bei tens-of-roundtrips/min pro User. 5s
// TTL ist für den User unsichtbar (Scrape-Commits invalidieren explizit
// via invalidateStatsCache, das Fenster greift nur zwischen Scrapes),
// schneidet aber 90%+ der Queries weg.
//
// Pro Funktion ein eigener Cache-Slot, weil getStats/getNotenStats/
// getStundenplanStats unterschiedliche Shapes liefern und auch separat
// gepollt werden.
//
// Der Cache merkt sich auch den db-Handle, gegen den er aufgebaut wurde.
// Wechselt das Handle (Singleton reopened, Test-tmpdir, Reconnect), wird
// der Cache automatisch verworfen — sonst würde z.B. eine Test-Suite die
// pro Test eine frische DB öffnet veraltete Werte aus einem früheren Test
// zurückbekommen.
const STATS_TTL_MS = 5000;

let _statsCache = null;
let _statsCacheAt = 0;
let _statsCacheDb = null;

let _notenStatsCache = null;
let _notenStatsCacheAt = 0;
let _notenStatsCacheDb = null;

let _stundenplanStatsCache = null;
let _stundenplanStatsCacheAt = 0;
let _stundenplanStatsCacheDb = null;

let _absenzenStatsCache = null;
let _absenzenStatsCacheAt = 0;
let _absenzenStatsCacheDb = null;

function invalidateStatsCache() {
  _statsCache = null;
  _statsCacheAt = 0;
  _statsCacheDb = null;
  _notenStatsCache = null;
  _notenStatsCacheAt = 0;
  _notenStatsCacheDb = null;
  _stundenplanStatsCache = null;
  _stundenplanStatsCacheAt = 0;
  _stundenplanStatsCacheDb = null;
  _absenzenStatsCache = null;
  _absenzenStatsCacheAt = 0;
  _absenzenStatsCacheDb = null;
}

// Per-db-Handle Prepared-Statement-Cache. getStats wird bei jedem Cache-Miss
// (Scrape-Commit + 5s Memo-Fenster) aus 5 separaten Queries gebaut — ohne
// Cache prepart node:sqlite die Statements jedes Mal neu. Bewusst NICHT zu
// UNION ALL konsolidiert, damit jede Query einzeln lesbar bleibt und der
// SQLite-Optimizer für die ORDER BY … LIMIT 1-Pfade den Index-Walk-Path
// nutzen kann (UNION ALL würde das verhindern).
let _stmts = null;
function stmts(db) {
  if (_stmts && _stmts.db === db) return _stmts;
  _stmts = {
    db,
    agg: db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM noten) AS noten_count,
        (SELECT COUNT(*) FROM noten WHERE note IS NOT NULL) AS noten_with_grade,
        (SELECT AVG(note) FROM noten WHERE note IS NOT NULL) AS avg_note,
        (SELECT COUNT(*) FROM noten_history WHERE recorded_at >= datetime('now', '-7 days')) AS changed_recent
    `),
    bySemester: db.prepare(`
      SELECT semester, AVG(note) AS a
      FROM noten
      WHERE note IS NOT NULL AND semester IS NOT NULL AND semester != ''
      GROUP BY semester
    `),
    upcoming: db.prepare('SELECT COUNT(*) AS c FROM stundenplan WHERE datum_iso >= ?'),
    lastNoten: db.prepare('SELECT fetched_at AS m FROM noten ORDER BY fetched_at DESC LIMIT 1'),
    lastSp: db.prepare('SELECT fetched_at AS m FROM stundenplan ORDER BY fetched_at DESC LIMIT 1'),
    nextEvent: db.prepare(`
      SELECT datum_iso, zeit_von, veranstaltung, raum
      FROM stundenplan
      WHERE datum_iso >= ?
      ORDER BY datum_iso ASC, zeit_von ASC
      LIMIT 1
    `),
    notenAvg: db.prepare('SELECT AVG(note) AS a FROM noten WHERE note IS NOT NULL'),
    absAgg: db.prepare(`
      SELECT
        (SELECT AVG(anwesenheit_pct) FROM absenzen WHERE anwesenheit_pct IS NOT NULL) AS avg_anwesenheit,
        (SELECT COUNT(*) FROM absenzen
           WHERE anwesenheit_pct IS NOT NULL
             AND minimal_pct IS NOT NULL
             AND anwesenheit_pct < minimal_pct) AS unter_minimum,
        (SELECT COUNT(*) FROM absenzen_termine
           WHERE status IN ('abwesend_entschuldigt', 'abwesend_unentschuldigt')) AS abwesend_gesamt,
        (SELECT MAX(fetched_at) FROM absenzen) AS last_fetched
    `)
  };
  return _stmts;
}

function getStats(db) {
  const now = Date.now();
  if (_statsCache && _statsCacheDb === db && (now - _statsCacheAt) < STATS_TTL_MS) {
    return _statsCache;
  }

  const today = new Date().toISOString().slice(0, 10);
  const s = stmts(db);

  // Konsolidiert vier Aggregate (count, count-with-grade, avg, history-7d) in
  // einer Round-Trip — Subqueries laufen alle gegen indexierte Spalten,
  // SQLite optimiert das in einer Pass.
  const aggRow = s.agg.get();

  const bySemRows = s.bySemester.all();

  const avgBySemester = {};
  for (const row of bySemRows || []) {
    if (row.a == null) continue;
    avgBySemester[row.semester] = round1(row.a);
  }

  const upcomingRow = s.upcoming.get(today);

  // ORDER BY fetched_at DESC LIMIT 1 nutzt idx_noten_fetched / idx_sp_*
  // (min-max-Optimizer greift bei MAX() in SQLite nicht zuverlässig durch
  // Indizes, ORDER+LIMIT schon).
  const lastNotenRow = s.lastNoten.get();
  const lastSpRow = s.lastSp.get();

  const nextEventRow = s.nextEvent.get(today);

  const result = {
    notenCount: aggRow?.noten_count || 0,
    notenWithGradeCount: aggRow?.noten_with_grade || 0,
    avgNote: round1(aggRow?.avg_note),
    avgBySemester,
    stundenplanUpcoming: upcomingRow?.c || 0,
    lastFetchedNoten: lastNotenRow?.m || null,
    lastFetchedStundenplan: lastSpRow?.m || null,
    nextEvent: nextEventRow || null,
    changedRecent: aggRow?.changed_recent || 0
  };

  _statsCache = result;
  _statsCacheAt = now;
  _statsCacheDb = db;
  return result;
}

// ---------- Slim Stats für /api/noten ----------
// /api/noten braucht aus dem fetten getStats() nur 3 Felder. Statt für jeden
// Request 7 Queries durchzujagen (mit nextEvent-Sort, changedRecent-Aggregat
// etc.), liefert dieser Helper genau das, was die Route konsumiert: Avg-Note,
// Avg pro Semester, lastFetchedNoten. 3 Queries statt 7 + 5s Memo-Cache.
function getNotenStats(db) {
  const now = Date.now();
  if (_notenStatsCache && _notenStatsCacheDb === db && (now - _notenStatsCacheAt) < STATS_TTL_MS) {
    return _notenStatsCache;
  }

  const s = stmts(db);
  const avgRow = s.notenAvg.get();
  const bySemRows = s.bySemester.all();
  const avgBySemester = {};
  for (const row of bySemRows || []) {
    if (row.a == null) continue;
    avgBySemester[row.semester] = round1(row.a);
  }
  const lastNotenRow = s.lastNoten.get();
  const result = {
    avgNote: round1(avgRow?.a),
    avgBySemester,
    lastFetchedNoten: lastNotenRow?.m || null
  };

  _notenStatsCache = result;
  _notenStatsCacheAt = now;
  _notenStatsCacheDb = db;
  return result;
}

// ---------- Slim Stats für /api/stundenplan ----------
// /api/stundenplan braucht aus getStats() nur lastFetchedStundenplan. 1 Query
// + 5s Memo-Cache (near-zero cost, aber konsistent mit den anderen Pfaden).
function getStundenplanStats(db) {
  const now = Date.now();
  if (_stundenplanStatsCache && _stundenplanStatsCacheDb === db && (now - _stundenplanStatsCacheAt) < STATS_TTL_MS) {
    return _stundenplanStatsCache;
  }

  const s = stmts(db);
  const lastSpRow = s.lastSp.get();
  const result = { lastFetchedStundenplan: lastSpRow?.m || null };

  _stundenplanStatsCache = result;
  _stundenplanStatsCacheAt = now;
  _stundenplanStatsCacheDb = db;
  return result;
}

// ---------- Slim Stats für /api/absenzen ----------
// Speist die Stats-Kachel der Absenzen-Route (Spec §1/§4.2):
//   avgAnwesenheit  Ø der berechneten anwesenheit_pct über alle Module (null leer)
//   unterMinimum    Anzahl Module deren Anwesenheit unter minimal_pct liegt
//   abwesendGesamt  Summe aller abwesend_* Lektionen über alle Module
// Eigener Cache-Slot, im invalidateStatsCache-Pfad eingehängt (Scrape-Commit
// verwirft ihn). round1 wird NICHT angewandt — Prozent-Werte, kein Noten-Raster.
function getAbsenzenStats(db) {
  const now = Date.now();
  if (_absenzenStatsCache && _absenzenStatsCacheDb === db && (now - _absenzenStatsCacheAt) < STATS_TTL_MS) {
    return _absenzenStatsCache;
  }

  const s = stmts(db);
  const aggRow = s.absAgg.get();
  const avg = aggRow?.avg_anwesenheit;
  const result = {
    avgAnwesenheit: avg == null ? null : Math.round(avg * 10) / 10,
    unterMinimum: aggRow?.unter_minimum || 0,
    abwesendGesamt: aggRow?.abwesend_gesamt || 0,
    lastFetchedAbsenzen: aggRow?.last_fetched || null
  };

  _absenzenStatsCache = result;
  _absenzenStatsCacheAt = now;
  _absenzenStatsCacheDb = db;
  return result;
}

// ---------- Frisch-Markierung ----------
// Setzt change_seen_at = jetzt für die übergebenen IDs, aber nur wo
// change_pending = 1 und change_seen_at noch NULL ist. Ein bereits gesehenes
// Item wird NICHT erneut "verlängert" — sonst würde Repeat-Hover die 24h-
// Frist immer wieder zurücksetzen. Returnt die Anzahl tatsächlich markierter
// Zeilen.
//
// kind: 'noten' (matched über kuerzel_id) | 'stundenplan' (matched über id)
function markSeen(db, kind, ids) {
  if (!Array.isArray(ids) || !ids.length) return 0;
  // Auf 200 Items pro Batch begrenzen — IntersectionObserver kann gerne mal
  // schubweise feuern, mehr als das ist sicher Missbrauch.
  const batch = ids.slice(0, 200);
  const placeholders = batch.map(() => '?').join(',');

  let sql;
  let args;
  if (kind === 'noten') {
    sql = `UPDATE noten SET change_seen_at = datetime('now')
           WHERE change_pending = 1
             AND change_seen_at IS NULL
             AND kuerzel_id IN (${placeholders})`;
    args = batch.map(String);
  } else if (kind === 'stundenplan') {
    sql = `UPDATE stundenplan SET change_seen_at = datetime('now')
           WHERE change_pending = 1
             AND change_seen_at IS NULL
             AND id IN (${placeholders})`;
    args = batch.map((v) => Number(v)).filter((n) => Number.isFinite(n));
    if (!args.length) return 0;
  } else if (kind === 'absenzen') {
    // Absenzen matchen über kuerzel_code (Text-Key, analog noten.kuerzel_id) —
    // NICHT zu Number coercen wie stundenplan.
    sql = `UPDATE absenzen SET change_seen_at = datetime('now')
           WHERE change_pending = 1
             AND change_seen_at IS NULL
             AND kuerzel_code IN (${placeholders})`;
    args = batch.map(String);
  } else {
    return 0;
  }

  const stmt = db.prepare(sql);
  const r = stmt.run(...args);
  return r.changes || 0;
}

// Hard dismiss: setzt change_pending = 0 (PLUS change_seen_at) für die
// übergebenen IDs. Im Gegensatz zu markSeen fällt der Eintrag SOFORT aus
// dem "Letzte Änderung"-Stream raus, statt erst nach 24h-Grace. Wird vom
// "Alle gelesen"-Button und vom Mobile-Swipe-to-Dismiss benutzt.
//
// kind: 'noten' | 'stundenplan'
// ids:  Array von kuerzel_id (noten) oder id (stundenplan), ODER null um
//       ALLE aktuell-fresh Einträge des kind zu dismissen.
function dismissChanges(db, kind, ids) {
  if (kind !== 'noten' && kind !== 'stundenplan' && kind !== 'absenzen') return 0;

  // dismissAll-Path: ids=null|undefined → alle pending dismissen
  if (ids == null) {
    let sql;
    if (kind === 'noten') {
      sql = `UPDATE noten SET change_pending = 0, change_seen_at = datetime('now')
             WHERE change_pending = 1`;
    } else if (kind === 'absenzen') {
      sql = `UPDATE absenzen SET change_pending = 0, change_seen_at = datetime('now')
             WHERE change_pending = 1`;
    } else {
      sql = `UPDATE stundenplan SET change_pending = 0, change_seen_at = datetime('now')
             WHERE change_pending = 1`;
    }
    return db.prepare(sql).run().changes || 0;
  }

  if (!Array.isArray(ids) || !ids.length) return 0;
  const batch = ids.slice(0, 200);
  const placeholders = batch.map(() => '?').join(',');

  let sql;
  let args;
  if (kind === 'noten') {
    sql = `UPDATE noten SET change_pending = 0, change_seen_at = datetime('now')
           WHERE change_pending = 1
             AND kuerzel_id IN (${placeholders})`;
    args = batch.map(String);
  } else if (kind === 'absenzen') {
    // Absenzen matchen über kuerzel_code (Text-Key) — nicht zu Number coercen.
    sql = `UPDATE absenzen SET change_pending = 0, change_seen_at = datetime('now')
           WHERE change_pending = 1
             AND kuerzel_code IN (${placeholders})`;
    args = batch.map(String);
  } else {
    sql = `UPDATE stundenplan SET change_pending = 0, change_seen_at = datetime('now')
           WHERE change_pending = 1
             AND id IN (${placeholders})`;
    args = batch.map((v) => Number(v)).filter((n) => Number.isFinite(n));
    if (!args.length) return 0;
  }
  return db.prepare(sql).run(...args).changes || 0;
}

module.exports = {
  getStats,
  getNotenStats,
  getStundenplanStats,
  getAbsenzenStats,
  invalidateStatsCache,
  markSeen,
  dismissChanges
};
