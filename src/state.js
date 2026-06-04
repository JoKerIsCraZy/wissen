'use strict';

// Shared mutable state for runScrape + scheduler + sse + routes.
// Single instance, required from anywhere.
//
// Note: settings.load() in sse.statusPayload() ist bereits gecached (siehe
// settings.cache.test.js), kein zusätzlicher Pro-Broadcast-Read-Hit. Der
// statusPayload-Call pro Broadcast bleibt billig.
const state = {
  running: false,
  lastRun: null,           // ISO string
  nextRun: null,           // ISO string
  lastError: null,         // string | null
  lastStats: null,         // letzter scraper-Result (summary)
  timer: null,             // scheduled setTimeout handle (regulärer Scrape)
  weeklyTimer: null,       // setTimeout handle für wöchentlichen Detail-Refresh
  scrapeLockedUntil: 0,    // Timestamp (ms) bis wann manuelle Trigger gesperrt sind (Cooldown)
  lastWeeklyDetailAt: null,// ISO string — letzter ERFOLGREICHER Weekly-Voll-Refresh
  lastWeeklyDetailAttemptAt: null, // ISO string — letzter Weekly-VERSUCH (auch fehlgeschlagen), Backoff-Marker (#1)
  currentPhase: null,      // 'starting'|'browser'|'login'|'noten'|'stundenplan'|'saving'|null
  phaseStartedAt: null     // ISO timestamp — wann die aktuelle Phase begann
};

module.exports = state;
