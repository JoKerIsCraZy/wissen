'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { parsePruefungen, parseAnzahlPruefungen } = require('../../src/scraper');

// Fixture = echter innerText der Tocco-Detailseite (ENG-N3-S2, Live-Spike
// 2026-06-04 via chrome-devtools gegen wiss.tocco.ch). Tocco rendert die
// LEERE Bewertungs-Zelle von "LB 4" als " " — nach trim()+filter(Boolean)
// fällt sie komplett weg, sodass direkt "Zurück zur Übersicht" (Stop-Marker)
// auf "25%" folgt. Genau dieser Fall (unbenotete letzte Prüfung) soll erfasst,
// aber mit leerer Bewertung emittiert werden.
const REAL_DETAIL_TEXT = [
  'Stammdaten',
  'Name:',
  'Elio Morais dos Santos Vaz',
  'Veranstaltung:',
  '35383 / UIFZ-2524-020-S2-ENG-N3 / Englisch Niveau 3 Semester 2',
  'Fach:',
  'GB-ZH-UIFZ-P-B21-03-EGK-ENG-N3-S2 - Englisch Niveau 3',
  'Typ:',
  'Noten',
  'Anzahl Prüfungen:',
  '4',
  'Ergebnis',
  'Bewertung:',
  '4.500',
  'Prüfung',
  'Bezeichnung',
  'Gewicht',
  'Bewertung',
  '1',
  'LB 1',
  '25%',
  '4.700',
  '2',
  'LB 2',
  '25%',
  '3.600',
  '3',
  'LB 3',
  '25%',
  '5.500',
  '4',
  'LB 4',
  '25%',
  // <- LB 4 Bewertung ist leer (" " → weggefiltert), KEINE Zeile hier
  'Zurück zur Übersicht',
  'DIREKT ZU...',
  'zu unserem Bildungsangebot'
].join('\n');

test('parsePruefungen erfasst alle 4 LB inkl. der unbenoteten LB 4', () => {
  const rows = parsePruefungen(REAL_DETAIL_TEXT);
  assert.strictEqual(rows.length, 4, 'sollte alle 4 LB-Zeilen erfassen (auch die leere)');

  assert.deepStrictEqual(
    rows.map(r => r.bezeichnung),
    ['LB 1', 'LB 2', 'LB 3', 'LB 4']
  );
  assert.deepStrictEqual(
    rows.map(r => r.bewertung),
    ['4.700', '3.600', '5.500', ''],
    'LB 4 ohne Note → leere Bewertung'
  );
  // Gewicht muss auch bei der unbenoteten Zeile sauber sein
  assert.strictEqual(rows[3].gewicht, '25%');
  assert.strictEqual(rows[3].pruefung_nr, 4);
});

test('parsePruefungen: benotete Zeilen unverändert (keine Regression)', () => {
  const text = [
    'Prüfung', 'Bezeichnung', 'Gewicht', 'Bewertung',
    '1', 'ZP 1', '50%', '4.000',
    '2', 'ZP 2', '50%', '5.500',
    'Zurück zur Übersicht'
  ].join('\n');
  const rows = parsePruefungen(text);
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(rows.map(r => r.bewertung), ['4.000', '5.500']);
});

test('parsePruefungen: mehrteilige Bezeichnung ohne Note wird erfasst', () => {
  // OTHER-Typ mit umgebrochener Bezeichnung ("Mündliche Prüfung") und leerer Note
  const text = [
    'Prüfung', 'Bezeichnung', 'Gewicht', 'Bewertung',
    '1', 'Mündliche', 'Prüfung', '100%',
    'Zurück zur Übersicht'
  ].join('\n');
  const rows = parsePruefungen(text);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].bezeichnung, 'Mündliche Prüfung');
  assert.strictEqual(rows[0].gewicht, '100%');
  assert.strictEqual(rows[0].bewertung, '');
});

test('parsePruefungen: kein Header → leeres Array (keine Phantom-Einträge)', () => {
  assert.deepStrictEqual(parsePruefungen('irgendein\nText\nohne\nTabelle'), []);
  assert.deepStrictEqual(parsePruefungen(''), []);
});

// --- Regression (User 2026-06): mehrere UNBENOTETE Zeilen hintereinander
//     dürfen KEINE Phantom-Note erzeugen. Die Prüfungs-Nr der Folgezeile darf
//     NICHT als Bewertung der laufenden (unbenoteten) Zeile verschluckt werden.
//     (Das war die Regression des verworfenen #9-State-Machine-Versuchs:
//      ZP ohne Note zeigte "2.00" = die Nr der nachfolgenden LB-Zeile.) ---

test('parsePruefungen: zwei unbenotete Zeilen (ZP + LB ohne Note) → beide leer', () => {
  const text = [
    'Prüfung', 'Bezeichnung', 'Gewicht', 'Bewertung',
    '1', 'ZP', '30%',   // unbenotet — danach folgt direkt die "2" (LB-Nr)
    '2', 'LB', '70%',   // unbenotet
    'Zurück zur Übersicht'
  ].join('\n');
  const rows = parsePruefungen(text);
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(
    rows.map(r => [r.pruefung_nr, r.bezeichnung, r.bewertung]),
    [[1, 'ZP', ''], [2, 'LB', '']],
    'keine Phantom-Note "2" auf der ZP'
  );
});

test('parsePruefungen: leere LB zwischen/neben benoteten Zeilen', () => {
  const text = [
    'Prüfung', 'Bezeichnung', 'Gewicht', 'Bewertung',
    '1', 'LB 1', '33%',          // leer
    '2', 'LB 2', '33%', '4.400', // benotet
    '3', 'LB 3', '34%',          // leer
    'Zurück zur Übersicht'
  ].join('\n');
  const rows = parsePruefungen(text);
  assert.deepStrictEqual(
    rows.map(r => [r.pruefung_nr, r.bewertung]),
    [[1, ''], [2, '4.400'], [3, '']]
  );
});

// --- parseAnzahlPruefungen (Vollständigkeits-Signal für #6) ---

test('parseAnzahlPruefungen: liest "Anzahl Prüfungen: N" (Label + Zahl getrennt)', () => {
  const text = REAL_DETAIL_TEXT; // enthält "Anzahl Prüfungen:\n4"
  assert.strictEqual(parseAnzahlPruefungen(text), 4);
  assert.strictEqual(parseAnzahlPruefungen('Anzahl Prüfungen: 7'), 7);
  assert.strictEqual(parseAnzahlPruefungen('kein passender Text'), null);
  assert.strictEqual(parseAnzahlPruefungen(''), null);
});
