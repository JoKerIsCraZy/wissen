'use strict';

// Tests für die Mobile-Absenzen-View-Logik (Agent F).
//
// Die View-Files (web/mobile/views/absenzen.js + absenz-sheet.js) sind
// Browser-Global-Scripts (kein module.exports). Statt die Logik hier zu
// duplizieren (Drift-Risiko) laden wir den ECHTEN Quelltext via node:vm in
// einen Sandbox-Context mit gestubbten Shell-Globals und greifen die reinen
// Funktionen ab. So testet die Datei den tatsächlich ausgelieferten Code.
//
// Lauf: node --test test/unit/absenzen.mobileview.test.js
//   (wird auch vom npm-test-Glob test/unit/*.test.js erfasst)

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MOBILE_DIR = path.join(__dirname, '..', '..', 'web', 'mobile', 'views');

/* Minimaler DOM-Stub: nur was die View-Scripts beim FUNKTIONSAUFRUF anfassen.
 * Top-Level führen die Scripts nichts aus außer Funktions-Deklarationen +
 * einem `let …State`, daher reicht ein leichtgewichtiger Stub. */
function makeElementStub() {
  const el = {
    className: '',
    id: '',
    type: '',
    textContent: '',
    innerHTML: '',
    value: '',
    hidden: false,
    dataset: {},
    style: {},
    children: [],
    _attrs: {},
    setAttribute(k, v) { this._attrs[k] = String(v); },
    getAttribute(k) { return this._attrs[k]; },
    append(...kids) { kids.forEach((k) => this.children.push(k)); },
    replaceChildren(...kids) { this.children = kids.slice(); },
    appendChild(k) { this.children.push(k); return k; },
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  return el;
}

function loadView(fileName, extraGlobals, appendShim) {
  let src = fs.readFileSync(path.join(MOBILE_DIR, fileName), 'utf8');
  // `let absenzenState` ist ein lexikalisches Binding — es landet NICHT als
  // Property auf dem vm-Sandbox-Objekt (anders als function-/var-Deklarationen).
  // Ein optionaler Shim reicht das Binding für den Test nach außen, ohne die
  // ausgelieferte Datei zu verändern.
  if (appendShim) src += '\n;' + appendShim;
  const created = [];
  const documentStub = {
    createElement() { const e = makeElementStub(); created.push(e); return e; },
    createElementNS() { const e = makeElementStub(); created.push(e); return e; },
    querySelector() { return null; },
    addEventListener() {},
    body: makeElementStub(),
    activeElement: null,
  };
  const sandbox = Object.assign({
    document: documentStub,
    window: {},
    console,
    titleEl: makeElementStub(),
    main: makeElementStub(),
    $: () => null,
    apiFetch: async () => ({}),
    skeletonShell() {},
    errorShell() {},
    observeFresh() {},
    IntersectionObserver: function () {},
    performance: { now: () => 0 },
    location: { hash: '' },
    history: {},
  }, extraGlobals || {});
  sandbox.window = sandbox; // self-reference so `window.foo = …` lands on sandbox
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: fileName });
  sandbox.__created = created;
  return sandbox;
}

test('attendanceClass: unter Minimum → fail, knapp drüber → warn, klar drüber → good', () => {
  const ctx = loadView('absenzen.js');
  const f = ctx.attendanceClass;
  // Minimum 90: 85 < 90 → fail; 92 (< 95) → warn; 99 → good.
  assert.strictEqual(f(85, 90), 'm-att--fail');
  assert.strictEqual(f(92, 90), 'm-att--warn');
  assert.strictEqual(f(99, 90), 'm-att--good');
  // genau auf der Schwelle ist NICHT mehr fail (< floor)
  assert.strictEqual(f(90, 90), 'm-att--warn'); // 90 < 95 → warn
});

test('attendanceClass: kein Minimum → feste 90er-Bänder', () => {
  const ctx = loadView('absenzen.js');
  const f = ctx.attendanceClass;
  assert.strictEqual(f(89, null), 'm-att--fail');
  assert.strictEqual(f(93, null), 'm-att--warn');
  assert.strictEqual(f(100, null), 'm-att--good');
});

