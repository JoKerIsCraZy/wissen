'use strict';

/**
 * secretCrypto.js — AES-256-GCM Verschlüsselung für settings.json-Secrets.
 *
 * Threat-Model (was wir schützen):
 *   ✅ Backup-Leak (jemand kopiert data/ ohne .env)
 *   ✅ Volume-Snapshot-Exposure (Cloud-Snapshot, NFS-Mishap)
 *   ✅ Casual-File-Share zum Debuggen
 *
 * NICHT geschützt:
 *   ❌ Shell-Access auf den laufenden Server (Master-Key liegt neben den Daten)
 *   ❌ Memory-Dump
 *   ❌ Container-Escape
 *
 * Master-Key (Ladereihenfolge, erste vorhandene Quelle gewinnt):
 *   1. process.env.MASTER_KEY       — 32 Bytes als 64 Hex-Chars ODER base64.
 *                                     Bevorzugt: der Key liegt dann NICHT im
 *                                     data/-Volume, ein Backup/Snapshot von
 *                                     data/ leakt ihn nicht mehr mit.
 *   2. process.env.MASTER_KEY_FILE  — Pfad zu einer Key-Datei (z.B. Docker-
 *                                     Secret /run/secrets/master_key). Inhalt:
 *                                     rohe 32 Byte ODER hex/base64-Text.
 *   3. data/.master-key             — Legacy-Fallback. 32 Bytes random, beim
 *                                     ersten Start generiert (mode 0600, atomic
 *                                     write via rename), danach wiederverwendet.
 *
 *   Ist Quelle 1 oder 2 GESETZT aber ungültig/unlesbar, bricht der Load LAUT ab
 *   — es wird NICHT still ein neuer Key generiert (das würde bestehende
 *   Ciphertexte unlesbar machen und die Fehlkonfiguration verschleiern). Nur
 *   wenn KEINE env-Quelle gesetzt ist, greift der Legacy-Generate-Pfad.
 *
 * Format auf Disk:
 *   "enc:v1:<iv-b64>:<ciphertext-b64>:<authtag-b64>"
 *   - iv: 12 Bytes (GCM-Standard)
 *   - authTag: 16 Bytes (GCM-Auth)
 *   - v1 erlaubt künftige Algo-Wechsel ohne Format-Bruch
 *
 * Backwards-Compat:
 *   - Plaintext-Werte (kein "enc:v1:"-Prefix) werden beim Read durchgereicht.
 *   - Erste save()-Operation nach dem Upgrade verschlüsselt sie.
 *   - Damit ist der Migrations-Pfad lazy — kein Migrations-Script nötig.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const KEY_FILE = path.join(process.cwd(), 'data', '.master-key');
const KEY_LENGTH = 32;     // 256-bit AES-Key
const IV_LENGTH = 12;      // GCM-Standard
const TAG_LENGTH = 16;     // GCM Auth-Tag

// Env-Quellen für den Master-Key (siehe Ladereihenfolge im Datei-Docstring).
// Namen als Konstanten, damit Fehler-Messages und Doku konsistent bleiben.
const ENV_KEY = 'MASTER_KEY';
const ENV_KEY_FILE = 'MASTER_KEY_FILE';

const PREFIX = 'enc:v1:';

// Welche Felder im Settings-Objekt verschlüsselt werden. Single source of truth.
//
// Deckt die schützenswerten Keys aus ALLOWED_UI_CREDENTIAL_KEYS (settings.js)
// ab. Bewusst NICHT enthalten ist `userPk`: das ist eine Tocco-Datensatz-ID,
// kein Geheimnis — sie authentifiziert nichts. `msEmail` dagegen schon: ohne
// sie wäre im Threat-Model dieser Datei (Backup-/Snapshot-Leak von data/) der
// Portal-Benutzername im Klartext neben dem verschlüsselten Passwort gelandet.
const SECRET_FIELDS = Object.freeze(['msPassword', 'telegramToken', 'msEmail']);

// Lazy-loaded master key — kein require-time Side-Effect, damit Tests die
// Reihenfolge (chdir → require) kontrollieren können.
let _key = null;

// Öffentlicher Einstieg: liefert den Master-Key nach der Ladereihenfolge
// (siehe Datei-Docstring). Env-Quellen werden bei jedem Erst-Load frisch
// gelesen; danach ist der Key modulweit gecached (_key). Die env-Pfade
// werfen LAUT bei Fehlkonfiguration — nur ein komplett ungesetztes
// MASTER_KEY / MASTER_KEY_FILE führt zum Legacy-Generate-Pfad.
function loadOrGenerateKey() {
  if (_key) return _key;

  const envKey = process.env[ENV_KEY];
  if (typeof envKey === 'string' && envKey.trim() !== '') {
    _key = parseKeyMaterial(envKey, `${ENV_KEY} env`);
    return _key;
  }

  const envFile = process.env[ENV_KEY_FILE];
  if (typeof envFile === 'string' && envFile.trim() !== '') {
    _key = loadKeyFromFile(envFile.trim());
    return _key;
  }

  _key = loadOrGenerateLegacyKey();
  return _key;
}

// Parst Key-Material aus einem String: 64 Hex-Chars ODER base64, muss zu
// exakt KEY_LENGTH (32) Bytes dekodieren. Wirft mit Quellen-Kontext, wenn
// die Länge nicht stimmt. `source` fließt in die Fehler-Message (z.B.
// "MASTER_KEY env" / "MASTER_KEY_FILE (/run/secrets/...)").
function parseKeyMaterial(raw, source) {
  const s = String(raw).trim();
  // Hex hat Vorrang: 64 Hex-Chars sind unmissverständlich als Hex gemeint.
  if (/^[0-9a-fA-F]{64}$/.test(s)) {
    return Buffer.from(s, 'hex');
  }
  // Sonst base64 / base64url (Buffer.from dekodiert lenient, wirft nie).
  const buf = Buffer.from(s, 'base64');
  if (buf.length === KEY_LENGTH) return buf;
  throw new Error(
    `${source}: ungültiges Key-Material — erwartet 32 Bytes als 64 Hex-Chars `
    + `oder base64, dekodiert wurden ${buf.length} Bytes`
  );
}

// Lädt den Key aus einer Datei (MASTER_KEY_FILE). Rohe 32-Byte-Binärdatei
// (z.B. eine kopierte data/.master-key) wird direkt genutzt; andernfalls wird
// der Datei-Inhalt als hex/base64-Text interpretiert. Fehlt die Datei oder ist
// sie unlesbar, wirft die Funktion LAUT — ein explizit gesetzter Pfad darf
// nicht still in den Generate-Pfad durchfallen.
function loadKeyFromFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file);
  } catch (err) {
    throw new Error(`${ENV_KEY_FILE} (${file}): Key-Datei nicht lesbar — ${err.message}`, { cause: err });
  }
  if (raw.length === KEY_LENGTH) return raw;
  return parseKeyMaterial(raw.toString('utf8'), `${ENV_KEY_FILE} (${file})`);
}

// Legacy-Pfad: data/.master-key lesen oder (race-safe) neu generieren.
// Wird NUR aufgerufen, wenn keine env-Quelle gesetzt ist.
function loadOrGenerateLegacyKey() {
  // Versuch 1: existierenden Key lesen
  try {
    const raw = fs.readFileSync(KEY_FILE);
    if (raw.length === KEY_LENGTH) {
      _key = raw;
      return _key;
    }
    // Falsche Länge — als korrupt behandeln und regenerieren.
    // (Achtung: das macht alle bestehenden ciphertexte unentschlüsselbar.
    // In der Praxis kommt das nur bei Datei-Corruption vor.)
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw new Error('master-key read failed: ' + err.message, { cause: err });
    }
    // ENOENT → unten neu generieren
  }

  // Versuch 2: neuen Key generieren + race-safe schreiben.
  // 'wx'-Flag öffnet exklusiv und schlägt mit EEXIST fehl, wenn die Datei
  // zwischen unserem readFileSync und dem openSync von einem parallelen
  // Prozess erstellt wurde. In dem Fall lesen wir den fremden Key, damit
  // beide Prozesse dieselbe ciphertext-Basis verwenden.
  const fresh = crypto.randomBytes(KEY_LENGTH);
  try {
    fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
    const fd = fs.openSync(KEY_FILE, 'wx', 0o600);
    try {
      fs.writeSync(fd, fresh);
    } finally {
      fs.closeSync(fd);
    }
    try { fs.chmodSync(KEY_FILE, 0o600); } catch (_) { /* Windows */ }
    _key = fresh;
    return _key;
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      // Race: anderer Prozess hat zuerst geschrieben. Den fremden Key lesen.
      try {
        const raw = fs.readFileSync(KEY_FILE);
        if (raw.length === KEY_LENGTH) {
          _key = raw;
          return _key;
        }
        throw new Error('master-key race-read returned wrong length: ' + raw.length, { cause: err });
      } catch (readErr) {
        throw new Error('master-key race-read failed: ' + readErr.message, { cause: readErr });
      }
    }
    // Persistenz fehlgeschlagen — Key lebt nur in-process.
    // Beim nächsten Boot wird ein anderer Key generiert,
    // bestehende ciphertexte sind dann unlesbar. Loud failure.
    throw new Error('master-key persist failed: ' + err.message, { cause: err });
  }
}

