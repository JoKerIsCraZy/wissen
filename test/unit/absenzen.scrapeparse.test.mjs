// Tests für die Absenzen-Scrape-Parser in src/scraper.js (Agent B / Scraper-Slice).
//
// Deckt die drei reinen Text-Parser ab, die aus Tocco-innerText die Absenzen-
// Übersicht (pro Modul) und die Detail-Lektionen (pro Termin) extrahieren —
// PLUS den deutschen Langdatum-Parser. Diese Datei ist die ausführbare Spec
// für das Parser-Layout (Spec §7 + §15).
//
// scraper.js ist CommonJS → via createRequire einbinden. Lauf:
//   node --test test/unit/absenzen.scrapeparse.test.mjs

import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  parseAbsenzenOverview,
  parseAbsenzLektionen,
  parseTerminLangDatum,
  parseAbsenzenIdMap,
  bumpDwrPagingLimit
} = require('../../src/scraper.js');

// ---------- parseTerminLangDatum ----------

test('parseTerminLangDatum: Standardfall mit Bindestrich-Zeitspanne', () => {
  // Arrange
  const raw = 'Montag, 13. Oktober 2025, 08:30 - 12:00';

  // Act
  const r = parseTerminLangDatum(raw);

  // Assert
  assert.deepStrictEqual(r, { termin_iso: '2025-10-13', zeit_von: '08:30', zeit_bis: '12:00' });
});

test('parseTerminLangDatum: Gedankenstrich (–) statt Bindestrich + einstellige Stunde', () => {
  const r = parseTerminLangDatum('Dienstag, 3. März 2025, 9:05 – 17:00');
  assert.deepStrictEqual(r, { termin_iso: '2025-03-03', zeit_von: '09:05', zeit_bis: '17:00' });
});

test('parseTerminLangDatum: alle deutschen Monatsnamen werden gemappt', () => {
  const cases = [
    ['1. Januar 2025', '2025-01-01'],
    ['1. Februar 2025', '2025-02-01'],
    ['1. März 2025', '2025-03-01'],
    ['1. April 2025', '2025-04-01'],
    ['1. Mai 2025', '2025-05-01'],
    ['1. Juni 2025', '2025-06-01'],
    ['1. Juli 2025', '2025-07-01'],
    ['1. August 2025', '2025-08-01'],
    ['1. September 2025', '2025-09-01'],
    ['1. Oktober 2025', '2025-10-01'],
    ['1. November 2025', '2025-11-01'],
    ['1. Dezember 2025', '2025-12-01']
  ];
  for (const [input, expectedIso] of cases) {
    const r = parseTerminLangDatum('Montag, ' + input + ', 08:00 - 09:00');
    assert.strictEqual(r.termin_iso, expectedIso, 'fehlgeschlagen für: ' + input);
  }
});

test('parseTerminLangDatum: tolerant gegen Komma zwischen Monat und Jahr (Zell-Umbruch)', () => {
  // innerText kann eine Zelle umbrechen → 'Oktober' + '2025' joinen ggf. mit Komma.
  const r = parseTerminLangDatum('Donnerstag, 16. Oktober, 2025, 08:30 - 09:15');
  assert.strictEqual(r.termin_iso, '2025-10-16');
  assert.strictEqual(r.zeit_von, '08:30');
});

test('parseTerminLangDatum: null bei nicht-parsebarem Input', () => {
  assert.strictEqual(parseTerminLangDatum('garbage'), null);
  assert.strictEqual(parseTerminLangDatum(''), null);
  assert.strictEqual(parseTerminLangDatum(null), null);
  // Unbekannter Monatsname → null (kein still falsches Datum).
  assert.strictEqual(parseTerminLangDatum('Montag, 5. Foobar 2025, 08:00 - 09:00'), null);
});

// ---------- parseAbsenzenOverview ----------