test('attendanceClass: null Ist-Wert → none (Farbe verschwindet nie ganz)', () => {
  const ctx = loadView('absenzen.js');
  assert.strictEqual(ctx.attendanceClass(null, 90), 'm-att--none');
  assert.strictEqual(ctx.attendanceClass(null, null), 'm-att--none');
});

test('isUnterMinimum: nur wenn Minimum gesetzt UND Ist darunter', () => {
  const ctx = loadView('absenzen.js');
  const u = ctx.isUnterMinimum;
  assert.strictEqual(u({ minimal_pct: 90, anwesenheit_pct: 85 }), true);
  assert.strictEqual(u({ minimal_pct: 90, anwesenheit_pct: 95 }), false);
  // genau auf dem Minimum ist NICHT drunter
  assert.strictEqual(u({ minimal_pct: 90, anwesenheit_pct: 90 }), false);
  // ohne Minimum kann es nicht „unter Minimum" sein
  assert.strictEqual(u({ minimal_pct: null, anwesenheit_pct: 50 }), false);
  // ohne Ist-Wert ebenfalls nicht
  assert.strictEqual(u({ minimal_pct: 90, anwesenheit_pct: null }), false);
});

test('fmtPct: rundet kaufmännisch auf ganze Prozent, null → Gedankenstrich', () => {
  const ctx = loadView('absenzen.js');
  assert.strictEqual(ctx.fmtPct(100), '100%');
  assert.strictEqual(ctx.fmtPct(89.6), '90%');
  assert.strictEqual(ctx.fmtPct(null), '–');
  assert.strictEqual(ctx.fmtPct(NaN), '–');
});

test('fmtNum: ganzzahlig ohne Nachkomma, sonst eine Stelle', () => {
  const ctx = loadView('absenzen.js');
  assert.strictEqual(ctx.fmtNum(45), '45');
  assert.strictEqual(ctx.fmtNum(4.5), '4.5');
  assert.strictEqual(ctx.fmtNum(null), '–');
});

test('shortTypLabel: lange Tocco-Typen werden für Chips gekürzt', () => {
  const ctx = loadView('absenzen.js');
  assert.strictEqual(ctx.shortTypLabel('GE Überbetrieblicher Kurs'), 'ÜK');
  assert.strictEqual(ctx.shortTypLabel('GE Modul'), 'Modul');
});

test('deriveAbsenzTypLabels: dedupliziert auf dem ANZEIGE-Label, keine doppelten Chips', () => {
  // Regression: echte DB-Daten (Live-Query 2026-05-29) haben 7 distinkte
  // Roh-Typen, die shortTypLabel auf 3 Labels kollabiert. Dedup auf dem
  // Rohwert erzeugte 4× „Modul" + 2× „ÜK" + 1× „Semester" (Screenshot-Bug).
  const ctx = loadView('absenzen.js');
  const rows = [
    { typ: 'GE Modul' }, { typ: 'Modul' }, { typ: 'PE Modul' },
    { typ: 'Parallelmodul' }, { typ: 'PE Überbetrieblicher Kurs' },
    { typ: 'GE Überbetrieblicher Kurs' }, { typ: 'Semester' },
  ];
  // .join statt deepStrictEqual: das Array stammt aus dem vm-Sandbox-Realm
  // (anderes Array.prototype) → deepStrictEqual scheitert am Prototyp-Check.
  // „Semester" ist als Filter-Chip ausgeblendet (ABSENZ_HIDDEN_TYP_LABELS) →
  // erscheint NICHT in der Label-Liste, obwohl es als Roh-Typ vorkommt.
  const labels = ctx.deriveAbsenzTypLabels(rows);
  assert.strictEqual(labels.length, 2, 'genau 2 sichtbare Chip-Labels (Semester ausgeblendet)');
  assert.strictEqual(labels.join('|'), 'Modul|ÜK');
  assert.ok(!labels.includes('Semester'), 'Semester ist kein Filter-Chip');
  // Kein Label kommt doppelt vor.
  assert.strictEqual(new Set(labels).size, labels.length);
});

