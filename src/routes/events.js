'use strict';

const express = require('express');

const sseTicket = require('../sseTicket');

// Modul-scope shared ping-interval. Statt pro Client ein setInterval zu
// starten (20 Timers), läuft ein einziger Interval-Loop und schreibt ': ping'
// in jeden Client. Wird beim ersten Mount gestartet und bleibt für die Lebzeit
// des Prozesses aktiv (.unref() damit es Node nicht am Shutdown hindert).
let pingIntervalStarted = false;

function startSharedPingInterval(sseClients) {
  if (pingIntervalStarted) return;
  pingIntervalStarted = true;
  const handle = setInterval(() => {
    for (const client of sseClients) {
      try {
        client.write(': ping\n\n');
      } catch (_) {
        // Verbindung tot — Cleanup-Handler des einzelnen Clients (req.close /
        // res.error) entfernt ihn aus sseClients. Hier nur Best-Effort.
      }
    }
  }, 15000);
  if (typeof handle.unref === 'function') handle.unref();
}

module.exports = function eventsRoutes(deps) {
  const router = express.Router();
  const { state, settings, sse } = deps;

  // Shared ping-Interval einmalig beim Router-Mount initialisieren.
  startSharedPingInterval(sse.sseClients);

  // ---------- SSE-Ticket ----------
  // Gibt ein kurzlebiges Einmal-Ticket fuer /api/events aus.
  //
  // Diese Route liegt NICHT unter dem SSE-Sonderfall des Auth-Gates (der
  // greift nur auf exakt /api/events), sie verlangt also den regulaeren
  // Authorization-Header. Der API-Token bleibt damit im Header und taucht in
  // keinem Access-Log auf; nur das Ticket wandert anschliessend in die URL.
  //
  // Bewusst POST: ein GET waere vom Browser prefetch-/cachebar und wuerde
  // Tickets verbrauchen, die nie fuer einen Connect genutzt werden.
  router.post('/api/events/ticket', (req, res) => {
    const { ticket, expiresInMs } = sseTicket.issue();
    res.json({ ticket, expiresInMs });
  });

  // ---------- SSE Events ----------
  router.get('/api/events', (req, res) => {
    // 21st-Connect Zombie-Eviction: bevor der Cap geprüft wird, alle bereits
    // toten Sockets aus dem Set werfen. Sonst belegt z.B. ein hängender
    // Mobile-Client einen Slot, obwohl die TCP-Verbindung längst tot ist.
    for (const c of sse.sseClients) {
      if (c.destroyed || !c.writable) {
        sse.sseClients.delete(c);
      }
    }

    if (sse.sseClients.size >= sse.SSE_MAX_CLIENTS) {
      return res.status(503).json({ error: 'Too many SSE clients' });
    }

    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.flushHeaders?.();

    // Resume-Pfad: wenn Client mit Last-Event-ID reconnected, alle Events
    // neuer als diese ID aus dem Ring-Buffer zurückspielen. Standard-
    // EventSource-Verhalten: setzt den Header automatisch bei jedem Reconnect.
    //
    // Snapshot der `lastEventId` einmal bei Handler-Entry, damit zwischen
    // Header-Read und Replay-Loop keine neuen Broadcasts den Snapshot bewegen.
    const lastIdRaw = req.headers['last-event-id'] || req.query.lastEventId;
    const lastId = lastIdRaw ? parseInt(lastIdRaw, 10) : 0;

    // WICHTIG: Client VOR dem Replay-Loop registrieren. Sonst gibt es ein
    // Race-Window, in dem ein neu gefeuerter broadcastSse() den Client nicht
    // erreicht (noch nicht im Set), aber gleichzeitig schon im Ring-Buffer
    // landen kann — und genau diese Events durch den Replay-Snapshot nicht
    // abgedeckt sind (`lastEventId` wurde zu früh gelesen).
    sse.sseClients.add(res);

    if (lastId > 0 && Number.isFinite(lastId)) {
      const missed = sse.replaySince(lastId);
      for (const ev of missed) {
        res.write(`id: ${ev.id}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`);
      }
    }

    // Initialer Status-Push: aktuellen Zustand IMMER mitliefern (auch nach Replay),
    // damit Clients beim Reconnect garantiert konsistent sind, falls
    // ein `status`-Event aus dem Ring-Buffer gerollt wurde.
    res.write(`event: status\ndata: ${JSON.stringify(sse.statusPayload(settings, state))}\n\n`);

    // Idempotent-Guard: cleanup() kann durch req.close, res.error oder einen
    // gefehlten ping-write getriggert werden — alle drei Pfade dürfen feuern,
    // aber nur der erste darf Effekt haben.
    let cleaned = false;
    function cleanup() {
      if (cleaned) return;
      cleaned = true;
      sse.sseClients.delete(res);
    }

    res.on('error', cleanup);
    req.on('close', cleanup);
  });

  return router;
};
