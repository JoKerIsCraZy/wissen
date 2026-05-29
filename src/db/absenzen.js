'use strict';

const { parsePosNum, normalizeAbsenzStatus, isAbwesend } = require('./parsers');
const { IS_FRESH_SQL } = require('./queries');
const { invalidateStatsCache } = require('./stats');

// ---------- Übersicht (absenzen) ----------
// Flat-Upsert pro Modul, gespiegelt an saveStundenplan: prev-Lookup vor dem
// Upsert, Diff danach. changedCodes enthält per Vertrag NUR Module mit einer
// prev-Zeile, deren besucht ODER anwesenheit_pct sich geändert hat — Erst-Inserts
// landen NIE drin (Cold-Start-Schutz: eine Neuinstallation mit historischen
// Absenzen treibt 0 Detail-Force-Scrapes und damit 0 Pushes an).
const UPSERT_ABS_SQL = `
INSERT INTO absenzen
  (kuerzel_code, typ, bezeichnung, semester, soll, besucht, absenzen,
   minimal_pct, anwesenheit_pct, anwesenheit_pct_scraped, fetched_at)
VALUES
  (:kuerzel_code, :typ, :bezeichnung, :semester, :soll, :besucht, :absenzen,
   :minimal_pct, :anwesenheit_pct, :anwesenheit_pct_scraped, CURRENT_TIMESTAMP)
ON CONFLICT(kuerzel_code) DO UPDATE SET
  typ                     = :typ,
  bezeichnung             = :bezeichnung,
  semester                = :semester,
  soll                    = :soll,
  besucht                 = :besucht,
  absenzen                = :absenzen,
  minimal_pct             = :minimal_pct,
  anwesenheit_pct         = :anwesenheit_pct,
  anwesenheit_pct_scraped = :anwesenheit_pct_scraped,
  fetched_at              = CURRENT_TIMESTAMP
`;

// ---------- Detail (absenzen_termine) ----------
const UPSERT_TERMIN_SQL = `
INSERT INTO absenzen_termine
  (kuerzel_code, termin_iso, zeit_von, zeit_bis, termin_raw,
   lektionen_soll, lektionen_ist, anwesenheit_pct, status, status_raw, fetched_at)
VALUES
  (:kuerzel_code, :termin_iso, :zeit_von, :zeit_bis, :termin_raw,
   :lektionen_soll, :lektionen_ist, :anwesenheit_pct, :status, :status_raw, CURRENT_TIMESTAMP)
ON CONFLICT(kuerzel_code, termin_iso, zeit_von) DO UPDATE SET
  zeit_bis        = :zeit_bis,
  termin_raw      = :termin_raw,
  lektionen_soll  = :lektionen_soll,
  lektionen_ist   = :lektionen_ist,
  anwesenheit_pct = :anwesenheit_pct,
  status          = :status,
  status_raw      = :status_raw,
  fetched_at      = CURRENT_TIMESTAMP
`;

// Cooldown für Detail-Scrape-Versuche: 12h. Spiegelt
// DETAIL_BACKFILL_COOLDOWN_MS aus noten.js — verhindert dass Module mit leerer
// Detail-Page (parse-fail / 0 Lektionen) bei jedem Cycle erneut navigiert werden.
const DETAIL_BACKFILL_COOLDOWN_MS = 12 * 60 * 60 * 1000;

