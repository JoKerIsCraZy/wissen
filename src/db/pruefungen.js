'use strict';

const { parseNote, classifyPruefung, parseGewichtPct } = require('./parsers');
const { invalidateStatsCache } = require('./stats');

const UPSERT_PRUEF_SQL = `
INSERT INTO noten_pruefungen
  (kuerzel_id, pruefung_typ, pruefung_nr, bezeichnung, gewicht, gewicht_pct, bewertung, bewertung_raw, fetched_at)
VALUES
  (:kuerzel_id, :pruefung_typ, :pruefung_nr, :bezeichnung, :gewicht, :gewicht_pct, :bewertung, :bewertung_raw, CURRENT_TIMESTAMP)
ON CONFLICT(kuerzel_id, pruefung_typ, pruefung_nr) DO UPDATE SET
  bezeichnung   = :bezeichnung,
  gewicht       = :gewicht,
  gewicht_pct   = :gewicht_pct,
  bewertung     = :bewertung,
  bewertung_raw = :bewertung_raw,
  fetched_at    = CURRENT_TIMESTAMP,
  missing_streak = 0
`;

// Lösch-Schutz (#6): eine im Detail-Scrape fehlende Prüfung wird nur dann
// gelöscht, wenn die Seite beweisbar vollständig war (gescrapte Anzahl >=
// "Anzahl Prüfungen: N") ODER sie an so vielen Checks IN FOLGE fehlte. So
// überlebt eine valide Note ein einmaliges Halb-Laden der Tocco-Detailseite.
const MISSING_STREAK_THRESHOLD = 2;

// Per-db-Handle Prepared-Statement-Cache. Gleiches Pattern wie in noten.js /
// stundenplan.js. markFresh wird ebenfalls vorbereitet, weil savePruefungen
// im Hot-Path nach jedem Detail-Scrape läuft.
let _stmts = null;
function stmts(db) {
  if (_stmts && _stmts.db === db) return _stmts;
  _stmts = {
    db,
    upsert: db.prepare(UPSERT_PRUEF_SQL),
    getExisting: db.prepare(
      'SELECT pruefung_typ, pruefung_nr, bewertung, bewertung_raw, missing_streak '
      + 'FROM noten_pruefungen WHERE kuerzel_id = ?'
    ),
    bumpStreak: db.prepare(
      'UPDATE noten_pruefungen SET missing_streak = ? '
      + 'WHERE kuerzel_id = ? AND pruefung_typ = ? AND pruefung_nr = ?'
    ),
    insertHist: db.prepare(
      'INSERT INTO pruefungen_history '
      + '(kuerzel_id, pruefung_typ, pruefung_nr, bezeichnung, bewertung, bewertung_raw) '
      + 'VALUES (?, ?, ?, ?, ?, ?)'
    ),
    del: db.prepare(
      'DELETE FROM noten_pruefungen WHERE kuerzel_id = ? AND pruefung_typ = ? AND pruefung_nr = ?'
    ),
    markFresh: db.prepare(
      'UPDATE noten SET change_pending = 1, change_seen_at = NULL WHERE kuerzel_id = ?'
    ),
    getPruefungen: db.prepare(`
      SELECT p.id, p.kuerzel_id, p.pruefung_typ, p.pruefung_nr, p.bezeichnung,
             p.gewicht, p.gewicht_pct, p.bewertung, p.bewertung_raw, p.fetched_at,
             (
               SELECT bewertung
               FROM pruefungen_history h
               WHERE h.kuerzel_id   = p.kuerzel_id
                 AND h.pruefung_typ = p.pruefung_typ
                 AND h.pruefung_nr  = p.pruefung_nr
               ORDER BY h.recorded_at DESC
               LIMIT 1 OFFSET 1
             ) AS prev_bewertung,
             (
               SELECT recorded_at
               FROM pruefungen_history h
               WHERE h.kuerzel_id   = p.kuerzel_id
                 AND h.pruefung_typ = p.pruefung_typ
                 AND h.pruefung_nr  = p.pruefung_nr
               ORDER BY h.recorded_at DESC
               LIMIT 1
             ) AS bewertung_recorded_at
      FROM noten_pruefungen p
      WHERE p.kuerzel_id = ?
      ORDER BY
        CASE p.pruefung_typ WHEN 'ZP' THEN 0 WHEN 'LB' THEN 1 ELSE 2 END ASC,
        p.pruefung_nr ASC
    `)
  };
  return _stmts;
}

