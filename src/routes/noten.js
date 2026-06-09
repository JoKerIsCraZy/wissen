'use strict';

const express = require('express');
const { apiError } = require('../shared/apiError');
const { getNotenStats } = require('../db/stats');

module.exports = function notenRoutes(deps) {
  const router = express.Router();
  const { db, logger, database } = deps;

  // ---------- Noten ----------
  router.get('/api/noten', (req, res) => {
    const filters = {};

    if (req.query.semester != null) {
      const sem = String(req.query.semester);
      if (!/^S[0-9]{1,2}$/.test(sem)) return apiError(res, 400, 'Ungültiger semester-Parameter');
      filters.semester = sem;
    }
    if (req.query.sortBy != null) {
      const sortBy = String(req.query.sortBy);
      if (!['note', 'fetched', 'fach'].includes(sortBy)) {
        return apiError(res, 400, 'Ungültiger sortBy-Parameter');
      }
      filters.sortBy = sortBy;
    }
    if (req.query.hasNote === 'true') filters.hasNote = true;
    else if (req.query.hasNote === 'false') filters.hasNote = false;

    try {
      const rows = db.getNoten(database, filters);
      // Slim getNotenStats statt fettes getStats — spart 4 Queries pro Request,
      // weil nextEvent / stundenplanUpcoming / changedRecent für /api/noten
      // gar nicht gebraucht werden.
      const stats = getNotenStats(database);
      const fetchedAt = stats.lastFetchedNoten || null;
      res.json({
        rows,
        count: rows.length,
        avg: stats.avgNote,
        bySemester: stats.avgBySemester,
        fetchedAt
      });
    } catch (e) {
      logger.log('DB error at GET /api/noten: ' + (e && e.message ? e.message : e), 'error');
      apiError(res, 500, 'Ein Datenbankfehler ist aufgetreten');
    }
  });

  // ---------- History ----------
  router.get('/api/history/:kuerzelId', (req, res) => {
    const id = req.params.kuerzelId;
    if (!id) return apiError(res, 400, 'kuerzelId fehlt');
    if (id.length > 128 || !/^[\w\-./:]+$/.test(id)) {
      return apiError(res, 400, 'Ungültige kuerzelId');
    }

    try {
      const rows = db.getHistory(database, id);
      res.json({ rows });
    } catch (e) {
      logger.log('DB error at GET /api/history: ' + (e && e.message ? e.message : e), 'error');
      apiError(res, 500, 'Ein Datenbankfehler ist aufgetreten');
    }
  });

  // ---------- Modul-Prüfungen (Detail-Noten LB/ZP/...) ----------
  router.get('/api/noten/:kuerzelId/pruefungen', (req, res) => {
    const id = req.params.kuerzelId;
    if (!id) return apiError(res, 400, 'kuerzelId fehlt');
    if (id.length > 128 || !/^[\w\-./:]+$/.test(id)) {
      return apiError(res, 400, 'Ungültige kuerzelId');
    }

    try {
      const rows = db.getPruefungen(database, id);
      // Modul-Note + detail_id für UI-Anzeige (berechneter Schnitt vs. Tocco-Schnitt)
      const modulRow = db.getNotenRow(database, id);
      res.json({
        rows,
        modulNote: modulRow ? modulRow.note : null,
        modulNoteRaw: modulRow ? modulRow.note_raw : null,
        detailId: modulRow ? modulRow.detail_id : null,
        fachName: modulRow ? modulRow.fach_name : null,
        fachCode: modulRow ? modulRow.fach_code : null,
        kuerzelCode: modulRow ? modulRow.kuerzel_code : null,
        kuerzelFull: modulRow ? modulRow.kuerzel_full : null,
        semester: modulRow ? modulRow.semester : null,
        typ: modulRow ? modulRow.typ : null
      });
    } catch (e) {
      logger.log('DB error at GET /api/noten/:id/pruefungen: ' + (e && e.message ? e.message : e), 'error');
      apiError(res, 500, 'Ein Datenbankfehler ist aufgetreten');
    }
  });

  // ids[]-Element-Validierung für /api/seen + /api/dismiss: nur Strings/
  // Zahlen mit sinnvoller Maximallänge. SQL-Injection ist durch Prepared
  // Statements ohnehin ausgeschlossen — das hier kappt nur Garbage-Payloads
  // (Objekte, Mega-Strings) bevor sie die DB-Schicht erreichen.
  function validIds(ids) {
    return ids.every((id) =>
      (typeof id === 'string' && id.length > 0 && id.length <= 128) ||
      (typeof id === 'number' && Number.isFinite(id))
    );
  }

  // ---------- Frisch-Markierung als gesehen ----------
  // Vom Client gerufen (IntersectionObserver-Batch), wenn ein gelb markiertes
  // Item im Viewport sichtbar war. Setzt change_seen_at auf jetzt; 24h später
  // fällt das Item per IS_FRESH_SQL automatisch aus der Highlight-Logik raus.
  router.post('/api/seen', (req, res) => {
    const kind = req.body && req.body.kind;
    const ids = req.body && req.body.ids;
    if (kind !== 'noten' && kind !== 'stundenplan' && kind !== 'absenzen') {
      return apiError(res, 400, 'kind muss "noten", "stundenplan" oder "absenzen" sein');
    }
    if (!Array.isArray(ids) || !ids.length) {
      return apiError(res, 400, 'ids[] erforderlich');
    }
    if (ids.length > 200) {
      return apiError(res, 400, 'maximal 200 ids pro Request');
    }
    if (!validIds(ids)) {
      return apiError(res, 400, 'ids müssen Strings (max 128 Zeichen) oder Zahlen sein');
    }
    try {
      const updated = db.markSeen(database, kind, ids);
      res.json({ ok: true, updated });
    } catch (e) {
      // M2: e.message NICHT an den Client durchreichen (kann SQLite-Pfade/
      // Spaltennamen leaken) — Volltext nur ins Log, generische Meldung zurück.
      logger.log('DB error at POST /api/seen: ' + (e && e.message ? e.message : e), 'error');
      apiError(res, 500, 'markSeen fehlgeschlagen');
    }
  });

  // ---------- Hard-Dismiss von Letzte-Änderungs-Einträgen ----------
  // Setzt change_pending = 0 (PLUS change_seen_at = jetzt). Im Gegensatz zu
  // /api/seen verschwindet der Eintrag SOFORT aus der "Letzte Änderung"-
  // Liste statt erst nach 24h. Vom "Alle gelesen"-Button und vom Mobile-
  // Swipe-to-Dismiss benutzt.
  //
  // Body: { kind: 'noten'|'stundenplan'|'absenzen', ids?: string[]|number[] }
  //   Kein ids → dismissAll für das gegebene kind.
  //   Body: { all: true } → dismissAll für noten, stundenplan UND absenzen.
  router.post('/api/dismiss', (req, res) => {
    const body = req.body || {};
    try {
      let totalNoten = 0;
      let totalPlan = 0;
      let totalAbsenzen = 0;
      if (body.all === true) {
        totalNoten = db.dismissChanges(database, 'noten', null);
        totalPlan  = db.dismissChanges(database, 'stundenplan', null);
        totalAbsenzen = db.dismissChanges(database, 'absenzen', null);
        return res.json({ ok: true, dismissed: { noten: totalNoten, stundenplan: totalPlan, absenzen: totalAbsenzen } });
      }
      const kind = body.kind;
      if (kind !== 'noten' && kind !== 'stundenplan' && kind !== 'absenzen') {
        return apiError(res, 400, 'kind muss "noten", "stundenplan" oder "absenzen" sein (oder all=true)');
      }
      const ids = body.ids;
      // ids weglassen heißt: alle dieses kinds dismissen.
      if (ids != null) {
        if (!Array.isArray(ids)) return apiError(res, 400, 'ids muss ein Array sein');
        if (ids.length > 200) return apiError(res, 400, 'maximal 200 ids pro Request');
        if (!validIds(ids)) return apiError(res, 400, 'ids müssen Strings (max 128 Zeichen) oder Zahlen sein');
      }
      const dismissed = db.dismissChanges(database, kind, ids != null ? ids : null);
      if (kind === 'noten') totalNoten = dismissed;
      else if (kind === 'stundenplan') totalPlan = dismissed;
      else totalAbsenzen = dismissed;
      res.json({ ok: true, dismissed: { noten: totalNoten, stundenplan: totalPlan, absenzen: totalAbsenzen } });
    } catch (e) {
      // M2: e.message NICHT an den Client durchreichen — Volltext nur ins Log.
      logger.log('DB error at POST /api/dismiss: ' + (e && e.message ? e.message : e), 'error');
      apiError(res, 500, 'dismissChanges fehlgeschlagen');
    }
  });

  return router;
};