// Reset-Helper für Tests — NICHT in module.exports!
// (Tests können require.cache invalidieren, das hier ist nur eine Notbremse.)
function _resetForTests() {
  _key = null;
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

// Verschlüsselt einen String-Wert. Idempotent: bereits verschlüsselte Werte
// werden unverändert zurückgegeben (verhindert Doppel-Encryption beim
// erneuten save()).
function encrypt(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) return plaintext;
  if (isEncrypted(plaintext)) return plaintext;

  const key = loadOrGenerateKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encBuf = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX
    + iv.toString('base64') + ':'
    + encBuf.toString('base64') + ':'
    + tag.toString('base64');
}

// Entschlüsselt einen String-Wert. Plaintext (kein PREFIX) wird durchgereicht
// — wichtig für Migration von Bestands-settings.json. Bei korruptem Blob
// wirft die Funktion mit deskriptiver Message; settings.js fängt das und
// loggt mit Feld-Name.
function decrypt(blob) {
  if (typeof blob !== 'string') return blob;
  if (!isEncrypted(blob)) return blob;

  const rest = blob.slice(PREFIX.length);
  const parts = rest.split(':');
  if (parts.length !== 3) {
    throw new Error('invalid blob format (expected iv:cipher:tag)');
  }
  const [ivB64, encB64, tagB64] = parts;

  const iv = Buffer.from(ivB64, 'base64');
  if (iv.length !== IV_LENGTH) {
    throw new Error('invalid iv length: ' + iv.length);
  }
  const tag = Buffer.from(tagB64, 'base64');
  if (tag.length !== TAG_LENGTH) {
    throw new Error('invalid auth tag length: ' + tag.length);
  }
  const encBuf = Buffer.from(encB64, 'base64');

  const key = loadOrGenerateKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  // .final() wirft wenn der Auth-Tag nicht stimmt → Tampering wird erkannt.
  return Buffer.concat([decipher.update(encBuf), decipher.final()]).toString('utf8');
}

