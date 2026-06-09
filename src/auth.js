'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// =============================================================
// Paths
// =============================================================

const DATA_DIR = path.join(process.cwd(), 'data');
const API_TOKEN_FILE = path.join(DATA_DIR, '.api-token');
const MIN_TOKEN_LENGTH = 16;

// =============================================================
// API Token (auto-generate + persist)
// =============================================================

function banner(logger, lines) {
  const sep = '='.repeat(60);
  logger.log(sep, 'info');
  for (const l of lines) logger.log('  ' + l, 'info');
  logger.log(sep, 'info');
}

function ensureApiToken({ logger }) {
  const envToken = typeof process.env.API_TOKEN === 'string' ? process.env.API_TOKEN.trim() : '';
  if (envToken) {
    if (envToken.length < MIN_TOKEN_LENGTH) {
      logger.log(
        `❌ API_TOKEN ist zu kurz (< ${MIN_TOKEN_LENGTH} Zeichen). Server wird beendet.`,
        'error'
      );
      process.exit(1);
    }
    return { token: envToken, generated: false };
  }

  // Versuche persisted token zu lesen
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (_) { /* ignore */ }

  // Direkt lesen (vermeidet TOCTOU zwischen existsSync und readFileSync)
  try {
    const persisted = fs.readFileSync(API_TOKEN_FILE, 'utf8').trim();
    if (persisted && persisted.length >= MIN_TOKEN_LENGTH) {
      return { token: persisted, generated: false };
    }
  } catch (err) {
    if (err && err.code !== 'ENOENT') { /* read error — neu generieren */ }
  }

  // Neuen Token generieren
  const newToken = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(API_TOKEN_FILE, newToken, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(API_TOKEN_FILE, 0o600); } catch (_) { /* Windows compat */ }
  } catch (e) {
    logger.log(
      '⚠️  Konnte data/.api-token nicht schreiben: ' + (e && e.message ? e.message : e),
      'warn'
    );
  }

  banner(logger, [
    'AUTO-GENERATED API_TOKEN (store it!):',
    '',
    '  ' + newToken,
    '',
    'persisted to data/.api-token (mode 0600)',
    'Override by setting API_TOKEN env var.'
  ]);

  return { token: newToken, generated: true };
}

// Returns a token-comparing predicate using a constant-time compare against
// the provided API_TOKEN. Verglichen werden SHA-256-Digests statt der rohen
// Buffer: beide Seiten sind dadurch immer gleich lang, d.h. es gibt keinen
// Length-Mismatch-Early-Return mehr, dessen Timing die Token-Länge leaken
// könnte (relevant bei kurzen Custom-Tokens via API_TOKEN env).
//
// CodeQL js/insufficient-password-hash ist hier ein False Positive: die
// Regel adressiert Passwort-SPEICHERUNG (gespeicherte Fast-Hashes sind
// offline bruteforcebar → bcrypt/scrypt nötig). Dieser Digest wird nie
// persistiert oder exponiert — er existiert nur in-memory zur Längen-
// Normalisierung für timingSafeEqual (Standard-Idiom). Ein KDF würde
// jeden API-Request um zweistellige Millisekunden verteuern, ohne
// Sicherheitsgewinn in diesem Threat-Model.
function makeTokensMatch(API_TOKEN) {
  const API_TOKEN_HASH = crypto.createHash('sha256').update(API_TOKEN, 'utf8').digest();
  return function tokensMatch(provided) {
    if (typeof provided !== 'string' || !provided) return false;
    const providedHash = crypto.createHash('sha256').update(provided, 'utf8').digest();
    try {
      return crypto.timingSafeEqual(providedHash, API_TOKEN_HASH);
    } catch (_) {
      return false;
    }
  };
}

// =============================================================
// Env-Flags
// =============================================================

function parseBoolEnv(v, def = false) {
  if (v == null) return def;
  const s = String(v).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no') return false;
  return def;
}

