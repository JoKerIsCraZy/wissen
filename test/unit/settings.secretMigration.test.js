'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// Regression-Guard für die Lazy-Migration von Klartext-Secrets in
// settings.json. Relevant seit msEmail zu SECRET_FIELDS dazukam: bestehende
// Installationen haben den Wert im Klartext auf Platte. Geht die Migration
// schief, kommt der Scraper nicht mehr ins Portal — also hier festnageln.
//
// Jeder Test bekommt ein frisches tmpdir via process.chdir und re-required
// settings + secretCrypto, damit weder Settings-Cache noch der gecachte
// Master-Key zwischen Tests leaken.
function setupTmp(diskState) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wissen-secret-migration-'));
  fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
  if (diskState) {
    fs.writeFileSync(
      path.join(tmpDir, 'data', 'settings.json'),
      JSON.stringify(diskState, null, 2)
    );
  }
  process.chdir(tmpDir);
  // Env-Quellen ausschalten: sonst gewinnt env über settings.json und der
  // Master-Key käme nicht aus dem Legacy-Pfad.
  delete process.env.MASTER_KEY;
  delete process.env.MASTER_KEY_FILE;
  for (const k of ['MS_EMAIL', 'MS_PASSWORD', 'TELEGRAM_TOKEN', 'USER_PK']) {
    delete process.env[k];
  }
  delete require.cache[require.resolve('../../src/settings')];
  delete require.cache[require.resolve('../../src/secretCrypto')];
  return { settings: require('../../src/settings'), tmpDir };
}

function readDisk(tmpDir) {
  return JSON.parse(fs.readFileSync(path.join(tmpDir, 'data', 'settings.json'), 'utf8'));
}

const isEnc = (v) => typeof v === 'string' && v.startsWith('enc:v1:');

const LEGACY = Object.freeze({
  msEmail: 'schueler@wiss.example.ch',
  msPassword: 'sup3r-s3cret',
  telegramToken: '123456:AAH-legacy-token',
  userPk: '98765',
  intervalMinutes: 45
});

test('legacy plaintext settings.json stays readable (no decrypt attempt)', () => {
  const { settings } = setupTmp(LEGACY);
  const loaded = settings.load();
  assert.strictEqual(loaded.msEmail, LEGACY.msEmail);
  assert.strictEqual(loaded.msPassword, LEGACY.msPassword);
  assert.strictEqual(loaded.telegramToken, LEGACY.telegramToken);
  assert.strictEqual(loaded.intervalMinutes, 45);
});

test('save() lazily encrypts plaintext secrets on disk', () => {
  const { settings, tmpDir } = setupTmp(LEGACY);
  settings.load();
  settings.save({ intervalMinutes: 30 });

  const onDisk = readDisk(tmpDir);
  assert.ok(isEnc(onDisk.msEmail), 'msEmail must be encrypted at rest');
  assert.ok(isEnc(onDisk.msPassword), 'msPassword must be encrypted at rest');
  assert.ok(isEnc(onDisk.telegramToken), 'telegramToken must be encrypted at rest');

  // userPk ist eine Tocco-Datensatz-ID, kein Geheimnis → bleibt Klartext.
  assert.strictEqual(onDisk.userPk, '98765');

  // Kein Secret darf als Klartext-Substring in der Datei überleben.
  const raw = JSON.stringify(onDisk);
  assert.ok(!raw.includes(LEGACY.msEmail), 'msEmail plaintext must not remain');
  assert.ok(!raw.includes(LEGACY.msPassword), 'msPassword plaintext must not remain');
  assert.ok(!raw.includes(LEGACY.telegramToken), 'telegramToken plaintext must not remain');
});

test('migrated secrets round-trip back to the original values', () => {
  const { settings, tmpDir } = setupTmp(LEGACY);
  settings.load();
  settings.save({ intervalMinutes: 30 });

  // Frischen Modul-Zustand erzwingen — liest die migrierte Datei neu ein.
  delete require.cache[require.resolve('../../src/settings')];
  delete require.cache[require.resolve('../../src/secretCrypto')];
  const reloaded = require('../../src/settings').load();

  assert.strictEqual(reloaded.msEmail, LEGACY.msEmail);
  assert.strictEqual(reloaded.msPassword, LEGACY.msPassword);
  assert.strictEqual(reloaded.telegramToken, LEGACY.telegramToken);
  assert.strictEqual(reloaded.userPk, LEGACY.userPk);
  assert.strictEqual(reloaded.intervalMinutes, 30);

  // Gegenprobe, dass die Werte wirklich verschlüsselt lagen und nicht etwa
  // still als Klartext durchgereicht wurden.
  assert.ok(isEnc(readDisk(tmpDir).msEmail));
});
