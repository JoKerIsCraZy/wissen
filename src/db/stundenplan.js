'use strict';

const { parseDatum, parseZeit } = require('./parsers');
const { IS_FRESH_SQL } = require('./queries');
const { invalidateStatsCache } = require('./stats');

const UPSERT_SP_SQL = `
INSERT INTO stundenplan
  (datum_iso, zeit_von, zeit_bis, raum, dozent, klasse, veranstaltung, source, fetched_at)
VALUES
  (:datum_iso, :zeit_von, :zeit_bis, :raum, :dozent, :klasse, :veranstaltung, :source, CURRENT_TIMESTAMP)
ON CONFLICT(datum_iso, zeit_von, veranstaltung, klasse) DO UPDATE SET
  zeit_bis   = :zeit_bis,
  raum       = :raum,
  dozent     = :dozent,
  source     = :source,
  fetched_at = CURRENT_TIMESTAMP
`;

// Per-db-Handle Prepared-Statement-Cache. Gleiches Pattern wie in noten.js —
// einmal pro Handle vorbereiten und beim Reopen transparent neu aufbauen.
let _stmts = null;
function stmts(db) {
  if (_stmts && _stmts.db === db) return _stmts;
  _stmts = {
    db,
    upsert: db.prepare(UPSERT_SP_SQL),
    getPrev: db.prepare(
      'SELECT raum, dozent FROM stundenplan WHERE datum_iso=? AND zeit_von=? AND veranstaltung=? AND klasse=?'
    ),
    markFresh: db.prepare(
      'UPDATE stundenplan SET change_pending = 1, change_seen_at = NULL '
      + 'WHERE datum_iso=? AND zeit_von=? AND veranstaltung=? AND klasse=?'
    ),
    clearAll: db.prepare('DELETE FROM stundenplan'),
    // Zählt Zeilen einer ANDEREN Quelle als der aktuellen (inkl. Legacy-NULL).
    // NULL-sicher: `source <> ?` allein würde NULL-Zeilen verfehlen, daher das
    // explizite `source IS NULL OR`. > 0 → Quellenwechsel → einmaliger Replace.
    countForeign: db.prepare(
      'SELECT COUNT(*) AS n FROM stundenplan WHERE source IS NULL OR source <> ?'
    ),
    prune: db.prepare(`
      DELETE FROM stundenplan
      WHERE datum_iso < :today
         OR (datum_iso = :today AND zeit_bis != '' AND zeit_bis < :nowTime)
    `)
  };
  return _stmts;
}

