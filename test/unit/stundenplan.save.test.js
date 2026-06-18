'use strict';

// Tests für die Stundenplan-DB-Schreiblogik (src/db/stundenplan.js):
//   saveStundenplan — UPSERT-Diff (Raumwechsel-Erkennung) UND der seamless
//   Quellenwechsel-Replace (DOM-Scrape ↔ REST v2).
//
// Hintergrund: Der Natural Key (datum_iso, zeit_von, veranstaltung, klasse)
// ändert sich beim Quellenwechsel — der alte DOM-Scraper schrieb den Klassen-
// CODE / das letzte DOM-Feld, REST v2 schreibt relEvent.class_label /
// relEvent.label. Ein blosser UPSERT würde dann statt zu matchen DUPLIZIEREN.
// saveStundenplan erkennt den Wechsel an der `source`-Spalte und baut die
// Tabelle EINMALIG atomar neu auf (sicher, seamless, kein Datenverlust).
//
// Setup-Pattern verbatim aus absenzen.save.test.js: pro Test ein frischer
// tmpdir + chdir VOR dem require (schema.js nutzt process.cwd()), Modul-Cache
// reset damit der Singleton sauber startet, closeInstance am Ende.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

function setup() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wissen-sp-save-'));
  process.chdir(tmpDir);
  for (const k of Object.keys(require.cache)) {
    if (k.includes('wissen') && k.includes('src')) delete require.cache[k];
  }
  const db = require('../../src/db');
  const d = db.openOnce();
  return { db, d };
}

function countRows(d) {
  return d.prepare('SELECT COUNT(*) AS n FROM stundenplan').get().n;
}

// REST-Beispielzeile (relEvent.class_label / relEvent.label).
function restEntry(over = {}) {
  return {
    datum: '04.06.26', zeit: '08:30 – 12:00',
    raum: 'A101', dozent: 'Muster, Hans',
    klasse: 'Informatik EFZ 24', veranstaltung: 'Datenbanken abfragen',
    ...over
  };
}

// DOM-Scrape-Beispielzeile (Klassen-CODE / letztes DOM-Feld) — gleicher Termin,
// ANDERE klasse/veranstaltung-Strings als die REST-Quelle.
function domEntry(over = {}) {
  return {
    datum: '04.06.26', zeit: '08:30 – 12:00',
    raum: 'A101', dozent: 'Muster, Hans',
    klasse: 'UIFZ-2524-020', veranstaltung: '254 - Datenbanken abfragen',
    ...over
  };
}

// ---------- Basis: Insert setzt source ----------

test('saveStundenplan: erster Insert schreibt source, kein Replace', () => {
  const { db, d } = setup();
  const r = db.saveStundenplan(d, [restEntry()], { source: 'rest' });
  assert.strictEqual(r.inserted, 1);
  assert.strictEqual(r.replaced, false);
  const row = d.prepare('SELECT source FROM stundenplan').get();
  assert.strictEqual(row.source, 'rest');
  db.closeInstance();
});

// ---------- Gleiche Quelle: UPSERT-Diff, KEIN Replace ----------

test('saveStundenplan: gleiche Quelle → UPSERT updated in-place + Raumwechsel erkannt', () => {
  const { db, d } = setup();
  db.saveStundenplan(d, [restEntry({ raum: 'A101' })], { source: 'rest' });
  const r = db.saveStundenplan(d, [restEntry({ raum: 'B202' })], { source: 'rest' });
  assert.strictEqual(r.replaced, false);
  assert.strictEqual(r.updated, 1);
  assert.strictEqual(r.inserted, 0);
  assert.strictEqual(countRows(d), 1);               // kein Duplikat
  assert.strictEqual(r.roomChanges.length, 1);       // Raumwechsel A101 → B202
  assert.strictEqual(r.roomChanges[0].prev_raum, 'A101');
  assert.strictEqual(r.roomChanges[0].new_raum, 'B202');
  db.closeInstance();
});