test('parseAbsenzenOverview: mehrzeilige Bezeichnung wird zusammengefügt', () => {
  // Arrange — Bezeichnung bricht über zwei Zeilen, danach SOLL/Besucht/2× %.
  const text = [
    'Kurzbezeichnung', 'Typ', 'Bezeichnung', 'SOLL', 'Besucht', 'Minimalanwesenheit', 'Anwesenheit',
    'UIFZ-2524-020-S1-UEK-106',
    'GE Überbetrieblicher Kurs',
    '106 - Datenbanken',
    'abfragen, gestalten',
    '45', '45', '90%', '100%'
  ].join('\n');

  // Act
  const rows = parseAbsenzenOverview(text);

  // Assert
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual(rows[0], {
    kuerzel_code: 'UIFZ-2524-020-S1-UEK-106',
    typ: 'GE Überbetrieblicher Kurs',
    bezeichnung: '106 - Datenbanken abfragen, gestalten',
    semester: 'S1',
    soll: 45,
    besucht: 45,
    minimal_pct: 90,
    anwesenheit_pct_scraped: 100
  });
});

test('parseAbsenzenOverview: mehrere Module + Stop am Footer', () => {
  const text = [
    'Kurzbezeichnung', 'Typ', 'Bezeichnung', 'SOLL', 'Besucht', 'Minimalanwesenheit', 'Anwesenheit',
    'UIFZ-2524-020-S1-UEK-106', 'GE Überbetrieblicher Kurs', '106 - DB', '45', '45', '90%', '100%',
    'UIFZ-2524-020-S1-MOD-187', 'GE Modul', '187 - Web', '20', '15', '80%', '75%',
    'Seite 1 von 1', 'Anzeige Eintrag 1-2'
  ].join('\n');

  const rows = parseAbsenzenOverview(text);

  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].kuerzel_code, 'UIFZ-2524-020-S1-UEK-106');
  assert.strictEqual(rows[1].kuerzel_code, 'UIFZ-2524-020-S1-MOD-187');
  assert.strictEqual(rows[1].soll, 20);
  assert.strictEqual(rows[1].besucht, 15);
  assert.strictEqual(rows[1].minimal_pct, 80);
  assert.strictEqual(rows[1].anwesenheit_pct_scraped, 75);
  assert.strictEqual(rows[1].semester, 'S1');
});

test('parseAbsenzenOverview: leerer Text → []', () => {
  assert.deepStrictEqual(parseAbsenzenOverview(''), []);
  assert.deepStrictEqual(parseAbsenzenOverview(null), []);
});

// ---------- parseAbsenzLektionen ----------

test('parseAbsenzLektionen: alle 4 Status-Werte werden RAW emittiert', () => {
  // Arrange — ein Record pro Status, Record-Trenner = Wochentag.
  const text = [
    'Termin', 'Lektionen Soll', 'Lektionen Ist', 'Anwesenheit (%)', 'Status',
    'Montag, 13. Oktober 2025, 08:30 - 12:00', '4.00', '4.00', '100%', 'Teilgenommen',
    'Dienstag, 14. Oktober 2025, 13:30 - 17:00', '4.00', '0.00', '0%', 'Nicht teilgenommen unentschuldigt',
    'Mittwoch, 15. Oktober 2025, 08:30 - 12:00', '4.00', '0.00', '0%', 'Nicht teilgenommen entschuldigt',
    'Freitag, 17. Oktober 2025, 09:00 - 10:00', '1.00', '0.00', '0%', 'Offen',
    'Zurück zur Übersicht'
  ].join('\n');

  // Act
  const rows = parseAbsenzLektionen(text);

  // Assert — Status bleibt unverändert (Normalisierung ist Aufgabe des DB-Slices).
  assert.strictEqual(rows.length, 4);
  assert.strictEqual(rows[0].status_raw, 'Teilgenommen');
  assert.strictEqual(rows[1].status_raw, 'Nicht teilgenommen unentschuldigt');
  assert.strictEqual(rows[2].status_raw, 'Nicht teilgenommen entschuldigt');
  assert.strictEqual(rows[3].status_raw, 'Offen');

  // Spalten-Mapping stimmt für den unentschuldigten Record.
  assert.deepStrictEqual(rows[1], {
    termin_iso: '2025-10-14',
    zeit_von: '13:30',
    zeit_bis: '17:00',
    termin_raw: 'Dienstag, 14. Oktober 2025, 13:30 - 17:00',
    lektionen_soll: 4,
    lektionen_ist: 0,
    anwesenheit_pct: 0,
    status_raw: 'Nicht teilgenommen unentschuldigt'
  });
});

