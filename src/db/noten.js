'use strict';

const { parseFach, parseKuerzel, parseNote } = require('./parsers');
const { IS_FRESH_SQL } = require('./queries');
const { invalidateStatsCache } = require('./stats');

const UPSERT_NOTEN_SQL = `
INSERT INTO noten
  (kuerzel_id, fach_code, fach_name, kuerzel_full, kuerzel_code, semester, typ, note, note_raw, fetched_at)
VALUES
  (:kuerzel_id, :fach_code, :fach_name, :kuerzel_full, :kuerzel_code, :semester, :typ, :note, :note_raw, CURRENT_TIMESTAMP)
ON CONFLICT(kuerzel_id) DO UPDATE SET
  fach_code    = :fach_code,
  fach_name    = :fach_name,
  kuerzel_full = :kuerzel_full,
  kuerzel_code = :kuerzel_code,
  semester     = :semester,
  typ          = :typ,
  note         = :note,
  note_raw     = :note_raw,
  fetched_at   = CURRENT_TIMESTAMP
`;

// Per-db-Handle Prepared-Statement-Cache. node:sqlite Statements sind an einen
// konkreten Handle gebunden, deshalb müssen sie bei einem Reopen (Tests, oder
// Singleton-Reset) neu vorbereitet werden. Wir cachen genau ein Set und
// invalidieren es transparent wenn sich der Handle ändert — kein WeakMap nötig
// weil der server-Prozess single-DB-Handle führt.
let _stmts = null;
function stmts(db) {
  if (_stmts && _stmts.db === db) return _stmts;
  _stmts = {
    db,
    upsert: db.prepare(UPSERT_NOTEN_SQL),
    getPrev: db.prepare('SELECT note, note_raw FROM noten WHERE kuerzel_id = ?'),
    insertHist: db.prepare(
      'INSERT INTO noten_history (kuerzel_id, fach_name, note, note_raw) VALUES (?, ?, ?, ?)'
    ),
    markFresh: db.prepare(
      'UPDATE noten SET change_pending = 1, change_seen_at = NULL WHERE kuerzel_id = ?'
    ),
    updateDetailId: db.prepare(
      // Bei ID-Wechsel auch detail_scraped_at zurücksetzen (#11): eine alte/
      // falsche detail_id hat ihre Prüfungen von der falschen Detailseite
      // gezogen → beim nächsten Cycle ohne Cooldown neu scrapen (Self-Healing,
      // spiegelt absenzen.updateDetailId). Greift nur bei echtem ID-Wechsel.
      'UPDATE noten SET detail_id = ?, detail_scraped_at = NULL WHERE kuerzel_id = ? AND (detail_id IS NULL OR detail_id != ?)'
    ),
    markDetailScraped: db.prepare(
      'UPDATE noten SET detail_scraped_at = CURRENT_TIMESTAMP WHERE kuerzel_id = ?'
    ),
    getNotenRow: db.prepare(
      'SELECT id, kuerzel_id, fach_code, fach_name, kuerzel_full, kuerzel_code, '
      + '       semester, typ, note, note_raw, detail_id, detail_scraped_at, fetched_at '
      + 'FROM noten WHERE kuerzel_id = ?'
    ),
    getHistory: db.prepare(`
      SELECT id, kuerzel_id, fach_name, note, note_raw, recorded_at
      FROM noten_history
      WHERE kuerzel_id = ?
      ORDER BY recorded_at DESC
    `),
    getKuerzelnWithDetailId: db.prepare(`
      SELECT kuerzel_id, detail_id, fach_name, semester, kuerzel_code
      FROM noten
      WHERE detail_id IS NOT NULL
        AND detail_id != ''
      ORDER BY kuerzel_id
    `)
  };
  return _stmts;
}

