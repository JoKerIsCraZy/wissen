'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// chdir BEFORE require('../../src/db') — schema.js leitet den DB-Pfad aus
// process.cwd() ab. Pro Test ein frischer tmpdir + closeInstance am Ende, da
// das db-Modul einen Singleton auf Modulebene hält.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wissen-verlauf-'));
process.chdir(tmpDir);
const db = require('../../src/db');
const {
  getNotenVerlauf,
  DEFAULT_VERLAUF_DAYS,
  MAX_VERLAUF_DAYS
} = require('../../src/db/notenVerlauf');

// --- Helpers -------------------------------------------------------------

/** Frische DB in eigenem tmpdir + Live-"today" (UTC) aus EINEM date('now')-Read. */
function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wissen-verlauf-'));
  process.chdir(dir);
  const d = db.openOnce();
  const today = d.prepare("SELECT date('now') AS d").get().d;
  return { d, today };
}

/** YYYY-MM-DD (UTC) verschoben um offset Tage. */
function addDaysUTC(day, offset) {
  const dt = new Date(day + 'T00:00:00Z');
  dt.setUTCDate(dt.getUTCDate() + offset);
  return dt.toISOString().slice(0, 10);
}

/** Live-noten-Zeile (note darf null sein). */
function seedNoten(d, kuerzelId, note) {
  d.prepare('INSERT INTO noten (kuerzel_id, note) VALUES (?, ?)').run(kuerzelId, note);
}

/** History-Zeile mit EXPLIZITEM recorded_at (DEFAULT feuert nur bei Auslassung). */
function seedHist(d, kuerzelId, note, day) {
  d.prepare(
    'INSERT INTO noten_history (kuerzel_id, note, recorded_at) VALUES (?, ?, ?)'
  ).run(kuerzelId, note, day + ' 12:00:00');
}

// --- Tests ---------------------------------------------------------------

test('returns [] when noten_history and noten are both empty', () => {
  const { d } = freshDb();
  assert.deepStrictEqual(getNotenVerlauf(d, {}), []);
  db.closeInstance();
});

test('returns a single today-point equal to live noten avg when history is empty but noten has grades', () => {
  const { d, today } = freshDb();
  seedNoten(d, 'A', 5.0);
  seedNoten(d, 'B', 4.0);
  const r = getNotenVerlauf(d, {});
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].day, today);
  assert.strictEqual(r[0].value, 4.5);
  assert.strictEqual(r[0].count, 2);
  db.closeInstance();
});

test('final point value equals round1(AVG(note)) over current noten (the headline invariant)', () => {
  const { d, today } = freshDb();
  seedNoten(d, 'A', 5.0);
  seedNoten(d, 'B', 4.0);
  seedHist(d, 'A', 5.0, addDaysUTC(today, -2));
  seedHist(d, 'B', 4.0, addDaysUTC(today, -1));
  const r = getNotenVerlauf(d, {});
  assert.strictEqual(r[r.length - 1].value, 4.5);
  db.closeInstance();
});

test('final point ignores NULL-note modules', () => {
  const { d, today } = freshDb();
  seedNoten(d, 'A', 5.0);
  seedNoten(d, 'B', null); // ungradetes Modul -> aus AVG/COUNT ausgeschlossen
  seedHist(d, 'A', 5.0, addDaysUTC(today, -1));
  const r = getNotenVerlauf(d, {});
  const last = r[r.length - 1];
  assert.strictEqual(last.value, 5.0);
  assert.strictEqual(last.count, 1);
  db.closeInstance();
});

test('carries an unchanged grade forward across a no-change day', () => {
  const { d, today } = freshDb();
  seedNoten(d, 'A', 5.0);
  seedHist(d, 'A', 5.0, addDaysUTC(today, -3));
  const r = getNotenVerlauf(d, {});
  // today-3 .. today => 4 Punkte, alle 5.0 (Carry-forward ueber tatenlose Tage).
  assert.strictEqual(r.length, 4);
  for (const p of r) assert.strictEqual(p.value, 5.0);
  const carried = r.find((p) => p.day === addDaysUTC(today, -2));
  assert.ok(carried);
  assert.strictEqual(carried.value, 5.0);
  db.closeInstance();
});

test('excludes a module while its note is NULL, includes it after it is graded', () => {
  const { d, today } = freshDb();
  seedNoten(d, 'A', 4.0);
  seedNoten(d, 'B', 5.0);
  seedHist(d, 'B', 5.0, addDaysUTC(today, -3));
  seedHist(d, 'A', null, addDaysUTC(today, -3)); // A bekannt aber ungraded
  seedHist(d, 'A', 4.0, addDaysUTC(today, -1)); // A wird benotet
  const r = getNotenVerlauf(d, {});
  const d3 = r.find((p) => p.day === addDaysUTC(today, -3));
  const d1 = r.find((p) => p.day === addDaysUTC(today, -1));
  assert.strictEqual(d3.count, 1); // nur B
  assert.strictEqual(d1.count, 2); // A jetzt dabei
  db.closeInstance();
});

test('seeds a legacy module (current note, no history row) into EVERY interior point, not just the pinned final', () => {
  const { d, today } = freshDb();
  seedNoten(d, 'H', 5.0); // hat History
  seedNoten(d, 'L', 3.0); // Legacy: KEINE History-Zeile
  seedHist(d, 'H', 5.0, addDaysUTC(today, -2));
  const r = getNotenVerlauf(d, {});
  // Legacy L wird ueber das ganze Fenster mitgefuehrt -> count 2 ab Punkt 0.
  assert.strictEqual(r[0].count, 2);
  assert.strictEqual(r[0].value, 4.0); // (5 + 3) / 2
  // Keine Klippe zwischen vorletztem und letztem (gepinntem) Punkt.
  assert.strictEqual(r[r.length - 2].value, r[r.length - 1].value);
  db.closeInstance();
});