// ---------- Quellenwechsel scrape → rest: atomarer Replace, KEINE Duplikate ----------

test('saveStundenplan: Quellenwechsel scrape→rest baut Tabelle neu auf (keine Duplikate)', () => {
  const { db, d } = setup();
  // Cutover-Ausgangslage: DOM-gescrapte Zeilen.
  db.saveStundenplan(d, [
    domEntry(),
    domEntry({ datum: '05.06.26', klasse: 'UIFZ-2524-021', veranstaltung: '255 - Testing' })
  ], { source: 'scrape' });
  assert.strictEqual(countRows(d), 2);

  // Umstellung auf REST — überlappende Termine, ABER andere klasse/veranstaltung.
  const r = db.saveStundenplan(d, [
    restEntry(),
    restEntry({ datum: '05.06.26', klasse: 'Informatik EFZ 24', veranstaltung: 'Testing' })
  ], { source: 'rest' });

  assert.strictEqual(r.replaced, true);              // einmaliger Neuaufbau
  assert.strictEqual(countRows(d), 2);               // NICHT 4 — keine Duplikate
  assert.strictEqual(r.roomChanges.length, 0);       // nach Wipe kein Raumwechsel-Push
  // Keine DOM-Zeilen mehr vorhanden, nur REST-Quelle.
  const foreign = d.prepare("SELECT COUNT(*) AS n FROM stundenplan WHERE source IS NULL OR source <> 'rest'").get().n;
  assert.strictEqual(foreign, 0);
  db.closeInstance();
});

// ---------- Legacy-NULL-Zeilen (Pre-Migration) gelten als fremde Quelle ----------

test('saveStundenplan: Legacy-NULL-Zeilen werden beim ersten REST-Lauf ersetzt', () => {
  const { db, d } = setup();
  // Pre-Migration-Zustand simulieren: Insert OHNE source (→ NULL in der Spalte).
  db.saveStundenplan(d, [domEntry()], {});
  assert.strictEqual(d.prepare('SELECT source FROM stundenplan').get().source, null);

  const r = db.saveStundenplan(d, [restEntry()], { source: 'rest' });
  assert.strictEqual(r.replaced, true);
  assert.strictEqual(countRows(d), 1);
  assert.strictEqual(d.prepare('SELECT source FROM stundenplan').get().source, 'rest');
  db.closeInstance();
});

// ---------- Sicherheit: leerer Scrape wipet NICHT ----------

test('saveStundenplan: Quellenwechsel mit leerem Input wipet NICHT (kein Leer-Fenster)', () => {
  const { db, d } = setup();
  db.saveStundenplan(d, [domEntry(), domEntry({ datum: '05.06.26', klasse: 'UIFZ-2524-021' })], { source: 'scrape' });
  assert.strictEqual(countRows(d), 2);

  // REST-Lauf, aber Scrape lieferte nichts (transienter Fehler) → Altdaten bleiben.
  const r = db.saveStundenplan(d, [], { source: 'rest' });
  assert.strictEqual(r.replaced, false);
  assert.strictEqual(r.inserted, 0);
  assert.strictEqual(countRows(d), 2);               // nichts gelöscht
  db.closeInstance();
});

// ---------- Gleiche Quelle, erneuter Lauf nach Replace bleibt stabil ----------

test('saveStundenplan: nach Replace ist der Folge-Lauf wieder normaler UPSERT', () => {
  const { db, d } = setup();
  db.saveStundenplan(d, [domEntry()], { source: 'scrape' });
  db.saveStundenplan(d, [restEntry()], { source: 'rest' });          // Replace
  const r = db.saveStundenplan(d, [restEntry({ raum: 'C303' })], { source: 'rest' }); // UPSERT
  assert.strictEqual(r.replaced, false);
  assert.strictEqual(r.updated, 1);
  assert.strictEqual(countRows(d), 1);
  assert.strictEqual(r.roomChanges.length, 1);
  db.closeInstance();
});
