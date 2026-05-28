'use strict';

// Tests für die at-rest-Verschlüsselung des Browser-Storage-State
// (storage.json). Die enthaltenen MS-SSO-Session-Cookies sind replaybar →
// serializeStorageState/readStorageState verschlüsseln sie via injiziertem
// storageCrypto. Siehe src/scraper.js + claude_docs/security.md.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { serializeStorageState, readStorageState } = require('../../src/scraper');

// Lädt secretCrypto frisch in einem tmp-cwd, damit der Master-Key dort
// (data/.master-key) erzeugt wird und Tests sich nicht beeinflussen.
function freshCrypto() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wissen-storage-'));
  process.chdir(tmpDir);
  delete require.cache[require.resolve('../../src/secretCrypto')];
  return require('../../src/secretCrypto');
}

function tmpFile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wissen-sf-')), name || 'storage.json');
}

const SAMPLE_STATE = {
  cookies: [{ name: 'ESTSAUTH', value: 'super-secret-session', domain: 'login.microsoftonline.com', path: '/' }],
  origins: [{ origin: 'https://wiss.tocco.ch', localStorage: [{ name: 'k', value: 'v' }] }]
};

test('serializeStorageState ohne Crypto → reines JSON', () => {
  const out = serializeStorageState(SAMPLE_STATE, null);
  assert.strictEqual(out, JSON.stringify(SAMPLE_STATE));
});

test('serializeStorageState mit Crypto → verschlüsselter Blob (kein Klartext)', () => {
  const c = freshCrypto();
  const out = serializeStorageState(SAMPLE_STATE, c);
  assert.ok(c.isEncrypted(out), 'Output muss enc:-Prefix tragen');
  assert.ok(!out.includes('super-secret-session'), 'Session-Cookie darf nicht im Klartext stehen');
});

test('round-trip: serialize (encrypt) → Datei → readStorageState (decrypt)', () => {
  const c = freshCrypto();
  const file = tmpFile();
  fs.writeFileSync(file, serializeStorageState(SAMPLE_STATE, c), 'utf8');

  const loaded = readStorageState(file, c, () => {});
  assert.deepStrictEqual(loaded, SAMPLE_STATE);
});

test('readStorageState ohne Crypto → gibt den Dateipfad zurück (Legacy/Tests)', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify(SAMPLE_STATE), 'utf8');
  assert.strictEqual(readStorageState(file, null, () => {}), file);
});

test('Lazy-Migration: Klartext-storage.json wird gelesen (decrypt reicht durch)', () => {
  const c = freshCrypto();
  const file = tmpFile();
  // Alt-Datei aus Pre-Encryption-Zeit: reines JSON ohne enc:-Prefix.
  fs.writeFileSync(file, JSON.stringify(SAMPLE_STATE), 'utf8');

  const loaded = readStorageState(file, c, () => {});
  assert.deepStrictEqual(loaded, SAMPLE_STATE, 'Plaintext muss weiterhin ladbar sein');
});

test('korrupter/getamperter Blob → null + Warn-Log (statt Crash)', () => {
  const c = freshCrypto();
  const file = tmpFile();
  const blob = serializeStorageState(SAMPLE_STATE, c);
  // Ein Byte im Ciphertext-Segment kippen → Auth-Tag schlägt fehl.
  const parts = blob.slice(c.PREFIX.length).split(':');
  const cipherBuf = Buffer.from(parts[1], 'base64');
  cipherBuf[0] = cipherBuf[0] ^ 0x01;
  const tampered = c.PREFIX + parts[0] + ':' + cipherBuf.toString('base64') + ':' + parts[2];
  fs.writeFileSync(file, tampered, 'utf8');

  let warned = false;
  const loaded = readStorageState(file, c, (_msg, level) => { if (level === 'warn') warned = true; });
  assert.strictEqual(loaded, null, 'korrupte Datei → null → Caller macht frischen Login');
  assert.ok(warned, 'Warn-Log muss gefeuert werden');
});

test('ungültiges JSON (ohne enc:-Prefix) mit Crypto → null', () => {
  const c = freshCrypto();
  const file = tmpFile();
  fs.writeFileSync(file, '{ kaputt ::: kein json', 'utf8');
  const loaded = readStorageState(file, c, () => {});
  assert.strictEqual(loaded, null);
});

test('fehlende Datei → null (kein Throw)', () => {
  const c = freshCrypto();
  const loaded = readStorageState(path.join(os.tmpdir(), 'gibt-es-nicht-12345.json'), c, () => {});
  assert.strictEqual(loaded, null);
});
