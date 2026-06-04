'use strict';

const { invalidateStatsCache } = require('./stats');

// Leert ALLE gescrapten Daten-Tabellen (Noten + Prüfungen + Historie +
// Stundenplan + Absenzen). BEHÄLT bewusst:
//   - push_subscriptions  → Geräte-Push-Anmeldungen, sonst müsste der User
//                           Web-Push auf jedem Gerät neu aktivieren.
//   - Schema + Migrations-State (PRAGMA user_version) → der nächste Scrape baut
//                           alle Daten frisch auf, ohne Re-Migration.
// Settings (msEmail/Passwort/Scheduler) liegen in einer separaten Datei, NICHT
// in der DB → bleiben unberührt.
//
// Tabellennamen sind hartkodiert (kein User-Input) → kein SQL-Injection-Risiko.
// Alles in EINER Transaktion: entweder alles weg oder nichts (Rollback bei Fehler).
const SCRAPED_TABLES = [
  'noten',
  'noten_history',
  'noten_pruefungen',
  'pruefungen_history',
  'stundenplan',
  'absenzen',
  'absenzen_termine'
];

function resetDb(db) {
  const deleted = {};
  let total = 0;
  db.exec('BEGIN');
  try {
    for (const t of SCRAPED_TABLES) {
      const res = db.prepare(`DELETE FROM ${t}`).run();
      const n = (res && typeof res.changes === 'number') ? res.changes : 0;
      deleted[t] = n;
      total += n;
    }
    db.exec('COMMIT');
    invalidateStatsCache();
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { deleted, total };
}

module.exports = { resetDb, SCRAPED_TABLES };
