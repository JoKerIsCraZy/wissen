'use strict';

const express = require('express');

const MANUAL_SCRAPE_COOLDOWN_MS = 60 * 1000;
const STUCK_THRESHOLD_MS = 15 * 60 * 1000;  // > 15 min in derselben Phase = stuck

module.exports = function scrapeRoutes(deps) {
  const router = express.Router();
  const { state, runScrapeCycle, ratelimits } = deps;

  // ---------- Abfrage-Trigger ----------
  // Der Handler-Body ist datenquellen-neutral und wird unter ZWEI Pfaden
  // gemountet: `/api/abfrage` (kanonisch) und `/api/scrape` (deprecated Alias).
  // Beide teilen EXAKT denselben Body und denselben Lock (state.scrapeLockedUntil),
  // d.h. der Cooldown gilt pfad-übergreifend — ein Trigger auf /api/scrape sperrt
  // auch /api/abfrage und umgekehrt. Der race-freie Lock-Set vor dem async-Dispatch
  // bleibt erhalten.
  function registerTriggerHandler(path, { deprecated = false } = {}) {
    router.post(path, ratelimits.scrapeLimiter, async (req, res) => {
      if (deprecated) {
        // RFC 8594 Deprecation-Header + Sunset/Successor-Hinweis auf den
        // kanonischen Pfad. Rein advisory — der Alias funktioniert weiter.
        res.set('Deprecation', 'true');
        res.set('Link', '</api/abfrage>; rel="successor-version"');
      }

      const now = Date.now();

      // Stuck-Detection: wenn state.running seit > 15 min in derselben Phase,
      // ist das mit hoher Wahrscheinlichkeit ein hängender Abfrage-Lauf (Browser-
      // Crash mit unsauberem state-Reset, Watchdog-Hänger, etc.). In dem Fall
      // ignorieren wir BEIDE Locks (running + cooldown), damit der User aus
      // dem Lockout rauskommt. Der eigentliche Trigger setzt state.running
      // dann auf den frischen Cycle.
      const stuckMs = state.running && state.phaseStartedAt
        ? now - Date.parse(state.phaseStartedAt)
        : 0;
      const isStuck = state.running && stuckMs > STUCK_THRESHOLD_MS;

      if (state.running && !isStuck) {
        return res.json({ triggered: false, reason: 'already_running' });
      }

      // Cooldown: 60s zwischen manuellen Triggern — auch für authorisierte User,
      // damit versehentliches Spammen nicht Login-Drosselung bei MS auslöst.
      // Race-frei: wir vergleichen Date.now() gegen einen absoluten "locked-until"
      // Timestamp und SETZEN den Lock SOFORT bevor wir async dispatchen — so
      // sehen parallele Requests den Lock direkt (kein TOCTOU-Fenster).
      // Stuck-Case: Cooldown ebenfalls ignorieren — sonst kommt der User
      // 60s nach dem Stuck-Detect noch immer nicht durch.
      if (!isStuck && now < state.scrapeLockedUntil) {
        const retryInSec = Math.ceil((state.scrapeLockedUntil - now) / 1000);
        return res.status(429).json({
          triggered: false,
          reason: 'cooldown',
          retryInSec
        });
      }
      state.scrapeLockedUntil = now + MANUAL_SCRAPE_COOLDOWN_MS;

      // Kick off; return immediately
      runScrapeCycle('manual').catch(() => { /* state.lastError is already set */ });
      res.json({ triggered: true, ...(isStuck ? { stuckReset: true } : {}) });
    });
  }

  registerTriggerHandler('/api/abfrage');                  // kanonisch
  registerTriggerHandler('/api/scrape', { deprecated: true }); // deprecated Alias

  return router;
};
