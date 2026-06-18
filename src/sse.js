'use strict';

// =============================================================
// SSE Broadcasting
// =============================================================

const sseClients = new Set();
const SSE_MAX_CLIENTS = 20;

// Ring-Buffer für SSE-Resume: Mobile-Browser (iOS Safari, Chrome) suspendieren
// Tabs aggressiv. Bei Reconnect schickt EventSource den `Last-Event-ID`-Header
// und wir spielen alles Neuere zurück. Ohne diesen Puffer verlieren Clients
// `scrape_done` / `log`-Events die während dem Sleep gefeuert wurden, und
// sehen veraltete UI bis zum nächsten Ping.
const SSE_RING_BUFFER_SIZE = 50;
const ringBuffer = []; // [{ id, type, data }]
let lastEventId = 0;

// 'progress'-Level wird per default NICHT an SSE-Clients gesendet — sonst flutet
// der Scrape-Cycle (50+ progress-Lines × N Clients) jeden Browser. Override
// per env SSE_LOG_LEVEL=info,warn,error,progress.
//
// Allowlist-Filter: nur bekannte Logger-Level werden akzeptiert. Tippfehler
// oder Garbage-Werte (z.B. via mis-injected env) führen NICHT dazu, dass die
// Filter-Funktion still bricht — unbekannte Level werden ignoriert, der
// Filter-Mechanismus bleibt aktiv.
//
// Die 4 kanonischen Levels: 'info' | 'warn' | 'error' | 'progress'. Kein
// 'debug' — logger.js coerced unbekannte Levels still zu 'info', deshalb darf
// 'debug' hier NICHT advertised werden (sonst würde SSE 'debug' filtern wollen,
// aber der Logger emittiert es als 'info' — silent mismatch).
const KNOWN_LOG_LEVELS = new Set(['info', 'warn', 'error', 'progress']);
const SSE_LOG_LEVELS = (() => {
  const env = String(process.env.SSE_LOG_LEVEL || 'info,warn,error').toLowerCase();
  const parsed = env.split(',').map(s => s.trim()).filter(Boolean);
  const filtered = parsed.filter(level => KNOWN_LOG_LEVELS.has(level));
  // Falls die env-Var komplett ungültig war, fallback auf safe-default damit
  // der Logger-Output nicht silent verschwindet.
  return new Set(filtered.length ? filtered : ['info', 'warn', 'error']);
})();

function broadcastSse(type, data) {
  lastEventId += 1;
  const id = lastEventId;
  ringBuffer.push({ id, type, data });
  if (ringBuffer.length > SSE_RING_BUFFER_SIZE) ringBuffer.shift();

  const payload = `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  // Backpressure-Schutz: wenn ein Client > 256 KB im writableBuffer staut
  // (flaky-mobile, suspended-tab), wird er evicted statt weiter mit Daten
  // gefüttert. Sonst Memory-Growth pro hängender Verbindung.
  for (const client of sseClients) {
    if (client.writableLength > 256 * 1024) {
      sseClients.delete(client);
      try { client.end(); } catch (_) {}
      continue;
    }
    try { client.write(payload); }
    catch (_) { /* tote Verbindung — wird vom close-handler entfernt */ }
  }
}

// Lauf-Ende-Broadcast unter BEIDEN Event-Typen: erst der neue/kanonische
// `abfrage_done`, dann der alte/Alias `scrape_done`. So sehen sowohl bereits
// migrierte Clients (web-svelte künftig) als auch die noch nicht migrierten
// Frontends (web/mobile, pwa-demo, Telegram-Bot) das Done-Event ohne Bruch.
// Beide Events landen im Ring-Buffer — ein Reconnect-Replay liefert einem
// Client also beide. Das ist akzeptiert: der Done-Refetch ist idempotent,
// deshalb braucht es im Backend kein Dedup.
function broadcastDone(data) {
  broadcastSse('abfrage_done', data);
  broadcastSse('scrape_done', data);
}

// Replay-Hilfsfunktion für `/api/events`: liefert Events neuer als `lastId`.
// Wird nur von events.js benutzt, wenn ein `Last-Event-ID`-Header beim
// Reconnect ankommt.
function replaySince(lastId) {
  if (!Number.isFinite(lastId) || lastId <= 0) return [];
  return ringBuffer.filter(e => e.id > lastId);
}

// statusPayload(settings, state) — pure function, used by /api/status,
// the SSE initial-push and broadcastStatus().
function statusPayload(settings, state) {
  const s = settings.load();
  return {
    running: state.running,
    lastRun: state.lastRun,
    nextRun: state.nextRun,
    lastError: state.lastError,
    enabled: Boolean(s.autoRun),
    intervalMinutes: s.intervalMinutes,
    serverTime: new Date().toISOString(),
    currentPhase: state.currentPhase,
    phaseStartedAt: state.phaseStartedAt
  };
}

function broadcastStatus(settings, state) {
  broadcastSse('status', statusPayload(settings, state));
}

function setPhase(state, settings, phase) {
  if (state.currentPhase === phase) return;
  state.currentPhase = phase;
  state.phaseStartedAt = phase ? new Date().toISOString() : null;
  broadcastStatus(settings, state);
}

// Logger → SSE forwarding. Called once at boot from server.js.
function wireLoggerToSse(logger) {
  logger.subscribe((entry) => {
    if (!SSE_LOG_LEVELS.has(entry.level)) return;
    broadcastSse('log', entry);
  });
}

module.exports = {
  sseClients,
  SSE_MAX_CLIENTS,
  broadcastSse,
  broadcastDone,
  broadcastStatus,
  statusPayload,
  setPhase,
  wireLoggerToSse,
  replaySince
};
