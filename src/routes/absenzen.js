'use strict';

const express = require('express');
const { apiError } = require('../shared/apiError');

// Kürzel-Code-Validierung (Join-Key Übersicht↔Detail, z.B.
// UIFZ-2524-020-S1-UEK-106). Gleicher Filter wie kuerzelId in noten.js:
// max 128 Zeichen, nur Wort-/Pfad-/Trenn-Zeichen — blockt SQL-/Pfad-Injection
// schon am Route-Rand, bevor die DB-Schicht den Wert sieht.
const CODE_RE = /^[\w\-./:]+$/;
const MAX_CODE_LEN = 128;

module.exports = function absenzenRoutes(deps) {
  const router = express.Router();
  const { db, logger, database } = deps;

  // ---------- Absenzen-Übersicht (pro Modul + Stats) ----------
  router.get('/api/absenzen', (req, res) => {
    try {
      const rows = db.getAbsenzen(database, {});
      // getAbsenzenStats liefert die drei Hero-Kacheln (Ø-Anwesenheit, Module
      // unter Minimum, Abwesenheiten gesamt) plus lastFetched-Marker.
      const stats = db.getAbsenzenStats(database);
      const fetchedAt = stats.lastFetchedAbsenzen || null;
      res.json({
        rows,
        count: rows.length,
        stats: {
          avgAnwesenheit: stats.avgAnwesenheit,
          unterMinimum: stats.unterMinimum,
          abwesendGesamt: stats.abwesendGesamt
        },
        fetchedAt
      });
    } catch (e) {
      // M2: e.message NICHT an den Client durchreichen (kann SQLite-Pfade/
      // Spaltennamen leaken) — Volltext nur ins Log, generische Meldung zurück.
      logger.log('DB error at GET /api/absenzen: ' + (e && e.message ? e.message : e), 'error');
      apiError(res, 500, 'Ein Datenbankfehler ist aufgetreten');
    }
  });

  // ---------- Modul-Termine (Tagesdetail pro Lektion) ----------
  router.get('/api/absenzen/:code/termine', (req, res) => {
    const code = req.params.code;
    if (!code) return apiError(res, 400, 'code fehlt');
    if (code.length > MAX_CODE_LEN || !CODE_RE.test(code)) {
      return apiError(res, 400, 'Ungültiger code');
    }

    try {
      const modul = db.getAbsenzRow(database, code);
      const rows = db.getLektionen(database, code);
      res.json({ modul: modul || null, rows });
    } catch (e) {
      logger.log('DB error at GET /api/absenzen/:code/termine: ' + (e && e.message ? e.message : e), 'error');
      apiError(res, 500, 'Ein Datenbankfehler ist aufgetreten');
    }
  });

  return router;
};
