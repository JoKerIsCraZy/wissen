'use strict';

// Tests für die Absenzen-DB-Schreiblogik (src/db/absenzen.js):
//   saveLektionen — newAbwesend-Übergänge (§9), Empty-Input-NO-OP,
//                   DELETE-Missing nur bei nicht-leerem Input
//   saveAbsenzen  — changedCodes NUR bei prev-Delta (Erst-Insert nie)
//
// Setup-Pattern verbatim aus pruefungen.markFresh.test.js: pro Test ein frischer
// tmpdir + chdir VOR dem require (schema.js nutzt process.cwd()), Modul-Cache
// reset damit der Singleton sauber startet, closeInstance am Ende.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

function setup() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wissen-abs-save-'));
  process.chdir(tmpDir);
  for (const k of Object.keys(require.cache)) {
    if (k.includes('wissen') && k.includes('src')) delete require.cache[k];
  }
  const db = require('../../src/db');
  const d = db.openOnce();
  return { db, d };
}

// ---------- saveLektionen: newAbwesend-Übergänge ----------

test('saveLektionen: neue abwesend-Lektion (kein prev) ist ein Kandidat', () => {
  const { db, d } = setup();
  const r = db.saveLektionen(d, 'M1', [
    { termin_iso: '2025-10-13', zeit_von: '08:30', zeit_bis: '12:00',
      termin_raw: 'Montag, 13. Oktober 2025, 08:30 - 12:00',
      lektionen_soll: 4, lektionen_ist: 0, anwesenheit_pct: 0,
      status_raw: 'Nicht teilgenommen unentschuldigt' }
  ]);
  assert.strictEqual(r.inserted, 1);
  assert.strictEqual(r.newAbwesend.length, 1);
  assert.strictEqual(r.newAbwesend[0].status_cat, 'abwesend_unentschuldigt');
  db.closeInstance();
});

test('saveLektionen: teilgenommen/offen erzeugen NIE newAbwesend', () => {
  const { db, d } = setup();
  const r = db.saveLektionen(d, 'M1', [
    { termin_iso: '2025-10-13', zeit_von: '08:30', status_raw: 'Teilgenommen' },
    { termin_iso: '2025-10-14', zeit_von: '08:30', status_raw: 'Offen' }
  ]);
  assert.strictEqual(r.inserted, 2);
  assert.strictEqual(r.newAbwesend.length, 0);
  db.closeInstance();
});

test('saveLektionen: Flip non-absence → unentschuldigt wird gemeldet', () => {
  const { db, d } = setup();
  db.saveLektionen(d, 'M1', [
    { termin_iso: '2025-10-13', zeit_von: '08:30', status_raw: 'Offen' }
  ]);
  const r = db.saveLektionen(d, 'M1', [
    { termin_iso: '2025-10-13', zeit_von: '08:30', status_raw: 'Nicht teilgenommen unentschuldigt' }
  ]);
  assert.strictEqual(r.updated, 1);
  assert.strictEqual(r.newAbwesend.length, 1);
  assert.strictEqual(r.newAbwesend[0].status_cat, 'abwesend_unentschuldigt');
  assert.strictEqual(r.newAbwesend[0].statusChanged, false); // neue Absenz, NICHT "Status geändert"
  db.closeInstance();
});

test('saveLektionen: "Nicht teilgenommen entschuldigt" pusht NICHT (User-Entscheid)', () => {
  const { db, d } = setup();
  // Neu (kein prev): entschuldigt ist eine echte Absenz, aber nicht push-würdig.
  const r1 = db.saveLektionen(d, 'M1', [
    { termin_iso: '2025-10-13', zeit_von: '08:30', status_raw: 'Nicht teilgenommen entschuldigt' }
  ]);
  assert.strictEqual(r1.inserted, 1);
  assert.strictEqual(r1.newAbwesend.length, 0);
  // Flip Offen → entschuldigt darf ebenfalls nicht pushen.
  db.saveLektionen(d, 'M2', [
    { termin_iso: '2025-10-13', zeit_von: '08:30', status_raw: 'Offen' }
  ]);
  const r2 = db.saveLektionen(d, 'M2', [
    { termin_iso: '2025-10-13', zeit_von: '08:30', status_raw: 'Nicht teilgenommen entschuldigt' }
  ]);
  assert.strictEqual(r2.newAbwesend.length, 0);
  db.closeInstance();
});