test('pins final point to live noten even for a module that has a current note but no history row', () => {
  const { d, today } = freshDb();
  seedNoten(d, 'H', 5.0);
  seedNoten(d, 'L', 3.0); // Legacy ohne History
  seedHist(d, 'H', 5.0, addDaysUTC(today, -2));
  const r = getNotenVerlauf(d, {});
  const last = r[r.length - 1];
  assert.strictEqual(last.value, 4.0); // round1((5 + 3) / 2)
  assert.strictEqual(last.count, 2);
  db.closeInstance();
});

test('drops the leading ungraded prefix (days before the first grade are not emitted)', () => {
  const { d, today } = freshDb();
  seedNoten(d, 'A', 4.0);
  seedHist(d, 'A', null, addDaysUTC(today, -4)); // bekannt, aber ungraded
  seedHist(d, 'A', 4.0, addDaysUTC(today, -2)); // erster echter Grade
  const r = getNotenVerlauf(d, {});
  assert.strictEqual(r[0].day, addDaysUTC(today, -2));
  assert.strictEqual(r.length, 3); // today-2, today-1, today
  assert.ok(!r.some((p) => p.day === addDaysUTC(today, -4)));
  assert.ok(!r.some((p) => p.day === addDaysUTC(today, -3)));
  db.closeInstance();
});

test('clamps days above MAX_VERLAUF_DAYS to 365', () => {
  const { d, today } = freshDb();
  seedNoten(d, 'A', 4.0);
  seedHist(d, 'A', 4.0, addDaysUTC(today, -400)); // aelter als 365 Tage
  const r = getNotenVerlauf(d, { days: 99999 });
  // Geklemmt auf 365 => Fensterstart today-364, NICHT today-400.
  assert.strictEqual(r[0].day, addDaysUTC(today, -(MAX_VERLAUF_DAYS - 1)));
  assert.strictEqual(r.length, MAX_VERLAUF_DAYS);
  db.closeInstance();
});

test('clamps fractional/zero days up to a minimum 1-day window (does not return [])', () => {
  const { d, today } = freshDb();
  seedNoten(d, 'A', 5.0);
  seedHist(d, 'A', 5.0, today);
  const r = getNotenVerlauf(d, { days: 0.5 });
  assert.notDeepStrictEqual(r, []);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].day, today);
  db.closeInstance();
});

test('defaults to DEFAULT_VERLAUF_DAYS (365) days when days is undefined/0/NaN', () => {
  const { d, today } = freshDb();
  seedNoten(d, 'A', 4.0);
  seedHist(d, 'A', 4.0, addDaysUTC(today, -500)); // deckt das volle Fenster ab
  for (const opts of [{}, { days: 0 }, { days: NaN }, { days: undefined }]) {
    const r = getNotenVerlauf(d, opts);
    assert.strictEqual(r.length, DEFAULT_VERLAUF_DAYS);
    assert.strictEqual(r[0].day, addDaysUTC(today, -(DEFAULT_VERLAUF_DAYS - 1)));
  }
  db.closeInstance();
});

test('windowStart is bounded by the first history day (no points before any data)', () => {
  const { d, today } = freshDb();
  seedNoten(d, 'A', 4.0);
  seedHist(d, 'A', 4.0, addDaysUTC(today, -5));
  const r = getNotenVerlauf(d, { days: 365 });
  assert.strictEqual(r[0].day, addDaysUTC(today, -5));
  assert.strictEqual(r.length, 6); // today-5 .. today
  db.closeInstance();
});

test('applies last-write-wins for multiple same-day snapshots of one module (highest id wins)', () => {
  const { d, today } = freshDb();
  seedNoten(d, 'A', 6.0);
  seedHist(d, 'A', 3.0, addDaysUTC(today, -2)); // niedrigere id
  seedHist(d, 'A', 6.0, addDaysUTC(today, -2)); // hoehere id -> gewinnt
  const r = getNotenVerlauf(d, { days: 365 });
  // points[0] = today-2 (interior, nicht gepinnt) -> spiegelt last-write-wins.
  assert.strictEqual(r[0].day, addDaysUTC(today, -2));
  assert.strictEqual(r[0].value, 6.0);
  db.closeInstance();
});

test('produces an ascending, gap-free series whose every emitted value is non-null', () => {
  const { d, today } = freshDb();
  seedNoten(d, 'A', 4.0);
  seedHist(d, 'A', 4.0, addDaysUTC(today, -3));
  const r = getNotenVerlauf(d, { days: 365 });
  assert.ok(r.length >= 2);
  for (let k = 0; k < r.length; k++) {
    assert.notStrictEqual(r[k].value, null);
    if (k > 0) {
      assert.strictEqual(r[k].day, addDaysUTC(r[k - 1].day, 1));
    }
  }
  db.closeInstance();
});

test('round1 rounding applied to each point value (mean 4.666… → 4.7)', () => {
  const { d, today } = freshDb();
  seedNoten(d, 'A', 4.0);
  seedNoten(d, 'B', 5.0);
  seedNoten(d, 'C', 5.0);
  const day = addDaysUTC(today, -2);
  seedHist(d, 'A', 4.0, day);
  seedHist(d, 'B', 5.0, day);
  seedHist(d, 'C', 5.0, day);
  const r = getNotenVerlauf(d, { days: 365 });
  // points[0] = today-2 (interior): mean (4+5+5)/3 = 4.666… -> round1 4.7.
  assert.strictEqual(r[0].value, 4.7);
  db.closeInstance();
});
