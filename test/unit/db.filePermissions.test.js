'use strict';

// Regression: data/wissen.db wurde mit SQLite-Defaultrechten angelegt
// (0666 & ~umask = 0644 bei umask 022) und war damit fuer jeden lokalen
// Account lesbar. In der Datei stehen der komplette Noten-/Absenzen-/
// Stundenplan-Bestand sowie die Web-Push-Krypto-Paare
// (push_subscriptions.p256dh / .auth). Alle anderen Secrets in data/
// (.master-key, .api-token, vapid.json, settings.json) bekommen explizit
// 0600 — die DB war die Ausnahme.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const schema = require('../../src/db/schema');

// chmod-Modes gibt es nur auf POSIX. Auf Windows ist der Fix ein No-op
// (bewusst in try/catch), der Test hat dort keine Aussagekraft.
const isPosix = process.platform !== 'win32';

let tmpDir;
let prevCwd;

before(() => {
  prevCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wissen-dbperm-'));
  // open() leitet data/ aus process.cwd() ab
  process.chdir(tmpDir);
});

after(() => {
  process.chdir(prevCwd);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
});

test('neu angelegte DB ist nicht world-/group-readable', { skip: !isPosix }, () => {
  const dbPath = path.join(tmpDir, 'data', 'perm-test.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = schema.open(dbPath);
  try {
    const mode = fs.statSync(dbPath).mode & 0o777;
    assert.strictEqual(
      mode & 0o077, 0,
      `DB darf keine Rechte fuer group/other haben, war: 0${mode.toString(8)}`
    );
  } finally {
    db.close();
  }
});

test('bestehende zu offene DB wird beim naechsten open() nachgezogen', { skip: !isPosix }, () => {
  const dbPath = path.join(tmpDir, 'data', 'migrate-test.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  // Zustand einer Installation von vor dem Fix nachstellen
  schema.open(dbPath).close();
  fs.chmodSync(dbPath, 0o644);
  assert.strictEqual(fs.statSync(dbPath).mode & 0o077, 0o044, 'Setup: DB ist world-readable');

  // Neustart des Servers
  const db = schema.open(dbPath);
  try {
    const mode = fs.statSync(dbPath).mode & 0o777;
    assert.strictEqual(
      mode & 0o077, 0,
      `bestehende DB muss beim Start gehaertet werden, war: 0${mode.toString(8)}`
    );
  } finally {
    db.close();
  }
});

test('WAL-Sidecars sind ebenfalls geschuetzt', { skip: !isPosix }, () => {
  const dbPath = path.join(tmpDir, 'data', 'wal-test.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = schema.open(dbPath);
  try {
    // -wal existiert im WAL-Mode, solange eine Verbindung offen ist
    const walPath = dbPath + '-wal';
    if (fs.existsSync(walPath)) {
      const mode = fs.statSync(walPath).mode & 0o777;
      assert.strictEqual(
        mode & 0o077, 0,
        `-wal enthaelt ungeschriebene Seiten und muss ebenso eng sein, war: 0${mode.toString(8)}`
      );
    }
  } finally {
    db.close();
  }
});
