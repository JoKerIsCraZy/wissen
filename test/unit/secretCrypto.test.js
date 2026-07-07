'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function setupTmp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wissen-crypto-'));
  process.chdir(tmpDir);
  delete require.cache[require.resolve('../../src/secretCrypto')];
  return require('../../src/secretCrypto');
}

test('encrypt + decrypt round-trip recovers plaintext', () => {
  const c = setupTmp();
  const ct = c.encrypt('hunter2');
  assert.ok(c.isEncrypted(ct), 'encrypt output must be tagged');
  assert.strictEqual(c.decrypt(ct), 'hunter2');
});

test('encrypt is non-deterministic (different IV per call)', () => {
  const c = setupTmp();
  const a = c.encrypt('same-input');
  const b = c.encrypt('same-input');
  assert.notStrictEqual(a, b, 'IV is random per call → ciphertexts must differ');
  assert.strictEqual(c.decrypt(a), 'same-input');
  assert.strictEqual(c.decrypt(b), 'same-input');
});

test('decrypt of plaintext returns plaintext (legacy compat)', () => {
  const c = setupTmp();
  assert.strictEqual(c.decrypt('plaintext-secret'), 'plaintext-secret');
  assert.strictEqual(c.decrypt(''), '');
  assert.strictEqual(c.decrypt(null), null);
});

test('encrypt is idempotent on already-encrypted blobs', () => {
  const c = setupTmp();
  const ct = c.encrypt('xyz');
  const ctAgain = c.encrypt(ct);
  assert.strictEqual(ct, ctAgain, 'double-encrypt must not re-wrap');
});

test('encrypt no-ops empty string and non-strings', () => {
  const c = setupTmp();
  assert.strictEqual(c.encrypt(''), '');
  assert.strictEqual(c.encrypt(null), null);
  assert.strictEqual(c.encrypt(undefined), undefined);
  assert.strictEqual(c.encrypt(42), 42);
});

test('tampered ciphertext fails auth tag check', () => {
  const c = setupTmp();
  const ct = c.encrypt('secret');
  // Flip a byte in the ciphertext portion (middle base64 segment)
  const parts = ct.slice(c.PREFIX.length).split(':');
  // Decode, flip bit, re-encode
  const cipherBuf = Buffer.from(parts[1], 'base64');
  cipherBuf[0] = cipherBuf[0] ^ 0x01;
  const tampered = c.PREFIX + parts[0] + ':' + cipherBuf.toString('base64') + ':' + parts[2];
  assert.throws(() => c.decrypt(tampered), /unable|auth/i);
});

test('invalid blob format throws descriptively', () => {
  const c = setupTmp();
  assert.throws(() => c.decrypt('enc:v1:onlyonepart'), /invalid blob format/);
  assert.throws(() => c.decrypt('enc:v1:a:b'), /invalid blob format/);
});

test('encryptSettings only touches SECRET_FIELDS', () => {
  const c = setupTmp();
  const input = {
    msEmail: 'user@example.com',
    msPassword: 'p4ssw0rd',
    telegramToken: 'bot-token-here',
    intervalMinutes: 60,
    autoRun: true,
    scheduleDays: [1, 2, 3]
  };
  const out = c.encryptSettings(input);
  assert.strictEqual(out.msEmail, 'user@example.com', 'non-secret untouched');
  assert.strictEqual(out.intervalMinutes, 60);
  assert.strictEqual(out.autoRun, true);
  assert.deepStrictEqual(out.scheduleDays, [1, 2, 3]);
  assert.ok(c.isEncrypted(out.msPassword), 'secret field encrypted');
  assert.ok(c.isEncrypted(out.telegramToken));
});

test('decryptSettings is tolerant of mixed plaintext + encrypted', () => {
  const c = setupTmp();
  // Simulate a partial-migration state: msPassword still plaintext (legacy),
  // telegramToken already encrypted.
  const partiallyEncrypted = {
    msPassword: 'legacy-plaintext',
    telegramToken: c.encrypt('new-encrypted-token'),
    msEmail: 'unaffected@example.com'
  };
  const out = c.decryptSettings(partiallyEncrypted);
  assert.strictEqual(out.msPassword, 'legacy-plaintext');
  assert.strictEqual(out.telegramToken, 'new-encrypted-token');
  assert.strictEqual(out.msEmail, 'unaffected@example.com');
});

test('master key persisted to disk with mode 0600 (where supported)', () => {
  const c = setupTmp();
  c.encrypt('triggers-key-gen');
  const stat = fs.statSync(c.KEY_FILE);
  // Mode bits 0o777 — Windows reports ~0o666, Linux respects 0o600
  const mode = stat.mode & 0o777;
  if (process.platform !== 'win32') {
    assert.strictEqual(mode, 0o600, 'master-key must be 0600 on POSIX');
  }
  assert.strictEqual(stat.size, 32, 'master-key must be 32 bytes');
});

