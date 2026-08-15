'use strict';

// Regression: der API-Token wurde als `/api/events?token=<token>` in die URL
// gehaengt, weil EventSource keine Custom-Header setzen kann. Query-Strings
// landen vollstaendig in Reverse-Proxy-Access-Logs. Da der Token statisch ist,
// nie ablaeuft und jede /api-Route autorisiert, war ein einziger geleakter
// Logeintrag Vollzugriff auf Dauer — und der Reconnect-Loop des SSE-Clients
// hat ihn fortlaufend nachgeloggt.
//
// Ersetzt durch kurzlebige Einmal-Tickets: was in den Logs landet, ist ein
// bereits verbrauchter Zufallswert ohne Autorisierung.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

const auth = require('../../src/auth');
const sseTicket = require('../../src/sseTicket');

const TOKEN = 'a'.repeat(32);

beforeEach(() => sseTicket._reset());

function makeApp() {
  const app = express();
  const fakeLogger = { log: () => {} };
  app.use(auth.requireAuth({ token: TOKEN, logger: fakeLogger }));

  const router = express.Router();
  router.post('/api/events/ticket', (req, res) => res.json(sseTicket.issue()));
  router.get('/api/events', (req, res) => res.json({ connected: true }));
  app.use(router);
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function req(port, path, method = 'GET', headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch (_) { /* nicht-JSON ist ok */ }
        resolve({ status: res.statusCode, body, json });
      });
    });
    r.on('error', reject);
    r.end();
  });
}

// ---------- Ticket-Store ----------

test('Ticket ist einmalig verwendbar', () => {
  const { ticket } = sseTicket.issue();
  assert.strictEqual(sseTicket.consume(ticket), true, 'erster Gebrauch gilt');
  assert.strictEqual(sseTicket.consume(ticket), false, 'Replay muss scheitern');
});

test('unbekannte oder kaputte Tickets werden abgelehnt', () => {
  assert.strictEqual(sseTicket.consume('nicht-existent'), false);
  assert.strictEqual(sseTicket.consume(''), false);
  assert.strictEqual(sseTicket.consume(null), false);
  assert.strictEqual(sseTicket.consume(undefined), false);
  assert.strictEqual(sseTicket.consume(42), false);
  assert.strictEqual(sseTicket.consume({}), false);
});

test('Tickets sind unvorhersagbar und kollidieren nicht', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    const { ticket } = sseTicket.issue();
    assert.match(ticket, /^[0-9a-f]{64}$/, '32 Byte Zufall als Hex erwartet');
    assert.ok(!seen.has(ticket), 'Tickets duerfen sich nicht wiederholen');
    seen.add(ticket);
  }
});

test('Ticket-Store waechst nicht unbegrenzt', () => {
  for (let i = 0; i < sseTicket.MAX_TICKETS + 50; i += 1) sseTicket.issue();
  // Das juengste Ticket muss trotz Cap noch gueltig sein
  const { ticket } = sseTicket.issue();
  assert.strictEqual(sseTicket.consume(ticket), true);
});

// ---------- Auth-Gate ----------

test('der API-Token wird als ?token= NICHT mehr akzeptiert', async () => {
  const app = makeApp();
  const { server, port } = await listen(app);
  try {
    const res = await req(port, `/api/events?token=${TOKEN}`);
    assert.strictEqual(res.status, 401, 'Token in der URL darf nicht mehr authentifizieren');
  } finally {
    server.close();
  }
});

test('gueltiges Ticket verbindet, Replay desselben Tickets nicht', async () => {
  const app = makeApp();
  const { server, port } = await listen(app);
  try {
    const issued = await req(port, '/api/events/ticket', 'POST', {
      Authorization: `Bearer ${TOKEN}`
    });
    assert.strictEqual(issued.status, 200);
    const ticket = issued.json.ticket;
    assert.ok(ticket, 'Ticket erwartet');

    const first = await req(port, `/api/events?ticket=${ticket}`);
    assert.strictEqual(first.status, 200, 'erster Connect muss gelingen');

    const replay = await req(port, `/api/events?ticket=${ticket}`);
    assert.strictEqual(replay.status, 401, 'aus einem Log kopiertes Ticket darf nicht funktionieren');
  } finally {
    server.close();
  }
});

test('Ticket-Ausgabe braucht den Authorization-Header', async () => {
  const app = makeApp();
  const { server, port } = await listen(app);
  try {
    const anon = await req(port, '/api/events/ticket', 'POST');
    assert.strictEqual(anon.status, 401, 'ohne Token kein Ticket');

    // Und der Weg ueber die URL darf hier erst recht nicht offenstehen,
    // sonst waere der Leak-Vektor nur verschoben.
    const viaQuery = await req(port, `/api/events/ticket?token=${TOKEN}`, 'POST');
    assert.strictEqual(viaQuery.status, 401, '?token= darf auf /ticket nicht greifen');
  } finally {
    server.close();
  }
});

test('ein Ticket autorisiert ausschliesslich /api/events', async () => {
  const app = makeApp();
  const { server, port } = await listen(app);
  try {
    const issued = await req(port, '/api/events/ticket', 'POST', {
      Authorization: `Bearer ${TOKEN}`
    });
    const ticket = issued.json.ticket;

    // Selbst wenn ein Ticket aus einem Log faellt: es oeffnet keine andere Route.
    const elsewhere = await req(port, `/api/noten?ticket=${ticket}`);
    assert.strictEqual(elsewhere.status, 401, 'Ticket darf nur den SSE-Stream oeffnen');
  } finally {
    server.close();
  }
});

test('Connect ohne jedes Credential bleibt 401', async () => {
  const app = makeApp();
  const { server, port } = await listen(app);
  try {
    const res = await req(port, '/api/events');
    assert.strictEqual(res.status, 401);
  } finally {
    server.close();
  }
});