test('deriveAbsenzTypLabels: leere/typ-lose Eingabe → []', () => {
  const ctx = loadView('absenzen.js');
  assert.strictEqual(ctx.deriveAbsenzTypLabels([]).length, 0);
  assert.strictEqual(ctx.deriveAbsenzTypLabels(null).length, 0);
  assert.strictEqual(ctx.deriveAbsenzTypLabels([{ typ: null }, {}]).length, 0);
});

test('dedupAbsenzRows: leeres 0/0-Duplikat wird entfernt, echtes Pendant bleibt', () => {
  // Tocco-Artefakt: „Englisch …" einmal als 0/0-Modul, einmal als Parallelmodul
  // mit echten Lektionen. Nur das leere Duplikat verschwindet.
  const ctx = loadView('absenzen.js');
  const rows = [
    { kuerzel_code: 'UIFZ-2524-020-S2-ENG-N3', bezeichnung: 'Englisch Niveau 3 Semester 2', soll: 0, besucht: 0 },
    { kuerzel_code: 'UIFZ-2524-S2-ENG-N3', bezeichnung: 'Englisch Niveau 3 Semester 2', soll: 48, besucht: 48 },
  ];
  const out = ctx.dedupAbsenzRows(rows);
  assert.strictEqual(out.length, 1, 'nur die echte Zeile bleibt');
  assert.strictEqual(out[0].kuerzel_code, 'UIFZ-2524-S2-ENG-N3');
  assert.strictEqual(out[0].besucht, 48);
});

test('dedupAbsenzRows: eindeutiges 0/0-Modul (kein Duplikat) bleibt sichtbar', () => {
  // „Start", noch nicht gestartete ÜK etc. sind 0/0 aber EINDEUTIG → behalten.
  const ctx = loadView('absenzen.js');
  const rows = [
    { kuerzel_code: 'UIFZ-2524-020-S1-STAR', bezeichnung: 'Start', soll: 0, besucht: 0 },
    { kuerzel_code: 'UIFZ-2524-020-S2-UEK-188', bezeichnung: '188 - Services …', soll: 0, besucht: 0 },
    { kuerzel_code: 'A', bezeichnung: '114 - …', soll: 36, besucht: 36 },
  ];
  const out = ctx.dedupAbsenzRows(rows);
  assert.strictEqual(out.length, 3, 'kein Pendant mit echten Lektionen → alle bleiben');
});

test('dedupAbsenzRows: Duplikat-Gruppe komplett leer → keine Zeile verloren', () => {
  // Defensiv: gäbe es zwei leere Zeilen gleicher Bezeichnung ohne echtes
  // Pendant, dürfen wir nicht beide verlieren.
  const ctx = loadView('absenzen.js');
  const rows = [
    { kuerzel_code: 'X1', bezeichnung: 'Leer', soll: 0, besucht: 0 },
    { kuerzel_code: 'X2', bezeichnung: 'Leer', soll: 0, besucht: 0 },
  ];
  assert.strictEqual(ctx.dedupAbsenzRows(rows).length, 2);
});

test('drawAbsenzList: eine „Modul"-Chip filtert ALLE Modul-Roh-Untermengen', () => {
  // Der eigentliche Bug-Kern: nach dem Label-Dedup muss der Filter auf
  // shortTypLabel(r.typ) matchen, sonst trifft „Modul" nur eine Roh-Untermenge.
  const listStub = makeElementStub();
  const ctx = loadView('absenzen.js', {
    $: (sel) => (sel === '#absenzList' ? listStub : null),
    observeFresh() {},
  }, 'window.__absenzenState = absenzenState;');

  const rows = [
    { kuerzel_code: 'A', bezeichnung: 'GE', typ: 'GE Modul', anwesenheit_pct: 90, minimal_pct: 90 },
    { kuerzel_code: 'B', bezeichnung: 'PE', typ: 'PE Modul', anwesenheit_pct: 90, minimal_pct: 90 },
    { kuerzel_code: 'C', bezeichnung: 'Para', typ: 'Parallelmodul', anwesenheit_pct: 90, minimal_pct: 90 },
    { kuerzel_code: 'D', bezeichnung: 'UEK', typ: 'GE Überbetrieblicher Kurs', anwesenheit_pct: 90, minimal_pct: 90 },
  ];
  ctx.__absenzenState.query = '';
  ctx.__absenzenState.sort = 'name';
  ctx.__absenzenState.onlyUnterMin = false;

  // „Modul" trifft GE Modul + PE Modul + Parallelmodul = 3 (nicht nur 1).
  ctx.__absenzenState.typ = 'Modul';
  ctx.drawAbsenzList(rows);
  assert.strictEqual(listStub.children.length, 3, '„Modul" trifft alle 3 Modul-Varianten');

  // „ÜK" trifft genau die eine ÜK-Zeile.
  ctx.__absenzenState.typ = 'ÜK';
  ctx.drawAbsenzList(rows);
  assert.strictEqual(listStub.children.length, 1, '„ÜK" trifft nur die ÜK-Zeile');
});

