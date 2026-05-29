// Tests für die reine Absenzen-Status-/Band-Logik (Desktop-Frontend, Agent E).
//
// Deckt die single source of truth ab, die helpers.ts re-exportiert und die
// AbsenzenTable/Tiles/Filters konsumieren:
//   - statusLabel(cat)       → Pill-Wort + Ton (teilgenommen/offen/abwesend_*)
//   - attendanceClass(ist,min) → Anwesenheits-Band-Klasse (analog gradeClass)
//   - isUnterMinimum(ist,min)  → Schwellen-Prüfung für Filter + Stats-Kachel
//
// ESM (.mjs), weil das Modul ESM ist. Lauf: node --test test/unit/absenzen.helpers.test.mjs

import { test } from 'node:test';
import assert from 'node:assert';
import {
  statusLabel,
  attendanceClass,
  isUnterMinimum,
} from '../../web-svelte/src/routes/absenzen/absenz-status.js';

// ---------------------------------------------------------------------------
// statusLabel — die 4 bestätigten Kategorien + Fallback (§3 + §10)
// ---------------------------------------------------------------------------

test('statusLabel: teilgenommen → has (gut)', () => {
  const r = statusLabel('teilgenommen');
  assert.strictEqual(r.tone, 'has');
  assert.strictEqual(r.text, 'Teilgenommen');
});

test('statusLabel: offen → neutral', () => {
  const r = statusLabel('offen');
  assert.strictEqual(r.tone, 'neutral');
  assert.strictEqual(r.text, 'Offen');
});

test('statusLabel: abwesend_entschuldigt → warning', () => {
  const r = statusLabel('abwesend_entschuldigt');
  assert.strictEqual(r.tone, 'warning');
  assert.strictEqual(r.text, 'Entschuldigt');
});

test('statusLabel: abwesend_unentschuldigt → danger', () => {
  const r = statusLabel('abwesend_unentschuldigt');
  assert.strictEqual(r.tone, 'danger');
  assert.strictEqual(r.text, 'Unentschuldigt');
});

test('statusLabel: unbekannt/leer/null → neutral (nie still als Absenz werten)', () => {
  // §3: 'unbekannt' gilt als nicht-pushend; UI darf es nie als danger/warning zeigen.
  assert.strictEqual(statusLabel('unbekannt').tone, 'neutral');
  assert.strictEqual(statusLabel('').tone, 'neutral');
  assert.strictEqual(statusLabel(null).tone, 'neutral');
  assert.strictEqual(statusLabel(undefined).tone, 'neutral');
  assert.strictEqual(statusLabel('irgendwas-neues').tone, 'neutral');
});

// ---------------------------------------------------------------------------
// attendanceClass — Band relativ zur Minimal-Anforderung
// ---------------------------------------------------------------------------

test('attendanceClass: 100% → a-good (Maximum)', () => {
  assert.strictEqual(attendanceClass(100, 90), 'a-good');
});

test('attendanceClass: klar über Minimum (min + 5pp) → a-good', () => {
  assert.strictEqual(attendanceClass(95, 90), 'a-good'); // 90 + 5
  assert.strictEqual(attendanceClass(96, 90), 'a-good');
});

test('attendanceClass: auf/knapp über Minimum → a-ok', () => {
  assert.strictEqual(attendanceClass(90, 90), 'a-ok'); // genau auf Minimum
  assert.strictEqual(attendanceClass(92, 90), 'a-ok'); // < min + 5, ≥ min
});

test('attendanceClass: unter Minimum → a-fail', () => {
  assert.strictEqual(attendanceClass(89, 90), 'a-fail');
  assert.strictEqual(attendanceClass(0, 90), 'a-fail');
});

test('attendanceClass: kein Ist-Wert → a-none', () => {
  assert.strictEqual(attendanceClass(null, 90), 'a-none');
  assert.strictEqual(attendanceClass(undefined, 90), 'a-none');
  assert.strictEqual(attendanceClass(NaN, 90), 'a-none');
});

test('attendanceClass: fehlendes Minimum → Fallback 90% (nie farblos)', () => {
  assert.strictEqual(attendanceClass(85, null), 'a-fail'); // < 90 Fallback
  assert.strictEqual(attendanceClass(100, null), 'a-good');
  assert.strictEqual(attendanceClass(92, null), 'a-ok'); // ≥ 90, < 95
});

// ---------------------------------------------------------------------------
// isUnterMinimum — geteilte Schwellen-Prüfung (Filter-Chip + Stats-Kachel)
// ---------------------------------------------------------------------------

test('isUnterMinimum: ist < min → true', () => {
  assert.strictEqual(isUnterMinimum(80, 90), true);
});

test('isUnterMinimum: ist >= min → false (auch exakt auf Minimum)', () => {
  assert.strictEqual(isUnterMinimum(90, 90), false);
  assert.strictEqual(isUnterMinimum(100, 90), false);
});

test('isUnterMinimum: fehlende Werte → false (kein falsch-positives Flaggen)', () => {
  assert.strictEqual(isUnterMinimum(null, 90), false);
  assert.strictEqual(isUnterMinimum(80, null), false);
  assert.strictEqual(isUnterMinimum(null, null), false);
  assert.strictEqual(isUnterMinimum(NaN, 90), false);
});
