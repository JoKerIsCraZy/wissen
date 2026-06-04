'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

function setup() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tocco-dbreset-'));
  process.chdir(tmpDir);
  for (const k of Object.keys(require.cache)) {
    if (k.includes('wissen') && k.includes('src')) delete require.cache[k];
  }
  const db = require('../../src/db');
  const d = db.openOnce();
  return { db, d };
}

function count(d, table) {
  return d.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
}

test('resetDb leert alle gescrapten Tabellen', () => {
  const { db, d } = setup();
  d.exec(`INSERT INTO noten (kuerzel_id, fach_name, note) VALUES ('M1','x',5.0)`);
  db.savePruefungen(d, 'M1', [{ bezeichnung: 'LB 1', pruefung_nr: 1, gewicht: '25%', bewertung: 4.5 }]);
  d.exec(`INSERT INTO noten_history (kuerzel_id, fach_name, note) VALUES ('M1','x',5.0)`);
  d.exec(`INSERT INTO stundenplan (datum_iso, veranstaltung, klasse) VALUES ('2025-10-01','V','K')`);
  d.exec(`INSERT INTO absenzen (kuerzel_code) VALUES ('CODE1')`);
  d.exec(`INSERT INTO absenzen_termine (kuerzel_code, termin_iso, zeit_von) VALUES ('CODE1','2025-10-01','08:30')`);

  const { deleted, total } = db.resetDb(d);

  for (const t of ['noten', 'noten_history', 'noten_pruefungen', 'pruefungen_history', 'stundenplan', 'absenzen', 'absenzen_termine']) {
    assert.strictEqual(count(d, t), 0, `${t} muss leer sein`);
  }
  assert.ok(total >= 6, `total=${total} (>=6 erwartet)`);
  assert.strictEqual(typeof deleted.noten, 'number');
  db.closeInstance();
});

test('resetDb behält push_subscriptions (Geräte-Anmeldungen)', () => {
  const { db, d } = setup();
  d.exec(`INSERT INTO noten (kuerzel_id, fach_name, note) VALUES ('M1','x',5.0)`);
  d.exec(`INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES ('https://fcm.example/x','p256','authkey')`);

  db.resetDb(d);

  assert.strictEqual(count(d, 'noten'), 0, 'Noten geleert');
  assert.strictEqual(count(d, 'push_subscriptions'), 1, 'Push-Abos bleiben erhalten');
  db.closeInstance();
});

test('resetDb auf leerer DB → total 0, kein Fehler', () => {
  const { db, d } = setup();
  const { total } = db.resetDb(d);
  assert.strictEqual(total, 0);
  db.closeInstance();
});