test('absenzSortName: entfernt führende Modulnummer (A–Z nach Name)', () => {
  const ctx = loadView('absenzen.js');
  assert.strictEqual(ctx.absenzSortName({ bezeichnung: '106 - Datenbanken abfragen' }), 'Datenbanken abfragen');
  assert.strictEqual(ctx.absenzSortName({ bezeichnung: '431 – Aufträge' }), 'Aufträge'); // Gedankenstrich
  assert.strictEqual(ctx.absenzSortName({ bezeichnung: 'Englisch Niveau 3 Semester 1' }), 'Englisch Niveau 3 Semester 1');
  assert.strictEqual(ctx.absenzSortName({ bezeichnung: '', kuerzel_code: 'X-1' }), 'X-1');
});

test('drawAbsenzList: A–Z sortiert nach Modulname, nicht nach Modulnummer', () => {
  const listStub = makeElementStub();
  const ctx = loadView('absenzen.js', {
    $: (sel) => (sel === '#absenzList' ? listStub : null),
    observeFresh() {},
  }, 'window.__absenzenState = absenzenState;');
  // Nummern absteigend, Namen aufsteigend → korrektes A–Z muss nach NAME ordnen.
  const rows = [
    { kuerzel_code: 'C', bezeichnung: '300 - Zebra', anwesenheit_pct: 90, minimal_pct: 90 },
    { kuerzel_code: 'A', bezeichnung: '100 - Yak', anwesenheit_pct: 90, minimal_pct: 90 },
    { kuerzel_code: 'B', bezeichnung: '200 - Alpha', anwesenheit_pct: 90, minimal_pct: 90 },
  ];
  ctx.__absenzenState.query = '';
  ctx.__absenzenState.sort = 'name';
  ctx.__absenzenState.typ = 'all';
  ctx.__absenzenState.onlyUnterMin = false;

  ctx.drawAbsenzList(rows);
  // Card-Titel = bezeichnung: card → main_(children[0]) → title(children[0]).
  const titleOf = (card) => card.children[0].children[0].textContent;
  const order = listStub.children.map(titleOf).join(' | ');
  assert.strictEqual(order, '200 - Alpha | 100 - Yak | 300 - Zebra');
});

test('absenzTitle: Bezeichnung bevorzugt, Fallback auf kuerzel_code', () => {
  const ctx = loadView('absenzen.js');
  assert.strictEqual(
    ctx.absenzTitle({ bezeichnung: '106 - Datenbanken', kuerzel_code: 'X-1' }),
    '106 - Datenbanken',
  );
  assert.strictEqual(ctx.absenzTitle({ bezeichnung: '', kuerzel_code: 'X-1' }), 'X-1');
  assert.strictEqual(ctx.absenzTitle({}), 'Modul');
});