test('parseAbsenzLektionen: multi-line Termin (Zell-Umbruch) wird zu vollem ISO', () => {
  // Tocco bricht die Termin-Zelle über zwei Zeilen — der Trenner ist trotzdem
  // der Wochentag, die zweite Zeile gehört zum selben Record.
  const text = [
    'Termin', 'Status',
    'Donnerstag, 16. Oktober', '2025, 08:30 - 09:15', '4.00', '4.00', '100%', 'Teilgenommen'
  ].join('\n');

  const rows = parseAbsenzLektionen(text);

  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].termin_iso, '2025-10-16');
  assert.strictEqual(rows[0].zeit_von, '08:30');
  assert.strictEqual(rows[0].zeit_bis, '09:15');
  assert.strictEqual(rows[0].status_raw, 'Teilgenommen');
});

test('parseAbsenzLektionen: 0-SOLL-Lektion (Lektionen Soll = 0.00)', () => {
  const text = [
    'Termin', 'Status',
    'Montag, 13. Oktober 2025, 08:30 - 12:00', '0.00', '0.00', '0%', 'Offen'
  ].join('\n');

  const rows = parseAbsenzLektionen(text);

  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].lektionen_soll, 0);
  assert.strictEqual(rows[0].lektionen_ist, 0);
  assert.strictEqual(rows[0].anwesenheit_pct, 0);
  assert.strictEqual(rows[0].status_raw, 'Offen');
});

test('parseAbsenzLektionen: leerer Text → []', () => {
  assert.deepStrictEqual(parseAbsenzLektionen(''), []);
  assert.deepStrictEqual(parseAbsenzLektionen(null), []);
});

// ---------- parseAbsenzenIdMap ----------

// Realistische DWR-Zeile (Live-Spike 2026-05-29): Kurzbezeichnung via
// relEvent.abbreviation, dann die GETEILTE Event_type-PK (pro Kurs-Typ), dann
// die eindeutige Registration-PK (= echte detail_id, URL #detail&key=<PK>).
function dwrRow(code, eventTypePk, registrationPk) {
  return '"r_relEvent.abbreviation":"' + code + '",is_percent:"100%",'
    + 'entityName:"Event_type",entityType:"STANDARD",key:new nice2.entity.PrimaryKey(\'' + eventTypePk + '\'),version:3,'
    + 'entityName:"Registration",entityType:"STANDARD",key:new nice2.entity.PrimaryKey(\'' + registrationPk + '\'),version:11})';
}

test('parseAbsenzenIdMap: nimmt die Registration-PK, NICHT die geteilte Event_type-PK', () => {
  // Regression (Live-Spike): früher koppelte der Parser an die NÄCHSTE
  // PrimaryKey = die Event_type-PK (pro Typ geteilt) → alle "Modul" kollabierten
  // auf 139, alle "UEK" auf 143. Korrekt ist die Registration-PK.
  const map = parseAbsenzenIdMap([dwrRow('UIFZ-2524-020-S1-UEK-106', '143', '297250')]);
  assert.deepStrictEqual(map, { 'UIFZ-2524-020-S1-UEK-106': '297250' });
});

test('parseAbsenzenIdMap: verschiedene Module mit geteiltem Event_type → eigene PKs', () => {
  // Beide "Modul" teilen Event_type 139, müssen aber eigene Registration-PKs
  // bekommen (genau der Kollaps-Bug).
  const map = parseAbsenzenIdMap([
    dwrRow('UIFZ-2524-020-S1-114', '139', '297251')
    + dwrRow('UIFZ-2524-020-S1-117', '139', '297252')
  ]);
  assert.deepStrictEqual(map, {
    'UIFZ-2524-020-S1-114': '297251',
    'UIFZ-2524-020-S1-117': '297252'
  });
});