test('saveLektionen: Wechsel entschuldigt → unentschuldigt pusht (als neue Absenz)', () => {
  const { db, d } = setup();
  db.saveLektionen(d, 'M1', [
    { termin_iso: '2025-10-13', zeit_von: '08:30', status_raw: 'Nicht teilgenommen entschuldigt' }
  ]);
  const r = db.saveLektionen(d, 'M1', [
    { termin_iso: '2025-10-13', zeit_von: '08:30', status_raw: 'Nicht teilgenommen unentschuldigt' }
  ]);
  assert.strictEqual(r.newAbwesend.length, 1);
  assert.strictEqual(r.newAbwesend[0].status_cat, 'abwesend_unentschuldigt');
  // entschuldigt ist nicht push-würdig → Flip-zu-Push, KEIN "Status geändert".
  assert.strictEqual(r.newAbwesend[0].statusChanged, false);
  db.closeInstance();
});

// ---------- saveLektionen: "Abwesend X%" (prozentuale Abwesenheit) ----------

test('saveLektionen: neue "Abwesend 50%"-Lektion pusht + reicht status_raw durch', () => {
  const { db, d } = setup();
  const r = db.saveLektionen(d, 'M1', [
    { termin_iso: '2025-10-13', zeit_von: '08:30', status_raw: 'Abwesend 50%' }
  ]);
  assert.strictEqual(r.inserted, 1);
  assert.strictEqual(r.newAbwesend.length, 1);
  assert.strictEqual(r.newAbwesend[0].status_cat, 'abwesend_prozent');
  assert.strictEqual(r.newAbwesend[0].status_raw, 'Abwesend 50%');
  db.closeInstance();
});

test('saveLektionen: Flip Teilgenommen → "Abwesend 100%" pusht (kein Status-Wechsel)', () => {
  const { db, d } = setup();
  db.saveLektionen(d, 'M1', [
    { termin_iso: '2025-10-13', zeit_von: '08:30', status_raw: 'Teilgenommen' }
  ]);
  const r = db.saveLektionen(d, 'M1', [
    { termin_iso: '2025-10-13', zeit_von: '08:30', status_raw: 'Abwesend 100%' }
  ]);
  assert.strictEqual(r.newAbwesend.length, 1);
  assert.strictEqual(r.newAbwesend[0].status_cat, 'abwesend_prozent');
  assert.strictEqual(r.newAbwesend[0].statusChanged, false);
  db.closeInstance();
});

test('saveLektionen: Wechsel unentschuldigt → "Abwesend 100%" = Status geändert', () => {
  const { db, d } = setup();
  db.saveLektionen(d, 'M1', [
    { termin_iso: '2025-10-13', zeit_von: '08:30', status_raw: 'Nicht teilgenommen unentschuldigt' }
  ]);
  const r = db.saveLektionen(d, 'M1', [
    { termin_iso: '2025-10-13', zeit_von: '08:30', status_raw: 'Abwesend 100%' }
  ]);
  assert.strictEqual(r.newAbwesend.length, 1);
  assert.strictEqual(r.newAbwesend[0].status_cat, 'abwesend_prozent');
  // beide Kategorien push-würdig, Kategorie wechselt → "Status geändert".
  assert.strictEqual(r.newAbwesend[0].statusChanged, true);
  db.closeInstance();
});

test('getAbsenzenStats: lastFetchedAbsenzen ist nach saveAbsenzen gesetzt (nicht null)', () => {
  const { db, d } = setup();
  db.saveAbsenzen(d, [
    { kuerzel_code: 'UIFZ-2524-020-S1-114', typ: 'GE Modul', bezeichnung: '114', soll: 36, besucht: 34, minimal_pct: 90 }
  ]);
  const stats = db.getAbsenzenStats(d);
  assert.ok(stats.lastFetchedAbsenzen, 'lastFetchedAbsenzen darf nach saveAbsenzen nicht null sein');
  assert.strictEqual(typeof stats.lastFetchedAbsenzen, 'string');
  db.closeInstance();
});

test('updateAbsenzDetailIds: detail_id-Wechsel setzt detail_scraped_at zurück (Selbstheilung)', () => {
  const { db, d } = setup();
  db.saveAbsenzen(d, [{ kuerzel_code: 'M1', soll: 10, besucht: 10 }]);
  db.updateAbsenzDetailIds(d, { M1: '143' });    // alte (falsche, kollabierte) ID
  db.markAbsenzDetailScraped(d, 'M1');           // Detail-Cooldown gesetzt
  assert.ok(db.getAbsenzRow(d, 'M1').detail_scraped_at, 'Vorbedingung: detail_scraped_at gesetzt');
  db.updateAbsenzDetailIds(d, { M1: '297250' }); // korrigierte ID
  const row = db.getAbsenzRow(d, 'M1');
  assert.strictEqual(row.detail_id, '297250');
  assert.strictEqual(row.detail_scraped_at, null, 'detail_scraped_at muss bei ID-Wechsel resettet sein → Re-Scrape ohne Cooldown');
  db.closeInstance();
});