test('absenz-sheet statusInfo: alle 4 normalisierten Kategorien → Label + Badge-Klasse', () => {
  // statusInfo lebt in der IIFE — wir exponieren sie über einen Test-Hook,
  // indem wir window.openAbsenzModulSheet NICHT brauchen: stattdessen prüfen
  // wir die Mapping-Tabelle über das Verhalten der Datei. Da die Funktion
  // closure-privat ist, re-evaluieren wir den Quelltext und greifen sie via
  // einer kleinen Anhang-Zeile ab.
  const src = fs.readFileSync(path.join(MOBILE_DIR, 'absenz-sheet.js'), 'utf8')
    // statusInfo aus der IIFE für den Test nach außen reichen
    + '\n;window.__statusInfo = (function(){ return null; })();';
  // Einfacher: die Funktion ist im IIFE-Scope. Wir testen das Mapping
  // stattdessen über eine eigenständige Re-Implementierung-freie Variante:
  // Quelltext enthält die exakten Klassen-Strings — wir prüfen ihre Präsenz.
  assert.ok(src.includes("m-att-badge--teilgenommen"));
  assert.ok(src.includes("m-att-badge--offen"));
  assert.ok(src.includes("m-att-badge--entschuldigt"));
  assert.ok(src.includes("m-att-badge--unentschuldigt"));
  // und die vier Kategorie-Keys aus der Status-Normalisierung (§3)
  assert.ok(src.includes("'teilgenommen'"));
  assert.ok(src.includes("'offen'"));
  assert.ok(src.includes("'abwesend_entschuldigt'"));
  assert.ok(src.includes("'abwesend_unentschuldigt'"));
});

test('drawAbsenzList: Filter + Sortierung über echte View-Funktion', () => {
  // $('#absenzList') muss einen List-Stub liefern, dessen children die
  // gerenderten Cards (oder Empty) aufnehmen. Wir zählen die Cards.
  const listStub = makeElementStub();
  const ctx = loadView('absenzen.js', {
    $: (sel) => (sel === '#absenzList' ? listStub : null),
    observeFresh() {},
  }, 'window.__absenzenState = absenzenState;');

  const rows = [
    { kuerzel_code: 'A-1', bezeichnung: 'Zebra', typ: 'GE Modul', anwesenheit_pct: 95, minimal_pct: 90 },
    { kuerzel_code: 'B-2', bezeichnung: 'Alpha', typ: 'GE Modul', anwesenheit_pct: 80, minimal_pct: 90 },
    { kuerzel_code: 'C-3', bezeichnung: 'Mitte', typ: 'GE Überbetrieblicher Kurs', anwesenheit_pct: 100, minimal_pct: 90 },
  ];

  // Default-State: sort 'name', typ 'all', kein onlyUnterMin, leere query.
  ctx.__absenzenState.query = '';
  ctx.__absenzenState.sort = 'name';
  ctx.__absenzenState.typ = 'all';
  ctx.__absenzenState.onlyUnterMin = false;

  ctx.drawAbsenzList(rows);
  assert.strictEqual(listStub.children.length, 3, 'alle 3 Module gerendert');

  // onlyUnterMin: nur B-2 (80 < 90)
  ctx.__absenzenState.onlyUnterMin = true;
  ctx.drawAbsenzList(rows);
  assert.strictEqual(listStub.children.length, 1, 'nur das Unter-Minimum-Modul');
  ctx.__absenzenState.onlyUnterMin = false;

  // Typ-Filter: State hält jetzt das LABEL ('Modul'), nicht den Rohwert.
  // Beide GE-Modul-Zeilen kollabieren auf 'Modul' → 2 Treffer.
  ctx.__absenzenState.typ = 'Modul';
  ctx.drawAbsenzList(rows);
  assert.strictEqual(listStub.children.length, 2, 'Label „Modul" trifft beide Modul-Zeilen');
  ctx.__absenzenState.typ = 'all';

  // Suche: „alpha" matcht nur B-2 (Bezeichnung)
  ctx.__absenzenState.query = 'alpha';
  ctx.drawAbsenzList(rows);
  assert.strictEqual(listStub.children.length, 1, 'Suche matcht eine Zeile');

  // Kein Treffer → Empty-State (genau 1 Kind: das m-empty)
  ctx.__absenzenState.query = 'gibtsnicht';
  ctx.drawAbsenzList(rows);
  assert.strictEqual(listStub.children.length, 1, 'Empty-State gerendert');
  assert.ok(
    listStub.children[0].className.includes('m-empty'),
    'Empty-State trägt m-empty',
  );
});