function saveNoten(db, entries) {
  const s = stmts(db);

  // gradeChanges listet nur Änderungen am Note-Wert selbst (relevant für Push-Notifications).
  // "new" = Eintrag erstmalig mit Note; "changed" = Note-Wert hat sich verändert.
  const stats = { inserted: 0, updated: 0, changed: 0, gradeChanges: [] };

  db.exec('BEGIN');
  try {
    for (const e of entries) {
      const fach = parseFach(e.fach);
      const kuerzel = parseKuerzel(e.kuerzel);
      if (!kuerzel.id) continue;

      const note = parseNote(e.note);
      const row = {
        kuerzel_id: kuerzel.id,
        fach_code: fach.code,
        fach_name: fach.name,
        kuerzel_full: e.kuerzel || '',
        kuerzel_code: kuerzel.code,
        semester: kuerzel.semester,
        typ: e.typ || '',
        note,
        note_raw: e.note || ''
      };

      const prev = s.getPrev.get(kuerzel.id);
      s.upsert.run(row);

      if (!prev) {
        stats.inserted++;
        if (note != null) {
          stats.gradeChanges.push({
            type: 'new',
            kuerzel_id: kuerzel.id,
            kuerzel_code: kuerzel.code,
            fach_name: fach.name,
            semester: kuerzel.semester,
            prev_note: null,
            new_note: note
          });
          s.markFresh.run(kuerzel.id);
        }
        s.insertHist.run(kuerzel.id, fach.name, note, row.note_raw);
      } else {
        stats.updated++;
        const noteChanged = prev.note !== note;
        const rawChanged = prev.note_raw !== row.note_raw;
        if (noteChanged) {
          stats.gradeChanges.push({
            type: prev.note == null ? 'new' : 'changed',
            kuerzel_id: kuerzel.id,
            kuerzel_code: kuerzel.code,
            fach_name: fach.name,
            semester: kuerzel.semester,
            prev_note: prev.note,
            new_note: note
          });
          s.markFresh.run(kuerzel.id);
        }
        if (noteChanged || rawChanged) {
          stats.changed++;
          s.insertHist.run(kuerzel.id, fach.name, note, row.note_raw);
        }
      }
    }
    db.exec('COMMIT');
    invalidateStatsCache();
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return stats;
}

function getNoten(db, filters = {}) {
  const where = [];
  const params = {};

  if (filters.semester) {
    where.push('semester = :semester');
    params.semester = filters.semester;
  }
  if (filters.hasNote === true) {
    where.push('note IS NOT NULL');
  } else if (filters.hasNote === false) {
    where.push('note IS NULL');
  }

  let orderBy = 'fach_name ASC';
  if (filters.sortBy === 'note') {
    // Noten mit NULL zuletzt, dann aufsteigend
    orderBy = 'CASE WHEN note IS NULL THEN 1 ELSE 0 END ASC, note ASC, fach_name ASC';
  } else if (filters.sortBy === 'fetched') {
    orderBy = 'fetched_at DESC';
  } else if (filters.sortBy === 'fach') {
    orderBy = 'fach_name ASC';
  }

  // prev_note: der vorherige distinkte Note-Wert aus noten_history.
  // Da saveNoten History-Snapshots NUR bei echter note-Änderung schreibt,
  // ist der zweitletzte Snapshot der letzte distinkte Vorwert
  // (LIMIT 1 OFFSET 1 nach recorded_at DESC). null wenn noch nie geändert
  // (initialer Eintrag oder keine History — z.B. Modul ohne Note).
  // note_recorded_at: wann der jetzige Note-Wert erfasst wurde — erlaubt
  // dem Frontend "vor X Stunden geändert auf Y" zu rendern.
  // SQL wird pro Filter-Kombination dynamisch zusammengebaut — daher hier
  // kein Statement-Cache (würde pro Variante geprepared, kaum Gewinn).
  const sql = `
    SELECT n.id, n.kuerzel_id, n.fach_code, n.fach_name, n.kuerzel_full, n.kuerzel_code,
           n.semester, n.typ, n.note, n.note_raw, n.fetched_at,
           ${IS_FRESH_SQL} AS isFresh,
           (
             SELECT note
             FROM noten_history h
             WHERE h.kuerzel_id = n.kuerzel_id
             ORDER BY h.recorded_at DESC
             LIMIT 1 OFFSET 1
           ) AS prev_note,
           (
             SELECT recorded_at
             FROM noten_history h
             WHERE h.kuerzel_id = n.kuerzel_id
             ORDER BY h.recorded_at DESC
             LIMIT 1
           ) AS note_recorded_at,
           -- Prüfungs-Fortschritt pro Modul: wie viele ZP/LB erfasst sind und
           -- wie viele davon noch OFFEN (unbenotet, bewertung IS NULL) sind.
           -- Treibt die "X offen"-Anzeige im Frontend (pro Modul + Summe).
           (
             SELECT COUNT(*) FROM noten_pruefungen p
             WHERE p.kuerzel_id = n.kuerzel_id
           ) AS pruefungen_total,
           (
             SELECT COUNT(*) FROM noten_pruefungen p
             WHERE p.kuerzel_id = n.kuerzel_id AND p.bewertung IS NULL
           ) AS pruefungen_open
    FROM noten n
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY ${orderBy}
  `;

  const stmt = db.prepare(sql);
  return stmt.all(params) || [];
}

function getHistory(db, kuerzelId) {
  if (!kuerzelId) return [];
  const s = stmts(db);
  return s.getHistory.all(kuerzelId) || [];
}

// Schreibt die detail_id (Tocco-PK aus DWR) auf bestehende Modul-Zeilen.
// Aufruf nach saveNoten — kuerzelToDetail = { '<kuerzel_id>': '<detail_id>' }.
function updateDetailIds(db, kuerzelToDetail) {
  if (!kuerzelToDetail || typeof kuerzelToDetail !== 'object') return 0;
  const s = stmts(db);
  let changed = 0;
  for (const [kuerzelId, detailId] of Object.entries(kuerzelToDetail)) {
    if (!kuerzelId || detailId == null) continue;
    const did = String(detailId);
    const result = s.updateDetailId.run(did, String(kuerzelId), did);
    changed += result.changes || 0;
  }
  if (changed > 0) invalidateStatsCache();
  return changed;
}

// Liefert ALLE Module mit detail_id — ignoriert Cooldown UND "haben
// pruefungen" Filter UND verlangt KEINE Modulnote. Wird vom Voll-Detail-
// Refresh genutzt (täglicher Lauf am Tagesende + Sa-Backstop), um
//  (a) Module mit bereits vorhandenen Prüfungen erneut zu prüfen
//      (Edge-Case: ZP=5.5 + LB=5.5 → Modulnote unverändert, aber LB ist neu),
//  (b) Module OHNE Modulnote (note IS NULL) abzudecken — diese haben oft schon
//      einzelne LB/ZP, die sonst nie gescrapt würden (Backfill verlangt note).
function getKuerzelnWithDetailId(db) {
  const s = stmts(db);
  return s.getKuerzelnWithDetailId.all() || [];
}

// Cooldown für Backfill-Versuche bei leeren Detail-Pages: 12h. Bei kürzerem
// Cooldown würden Module ohne Prüfungen jeden Cycle erneut gescrapt werden
// (Playwright-Page-Load = teuer). Bei längerem würden neue Prüfungen zu spät
// nachgezogen.
const DETAIL_BACKFILL_COOLDOWN_MS = 12 * 60 * 60 * 1000;

// Liefert Module die einen Detail-Scrape brauchen:
//  - haben eine Note (note IS NOT NULL)
//  - haben eine detail_id (sonst können wir nicht navigieren)
//  - haben noch KEINE BENOTETE Prüfung (bewertung IS NOT NULL) — Backfill.
//    Wichtig: der Filter prüft auf eine benotete Prüfung, NICHT bloss auf
//    "irgendeine Zeile". Sonst würde eine rein leere/unbenotete LB-Zeile (die
//    seit der Leer-LB-Erfassung persistiert wird) das Modul fälschlich aus der
//    Backfill-Rotation kicken, sodass die spätere null→Wert-Benotung erst beim
//    nächsten Voll-Refresh statt zeitnah erkannt würde (Audit-Fund #4).
//  - wurden noch nie ODER vor > Cooldown gescrapt (verhindert Endlos-Retry
//    bei Modulen, deren Detail-Page wirklich leer ist)
// Ergänzt durch explizite Liste von kuerzelIds (z.B. aus gradeChanges) — diese
// werden IMMER mit aufgenommen (Cooldown ignoriert), weil eine geänderte Note
// auch potentiell neue/aktualisierte Prüfungen bedeutet.
function getKuerzelnNeedingDetailScrape(db, additionalKuerzelIds = []) {
  const rows = db.prepare(`
    SELECT n.kuerzel_id, n.detail_id
    FROM noten n
    WHERE n.note IS NOT NULL
      AND n.detail_id IS NOT NULL
      AND n.detail_id != ''
      AND (n.detail_scraped_at IS NULL
           OR n.detail_scraped_at < datetime('now', ?))
      AND NOT EXISTS (
        SELECT 1 FROM noten_pruefungen p
        WHERE p.kuerzel_id = n.kuerzel_id AND p.bewertung IS NOT NULL
      )
  `).all('-' + Math.round(DETAIL_BACKFILL_COOLDOWN_MS / 1000) + ' seconds') || [];

  const map = new Map();
  for (const r of rows) map.set(r.kuerzel_id, r.detail_id);

  // Zusätzliche kuerzelIds (aus gradeChanges) — Cooldown ignoriert,
  // weil sich die Note geändert hat → potentiell neue/aktualisierte Prüfungen.
  // Batched IN(?, ?, …) statt N+1 lookupOne.get() — bei initialem Import
  // sind das schnell 50+ Module pro Cycle.
  if (Array.isArray(additionalKuerzelIds) && additionalKuerzelIds.length) {
    const ids = additionalKuerzelIds
      .filter((kid) => kid && !map.has(String(kid)))
      .map(String);
    if (ids.length) {
      const placeholders = ids.map(() => '?').join(',');
      const extraRows = db.prepare(
        `SELECT kuerzel_id, detail_id FROM noten
         WHERE kuerzel_id IN (${placeholders})
           AND detail_id IS NOT NULL AND detail_id != ''`
      ).all(...ids) || [];
      for (const r of extraRows) {
        if (!map.has(r.kuerzel_id)) map.set(r.kuerzel_id, r.detail_id);
      }
    }
  }

  return [...map.entries()].map(([kuerzel_id, detail_id]) => ({ kuerzel_id, detail_id }));
}

// Markiert ein Modul als "Detail-Scrape versucht" (egal ob erfolgreich oder leer).
// MUSS nach jedem scrapeDetail-Aufruf gerufen werden, damit die Cooldown-Logik
// in getKuerzelnNeedingDetailScrape greift.
function markDetailScraped(db, kuerzelId) {
  if (!kuerzelId) return;
  const s = stmts(db);
  s.markDetailScraped.run(String(kuerzelId));
  invalidateStatsCache();
}

// Gezielter Lookup einer Modul-Zeile — wird vom /api/noten/:id/pruefungen
// Endpoint genutzt, damit der Server-Layer keine eigene SQL-Statements führt.
function getNotenRow(db, kuerzelId) {
  if (!kuerzelId) return null;
  const s = stmts(db);
  return s.getNotenRow.get(String(kuerzelId)) || null;
}

module.exports = {
  saveNoten,
  getNoten,
  getNotenRow,
  getHistory,
  updateDetailIds,
  getKuerzelnWithDetailId,
  getKuerzelnNeedingDetailScrape,
  markDetailScraped
};