// Persistiert die Prüfungs-Liste für ein Modul. Empty array = no-op (lässt
// bestehende Daten unangetastet — Schutz gegen fehlgeschlagene Detail-Scrapes
// die fälschlich 0 Treffer liefern). Sonst: Upsert pro Eintrag + DELETE der
// nicht mehr vorhandenen (Tocco hat eine Prüfung entfernt).
//
// History-Trail: Bei jeder echten Wert-Änderung (bewertung != prev.bewertung
// ODER bewertung_raw != prev.bewertung_raw) wird ein Snapshot in
// pruefungen_history geschrieben — analog zu noten_history. Auch beim
// erstmaligen Einfügen mit Bewertung (damit künftige Änderungen einen
// "from"-Punkt haben).
//
// Returns: { inserted, updated, deleted, addedEntries, changedEntries }
//   addedEntries  = NEU eingefügte Prüfungen (typ/nr existierten vorher
//                   nicht). Liefert die Push-Diff-Quelle für "Neue ZP".
//   changedEntries = Bewertung einer bestehenden Prüfung hat sich geändert.
//                    Enthält prev_bewertung + new_bewertung. Liefert die
//                    Push-Diff-Quelle für "ZP von 4.0 → 4.5".
function savePruefungen(db, kuerzelId, entries, opts = {}) {
  if (!kuerzelId) {
    return { inserted: 0, updated: 0, deleted: 0, addedEntries: [], changedEntries: [] };
  }
  if (!Array.isArray(entries) || !entries.length) {
    // Empty-Input NO-OP: ein komplett fehlgeschlagener/leerer Scrape darf NIE
    // löschen (kein Vertrauen in die Absenz). Bestehende Daten bleiben.
    return { inserted: 0, updated: 0, deleted: 0, addedEntries: [], changedEntries: [] };
  }

  const s = stmts(db);

  const stats = {
    inserted: 0, updated: 0, deleted: 0,
    addedEntries: [], changedEntries: []
  };

  db.exec('BEGIN');
  try {
    const seen = new Set();
    // Map<key, {bewertung, bewertung_raw}> der vor diesem Save existierenden
    // Einträge — für Diff- und History-Logik nötig.
    const beforeMap = new Map();
    for (const r of (s.getExisting.all(String(kuerzelId)) || [])) {
      beforeMap.set(`${r.pruefung_typ}#${r.pruefung_nr}`, {
        bewertung: r.bewertung,
        bewertung_raw: r.bewertung_raw,
        missing_streak: r.missing_streak || 0
      });
    }

    for (const e of entries) {
      const cls = classifyPruefung(e.bezeichnung, e.pruefung_nr);
      const key = `${cls.typ}#${cls.nr}`;
      if (seen.has(key)) continue; // doppelte aus dem Parser ignorieren
      seen.add(key);

      const bewertung = (e.bewertung == null || e.bewertung === '') ? null
        : (typeof e.bewertung === 'number' ? e.bewertung : parseNote(String(e.bewertung)));

      const row = {
        kuerzel_id:    String(kuerzelId),
        pruefung_typ:  cls.typ,
        pruefung_nr:   cls.nr,
        bezeichnung:   e.bezeichnung || null,
        gewicht:       e.gewicht || null,
        gewicht_pct:   parseGewichtPct(e.gewicht),
        bewertung:     bewertung,
        bewertung_raw: e.bewertung_raw != null ? String(e.bewertung_raw) : (e.bewertung != null ? String(e.bewertung) : null)
      };

      const prev = beforeMap.get(key);
      s.upsert.run(row);

      if (!prev) {
        stats.inserted++;
        // Eine NEU aufgetauchte, aber noch UNBENOTETE Prüfung (leere LB) wird
        // gespeichert (damit sie in der UI als "—" erscheint), aber NICHT als
        // push-/feed-würdiges addedEntry gewertet und löst kein markFresh aus —
        // eine leere Note ist keine Neuigkeit. Sobald sie später eine Bewertung
        // bekommt (NULL → Wert), greift der changedEntries-Pfad unten und
        // erzeugt korrekt einen Push ("LB 4: —→4.7").
        if (row.bewertung != null) {
          stats.addedEntries.push({
            pruefung_typ: cls.typ,
            pruefung_nr:  cls.nr,
            bezeichnung:  row.bezeichnung,
            gewicht:      row.gewicht,
            gewicht_pct:  row.gewicht_pct,
            bewertung:    row.bewertung
          });
          // Snapshot für künftige Diffs (nur für benotete Erst-Einträge).
          s.insertHist.run(
            row.kuerzel_id, row.pruefung_typ, row.pruefung_nr,
            row.bezeichnung, row.bewertung, row.bewertung_raw
          );
        }
      } else {
        stats.updated++;
        const bewertungChanged = prev.bewertung !== row.bewertung;
        const rawChanged = prev.bewertung_raw !== row.bewertung_raw;
        if (bewertungChanged) {
          stats.changedEntries.push({
            pruefung_typ:    cls.typ,
            pruefung_nr:     cls.nr,
            bezeichnung:     row.bezeichnung,
            gewicht:         row.gewicht,
            gewicht_pct:     row.gewicht_pct,
            prev_bewertung:  prev.bewertung,
            new_bewertung:   row.bewertung
          });
        }
        if (bewertungChanged || rawChanged) {
          s.insertHist.run(
            row.kuerzel_id, row.pruefung_typ, row.pruefung_nr,
            row.bezeichnung, row.bewertung, row.bewertung_raw
          );
        }
      }
    }

    // ---- Lösch-Schutz gegen Teil-Scrapes (#6) ----
    // expectedCount = "Anzahl Prüfungen: N" von der Detailseite (via opts).
    // scrapedCount  = Anzahl distinkter, in DIESEM Scrape gesehener Prüfungen.
    //   complete   → Seite beweisbar vollständig → fehlende Prüfung ist wirklich
    //                weg → sofort löschen (echte Lehrer-Löschung).
    //   incomplete → Teil-Scrape (Seite halb geladen) → Absenz NICHT vertrauen,
    //                NICHTS anfassen (kein Löschen, kein Strike).
    //   unbekannt  → 2-Strike: erst nach MISSING_STREAK_THRESHOLD Checks in
    //                Folge löschen, sonst Streak hochzählen und behalten.
    const expectedCount = (opts && Number.isFinite(opts.expectedCount) && opts.expectedCount > 0)
      ? opts.expectedCount : null;
    const scrapedCount = seen.size;
    const complete   = expectedCount != null && scrapedCount >= expectedCount;
    const incomplete = expectedCount != null && scrapedCount < expectedCount;
    stats.expectedCount = expectedCount;
    stats.scrapedCount = scrapedCount;
    stats.incomplete = incomplete;

    for (const key of beforeMap.keys()) {
      if (seen.has(key)) continue; // in diesem Scrape vorhanden → bleibt (Streak via UPSERT auf 0)
      const [typ, nr] = key.split('#');
      const nrInt = parseInt(nr, 10);
      if (complete) {
        s.del.run(String(kuerzelId), typ, nrInt);
        stats.deleted++;
      } else if (incomplete) {
        stats.protected = (stats.protected || 0) + 1; // Teil-Scrape → geschützt
      } else {
        const prevStreak = (beforeMap.get(key) && beforeMap.get(key).missing_streak) || 0;
        const newStreak = prevStreak + 1;
        if (newStreak >= MISSING_STREAK_THRESHOLD) {
          s.del.run(String(kuerzelId), typ, nrInt);
          stats.deleted++;
        } else {
          s.bumpStreak.run(newStreak, String(kuerzelId), typ, nrInt);
          stats.deferredDelete = (stats.deferredDelete || 0) + 1;
        }
      }
    }

    // Markiert das Modul als "frisch" wenn sich eine ZP/LB-Bewertung geändert
    // hat ODER eine neue ZP/LB-Prüfung hinzukam. Damit landet die Änderung im
    // "Letzte Änderung"-Feed des Frontends — analog zu saveNoten.markFresh.
    // Wird auch dann gesetzt wenn die Modulnote sich nicht geändert hat
    // (Edge-Case Tocco-Rundung: ZP 4.0 → 4.5 aber Schnitt bleibt gerundet).
    // UPDATE läuft NUR wenn die noten-Zeile existiert (kein Insert hier);
    // bei nicht-existierendem Modul ist die Operation ein no-op.
    if (stats.changedEntries.length > 0 || stats.addedEntries.length > 0) {
      s.markFresh.run(String(kuerzelId));
    }

    db.exec('COMMIT');
    invalidateStatsCache();
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return stats;
}

// Einmalige (idempotente) Migration: existierende OTHER-Einträge deren
// Bezeichnung mit "LB" oder "ZP" beginnt werden re-klassifiziert. Wird beim
// open() aufgerufen — beim zweiten Mal findet die Query nichts mehr.
//
// Bei UNIQUE-Konflikt (es gibt bereits einen Eintrag mit dem korrekten
// pruefung_typ + pruefung_nr) wird der OTHER-Duplikat gelöscht.
//
// Hinweis: Wird in schema.js inzwischen über PRAGMA user_version gegated, so
// dass dieser unindexierte LIKE-Scan nur einmal pro DB-Lifetime läuft.
function reclassifyOtherPruefungen(db) {
  const rows = db.prepare(
    "SELECT id, kuerzel_id, pruefung_nr, bezeichnung " +
    "FROM noten_pruefungen " +
    "WHERE pruefung_typ = 'OTHER' " +
    "  AND (bezeichnung LIKE 'LB%' OR bezeichnung LIKE 'ZP%' " +
    "       OR bezeichnung LIKE 'lb%' OR bezeichnung LIKE 'zp%')"
  ).all() || [];
  if (!rows.length) return { updated: 0, removed: 0 };

  const upd = db.prepare(
    'UPDATE noten_pruefungen SET pruefung_typ = ?, pruefung_nr = ? WHERE id = ?'
  );
  const del = db.prepare('DELETE FROM noten_pruefungen WHERE id = ?');

  let updated = 0, removed = 0;
  for (const r of rows) {
    const cls = classifyPruefung(r.bezeichnung, r.pruefung_nr);
    if (cls.typ === 'OTHER') continue;
    try {
      upd.run(cls.typ, cls.nr, r.id);
      updated++;
    } catch (_) {
      // UNIQUE-Konflikt: korrekter Eintrag existiert bereits — Duplikat löschen.
      try { del.run(r.id); removed++; } catch (_e) { /* ignore */ }
    }
  }
  if (updated > 0 || removed > 0) invalidateStatsCache();
  return { updated, removed };
}

function getPruefungen(db, kuerzelId) {
  if (!kuerzelId) return [];
  // prev_bewertung = der vorherige Wert dieser Prüfung, gezogen aus
  // pruefungen_history. Da savePruefungen Snapshots NUR bei echter Wert-
  // Änderung schreibt, ist der zweitletzte Snapshot per Definition der
  // letzte distinkte Vorwert (LIMIT 1 OFFSET 1 nach recorded_at DESC).
  // prev_bewertung_at = wann der jetzige Wert erstmals erfasst wurde
  // (= recorded_at des aktuellen / letzten Snapshots), damit die UI
  // bei Bedarf "vor X Tagen geändert auf 4.5" rendern kann.
  const s = stmts(db);
  return s.getPruefungen.all(String(kuerzelId)) || [];
}

module.exports = {
  savePruefungen,
  getPruefungen,
  reclassifyOtherPruefungen
};