// Per-db-Handle Prepared-Statement-Cache (verbatim-Pattern aus pruefungen.js:24).
// node:sqlite Statements sind an einen Handle gebunden, deshalb beim Reopen
// (Tests / Singleton-Reset) transparent neu aufbauen.
let _stmts = null;
function stmts(db) {
  if (_stmts && _stmts.db === db) return _stmts;
  _stmts = {
    db,
    upsertAbs: db.prepare(UPSERT_ABS_SQL),
    getPrevAbs: db.prepare(
      'SELECT besucht, anwesenheit_pct FROM absenzen WHERE kuerzel_code = ?'
    ),
    updateDetailId: db.prepare(
      // Bei ID-Wechsel auch detail_scraped_at zurücksetzen: eine alte/falsche
      // detail_id hat ihre Termine von der falschen Detailseite gezogen → beim
      // nächsten Cycle ohne Cooldown neu scrapen. Macht den ID-Fix selbstheilend
      // (kein manueller Voll-Detail-Scrape nötig). Greift nur wenn die ID sich
      // wirklich ändert (Tocco-PKs sind sonst stabil).
      'UPDATE absenzen SET detail_id = ?, detail_scraped_at = NULL WHERE kuerzel_code = ? AND (detail_id IS NULL OR detail_id != ?)'
    ),
    markDetailScraped: db.prepare(
      'UPDATE absenzen SET detail_scraped_at = CURRENT_TIMESTAMP WHERE kuerzel_code = ?'
    ),
    getWithDetailId: db.prepare(`
      SELECT kuerzel_code, detail_id, bezeichnung, semester, typ
      FROM absenzen
      WHERE detail_id IS NOT NULL
        AND detail_id != ''
      ORDER BY kuerzel_code
    `),
    getAbsRow: db.prepare(`
      SELECT id, kuerzel_code, typ, bezeichnung, semester, soll, besucht, absenzen,
             minimal_pct, anwesenheit_pct, anwesenheit_pct_scraped, detail_id,
             detail_scraped_at, fetched_at
      FROM absenzen WHERE kuerzel_code = ?
    `),
    upsertTermin: db.prepare(UPSERT_TERMIN_SQL),
    getExistingTermine: db.prepare(
      'SELECT termin_iso, zeit_von, status FROM absenzen_termine WHERE kuerzel_code = ?'
    ),
    delTermin: db.prepare(
      'DELETE FROM absenzen_termine WHERE kuerzel_code = ? AND termin_iso = ? AND zeit_von = ?'
    ),
    markFresh: db.prepare(
      'UPDATE absenzen SET change_pending = 1, change_seen_at = NULL WHERE kuerzel_code = ?'
    ),
    getLektionen: db.prepare(`
      SELECT t.id, t.kuerzel_code, t.termin_iso, t.zeit_von, t.zeit_bis, t.termin_raw,
             t.lektionen_soll, t.lektionen_ist, t.anwesenheit_pct,
             t.status, t.status_raw, t.fetched_at,
             ${IS_FRESH_SQL.replace(/change_pending/g, 't.change_pending').replace(/change_seen_at/g, 't.change_seen_at')} AS isFresh,
             (
               SELECT h.status
               FROM absenzen_termine h
               WHERE h.kuerzel_code = t.kuerzel_code
                 AND h.termin_iso   = t.termin_iso
                 AND h.zeit_von     = t.zeit_von
               ORDER BY h.fetched_at DESC
               LIMIT 1 OFFSET 1
             ) AS prev_status
      FROM absenzen_termine t
      WHERE t.kuerzel_code = ?
      ORDER BY t.termin_iso ASC, t.zeit_von ASC
    `)
  };
  return _stmts;
}

// soll - besucht (NICHT auf >=0 clampen — Tocco kann besucht>soll führen).
// null wenn eine der beiden Komponenten fehlt.
function computeAbsenzen(soll, besucht) {
  if (soll == null || besucht == null) return null;
  return soll - besucht;
}

// besucht/soll*100, null bei soll=0 oder fehlenden Komponenten.
function computeAnwesenheitPct(soll, besucht) {
  if (soll == null || besucht == null || soll === 0) return null;
  return (besucht / soll) * 100;
}