// saveStundenplan(db, entries, opts)
//   opts.source : 'rest' | 'scrape' — die Datenquelle dieses Laufs. Steuert den
//                 seamless Quellenwechsel-Replace (siehe unten). Fehlt sie, wird
//                 source als NULL geschrieben und KEIN Replace ausgelöst
//                 (Abwärtskompatibilität für Aufrufer ohne Quellen-Info).
function saveStundenplan(db, entries, opts = {}) {
  const s = stmts(db);
  // Nur die zwei bekannten Quellen akzeptieren; alles andere → null (kein Replace).
  const source = opts.source === 'rest' ? 'rest'
    : opts.source === 'scrape' ? 'scrape'
      : null;

  const stats = { inserted: 0, updated: 0, roomChanges: [], replaced: false };

  db.exec('BEGIN');
  try {
    // Seamless Quellenwechsel: Enthält die Tabelle Zeilen einer ANDEREN Quelle
    // (DOM↔REST oder Legacy-NULL), sind deren Natural Keys inkompatibel — ein
    // UPSERT würde duplizieren statt matchen. Darum EINMALIG atomar leeren, bevor
    // die neue Quelle schreibt. Bedingungen für maximale Sicherheit:
    //   - nur bei bekannter source (sonst kein Replace),
    //   - nur bei nicht-leerem Input (ein transient leerer Scrape darf die
    //     Tabelle NIE auf leer wipen → kein Leer-Fenster),
    //   - alles in DERSELBEN Transaktion (Rollback lässt Altdaten intakt).
    // Nach dem Wipe sind alle Zeilen frische Inserts → getPrev liefert null →
    // KEIN Raumwechsel-Diff/-Push beim Cutover (korrekt: über den Quellenwechsel
    // hinweg gibt es keine valide Baseline). Re-derivebar, kein Datenverlust.
    if (source && entries.length) {
      const foreign = s.countForeign.get(source);
      if (foreign && foreign.n > 0) {
        s.clearAll.run();
        stats.replaced = true;
      }
    }

    for (const e of entries) {
      const zeit = parseZeit(e.zeit);
      const row = {
        datum_iso: parseDatum(e.datum),
        zeit_von: zeit.von,
        zeit_bis: zeit.bis,
        raum: e.raum || '',
        dozent: e.dozent || '',
        klasse: e.klasse || '',
        veranstaltung: e.veranstaltung || '',
        source
      };
      if (!row.datum_iso) continue;

      const prev = s.getPrev.get(row.datum_iso, row.zeit_von, row.veranstaltung, row.klasse);
      s.upsert.run(row);

      if (prev) {
        stats.updated++;
        // Raum-Änderung detektieren
        const prevRaum = (prev.raum || '').trim();
        const newRaum = row.raum.trim();
        if (prevRaum && newRaum && prevRaum !== newRaum) {
          const prevOnline = /online/i.test(prevRaum);
          const newOnline = /online/i.test(newRaum);
          stats.roomChanges.push({
            datum_iso: row.datum_iso,
            zeit_von: row.zeit_von,
            zeit_bis: row.zeit_bis,
            veranstaltung: row.veranstaltung,
            dozent: row.dozent,
            prev_raum: prevRaum,
            new_raum: newRaum,
            wentOnline: newOnline && !prevOnline,
            wentOffline: prevOnline && !newOnline
          });
          s.markFresh.run(row.datum_iso, row.zeit_von, row.veranstaltung, row.klasse);
        }
      } else {
        stats.inserted++;
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

function getStundenplan(db, filters = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const from = filters.from || today;

  const where = ['datum_iso >= :from'];
  const params = { from };

  if (filters.to) {
    where.push('datum_iso <= :to');
    params.to = filters.to;
  }

  let limitClause = '';
  if (typeof filters.limit === 'number' && filters.limit > 0) {
    limitClause = 'LIMIT :limit';
    params.limit = filters.limit;
  }

  // SQL dynamisch per Filter — daher kein Statement-Cache (varianten-Explosion).
  const sql = `
    SELECT id, datum_iso, zeit_von, zeit_bis, raum, dozent, klasse, veranstaltung, fetched_at,
           ${IS_FRESH_SQL} AS isFresh
    FROM stundenplan
    WHERE ${where.join(' AND ')}
    ORDER BY datum_iso ASC, zeit_von ASC
    ${limitClause}
  `;

  const stmt = db.prepare(sql);
  return stmt.all(params) || [];
}

// Komplett-Reset: alle Stundenplan-Einträge löschen. Wird vom UI-Button
// "Stundenplan zurücksetzen" genutzt — z.B. nach Klassen-Wechsel, kaputten
// Daten o.ä. Beim nächsten Scrape werden die aktuellen Einträge frisch geladen.
function clearStundenplan(db) {
  const s = stmts(db);
  const result = s.clearAll.run();
  invalidateStatsCache();
  return result.changes || 0;
}

function pruneVergangen(db) {
  const s = stmts(db);
  const now = new Date();
  const today = now.toISOString().slice(0, 10);        // YYYY-MM-DD
  const nowTime = now.toTimeString().slice(0, 5);      // HH:MM (Lokale Zeit)

  const result = s.prune.run({ today, nowTime });
  if (result.changes > 0) invalidateStatsCache();
  return result.changes || 0;
}

module.exports = {
  saveStundenplan,
  getStundenplan,
  pruneVergangen,
  clearStundenplan
};