test('parseAbsenzenIdMap: 0 Mappings → Log-Warn + leeres Objekt', () => {
  const warnings = [];
  const map = parseAbsenzenIdMap([''], (m, lvl) => warnings.push({ m, lvl }));
  assert.deepStrictEqual(map, {});
  assert.strictEqual(warnings.length, 1);
  assert.strictEqual(warnings[0].lvl, 'warn');
});

test('parseAbsenzenIdMap: erstes Mapping pro Code gewinnt (Pagination-Dups)', () => {
  const map = parseAbsenzenIdMap([
    dwrRow('UIFZ-2524-020-S1-UEK-106', '143', '111')
    + dwrRow('UIFZ-2524-020-S1-UEK-106', '143', '222')
  ]);
  assert.strictEqual(map['UIFZ-2524-020-S1-UEK-106'], '111');
});

// ---------- bumpDwrPagingLimit ----------

// Echter Such-Request-Body (Live-Spike 2026-05-29, reqid=672): die Absenzen-
// Übersicht lädt mit offset 0 / limit 25. Wir bumpen das Limit, damit EINE
// Suche alle Module (35) liefert. Offset/Limit-Referenz-IDs werden aus dem
// Paging-Objekt abgeleitet → robust gegen c0-eNN-Verschiebungen.
const REAL_SEARCH_BODY = [
  'callCount=1',
  'c0-scriptName=nice2_netui_SearchService',
  'c0-e12=number:0',
  'c0-e13=number:25',
  'c0-e11=Object_searchService.Paging:{offset:reference:c0-e12, limit:reference:c0-e13}',
  'c0-e22=string:Registration',
  'batchId=3'
].join('\n');

test('bumpDwrPagingLimit: setzt das Paging-Limit hoch, Offset auf 0', () => {
  // Act
  const out = bumpDwrPagingLimit(REAL_SEARCH_BODY, 1000);

  // Assert — Limit gebumpt, Offset bleibt/wird 0, Rest unverändert.
  assert.match(out, /c0-e13=number:1000/);
  assert.match(out, /c0-e12=number:0/);
  assert.doesNotMatch(out, /c0-e13=number:25/);
  assert.match(out, /c0-scriptName=nice2_netui_SearchService/);
});

test('bumpDwrPagingLimit: leitet Limit-Ref aus dem Paging-Objekt ab (verschobene Indizes)', () => {
  // Andere e-Indizes als im Standardfall — der Ersatz darf NICHT auf c0-e13
  // hartkodiert sein, sondern muss der Paging-Referenz folgen.
  const body = [
    'c0-e40=number:0',
    'c0-e41=number:25',
    'c0-e30=Object_searchService.Paging:{offset:reference:c0-e40, limit:reference:c0-e41}'
  ].join('\n');

  const out = bumpDwrPagingLimit(body, 500);

  assert.match(out, /c0-e41=number:500/);
  assert.doesNotMatch(out, /c0-e41=number:25/);
});

test('bumpDwrPagingLimit: gibt Body unverändert zurück, wenn kein Paging-Objekt da ist', () => {
  assert.strictEqual(bumpDwrPagingLimit('kein paging hier', 1000), 'kein paging hier');
  assert.strictEqual(bumpDwrPagingLimit('', 1000), '');
  assert.strictEqual(bumpDwrPagingLimit(null, 1000), null);
});

test('bumpDwrPagingLimit: bumpt NUR die Paging-Limit-Referenz, nicht andere number-Felder', () => {
  // c0-e99=number:25 ist KEINE Paging-Referenz und darf NICHT angefasst werden.
  const body = [
    'c0-e99=number:25',
    'c0-e12=number:0',
    'c0-e13=number:25',
    'c0-e11=Object_searchService.Paging:{offset:reference:c0-e12, limit:reference:c0-e13}'
  ].join('\n');

  const out = bumpDwrPagingLimit(body, 1000);

  assert.match(out, /c0-e99=number:25/);   // unangetastet
  assert.match(out, /c0-e13=number:1000/); // gebumpt
});
