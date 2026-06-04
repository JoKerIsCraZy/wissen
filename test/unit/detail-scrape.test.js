'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { isFullDetailRefresh } = require('../../src/runScrape');

function setupDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tocco-detailsel-'));
  process.chdir(tmpDir);
  for (const k of Object.keys(require.cache)) {
    if (k.includes('wissen') && k.includes('src')) delete require.cache[k];
  }
  const db = require('../../src/db');
  const d = db.openOnce();
  return { db, d };
}

// ============================================================
// A — isFullDetailRefresh: täglicher Voll-Refresh am letzten Lauf des Tages
//     (ersetzt den reinen wöchentlichen Sa-Rhythmus)
// ============================================================

test('isFullDetailRefresh: weekly-Backstop → true', () => {
  assert.strictEqual(isFullDetailRefresh('weekly', {}, {}), true);
});

test('isFullDetailRefresh: scheduled + letzter Lauf des Tages → true', () => {
  assert.strictEqual(isFullDetailRefresh('scheduled', { isLastRunOfDay: true }, {}), true);
});

test('isFullDetailRefresh: scheduled, NICHT letzter Lauf → false', () => {
  assert.strictEqual(isFullDetailRefresh('scheduled', { isLastRunOfDay: false }, {}), false);
  assert.strictEqual(isFullDetailRefresh('scheduled', {}, {}), false);
});

test('isFullDetailRefresh: manual nur mit aktiviertem Toggle', () => {
  assert.strictEqual(isFullDetailRefresh('manual', {}, { manualScrapeFullDetails: true }), true);
  assert.strictEqual(isFullDetailRefresh('manual', {}, { manualScrapeFullDetails: false }), false);
  assert.strictEqual(isFullDetailRefresh('manual', {}, {}), false);
});

test('isFullDetailRefresh: telegram/boot lösen KEINEN Voll-Refresh aus', () => {
  assert.strictEqual(isFullDetailRefresh('telegram', {}, {}), false);
  assert.strictEqual(isFullDetailRefresh('boot', {}, {}), false);
  assert.strictEqual(isFullDetailRefresh('irgendwas', {}, {}), false);
});

// ============================================================
// B — getKuerzelnWithDetailId erfasst auch Module OHNE Modulnote
//     (solange detail_id vorhanden), damit LB-only-Module ihre Prüfungen
//     beim Voll-Refresh nachziehen.
// ============================================================

test('getKuerzelnWithDetailId: Modul OHNE Note aber mit detail_id wird erfasst (B)', () => {
  const { db, d } = setupDb();
  d.exec(`INSERT INTO noten (kuerzel_id, fach_name, note, detail_id) VALUES ('M_NOTE',     'Mit Note',   5.0,  '111')`);
  d.exec(`INSERT INTO noten (kuerzel_id, fach_name, note, detail_id) VALUES ('M_NONOTE',   'Ohne Note',  NULL, '222')`);
  d.exec(`INSERT INTO noten (kuerzel_id, fach_name, note, detail_id) VALUES ('M_NODETAIL', 'Ohne ID',    4.0,  NULL)`);
  d.exec(`INSERT INTO noten (kuerzel_id, fach_name, note, detail_id) VALUES ('M_EMPTYID',  'Leere ID',   4.0,  '')`);

  const ids = db.getKuerzelnWithDetailId(d).map(r => r.kuerzel_id).sort();
  // Beide Module MIT detail_id (auch das ohne Note) — Module ohne/leere ID raus.
  assert.deepStrictEqual(ids, ['M_NONOTE', 'M_NOTE']);
  db.closeInstance();
});

// ============================================================
// Open-Count — getNoten liefert pro Modul, wie viele Prüfungen noch offen sind
// ============================================================

test('getNoten: zählt offene (unbenotete) Prüfungen pro Modul', () => {
  const { db, d } = setupDb();
  d.exec(`INSERT INTO noten (kuerzel_id, fach_name, semester, note, detail_id) VALUES ('M1', 'Englisch', 'S2', 4.5, '900')`);
  db.savePruefungen(d, 'M1', [
    { bezeichnung: 'LB 1', pruefung_nr: 1, gewicht: '25%', bewertung: 4.7 },
    { bezeichnung: 'LB 2', pruefung_nr: 2, gewicht: '25%', bewertung: 3.6 },
    { bezeichnung: 'LB 3', pruefung_nr: 3, gewicht: '25%', bewertung: '' }, // offen
    { bezeichnung: 'LB 4', pruefung_nr: 4, gewicht: '25%', bewertung: '' }  // offen
  ]);

  const m1 = db.getNoten(d, {}).find(r => r.kuerzel_id === 'M1');
  assert.strictEqual(m1.pruefungen_total, 4, '4 Prüfungen erfasst');
  assert.strictEqual(m1.pruefungen_open, 2, '2 davon offen (LB3, LB4)');
  db.closeInstance();
});

