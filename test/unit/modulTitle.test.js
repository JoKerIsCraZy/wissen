'use strict';

// Tests für die Mobile-Shell-Helfer modulNummerOf + buildTitle.
//
// web/mobile/mobile.js ist ein Browser-Global-Script (kein module.exports) und
// führt beim Laden Shell-Init aus (Router, EventSource, …). Wir laden den ECHTEN
// Quelltext via node:vm in eine Sandbox: die Funktions-Deklarationen sind
// gehoistet und liegen VOR dem ersten Top-Level-Statement im Context — der
// Shell-Init darf also scheitern, die reinen Helfer bleiben abgreifbar. So
// testet die Datei den tatsächlich ausgelieferten Code (kein Logik-Duplikat).
//
// Lauf: node --test test/unit/modulTitle.test.js
//   (wird auch vom npm-test-Glob test/unit/*.test.js erfasst)

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadShellFns() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'web', 'mobile', 'mobile.js'), 'utf8'
  );
  const noop = () => {};
  const elStub = new Proxy({}, { get: () => noop });
  const sandbox = {
    document: {
      addEventListener: noop, querySelector: () => null,
      querySelectorAll: () => [], getElementById: () => null,
      createElement: () => elStub, body: elStub
    },
    window: {
      addEventListener: noop, location: { hash: '', href: '' },
      matchMedia: () => ({ matches: false, addEventListener: noop })
    },
    navigator: { serviceWorker: { register: () => Promise.resolve(), addEventListener: noop } },
    location: { hash: '', href: '' },
    console, setTimeout: noop, setInterval: noop,
    clearTimeout: noop, clearInterval: noop,
    fetch: () => Promise.resolve(),
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    EventSource: function () { return { addEventListener: noop, close: noop }; }
  };
  vm.createContext(sandbox);
  // Shell-Init darf werfen — gehoistete function-Deklarationen stehen vorher
  // bereits als Properties im Context.
  try { vm.runInContext(src, sandbox, { filename: 'mobile.js' }); } catch (_) { /* erwartet */ }
  return sandbox;
}

const shell = loadShellFns();

test('Sanity: Helfer wurden aus mobile.js geladen', () => {
  assert.strictEqual(typeof shell.modulNummerOf, 'function');
  assert.strictEqual(typeof shell.buildTitle, 'function');
});

test('modulNummerOf: numerische Modulnummer bleibt unverändert', () => {
  assert.strictEqual(shell.modulNummerOf('UIFZ-2524-020-S1-254'), '254');
});

test('modulNummerOf: Niveau-Code (kein Semester-Suffix in der Nr)', () => {
  assert.strictEqual(shell.modulNummerOf('UIFZ-2524-020-S1-ENG-N3'), 'ENG-N3');
  assert.strictEqual(shell.modulNummerOf('UIFZ-2524-020-S2-MAT'), 'MAT');
});

test('buildTitle: numerisches Modul OHNE Semester-Suffix', () => {
  assert.strictEqual(
    shell.buildTitle('UIFZ-2524-020-S1-254', 'Geschäftsprozesse beschreiben'),
    '254 — Geschäftsprozesse beschreiben'
  );
});

test('buildTitle: gleiches Niveau über zwei Semester ist unterscheidbar', () => {
  const s1 = shell.buildTitle('UIFZ-2524-020-S1-ENG-N3', 'Englisch Niveau 3');
  const s2 = shell.buildTitle('UIFZ-2524-020-S2-ENG-N3', 'Englisch Niveau 3');
  assert.notStrictEqual(s1, s2, 'S1- und S2-Titel müssen sich unterscheiden');
  assert.match(s1, /S1$/);
  assert.match(s2, /S2$/);
});

test('buildTitle: Mathematik (Buchstaben-Code) bekommt Semester-Suffix', () => {
  assert.strictEqual(
    shell.buildTitle('UIFZ-2524-020-S2-MAT', 'Mathematik'),
    'MAT — Mathematik · S2'
  );
});

test('buildTitle: Fallback auf fach_name wenn kein Code', () => {
  assert.strictEqual(shell.buildTitle('', 'Irgendwas'), 'Irgendwas');
  assert.strictEqual(shell.buildTitle(null, null), 'Modul');
});
