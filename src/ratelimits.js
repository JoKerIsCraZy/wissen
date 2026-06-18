'use strict';

const rateLimit = require('express-rate-limit');
const { apiError } = require('./shared/apiError');

// Factory: erstellt alle 5 rate-limit Middlewares mit gemeinsamer logger-Abhängigkeit.
// globalLimiter, scrapeLimiter und pushLimiter sind static (kein logger nötig);
// die beiden auth-Limiter brauchen den logger für Brute-Force-Warnings.
function create({ logger }) {
  const globalLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,           // 5 min
    limit: 300,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // SSE skippen — long-lived connection, jede "request" wäre fatal.
    // WICHTIG: dieser Limiter wird in server.js per `app.use('/api/', ...)`
    // gemountet (damit Static-Asset-Requests nicht mitzählen). Innerhalb
    // einer path-gemounteten Middleware ist `req.path` mount-relativ, d.h.
    // für GET /api/events sieht der Limiter `req.path === '/events'`,
    // NICHT '/api/events'. Daher hier auf den post-mount-Pfad prüfen.
    // Doppelt absichern via originalUrl für den Fall dass jemand den
    // Limiter in Zukunft global mountet.
    skip: (req) => req.path === '/events' || req.originalUrl === '/api/events',
    handler: (req, res) => apiError(res, 429, 'Zu viele Anfragen, bitte später erneut versuchen')
  });

  const scrapeLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,           // 5 min
    limit: 5,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => apiError(res, 429, 'Abfrage-Rate überschritten')
  });

  // Test-Push verbraucht FCM/Mozilla/Apple-Quota — wenn das spamt riskieren wir
  // Push-Service-Suspension. Plus: Subscribe wird vor jedem PWA-Install genau
  // einmal gerufen, mehr als ein paar pro Minute ist bot-ähnlich.
  const pushLimiter = rateLimit({
    windowMs: 60 * 1000,               // 1 min
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => apiError(res, 429, 'Push-Rate überschritten')
  });

  // ---------- Anti-Brute-Force: Auth-Failure-Limiter ----------
  // Defense-in-Depth gegen Token-Brute-Force. Zwei Schichten:
  //
  //   1. Kurze Schicht: 10 failed Auths / 15min / IP → 15min Lockout.
  //      Stoppt aktive Wörterbuch-/Brute-Force-Attacken.
  //   2. Lange Schicht: 50 failed Auths / 6h / IP → 6h Lockout.
  //      Fängt verteilte Slow-Brute ab (z.B. 9 Versuche alle 15min, die der
  //      kurzen Schicht entgehen würden = ~860/Tag).
  //
  // `skipSuccessfulRequests: true` → erfolgreiche Requests (status < 400)
  // zählen NICHT mit. Nur 401er (und 429er aus dem Limiter selbst) erhöhen
  // den Counter — legitime Nutzung wird also nicht eingeschränkt.
  //
  // `/api/events` (SSE) wird übersprungen: bei 401 reconnectet der Browser
  // per EventSource sofort wieder, was legitime User mit abgelaufenem Token
  // in Sekunden ausperren würde.
  const authFailureLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: (req) => !req.path.startsWith('/api/') || req.path === '/api/events',
    handler: (req, res) => {
      logger.log(`🚫 Auth-Brute-Force blockiert (15min): IP ${req.ip} → ${req.method} ${req.path}`, 'warn');
      return apiError(res, 429, 'Zu viele fehlgeschlagene Auth-Versuche - IP für 15 Minuten gesperrt');
    }
  });

  const authBruteForceLockout = rateLimit({
    windowMs: 6 * 60 * 60 * 1000,      // 6h
    limit: 50,
    skipSuccessfulRequests: true,
    standardHeaders: false,             // nur die kurze Schicht setzt RateLimit-Headers
    legacyHeaders: false,
    skip: (req) => !req.path.startsWith('/api/') || req.path === '/api/events',
    handler: (req, res) => {
      logger.log(`⛔ Auth-Lockout (6h): IP ${req.ip} hat 50+ Auth-Fehler in 6h ausgelöst`, 'error');
      return apiError(res, 429, 'IP wegen wiederholter Auth-Fehler langzeitgesperrt (6h)');
    }
  });

  // ---------- SSE-spezifischer Auth-Failure-Limiter ----------
  // Die globalen authFailure-Limiter (10/15min, 50/6h) skippen /api/events,
  // weil ein Browser mit stalem Token via EventSource sofort reconnectet
  // (10 Fails in <30s → legitimer User wäre 15min gesperrt).
  //
  // Wir wollen aber Token-Brute-Force gegen /api/events trotzdem fangen:
  // 60 Failed-Auth-Versuche pro 15min pro IP — toleriert Reconnect-Storms
  // eines einzelnen bad-token-Clients (4/min sustained), fängt enumerative
  // Angriffe (>1 Token-Versuch pro Sekunde) ab. Erfolgreiche Connects
  // zählen NICHT (skipSuccessfulRequests: true).
  const sseFailureLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 60,
    skipSuccessfulRequests: true,
    standardHeaders: false,
    legacyHeaders: false,
    skip: (req) => req.path !== '/api/events',
    handler: (req, res) => {
      logger.log(`🚫 SSE-Auth-Brute-Force: IP ${req.ip} hat 60+ Fehler an /api/events in 15min`, 'warn');
      return apiError(res, 429, 'Zu viele fehlgeschlagene SSE-Auth-Versuche');
    }
  });

  // ---------- Healthcheck-Limiter ----------
  // `/healthz/ready` ist unauthenticated (damit Docker HEALTHCHECK ohne Token
  // probet) — ohne Limiter wäre das eine billige DoS-Surface (jeder Request
  // touched DB + serialisiert Status). 60/min ist mehr als genug für Docker
  // (default 30s-Intervall = 2/min) + externe Monitoring-Probes.
  const healthLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => apiError(res, 429, 'Healthcheck-Rate überschritten')
  });

  return {
    globalLimiter,
    authFailureLimiter,
    authBruteForceLockout,
    sseFailureLimiter,
    scrapeLimiter,
    pushLimiter,
    healthLimiter
  };
}

module.exports = { create };