test('getNoten: Modul ohne Prüfungen → total/open = 0', () => {
  const { db, d } = setupDb();
  d.exec(`INSERT INTO noten (kuerzel_id, fach_name, note) VALUES ('M0', 'Leer', 5.0)`);
  const m0 = db.getNoten(d, {}).find(r => r.kuerzel_id === 'M0');
  assert.strictEqual(m0.pruefungen_total, 0);
  assert.strictEqual(m0.pruefungen_open, 0);
  db.closeInstance();
});

// ============================================================
// Audit-Fund #4 — eine rein LEERE Prüfung darf das Modul NICHT aus der
// Backfill-Rotation kicken (Guard prüft auf BENOTETE Prüfung, nicht "irgendeine").
// ============================================================

test('getKuerzelnNeedingDetailScrape: Modul mit NUR leeren Prüfungen bleibt im Backfill (#4)', () => {
  const { db, d } = setupDb();
  d.exec(`INSERT INTO noten (kuerzel_id, fach_name, note, detail_id) VALUES ('M_EMPTY', 'Nur leer', 4.0, '700')`);
  // Nur unbenotete LBs → bewertung IS NULL
  db.savePruefungen(d, 'M_EMPTY', [
    { bezeichnung: 'LB 1', pruefung_nr: 1, gewicht: '25%', bewertung: '' },
    { bezeichnung: 'LB 2', pruefung_nr: 2, gewicht: '25%', bewertung: '' }
  ]);
  const ids = db.getKuerzelnNeedingDetailScrape(d, []).map(r => r.kuerzel_id);
  assert.ok(ids.includes('M_EMPTY'), 'Modul mit nur leeren Prüfungen muss weiter backfilled werden');
  db.closeInstance();
});

test('getKuerzelnNeedingDetailScrape: Modul mit ≥1 BENOTETER Prüfung fällt aus dem Backfill', () => {
  const { db, d } = setupDb();
  d.exec(`INSERT INTO noten (kuerzel_id, fach_name, note, detail_id) VALUES ('M_GRADED', 'Benotet', 4.0, '701')`);
  db.savePruefungen(d, 'M_GRADED', [
    { bezeichnung: 'LB 1', pruefung_nr: 1, gewicht: '25%', bewertung: 4.5 }, // benotet
    { bezeichnung: 'LB 2', pruefung_nr: 2, gewicht: '25%', bewertung: '' }   // offen
  ]);
  const ids = db.getKuerzelnNeedingDetailScrape(d, []).map(r => r.kuerzel_id);
  assert.ok(!ids.includes('M_GRADED'), 'Modul mit einer benoteten Prüfung braucht keinen Backfill mehr (Voll-Refresh/gradeChange deckt den Rest)');
  db.closeInstance();
});

// ============================================================
// #6 — Lösch-Schutz gegen Teil-Scrapes (count-guard + 2-Strike)
// ============================================================

function seed4(db, d, id) {
  d.exec(`INSERT OR IGNORE INTO noten (kuerzel_id, fach_name, note, detail_id) VALUES ('${id}', 'x', 4.0, 'dd')`);
  db.savePruefungen(d, id, [
    { bezeichnung: 'LB 1', pruefung_nr: 1, gewicht: '25%', bewertung: 4.0 },
    { bezeichnung: 'LB 2', pruefung_nr: 2, gewicht: '25%', bewertung: 5.0 },
    { bezeichnung: 'LB 3', pruefung_nr: 3, gewicht: '25%', bewertung: 4.5 },
    { bezeichnung: 'LB 4', pruefung_nr: 4, gewicht: '25%', bewertung: 5.5 }
  ], { expectedCount: 4 });
}

test('#6 Teil-Scrape (gescrapt < expectedCount) löscht NICHTS', () => {
  const { db, d } = setupDb();
  seed4(db, d, 'P1');
  // Tocco halb geladen: nur 2 von 4 — Seite sagt aber weiter "Anzahl Prüfungen: 4"
  const ps = db.savePruefungen(d, 'P1', [
    { bezeichnung: 'LB 1', pruefung_nr: 1, gewicht: '25%', bewertung: 4.0 },
    { bezeichnung: 'LB 2', pruefung_nr: 2, gewicht: '25%', bewertung: 5.0 }
  ], { expectedCount: 4 });
  assert.strictEqual(ps.incomplete, true);
  assert.strictEqual(ps.deleted, 0);
  assert.strictEqual(db.getPruefungen(d, 'P1').length, 4, 'keine valide Note gelöscht');
  db.closeInstance();
});

test('#6 vollständiger Scrape (gescrapt >= expectedCount) löscht echte Entfernung', () => {
  const { db, d } = setupDb();
  seed4(db, d, 'P2');
  // Lehrer hat LB4 entfernt → Seite zeigt jetzt "Anzahl Prüfungen: 3", 3 Zeilen
  const ps = db.savePruefungen(d, 'P2', [
    { bezeichnung: 'LB 1', pruefung_nr: 1, gewicht: '25%', bewertung: 4.0 },
    { bezeichnung: 'LB 2', pruefung_nr: 2, gewicht: '25%', bewertung: 5.0 },
    { bezeichnung: 'LB 3', pruefung_nr: 3, gewicht: '25%', bewertung: 4.5 }
  ], { expectedCount: 3 });
  assert.strictEqual(ps.deleted, 1);
  assert.strictEqual(db.getPruefungen(d, 'P2').length, 3, 'echte Löschung wird nachgezogen');
  db.closeInstance();
});

