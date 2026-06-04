'use strict';

const express = require('express');
const { apiError } = require('../shared/apiError');

module.exports = function dbRoutes(deps) {
  const router = express.Router();
  const { db, logger, database, ratelimits } = deps;

  // ---------- DB-Reset (alle gescrapten Daten löschen) ----------
  // Destruktive Aktion — das Desktop-UI hat eine 2-Klick-Bestätigung. Token-Auth
  // ist für /api/* via Middleware aktiv; zusätzlich scrapeLimiter (5/5min) gegen
  // curl-Loops, weil die Aktion genauso destruktiv ist wie ein Scrape-Trigger.
  // push_subscriptions + Settings bleiben erhalten (siehe db/reset.js).
  router.post('/api/db/reset', ratelimits.scrapeLimiter, (req, res) => {
    try {
      const { deleted, total } = db.resetDb(database);
      logger.log(
        `🧨 Datenbank zurückgesetzt — ${total} Zeilen gelöscht (`
        + Object.entries(deleted).map(([t, n]) => `${t}:${n}`).join(', ') + ')',
        'info'
      );
      res.json({ deleted, total });
    } catch (e) {
      logger.log('DB error at POST /api/db/reset: ' + (e && e.message ? e.message : e), 'error');
      apiError(res, 500, 'Ein Datenbankfehler ist aufgetreten');
    }
  });

  return router;
};