// Parses TRUST_PROXY env var. Express akzeptiert:
//   true|false  → trust all/none
//   integer     → number of hops to trust
//   'loopback'  → 127.0.0.1/8 + ::1
//   'linklocal' → 169.254.0.0/16 + fe80::/10
//   'uniquelocal' → 10/8, 172.16/12, 192.168/16, fc00::/7
//   CIDR list   → comma-separated CIDR ranges (e.g. '10.0.0.0/8,127.0.0.1/8')
//   IP/CIDR     → single IPv4/IPv6 with optional /prefix
// Default ist 1 (single proxy hop) wenn unset/invalid — kompatibel mit dem
// vorherigen hardcoded Wert.
//
// Sicherheitshinweis: Mit TRUST_PROXY=true (oder einer zu breiten CIDR-
// Range) ist `req.ip` über X-Forwarded-For spoofbar. Das ermöglicht es
// einem Angreifer, den IP-basierten Rate-Limiter / Auth-Lockout zu umgehen,
// indem er pro Request eine neue gefälschte Source-IP setzt. Setze daher
// die exakte Anzahl Hops (z.B. 1 hinter nginx) oder eine enge CIDR-Liste
// der eigenen Proxies.
const TRUST_PROXY_TOKENS = new Set(['loopback', 'linklocal', 'uniquelocal']);
// IPv4 mit optionalem Prefix ODER IPv6 mit optionalem Prefix
const TRUST_PROXY_CIDR_RE = /^(\d+\.\d+\.\d+\.\d+(\/\d+)?|[0-9a-fA-F:]+(\/\d+)?)$/;

function _isValidTrustProxyPart(part) {
  if (!part) return false;
  if (TRUST_PROXY_TOKENS.has(part)) return true;
  return TRUST_PROXY_CIDR_RE.test(part);
}

function parseTrustProxy(raw, logger) {
  if (raw == null || raw === '') return 1;
  const s = String(raw).trim();
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (TRUST_PROXY_TOKENS.has(s)) return s;
  // Integer (hop count)
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    return Number.isFinite(n) && n >= 0 ? n : 1;
  }
  // Comma-separated CIDR list
  if (s.includes(',')) {
    const parts = s.split(',').map(p => p.trim()).filter(Boolean);
    const valid = parts.filter(_isValidTrustProxyPart);
    const invalid = parts.filter(p => !_isValidTrustProxyPart(p));
    if (invalid.length && logger && typeof logger.log === 'function') {
      logger.log(`⚠️  TRUST_PROXY: ungültige Einträge ignoriert (${invalid.join(', ')}) — fallback 1 Hop falls Liste leer.`, 'warn');
    }
    if (valid.length) return valid;
    return 1;
  }
  // Single CIDR / IP / known token
  if (_isValidTrustProxyPart(s)) return s;
  if (logger && typeof logger.log === 'function') {
    logger.log(`⚠️  TRUST_PROXY="${s}" ist kein valider Token/CIDR — falle auf 1 Hop zurück. Erlaubt: true/false, integer, loopback/linklocal/uniquelocal, IPv4/IPv6 mit optionalem /prefix, oder kommaseparierte CIDR-Liste.`, 'warn');
  }
  return 1;
}

// =============================================================
// Auth Middleware (protect /api/*)
// =============================================================

function requireAuth({ token, logger }) {
  const tokensMatch = makeTokensMatch(token);
  return function authMiddleware(req, res, next) {
    if (!req.path.startsWith('/api/')) return next();

    // Token aus Header oder (NUR für SSE) Query-String.
    // Query-String-Auth ist auf /api/events beschränkt, weil EventSource
    // im Browser keine Custom-Header setzen kann. Auf allen anderen Routen
    // wäre `?token=` ein Leak-Vektor (landet in nginx-Access-Logs, Browser-
    // History, Referrer-Header bei Outbound-Links).
    let provided = null;
    const auth = req.get('Authorization');
    if (auth && /^Bearer\s+/i.test(auth)) {
      provided = auth.replace(/^Bearer\s+/i, '').trim();
    } else if (req.path === '/api/events' && typeof req.query.token === 'string') {
      provided = req.query.token;
    }

    if (!tokensMatch(provided)) {
      // Sichtbarkeit für Brute-Force-Erkennung. SSE wird gloggt aber von den
      // authFailure-Limitern selbst übersprungen (siehe oben).
      const reason = provided ? 'falscher Token' : 'kein Token';
      logger.log(`🔒 Auth fehlgeschlagen: IP ${req.ip} → ${req.method} ${req.path} (${reason})`, 'warn');
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  };
}

module.exports = {
  DATA_DIR,
  API_TOKEN_FILE,
  MIN_TOKEN_LENGTH,
  ensureApiToken,
  makeTokensMatch,
  requireAuth,
  parseBoolEnv,
  parseTrustProxy,
  banner
};
