// Tests für die Absenzen-Parser-Helfer in src/db/parsers.js:
//   normalizeAbsenzStatus — single source of truth der Status-Normalisierung
//   parsePosNum           — generischer Zahl-Extractor (SOLL/Besucht/Lektionen)
//   isAbwesend            — Abwesenheits-Prädikat (treibt die Push-Diff)
//
// parsers.js ist CommonJS, daher via createRequire geladen.
// Lauf: node --test test/unit/absenzen.parsers.test.mjs

import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeAbsenzStatus, parsePosNum, isAbwesend, isAbwesendPush } = require('../../src/db/parsers');

test('normalizeAbsenzStatus mappt die 4 bestätigten Status-Werte', () => {
  assert.strictEqual(normalizeAbsenzStatus('Teilgenommen'), 'teilgenommen');
  assert.strictEqual(normalizeAbsenzStatus('Offen'), 'offen');
  assert.strictEqual(
    normalizeAbsenzStatus('Nicht teilgenommen entschuldigt'),
    'abwesend_entschuldigt'
  );
  assert.strictEqual(
    normalizeAbsenzStatus('Nicht teilgenommen unentschuldigt'),
    'abwesend_unentschuldigt'
  );
});

test('normalizeAbsenzStatus: "Abwesend X%" → abwesend_prozent (jede Prozentzahl)', () => {
  // Eigene Kategorie für die prozentuale Abwesenheit. Generischer 'abwesend'-
  // Match deckt 50/100/25 % usw. ohne Einzel-Pflege ab.
  assert.strictEqual(normalizeAbsenzStatus('Abwesend 50%'), 'abwesend_prozent');
  assert.strictEqual(normalizeAbsenzStatus('Abwesend 100%'), 'abwesend_prozent');
  assert.strictEqual(normalizeAbsenzStatus('Abwesend 25%'), 'abwesend_prozent');
  assert.strictEqual(normalizeAbsenzStatus('  ABWESEND 75 %  '), 'abwesend_prozent');
  // Der Scraper hängt teils " Zur Übersicht" an — muss trotzdem greifen.
  assert.strictEqual(normalizeAbsenzStatus('Abwesend 100% Zur Übersicht'), 'abwesend_prozent');
});

test('normalizeAbsenzStatus ist tolerant gegen Case/Whitespace', () => {
  assert.strictEqual(normalizeAbsenzStatus('  TEILGENOMMEN  '), 'teilgenommen');
  assert.strictEqual(
    normalizeAbsenzStatus('nicht  teilgenommen   UNENTSCHULDIGT'),
    'abwesend_unentschuldigt'
  );
});

test('normalizeAbsenzStatus: unentschuldigt gewinnt vor entschuldigt-Substring', () => {
  // "unentschuldigt" enthält "entschuldigt" als Substring — die spezifischere
  // Regel muss zuerst greifen, sonst landet alles als entschuldigt.
  assert.strictEqual(
    normalizeAbsenzStatus('Nicht teilgenommen unentschuldigt'),
    'abwesend_unentschuldigt'
  );
});

test('normalizeAbsenzStatus: alles Unbekannte → unbekannt (nicht-pushend)', () => {
  assert.strictEqual(normalizeAbsenzStatus('Krankgeschrieben'), 'unbekannt');
  assert.strictEqual(normalizeAbsenzStatus('Nicht teilgenommen'), 'unbekannt');
  assert.strictEqual(normalizeAbsenzStatus(''), 'unbekannt');
  assert.strictEqual(normalizeAbsenzStatus(null), 'unbekannt');
  assert.strictEqual(normalizeAbsenzStatus(undefined), 'unbekannt');
});

test('isAbwesend ist für alle abwesend_*-Kategorien wahr (inkl. prozent)', () => {
  assert.strictEqual(isAbwesend('abwesend_entschuldigt'), true);
  assert.strictEqual(isAbwesend('abwesend_unentschuldigt'), true);
  assert.strictEqual(isAbwesend('abwesend_prozent'), true);
  assert.strictEqual(isAbwesend('teilgenommen'), false);
  assert.strictEqual(isAbwesend('offen'), false);
  assert.strictEqual(isAbwesend('unbekannt'), false);
  assert.strictEqual(isAbwesend(null), false);
});

test('isAbwesendPush: nur unentschuldigt + prozent pushen, entschuldigt NICHT', () => {
  // User-Entscheid: "Abwesend X%" + "Nicht teilgenommen unentschuldigt" pushen,
  // "Nicht teilgenommen entschuldigt" bewusst NICHT (echte Absenz, aber kein Push).
  assert.strictEqual(isAbwesendPush('abwesend_unentschuldigt'), true);
  assert.strictEqual(isAbwesendPush('abwesend_prozent'), true);
  assert.strictEqual(isAbwesendPush('abwesend_entschuldigt'), false);
  assert.strictEqual(isAbwesendPush('teilgenommen'), false);
  assert.strictEqual(isAbwesendPush('offen'), false);
  assert.strictEqual(isAbwesendPush('unbekannt'), false);
  assert.strictEqual(isAbwesendPush(null), false);
});

test('parsePosNum extrahiert Dezimal-Punkt und -Komma', () => {
  assert.strictEqual(parsePosNum('45'), 45);
  assert.strictEqual(parsePosNum('4.00'), 4);
  assert.strictEqual(parsePosNum('4,00'), 4);
  assert.strictEqual(parsePosNum('90%'), 90);
  assert.strictEqual(parsePosNum('  12.5 Lektionen '), 12.5);
});

test('parsePosNum: Zahlen werden durchgereicht, Müll → null', () => {
  assert.strictEqual(parsePosNum(7), 7);
  assert.strictEqual(parsePosNum(0), 0);
  assert.strictEqual(parsePosNum(null), null);
  assert.strictEqual(parsePosNum(undefined), null);
  assert.strictEqual(parsePosNum('keine Zahl'), null);
  assert.strictEqual(parsePosNum(NaN), null);
});