// Persistiert die Übersichts-Zeilen. Returns { inserted, updated, changedCodes }.
// changedCodes = NUR Module mit prev-Zeile, deren besucht ODER anwesenheit_pct
// sich änderte (Erst-Insert NIE → Cold-Start-Schutz, Spec §4.2).
function saveAbsenzen(db, rows) {
  const s = stmts(db);
  const stats = { inserted: 0, updated: 0, changedCodes: [] };
  if (!Array.isArray(rows)) return stats;

  db.exec('BEGIN');
  try {
    const seen = new Set();
    for (const e of rows) {
      const code = e && e.kuerzel_code != null ? String(e.kuerzel_code).trim() : '';
      if (!code) continue;
      if (seen.has(code)) continue; // Parser-Duplikate ignorieren
      seen.add(code);

      const soll = parsePosNum(e.soll);
      const besucht = parsePosNum(e.besucht);
      const row = {
        kuerzel_code: code,
        typ: e.typ != null ? String(e.typ) : null,
        bezeichnung: e.bezeichnung != null ? String(e.bezeichnung) : null,
        semester: e.semester != null ? String(e.semester) : null,
        soll,
        besucht,
        absenzen: computeAbsenzen(soll, besucht),
        minimal_pct: parsePosNum(e.minimal_pct),
        anwesenheit_pct: computeAnwesenheitPct(soll, besucht),
        anwesenheit_pct_scraped: parsePosNum(e.anwesenheit_pct_scraped)
      };

      const prev = s.getPrevAbs.get(code);
      s.upsertAbs.run(row);

      if (!prev) {
        stats.inserted++;
        // Erst-Insert NIE in changedCodes (Cold-Start-Schutz).
      } else {
        stats.updated++;
        const besuchtChanged = prev.besucht !== row.besucht;
        const pctChanged = prev.anwesenheit_pct !== row.anwesenheit_pct;
        if (besuchtChanged || pctChanged) {
          stats.changedCodes.push(code);
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

// Schreibt die detail_id (Tocco-PK aus DWR) auf bestehende Absenzen-Zeilen.
// map = { '<kuerzel_code>': '<detail_id>' }.
function updateAbsenzDetailIds(db, map) {
  if (!map || typeof map !== 'object') return;
  const s = stmts(db);
  let changed = 0;
  for (const [code, detailId] of Object.entries(map)) {
    if (!code || detailId == null) continue;
    const did = String(detailId);
    const result = s.updateDetailId.run(did, String(code), did);
    changed += result.changes || 0;
  }
  if (changed > 0) invalidateStatsCache();
}

// Alle Module mit detail_id — wöchentlicher Voll-Refresh (ignoriert Cooldown).
function getAbsenzenWithDetailId(db) {
  const s = stmts(db);
  return s.getWithDetailId.all() || [];
}

// Module die einen Detail-Scrape brauchen: noch nie ODER vor > Cooldown
// gescrapt (Backfill) PLUS explizit übergebene changedCodes (Cooldown ignoriert,
// weil eine geänderte Übersicht potentiell neue/geänderte Lektionen bedeutet).
// Spiegelt getKuerzelnNeedingDetailScrape aus noten.js.
function getAbsenzenNeedingDetailScrape(db, changedCodes = []) {
  const rows = db.prepare(`
    SELECT a.kuerzel_code, a.detail_id
    FROM absenzen a
    WHERE a.detail_id IS NOT NULL
      AND a.detail_id != ''
      AND (a.detail_scraped_at IS NULL
           OR a.detail_scraped_at < datetime('now', ?))
  `).all('-' + Math.round(DETAIL_BACKFILL_COOLDOWN_MS / 1000) + ' seconds') || [];

  const map = new Map();
  for (const r of rows) map.set(r.kuerzel_code, r.detail_id);

  // Geänderte Module IMMER mit aufnehmen (Cooldown ignoriert).
  if (Array.isArray(changedCodes) && changedCodes.length) {
    const codes = changedCodes
      .filter((c) => c && !map.has(String(c)))
      .map(String);
    if (codes.length) {
      const placeholders = codes.map(() => '?').join(',');
      const extraRows = db.prepare(
        `SELECT kuerzel_code, detail_id FROM absenzen
         WHERE kuerzel_code IN (${placeholders})
           AND detail_id IS NOT NULL AND detail_id != ''`
      ).all(...codes) || [];
      for (const r of extraRows) {
        if (!map.has(r.kuerzel_code)) map.set(r.kuerzel_code, r.detail_id);
      }
    }
  }

  return [...map.entries()].map(([kuerzel_code, detail_id]) => ({ kuerzel_code, detail_id }));
}

// Markiert ein Modul als "Detail-Scrape versucht" (egal welcher Outcome) —
// MUSS nach jedem scrapeAbsenzenDetail-Aufruf gerufen werden (Cooldown-Logik).
function markAbsenzDetailScraped(db, kuerzelCode) {
  if (!kuerzelCode) return;
  const s = stmts(db);
  s.markDetailScraped.run(String(kuerzelCode));
  invalidateStatsCache();
}

// Persistiert die Lektions-Liste eines Moduls. Mirror savePruefungen:
//  - Leerer Input = NO-OP (kein Delete, kein Push) — Schutz gegen
//    fehlgeschlagene Detail-Scrapes die fälschlich 0 Treffer liefern.
//  - Sonst: Upsert pro Eintrag (status via normalizeAbsenzStatus) + DELETE der
//    nicht mehr vorhandenen Lektionen.
//
// newAbwesend (Spec §9) sammelt die Push-Kandidaten:
//  - neue Lektion mit isAbwesend(new)            → Kandidat
//  - prev !isAbwesend & new isAbwesend           → Flip → newAbwesend
//  - prev isAbwesend & new isAbwesend & prev≠new → Status-Wechsel → newAbwesend
//  - Flip → teilgenommen/offen                    → nie
//  - entfernte (gelöschte) Lektion                → nie in newAbwesend
// Bei newAbwesend.length>0 → markFresh auf die absenzen-Zeile.
//
// HINWEIS Cold-Start: saveLektionen liefert beim Erst-Befüllen historische
// Abwesenheiten als Kandidaten (kein prev) — der zweite Cold-Start-Filter sitzt
// im runScrapeCycle (nur changedCodes-Module landen im absenzReport, Spec §9.2).
function saveLektionen(db, kuerzelCode, entries) {
  if (!kuerzelCode) {
    return { inserted: 0, updated: 0, deleted: 0, newAbwesend: [] };
  }
  if (!Array.isArray(entries) || !entries.length) {
    // Empty-Input NO-OP (verbatim-Semantik pruefungen.js:96-98).
    return { inserted: 0, updated: 0, deleted: 0, newAbwesend: [] };
  }

  const s = stmts(db);
  const code = String(kuerzelCode);
  const stats = { inserted: 0, updated: 0, deleted: 0, newAbwesend: [] };

  db.exec('BEGIN');
  try {
    const seen = new Set();
    // Map<key, {status}> der vor diesem Save existierenden Lektionen — für die
    // Diff-/Push-Logik. key = `${termin_iso}#${zeit_von}` (Spec §9).
    const beforeMap = new Map();
    for (const r of (s.getExistingTermine.all(code) || [])) {
      beforeMap.set(`${r.termin_iso}#${r.zeit_von}`, { status: r.status });
    }

    for (const e of entries) {
      const terminIso = e.termin_iso != null ? String(e.termin_iso) : null;
      const zeitVon = e.zeit_von != null ? String(e.zeit_von) : '';
      const key = `${terminIso}#${zeitVon}`;
      if (seen.has(key)) continue; // Parser-Duplikate ignorieren
      seen.add(key);

      const statusCat = normalizeAbsenzStatus(e.status_raw);
      const row = {
        kuerzel_code: code,
        termin_iso: terminIso,
        zeit_von: zeitVon,
        zeit_bis: e.zeit_bis != null ? String(e.zeit_bis) : '',
        termin_raw: e.termin_raw != null ? String(e.termin_raw) : null,
        lektionen_soll: parsePosNum(e.lektionen_soll),
        lektionen_ist: parsePosNum(e.lektionen_ist),
        anwesenheit_pct: parsePosNum(e.anwesenheit_pct),
        status: statusCat,
        status_raw: e.status_raw != null ? String(e.status_raw) : null
      };

      const prev = beforeMap.get(key);
      s.upsertTermin.run(row);

      if (!prev) {
        stats.inserted++;
        if (isAbwesend(statusCat)) {
          stats.newAbwesend.push({
            termin_iso: row.termin_iso,
            termin_raw: row.termin_raw,
            zeit_von: row.zeit_von,
            zeit_bis: row.zeit_bis,
            status_cat: statusCat
          });
        }
      } else {
        stats.updated++;
        const prevAbw = isAbwesend(prev.status);
        const newAbw = isAbwesend(statusCat);
        // Flip non-absence→absence (neue Absenz) ODER Wechsel zwischen den
        // Absenz-Arten (entschuldigt↔unentschuldigt = "Status geändert").
        // statusChanged unterscheidet beide für die Notify-Formatter
        // (push.js / bot/notify.js branchen auf statusChanged → "🔄 Status geändert").
        const flippedToAbsence = !prevAbw && newAbw;
        const changedBetweenAbsences = prevAbw && newAbw && prev.status !== statusCat;
        if (flippedToAbsence || changedBetweenAbsences) {
          stats.newAbwesend.push({
            termin_iso: row.termin_iso,
            termin_raw: row.termin_raw,
            zeit_von: row.zeit_von,
            zeit_bis: row.zeit_bis,
            status_cat: statusCat,
            statusChanged: changedBetweenAbsences
          });
        }
      }
    }

    // Entfernte Lektionen löschen — NUR bei nicht-leerem Input (oben garantiert).
    // Gelöschte landen nie in newAbwesend (Klon pruefungen.js:184-189).
    for (const key of beforeMap.keys()) {
      if (seen.has(key)) continue;
      const [terminIso, zeitVon] = key.split('#');
      s.delTermin.run(code, terminIso === 'null' ? null : terminIso, zeitVon);
      stats.deleted++;
    }

    // Frisch-Markierung auf die absenzen-Zeile, wenn es neue/geänderte
    // Abwesenheiten gab. UPDATE no-op falls die absenzen-Zeile (noch) fehlt.
    if (stats.newAbwesend.length > 0) {
      s.markFresh.run(code);
    }

    db.exec('COMMIT');
    invalidateStatsCache();
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return stats;
}

// Tagesliste eines Moduls (inkl. prev_status via OFFSET-1-Subquery + isFresh).
function getLektionen(db, kuerzelCode) {
  if (!kuerzelCode) return [];
  const s = stmts(db);
  return s.getLektionen.all(String(kuerzelCode)) || [];
}

// Gezielter Lookup einer Übersichts-Zeile — für /api/absenzen/:code/termine.
function getAbsenzRow(db, kuerzelCode) {
  if (!kuerzelCode) return null;
  const s = stmts(db);
  return s.getAbsRow.get(String(kuerzelCode)) || null;
}

// Übersichts-Liste (inkl. berechneter anwesenheit_pct, isFresh, detail-
// Vorhandensein). SQL dynamisch per Filter — daher kein Statement-Cache.
function getAbsenzen(db, filters = {}) {
  const where = [];
  const params = {};

  if (filters.typ) {
    where.push('typ = :typ');
    params.typ = filters.typ;
  }
  if (filters.semester) {
    where.push('semester = :semester');
    params.semester = filters.semester;
  }
  // "Unter Minimum": Anwesenheit unter der geforderten Minimalanwesenheit.
  if (filters.unterMinimum === true) {
    where.push('anwesenheit_pct IS NOT NULL AND minimal_pct IS NOT NULL AND anwesenheit_pct < minimal_pct');
  }

  const sql = `
    SELECT a.id, a.kuerzel_code, a.typ, a.bezeichnung, a.semester,
           a.soll, a.besucht, a.absenzen, a.minimal_pct,
           a.anwesenheit_pct, a.anwesenheit_pct_scraped, a.detail_id, a.fetched_at,
           ${IS_FRESH_SQL} AS isFresh,
           CASE WHEN EXISTS (
             SELECT 1 FROM absenzen_termine t WHERE t.kuerzel_code = a.kuerzel_code
           ) THEN 1 ELSE 0 END AS hasDetail
    FROM absenzen a
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY a.bezeichnung ASC, a.kuerzel_code ASC
  `;

  const stmt = db.prepare(sql);
  return stmt.all(params) || [];
}

// Re-export aus stats.js, damit getAbsenzenStats auch via db/absenzen erreichbar
// ist (Stats-Kachel-Quelle, Spec §4.2/§12). Die Implementierung + Cache-Hook
// liegen in stats.js (invalidateStatsCache-Pfad).
const { getAbsenzenStats } = require('./stats');

module.exports = {
  saveAbsenzen,
  updateAbsenzDetailIds,
  getAbsenzenWithDetailId,
  getAbsenzenNeedingDetailScrape,
  markAbsenzDetailScraped,
  saveLektionen,
  getLektionen,
  getAbsenzRow,
  getAbsenzen,
  getAbsenzenStats
};