test('saveLektionen: gleicher abwesend-Status (kein Wechsel) meldet NICHT erneut', () => {
  const { db, d } = setup();
  db.saveLektionen(d, 'M1', [
    { termin_iso: '2025-10-13', zeit_von: '08:30', status_raw: 'Nicht teilgenommen unentschuldigt' }
  ]);
  const r = db.saveLektionen(d, 'M1', [
    { termin_iso: '2025-10-13', zeit_von: '08:30', status_raw: 'Nicht teilgenommen unentschuldigt' }
  ]);
  assert.strictEqual(r.newAbwesend.length, 0);
  db.closeInstance();
});

test('saveLektionen: Flip absence → teilgenommen meldet NICHT', () => {
  const { db, d } = setup();
  db.saveLektionen(d, 'M1', [
    { termin_iso: '2025-10-13', zeit_von: '08:30', status_raw: 'Nicht teilgenommen entschuldigt' }
  ]);
  const r = db.saveLektionen(d, 'M1', [
    { termin_iso: '2025-10-13', zeit_von: '08:30', status_raw: 'Teilgenommen' }
  ]);
  assert.strictEqual(r.newAbwesend.length, 0);
  db.closeInstance();
});

// ---------- saveLektionen: Empty-Input-NO-OP (Cold-Start-Layer 1) ----------

test('saveLektionen: leerer Input ist NO-OP — kein Delete, kein newAbwesend', () => {
  const { db, d } = setup();
  // erst mit Daten füllen
  db.saveLektionen(d, 'M1', [
    { termin_iso: '2025-10-13', zeit_von: '08:30', status_raw: 'Teilgenommen' },
    { termin_iso: '2025-10-14', zeit_von: '08:30', status_raw: 'Nicht teilgenommen entschuldigt' }
  ]);
  const before = db.getLektionen(d, 'M1');
  assert.strictEqual(before.length, 2);

  // leerer Scrape darf NICHTS löschen (Schutz gegen fehlgeschlagenen Detail-Scrape)
  const r = db.saveLektionen(d, 'M1', []);
  assert.deepStrictEqual(r, { inserted: 0, updated: 0, deleted: 0, newAbwesend: [] });
  const after = db.getLektionen(d, 'M1');
  assert.strictEqual(after.length, 2, 'leerer Input darf bestehende Lektionen nicht löschen');
  db.closeInstance();
});

test('saveLektionen: leerer Input bei leerem Modul (echter Cold-Start) = 0 newAbwesend', () => {
  const { db, d } = setup();
  const r = db.saveLektionen(d, 'M1', []);
  assert.strictEqual(r.newAbwesend.length, 0);
  assert.strictEqual(r.deleted, 0);
  db.closeInstance();
});

// ---------- saveLektionen: DELETE-Missing nur bei nicht-leerem Input ----------

test('saveLektionen: nicht-leerer Input löscht verschwundene Lektionen', () => {
  const { db, d } = setup();
  db.saveLektionen(d, 'M1', [
    { termin_iso: '2025-10-13', zeit_von: '08:30', status_raw: 'Teilgenommen' },
    { termin_iso: '2025-10-14', zeit_von: '08:30', status_raw: 'Teilgenommen' }
  ]);
  // zweiter Scrape ohne die 14.10.-Lektion → muss sie löschen
  const r = db.saveLektionen(d, 'M1', [
    { termin_iso: '2025-10-13', zeit_von: '08:30', status_raw: 'Teilgenommen' }
  ]);
  assert.strictEqual(r.deleted, 1);
  const after = db.getLektionen(d, 'M1');
  assert.strictEqual(after.length, 1);
  assert.strictEqual(after[0].termin_iso, '2025-10-13');
  db.closeInstance();
});

test('saveLektionen: gelöschte abwesend-Lektion landet NIE in newAbwesend', () => {
  const { db, d } = setup();
  db.saveLektionen(d, 'M1', [
    { termin_iso: '2025-10-13', zeit_von: '08:30', status_raw: 'Teilgenommen' },
    { termin_iso: '2025-10-14', zeit_von: '08:30', status_raw: 'Nicht teilgenommen unentschuldigt' }
  ]);
  // zweiter Scrape ohne die abwesende Lektion
  const r = db.saveLektionen(d, 'M1', [
    { termin_iso: '2025-10-13', zeit_von: '08:30', status_raw: 'Teilgenommen' }
  ]);
  assert.strictEqual(r.deleted, 1);
  assert.strictEqual(r.newAbwesend.length, 0);
  db.closeInstance();
});

// ---------- saveLektionen: markFresh ----------

