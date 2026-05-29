'use strict';

/**
 * SQLite-Schicht für WISSen — nutzt Nodes eingebautes node:sqlite (Node 22.5+).
 * Aufgeteilt in Domain-Module:
 *   - schema.js      Schema + Migrationen + open()
 *   - parsers.js     Reine String-Parser (Fach, Kürzel, Note, Datum, Zeit, etc.)
 *   - queries.js     SQL-Snippets die in mehreren Modulen genutzt werden
 *   - noten.js       Noten + History + Detail-IDs (Modul-PKs)
 *   - stundenplan.js Stundenplan inkl. Prune
 *   - pruefungen.js  Modul-Detail-Noten (LB/ZP/OTHER)
 *   - stats.js       Aggregat-Stats + markSeen (kreuzt noten + stundenplan)
 *   - push.js        Web-Push Subscriptions
 *
 * Diese Datei re-exportiert die öffentliche API, damit `require('./db')` aus
 * server.js / cli.js / push.js identisch funktioniert wie vorher (Node
 * resolved Verzeichnisse automatisch zu index.js).
 */

const { open, openOnce, getInstance, closeInstance } = require('./schema');
const {
  saveNoten,
  getNoten,
  getNotenRow,
  getHistory,
  updateDetailIds,
  getKuerzelnWithDetailId,
  getKuerzelnNeedingDetailScrape,
  markDetailScraped
} = require('./noten');
const {
  saveStundenplan,
  getStundenplan,
  pruneVergangen,
  clearStundenplan
} = require('./stundenplan');
const {
  savePruefungen,
  getPruefungen
} = require('./pruefungen');
const {
  saveAbsenzen,
  updateAbsenzDetailIds,
  getAbsenzenWithDetailId,
  getAbsenzenNeedingDetailScrape,
  markAbsenzDetailScraped,
  saveLektionen,
  getLektionen,
  getAbsenzRow,
  getAbsenzen
} = require('./absenzen');
const { getStats, getAbsenzenStats, markSeen, dismissChanges } = require('./stats');
const {
  addPushSubscription,
  removePushSubscription,
  getAllPushSubscriptions,
  countPushSubscriptions
} = require('./push');

module.exports = {
  open,
  openOnce,
  getInstance,
  closeInstance,
  saveNoten,
  saveStundenplan,
  pruneVergangen,
  clearStundenplan,
  getNoten,
  getStundenplan,
  getHistory,
  getStats,
  markSeen,
  dismissChanges,
  // Modul-Detail-Noten
  updateDetailIds,
  savePruefungen,
  getPruefungen,
  getKuerzelnNeedingDetailScrape,
  getKuerzelnWithDetailId,
  markDetailScraped,
  getNotenRow,
  // Absenzen (Übersicht + Tagesdetail)
  saveAbsenzen,
  updateAbsenzDetailIds,
  getAbsenzenWithDetailId,
  getAbsenzenNeedingDetailScrape,
  markAbsenzDetailScraped,
  saveLektionen,
  getLektionen,
  getAbsenzRow,
  getAbsenzen,
  getAbsenzenStats,
  // Push
  addPushSubscription,
  removePushSubscription,
  getAllPushSubscriptions,
  countPushSubscriptions
};