test('subsequent calls reuse the same master key', () => {
  const c = setupTmp();
  const ct = c.encrypt('persist-test');
  // Drop module cache to force re-load from disk
  delete require.cache[require.resolve('../../src/secretCrypto')];
  const c2 = require('../../src/secretCrypto');
  assert.strictEqual(c2.decrypt(ct), 'persist-test',
    'reload must read the existing master-key, not regenerate');
});

// =============================================================
// Master-Key aus env-Quellen (MASTER_KEY / MASTER_KEY_FILE)
// =============================================================

// Setzt env-Vars, führt fn aus und räumt IMMER auf (auch bei Throw), damit
// kein Leak in nachfolgende Tests passiert.
function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('MASTER_KEY env (hex) is used and no data/.master-key is written', () => {
  const keyHex = 'a'.repeat(64); // 32 bytes as 64 hex chars
  withEnv({ MASTER_KEY: keyHex, MASTER_KEY_FILE: undefined }, () => {
    const c = setupTmp();
    const ct = c.encrypt('via-env');
    assert.strictEqual(c.decrypt(ct), 'via-env');
    assert.strictEqual(fs.existsSync(c.KEY_FILE), false,
      'env key must NOT trigger the legacy data/.master-key generate path');
  });
});

test('MASTER_KEY env (base64) round-trips', () => {
  const keyB64 = Buffer.alloc(32, 7).toString('base64');
  withEnv({ MASTER_KEY: keyB64, MASTER_KEY_FILE: undefined }, () => {
    const c = setupTmp();
    const ct = c.encrypt('b64-key');
    assert.strictEqual(c.decrypt(ct), 'b64-key');
  });
});

test('MASTER_KEY env with wrong length throws loudly (no silent regen)', () => {
  withEnv({ MASTER_KEY: 'deadbeef', MASTER_KEY_FILE: undefined }, () => {
    const c = setupTmp();
    assert.throws(() => c.encrypt('x'), /MASTER_KEY.*Key-Material|32 Bytes/i);
    assert.strictEqual(fs.existsSync(c.KEY_FILE), false,
      'invalid env key must not fall through to generating a fresh legacy key');
  });
});

test('MASTER_KEY_FILE (hex text file) is used', () => {
  const c0 = setupTmp(); // establishes a tmp cwd
  const keyPath = path.join(process.cwd(), 'ext-key.hex');
  fs.writeFileSync(keyPath, 'b'.repeat(64));
  withEnv({ MASTER_KEY: undefined, MASTER_KEY_FILE: keyPath }, () => {
    delete require.cache[require.resolve('../../src/secretCrypto')];
    const c = require('../../src/secretCrypto');
    const ct = c.encrypt('via-file');
    assert.strictEqual(c.decrypt(ct), 'via-file');
    assert.strictEqual(fs.existsSync(c.KEY_FILE), false);
  });
  void c0;
});

test('MASTER_KEY_FILE (raw 32-byte binary) is used directly', () => {
  const c0 = setupTmp();
  const keyPath = path.join(process.cwd(), 'ext-key.bin');
  fs.writeFileSync(keyPath, Buffer.alloc(32, 0x11));
  withEnv({ MASTER_KEY: undefined, MASTER_KEY_FILE: keyPath }, () => {
    delete require.cache[require.resolve('../../src/secretCrypto')];
    const c = require('../../src/secretCrypto');
    const ct = c.encrypt('raw-bin');
    assert.strictEqual(c.decrypt(ct), 'raw-bin');
  });
  void c0;
});

test('MASTER_KEY_FILE pointing at a missing file throws loudly', () => {
  const c0 = setupTmp();
  const missing = path.join(process.cwd(), 'does-not-exist.key');
  withEnv({ MASTER_KEY: undefined, MASTER_KEY_FILE: missing }, () => {
    delete require.cache[require.resolve('../../src/secretCrypto')];
    const c = require('../../src/secretCrypto');
    assert.throws(() => c.encrypt('x'), /MASTER_KEY_FILE.*nicht lesbar/i);
  });
  void c0;
});

test('MASTER_KEY takes precedence over MASTER_KEY_FILE', () => {
  const c0 = setupTmp();
  const keyPath = path.join(process.cwd(), 'ignored-key.hex');
  fs.writeFileSync(keyPath, 'c'.repeat(64));
  const envKeyHex = 'd'.repeat(64);
  // Encrypt with the env key active.
  let ct;
  withEnv({ MASTER_KEY: envKeyHex, MASTER_KEY_FILE: keyPath }, () => {
    delete require.cache[require.resolve('../../src/secretCrypto')];
    const c = require('../../src/secretCrypto');
    ct = c.encrypt('precedence');
  });
  // The FILE key alone must NOT be able to decrypt it (env key won, keys differ).
  withEnv({ MASTER_KEY: undefined, MASTER_KEY_FILE: keyPath }, () => {
    delete require.cache[require.resolve('../../src/secretCrypto')];
    const c = require('../../src/secretCrypto');
    assert.throws(() => c.decrypt(ct), /unable|auth/i,
      'file key must not decrypt what the env key encrypted');
  });
  void c0;
});