test('#6 ohne expectedCount: 2-Strike — erst beim zweiten Fehlen löschen', () => {
  const { db, d } = setupDb();
  seed4(db, d, 'P3');
  // 1. Check ohne Soll-Zahl: LB3/LB4 fehlen → noch NICHT löschen (Strike 1)
  const a = db.savePruefungen(d, 'P3', [
    { bezeichnung: 'LB 1', pruefung_nr: 1, gewicht: '25%', bewertung: 4.0 },
    { bezeichnung: 'LB 2', pruefung_nr: 2, gewicht: '25%', bewertung: 5.0 }
  ]); // kein opts → expectedCount unbekannt
  assert.strictEqual(a.deleted, 0);
  assert.strictEqual(db.getPruefungen(d, 'P3').length, 4, 'Strike 1: noch behalten');
  // 2. Check, wieder fehlen → jetzt löschen (Strike 2)
  const b = db.savePruefungen(d, 'P3', [
    { bezeichnung: 'LB 1', pruefung_nr: 1, gewicht: '25%', bewertung: 4.0 },
    { bezeichnung: 'LB 2', pruefung_nr: 2, gewicht: '25%', bewertung: 5.0 }
  ]);
  assert.strictEqual(b.deleted, 2);
  assert.strictEqual(db.getPruefungen(d, 'P3').length, 2, 'Strike 2: gelöscht');
  db.closeInstance();
});

test('#6 2-Strike-Reset: taucht die Prüfung wieder auf, wird der Streak genullt', () => {
  const { db, d } = setupDb();
  seed4(db, d, 'P4');
  db.savePruefungen(d, 'P4', [
    { bezeichnung: 'LB 1', pruefung_nr: 1, gewicht: '25%', bewertung: 4.0 }
  ]); // LB2/3/4 fehlen → Strike 1
  // wieder vollständig (alle 4 da) → Streak-Reset
  seed4(db, d, 'P4');
  // erneut fehlen → Strike 1 (nicht 2, weil Reset) → NICHT löschen
  const c = db.savePruefungen(d, 'P4', [
    { bezeichnung: 'LB 1', pruefung_nr: 1, gewicht: '25%', bewertung: 4.0 }
  ]);
  assert.strictEqual(c.deleted, 0, 'nach Wiederauftauchen ist der Streak zurückgesetzt');
  db.closeInstance();
});

// ============================================================
// #11 — detail_id-Wechsel resettet detail_scraped_at (Self-Healing)
// ============================================================

test('#11 updateDetailIds setzt detail_scraped_at bei ID-Wechsel zurück', () => {
  const { db, d } = setupDb();
  d.exec(`INSERT INTO noten (kuerzel_id, fach_name, note, detail_id, detail_scraped_at) VALUES ('ID1', 'x', 4.0, '100', CURRENT_TIMESTAMP)`);
  db.updateDetailIds(d, { ID1: '999' });
  const row = db.getNotenRow(d, 'ID1');
  assert.strictEqual(row.detail_id, '999');
  assert.strictEqual(row.detail_scraped_at, null, 'Cooldown zurückgesetzt → nächster Cycle scrapt neu');
  db.closeInstance();
});

test('#11 updateDetailIds OHNE ID-Wechsel lässt detail_scraped_at stehen', () => {
  const { db, d } = setupDb();
  d.exec(`INSERT INTO noten (kuerzel_id, fach_name, note, detail_id, detail_scraped_at) VALUES ('ID2', 'x', 4.0, '100', CURRENT_TIMESTAMP)`);
  db.updateDetailIds(d, { ID2: '100' }); // gleiche ID → UPDATE greift nicht
  const row = db.getNotenRow(d, 'ID2');
  assert.notStrictEqual(row.detail_scraped_at, null, 'kein unnötiger Reset bei gleicher ID');
  db.closeInstance();
});

// ============================================================
// #2 — saveLektionen meldet coldStart (Cold-Start-Push-Schutz)
// ============================================================

test('#2 saveLektionen: Erstbefüllung meldet coldStart=true, Folgelauf false', () => {
  const { db, d } = setupDb();
  const first = db.saveLektionen(d, 'ABSX', [
    { termin_iso: '2025-10-13', zeit_von: '08:30', status_raw: 'Nicht teilgenommen unentschuldigt', lektionen_soll: 4, lektionen_ist: 0 }
  ]);
  assert.strictEqual(first.coldStart, true, 'erste Befüllung = Cold-Start');
  const second = db.saveLektionen(d, 'ABSX', [
    { termin_iso: '2025-10-14', zeit_von: '08:30', status_raw: 'Nicht teilgenommen unentschuldigt', lektionen_soll: 4, lektionen_ist: 0 }
  ]);
  assert.strictEqual(second.coldStart, false, 'Modul hatte schon prev-Lektionen');
  db.closeInstance();
});