test('saveLektionen: setzt change_pending=1 auf die absenzen-Zeile bei newAbwesend', () => {
  const { db, d } = setup();
  // Übersichts-Zeile anlegen, damit markFresh greift (UPDATE no-op ohne Zeile)
  db.saveAbsenzen(d, [
    { kuerzel_code: 'M1', bezeichnung: '106 - Datenbanken', soll: 45, besucht: 41,
      minimal_pct: 90, anwesenheit_pct_scraped: 91 }
  ]);
  d.prepare('UPDATE absenzen SET change_pending=0 WHERE kuerzel_code=?').run('M1');

  db.saveLektionen(d, 'M1', [
    { termin_iso: '2025-10-13', zeit_von: '08:30', status_raw: 'Nicht teilgenommen unentschuldigt' }
  ]);
  const row = d.prepare('SELECT change_pending FROM absenzen WHERE kuerzel_code=?').get('M1');
  assert.strictEqual(row.change_pending, 1);
  db.closeInstance();
});

// ---------- saveAbsenzen: changedCodes NUR bei prev-Delta ----------

test('saveAbsenzen: Erst-Insert liefert NIE changedCodes (Cold-Start-Schutz)', () => {
  const { db, d } = setup();
  const r = db.saveAbsenzen(d, [
    { kuerzel_code: 'M1', bezeichnung: '106', soll: 45, besucht: 40, minimal_pct: 90, anwesenheit_pct_scraped: 89 },
    { kuerzel_code: 'M2', bezeichnung: '107', soll: 20, besucht: 20, minimal_pct: 90, anwesenheit_pct_scraped: 100 }
  ]);
  assert.strictEqual(r.inserted, 2);
  assert.strictEqual(r.updated, 0);
  assert.deepStrictEqual(r.changedCodes, []);
  db.closeInstance();
});

test('saveAbsenzen: changedCodes nur bei geändertem besucht/anwesenheit_pct', () => {
  const { db, d } = setup();
  db.saveAbsenzen(d, [
    { kuerzel_code: 'M1', soll: 45, besucht: 45, minimal_pct: 90, anwesenheit_pct_scraped: 100 },
    { kuerzel_code: 'M2', soll: 20, besucht: 18, minimal_pct: 90, anwesenheit_pct_scraped: 90 }
  ]);
  // M1: besucht ändert sich 45→41 (Delta) ; M2: identisch (kein Delta)
  const r = db.saveAbsenzen(d, [
    { kuerzel_code: 'M1', soll: 45, besucht: 41, minimal_pct: 90, anwesenheit_pct_scraped: 91 },
    { kuerzel_code: 'M2', soll: 20, besucht: 18, minimal_pct: 90, anwesenheit_pct_scraped: 90 }
  ]);
  assert.strictEqual(r.updated, 2);
  assert.deepStrictEqual(r.changedCodes, ['M1']);
  db.closeInstance();
});

test('saveAbsenzen: identischer Re-Scrape liefert leere changedCodes', () => {
  const { db, d } = setup();
  const rows = [
    { kuerzel_code: 'M1', soll: 45, besucht: 45, minimal_pct: 90, anwesenheit_pct_scraped: 100 }
  ];
  db.saveAbsenzen(d, rows);
  const r = db.saveAbsenzen(d, rows);
  assert.strictEqual(r.updated, 1);
  assert.deepStrictEqual(r.changedCodes, []);
  db.closeInstance();
});

test('saveAbsenzen: absenzen-Spalte = soll - besucht (nicht geclampt)', () => {
  const { db, d } = setup();
  db.saveAbsenzen(d, [
    { kuerzel_code: 'M1', soll: 45, besucht: 40 },
    { kuerzel_code: 'M2', soll: 20, besucht: 22 } // besucht > soll → negativ, nicht clampen
  ]);
  const m1 = d.prepare('SELECT absenzen, anwesenheit_pct FROM absenzen WHERE kuerzel_code=?').get('M1');
  const m2 = d.prepare('SELECT absenzen FROM absenzen WHERE kuerzel_code=?').get('M2');
  assert.strictEqual(m1.absenzen, 5);
  assert.ok(Math.abs(m1.anwesenheit_pct - (40 / 45 * 100)) < 1e-9);
  assert.strictEqual(m2.absenzen, -2);
  db.closeInstance();
});

test('saveAbsenzen: anwesenheit_pct ist null bei soll=0', () => {
  const { db, d } = setup();
  db.saveAbsenzen(d, [
    { kuerzel_code: 'M1', soll: 0, besucht: 0 }
  ]);
  const row = d.prepare('SELECT anwesenheit_pct FROM absenzen WHERE kuerzel_code=?').get('M1');
  assert.strictEqual(row.anwesenheit_pct, null);
  db.closeInstance();
});
