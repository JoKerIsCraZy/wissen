'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

function setup() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tocco-pruef-fresh-'));
  process.chdir(tmpDir);
  // Reset module cache so singleton starts fresh
  for (const k of Object.keys(require.cache)) {
    if (k.includes('wissen') && k.includes('src')) delete require.cache[k];
  }
  const db = require('../../src/db');
  const d = db.openOnce();
  // Seed a noten row
  d.exec(`INSERT INTO noten (kuerzel_id, fach_name, semester, note, note_raw, change_pending)
          VALUES ('M1', 'Mathe', 'S1', 5.0, '5.0', 0)`);
  return { db, d };
}

test('savePruefungen sets change_pending=1 when ZP value changes', () => {
  const { db, d } = setup();
  // Initial pruefung
  db.savePruefungen(d, 'M1', [
    { bezeichnung: 'ZP 1', pruefung_nr: 1, gewicht: '50%', bewertung: 4.0 }
  ]);
  // Reset change_pending after the initial insert
  d.prepare('UPDATE noten SET change_pending=0 WHERE kuerzel_id=?').run('M1');
  // Change the value
  const result = db.savePruefungen(d, 'M1', [
    { bezeichnung: 'ZP 1', pruefung_nr: 1, gewicht: '50%', bewertung: 4.5 }
  ]);
  assert.strictEqual(result.changedEntries.length, 1);
  const row = d.prepare('SELECT change_pending FROM noten WHERE kuerzel_id=?').get('M1');
  assert.strictEqual(row.change_pending, 1, 'change_pending should be set when ZP changes');
  db.closeInstance();
});

test('savePruefungen does NOT set change_pending when nothing changes', () => {
  const { db, d } = setup();
  db.savePruefungen(d, 'M1', [
    { bezeichnung: 'ZP 1', pruefung_nr: 1, gewicht: '50%', bewertung: 4.0 }
  ]);
  d.prepare('UPDATE noten SET change_pending=0 WHERE kuerzel_id=?').run('M1');
  // Same data again — no change
  const result = db.savePruefungen(d, 'M1', [
    { bezeichnung: 'ZP 1', pruefung_nr: 1, gewicht: '50%', bewertung: 4.0 }
  ]);
  assert.strictEqual(result.changedEntries.length, 0);
  assert.strictEqual(result.addedEntries.length, 0);
  const row = d.prepare('SELECT change_pending FROM noten WHERE kuerzel_id=?').get('M1');
  assert.strictEqual(row.change_pending, 0, 'change_pending should stay 0 when nothing changed');
  db.closeInstance();
});

test('savePruefungen sets change_pending=1 when new ZP added', () => {
  const { db, d } = setup();
  db.savePruefungen(d, 'M1', [
    { bezeichnung: 'ZP 1', pruefung_nr: 1, gewicht: '50%', bewertung: 4.0 }
  ]);
  d.prepare('UPDATE noten SET change_pending=0 WHERE kuerzel_id=?').run('M1');
  const result = db.savePruefungen(d, 'M1', [
    { bezeichnung: 'ZP 1', pruefung_nr: 1, gewicht: '50%', bewertung: 4.0 },
    { bezeichnung: 'ZP 2', pruefung_nr: 2, gewicht: '50%', bewertung: 5.0 }
  ]);
  assert.strictEqual(result.addedEntries.length, 1);
  const row = d.prepare('SELECT change_pending FROM noten WHERE kuerzel_id=?').get('M1');
  assert.strictEqual(row.change_pending, 1, 'change_pending should be set when new ZP added');
  db.closeInstance();
});

// --- Leere (unbenotete) Prüfungen: speichern, anzeigen, aber NICHT als
//     "neue Prüfung" pushen/markieren (eine leere Note ist keine Neuigkeit). ---

test('savePruefungen speichert eine leere LB, ohne sie als addedEntry/fresh zu werten', () => {
  const { db, d } = setup();
  const result = db.savePruefungen(d, 'M1', [
    { bezeichnung: 'LB 1', pruefung_nr: 1, gewicht: '25%', bewertung: 4.7 },
    { bezeichnung: 'LB 4', pruefung_nr: 4, gewicht: '25%', bewertung: '' } // unbenotet
  ]);
  // Nur die benotete LB1 zählt als "neu" (push-/feed-würdig)
  assert.strictEqual(result.addedEntries.length, 1);
  assert.strictEqual(result.addedEntries[0].pruefung_nr, 1);
  // Beide Zeilen sind gespeichert (LB4 mit bewertung = NULL → wird im UI als "—"
  // angezeigt und von computeWeighted ignoriert)
  const rows = d.prepare(
    'SELECT pruefung_nr, bewertung FROM noten_pruefungen WHERE kuerzel_id=? ORDER BY pruefung_nr'
  ).all('M1');
  assert.strictEqual(rows.length, 2);
  const lb4 = rows.find(r => r.pruefung_nr === 4);
  assert.strictEqual(lb4.bewertung, null, 'leere LB wird als NULL gespeichert');
  db.closeInstance();
});

test('savePruefungen: leere LB ohne andere Änderung setzt change_pending NICHT', () => {
  const { db, d } = setup();
  const result = db.savePruefungen(d, 'M1', [
    { bezeichnung: 'LB 4', pruefung_nr: 4, gewicht: '25%', bewertung: '' }
  ]);
  assert.strictEqual(result.addedEntries.length, 0);
  assert.strictEqual(result.changedEntries.length, 0);
  const row = d.prepare('SELECT change_pending FROM noten WHERE kuerzel_id=?').get('M1');
  assert.strictEqual(row.change_pending, 0, 'eine neu erfasste leere LB ist keine Änderung');
  db.closeInstance();
});

test('savePruefungen: leere LB die später benotet wird → changedEntry + fresh + Push-Quelle', () => {
  const { db, d } = setup();
  db.savePruefungen(d, 'M1', [
    { bezeichnung: 'LB 4', pruefung_nr: 4, gewicht: '25%', bewertung: '' }
  ]);
  d.prepare('UPDATE noten SET change_pending=0 WHERE kuerzel_id=?').run('M1');
  // Lehrer trägt die Note nach: '' → 4.7
  const result = db.savePruefungen(d, 'M1', [
    { bezeichnung: 'LB 4', pruefung_nr: 4, gewicht: '25%', bewertung: 4.7 }
  ]);
  assert.strictEqual(result.changedEntries.length, 1);
  assert.strictEqual(result.changedEntries[0].prev_bewertung, null);
  assert.strictEqual(result.changedEntries[0].new_bewertung, 4.7);
  const row = d.prepare('SELECT change_pending FROM noten WHERE kuerzel_id=?').get('M1');
  assert.strictEqual(row.change_pending, 1, 'das Benoten einer vorher leeren LB ist push-würdig');
  db.closeInstance();
});