// Verschlüsselt SECRET_FIELDS in einem Settings-Objekt. Returnt eine NEUE
// Kopie (kein In-Place-Mutate). Leere Strings bleiben leer (User hat das
// Secret bewusst geleert).
function encryptSettings(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = { ...obj };
  for (const field of SECRET_FIELDS) {
    if (out[field] != null && out[field] !== '') {
      out[field] = encrypt(out[field]);
    }
  }
  return out;
}

// Entschlüsselt SECRET_FIELDS. Tolerant gegen Plaintext (Migration) UND
// gegen fehlende Felder (Settings-Update hat Feld nicht enthalten).
// Bei korruptem Blob wirft die Funktion mit Feld-Name in der Message.
function decryptSettings(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = { ...obj };
  for (const field of SECRET_FIELDS) {
    if (out[field] != null && isEncrypted(out[field])) {
      try {
        out[field] = decrypt(out[field]);
      } catch (err) {
        throw new Error(`failed to decrypt settings.${field}: ${err.message}`, { cause: err });
      }
    }
  }
  return out;
}

module.exports = {
  loadOrGenerateKey,
  encrypt,
  decrypt,
  isEncrypted,
  encryptSettings,
  decryptSettings,
  SECRET_FIELDS,
  KEY_FILE,
  PREFIX,
  // Test-internal
  _resetForTests
};
