'use strict';

/**
 * Unit-Tests für push.notifyNeueAbsenzen (src/push.js — Agent C, Absenzen-Push).
 *
 * Verifiziert den §4.4-Vertrag:
 *   - ≤3 Module → ein Detail-Push pro Modul, Body text-differenziert nach
 *     Kategorie (unentschuldigt / entschuldigt / Status geändert).
 *   - >3 Module → ein Summary-Push.
 *   - url = '/mobile/#/absenzen?code='+encode, tag = 'absenz-'+code.
 *   - Leerer Report / 0 Lektionen → kein Push (resolve null).
 *
 * Strategie wie push.test.js: web-push via require.cache stubben, DB-Singleton
 * fälschen, sentPayloads pro Test einsammeln.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const WEB_PUSH_PATH = require.resolve('web-push');
const SRC_DIR = path.resolve(__dirname, '..', '..', 'src') + path.sep;

function freshTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wissen-absenz-push-test-'));
  process.chdir(dir);
  return dir;
}

function clearTocco() {
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(SRC_DIR)) delete require.cache[k];
  }
  if (require.cache[WEB_PUSH_PATH]) delete require.cache[WEB_PUSH_PATH];
}

function installWebPushStub(sendNotificationImpl) {
  const stub = {
    generateVAPIDKeys: () => ({
      publicKey: 'B' + 'A'.repeat(86),
      privateKey: 'A'.repeat(43)
    }),
    setVapidDetails: () => {},
    sendNotification: sendNotificationImpl
  };
  require.cache[WEB_PUSH_PATH] = {
    id: WEB_PUSH_PATH,
    filename: WEB_PUSH_PATH,
    loaded: true,
    exports: stub
  };
  return stub;
}

// Minimal-Fake-DB: notifyNeueAbsenzen → sendToAll braucht nur die
// push_subscriptions-SELECT-Pfade. UPDATE last_seen wird best-effort getriggert.
function makeFakeDb(subs) {
  const handle = {
    prepare(sql) {
      if (/SELECT .* FROM push_subscriptions WHERE endpoint = \?/.test(sql)) {
        return { get: (ep) => subs.find(s => s.endpoint === ep) || undefined };
      }
      if (/SELECT .* FROM push_subscriptions$/.test(sql)) {
        return { all: () => subs.slice() };
      }
      if (/SELECT COUNT/.test(sql)) {
        return { get: () => ({ c: subs.length }) };
      }
      if (/UPDATE push_subscriptions SET last_seen/.test(sql)) {
        return { run: () => ({ changes: 1 }) };
      }
      if (/DELETE FROM push_subscriptions/.test(sql)) {
        return { run: () => ({ changes: 0 }) };
      }
      return { run: () => ({ changes: 0 }), get: () => undefined, all: () => [] };
    }
  };
  return { handle };
}

function loadPush(sentPayloads, subs) {
  clearTocco();
  installWebPushStub(async (subscription, payload) => {
    sentPayloads.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) });
    return { statusCode: 201 };
  });
  const push = require('../../src/push');
  const db = require('../../src/db');
  const fake = makeFakeDb(subs);
  db.getInstance = () => fake.handle;
  return push;
}

function makeSub(suffix) {
  return {
    endpoint: 'https://fcm.googleapis.com/fcm/send/' + suffix,
    p256dh: 'p' + suffix,
    auth: 'a' + suffix
  };
}

test('notifyNeueAbsenzen: leerer Report → kein Push (resolve null)', async () => {
  freshTmp();
  const sent = [];
  const push = loadPush(sent, [makeSub('empty')]);
  const r = await push.notifyNeueAbsenzen([], null);
  assert.strictEqual(r, null);
  assert.strictEqual(sent.length, 0);
});

test('notifyNeueAbsenzen: Modul mit 0 Lektionen → kein Push', async () => {
  freshTmp();
  const sent = [];
  const push = loadPush(sent, [makeSub('zero')]);
  const r = await push.notifyNeueAbsenzen([{ kuerzel_code: 'X-1', bezeichnung: 'Foo', lektionen: [] }], null);
  assert.strictEqual(r, null);
  assert.strictEqual(sent.length, 0);
});

test('notifyNeueAbsenzen: 1 Modul unentschuldigt → per-item, korrekter Body/url/tag', async () => {
  freshTmp();
  const sent = [];
  const push = loadPush(sent, [makeSub('unent')]);
  const code = 'UIFZ-2524-020-S1-UEK-106';
  await push.notifyNeueAbsenzen([{
    kuerzel_code: code,
    bezeichnung: '106 - Datenbanken abfragen',
    lektionen: [{
      termin_iso: '2025-10-13', termin_raw: 'Montag, 13. Oktober 2025, 08:30 - 12:00',
      zeit_von: '08:30', zeit_bis: '12:00', status_cat: 'abwesend_unentschuldigt'
    }]
  }], null);
  assert.strictEqual(sent.length, 1, 'genau ein Push für ein Modul');
  const p = sent[0].payload;
  assert.match(p.title, /106 - Datenbanken abfragen/);
  assert.match(p.body, /UNENTSCHULDIGT abwesend/);
  assert.strictEqual(p.url, '/mobile/#/absenzen?code=' + encodeURIComponent(code));
  assert.strictEqual(p.tag, 'absenz-' + code);
});

test('notifyNeueAbsenzen: entschuldigt vs unentschuldigt vs Status geändert differenziert', async () => {
  freshTmp();
  const sent = [];
  const push = loadPush(sent, [makeSub('diff')]);
  await push.notifyNeueAbsenzen([{
    kuerzel_code: 'M-1',
    bezeichnung: 'Modul Eins',
    lektionen: [
      { termin_iso: '2025-10-01', termin_raw: 'Mi 1', status_cat: 'abwesend_entschuldigt' },
      { termin_iso: '2025-10-02', termin_raw: 'Do 2', status_cat: 'abwesend_unentschuldigt' },
      { termin_iso: '2025-10-03', termin_raw: 'Fr 3', status_cat: 'abwesend_unentschuldigt', statusChanged: true }
    ]
  }], null);
  assert.strictEqual(sent.length, 1);
  const body = sent[0].payload.body;
  assert.match(body, /abwesend \(entschuldigt\)/, 'entschuldigt-Phrase');
  assert.match(body, /UNENTSCHULDIGT abwesend/, 'unentschuldigt-Phrase');
  assert.match(body, /Status geändert/, 'Status-Wechsel-Phrase');
});

test('notifyNeueAbsenzen: >3 Module → Summary-Push', async () => {
  freshTmp();
  const sent = [];
  const push = loadPush(sent, [makeSub('summary')]);
  const report = ['A', 'B', 'C', 'D'].map((c) => ({
    kuerzel_code: c,
    bezeichnung: 'Modul ' + c,
    lektionen: [{ termin_iso: '2025-10-0' + c.length, termin_raw: c, status_cat: 'abwesend_unentschuldigt' }]
  }));
  await push.notifyNeueAbsenzen(report, null);
  assert.strictEqual(sent.length, 1, '>3 Module → genau EIN Summary-Push (nicht per-item)');
  const p = sent[0].payload;
  assert.strictEqual(p.tag, 'absenz-summary');
  assert.strictEqual(p.url, '/mobile/#/absenzen');
  assert.match(p.body, /4 Nicht-Teilnahmen in 4 Modulen/);
});

test('notifyNeueAbsenzen: 3 Module → per-item (genau 3 Pushes)', async () => {
  freshTmp();
  const sent = [];
  const push = loadPush(sent, [makeSub('three')]);
  const report = ['A', 'B', 'C'].map((c) => ({
    kuerzel_code: c,
    bezeichnung: 'Modul ' + c,
    lektionen: [{ termin_iso: '2025-10-01', termin_raw: c, status_cat: 'abwesend_entschuldigt' }]
  }));
  await push.notifyNeueAbsenzen(report, null);
  assert.strictEqual(sent.length, 3, '3 Module → per-item-Schwelle (≤3)');
  const tags = sent.map(s => s.payload.tag).sort();
  assert.deepStrictEqual(tags, ['absenz-A', 'absenz-B', 'absenz-C']);
});

test('notifyNeueAbsenzen: Body wird auf <=120 Zeichen gekappt', async () => {
  freshTmp();
  const sent = [];
  const push = loadPush(sent, [makeSub('cap')]);
  const manyLektionen = [];
  for (let i = 0; i < 20; i += 1) {
    manyLektionen.push({
      termin_iso: '2025-10-' + String(i + 1).padStart(2, '0'),
      termin_raw: 'Sehr langer Termin-String Nummer ' + i + ' mit viel Text',
      status_cat: 'abwesend_unentschuldigt'
    });
  }
  await push.notifyNeueAbsenzen([{ kuerzel_code: 'LONG', bezeichnung: 'X', lektionen: manyLektionen }], null);
  assert.strictEqual(sent.length, 1);
  assert.ok(sent[0].payload.body.length <= 120, 'Body muss <=120 Zeichen sein');
});
