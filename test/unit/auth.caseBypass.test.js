'use strict';

// Regression: Express-Router matchen case-INSENSITIV, das Auth-Gate verglich
// den Pfad aber byte-exakt (`req.path.startsWith('/api/')`). Dadurch lief
// `GET /API/noten` ohne Token am Gate vorbei und traf trotzdem den Handler —
// ein vollständiger Auth-Bypass für jede /api/*-Route (inkl. POST /API/db/reset).
//
// Dieselbe Lücke betraf die Auth-Failure-Limiter: fehlgeschlagene Versuche
// gegen `/API/...` wurden nie gezählt, der Brute-Force-Lockout griff also nie.
//
// Diese Tests fahren das echte Setup: Router via express.Router() (mit dem
// Default caseSensitive:false, genau wie src/routes/*), Auth-Middleware davor.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

const auth = require('../../src/auth');
const { isApiPath, isEventsPath } = require('../../src/shared/apiPath');

const TOKEN = 'a'.repeat(32);

function makeApp() {
  const app = express();
  const fakeLogger = { log: () => {} };
  app.use(auth.requireAuth({ token: TOKEN, logger: fakeLogger }));

  // Exakt das Mount-Pattern aus src/routes/*: eigener Router, Default-Optionen.
  const router = express.Router();
  router.get('/api/noten', (req, res) => res.json({ secret: 'noten' }));
  router.post('/api/db/reset', (req, res) => res.json({ wiped: true }));
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
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    r.on('error', reject);
    r.end();
  });
}

test('GET /API/noten ohne Token wird NICHT durchgelassen (Auth-Bypass)', async () => {
  const app = makeApp();
  const { server, port } = await listen(app);
  try {
    const res = await req(port, '/API/noten');
    assert.strictEqual(res.status, 401, 'Uppercase-Prefix darf das Auth-Gate nicht umgehen');
    assert.ok(!res.body.includes('noten'), 'Response darf keine Daten enthalten');
  } finally {
    server.close();
  }
});

test('POST /API/db/reset ohne Token wird NICHT durchgelassen', async () => {
  const app = makeApp();
  const { server, port } = await listen(app);
  try {
    const res = await req(port, '/API/db/reset', 'POST');
    assert.strictEqual(res.status, 401, 'destruktive Route darf nicht per Case-Trick erreichbar sein');
  } finally {
    server.close();
  }
});

test('gemischte Schreibweisen werden ebenfalls abgefangen', async () => {
  const app = makeApp();
  const { server, port } = await listen(app);
  try {
    for (const p of ['/Api/noten', '/aPi/noten', '/API/NOTEN']) {
      const res = await req(port, p);
      assert.strictEqual(res.status, 401, `${p} muss 401 liefern`);
    }
  } finally {
    server.close();
  }
});

test('korrekt authentifizierte Requests funktionieren unverändert', async () => {
  const app = makeApp();
  const { server, port } = await listen(app);
  try {
    const res = await req(port, '/api/noten', 'GET', { Authorization: `Bearer ${TOKEN}` });
    assert.strictEqual(res.status, 200);
  } finally {
    server.close();
  }
});

test('isApiPath erkennt jede Schreibweise des /api/-Prefix', () => {
  for (const p of ['/api/x', '/API/x', '/Api/x', '/aPI/x']) {
    assert.strictEqual(isApiPath(p), true, `${p} muss als API-Pfad gelten`);
  }
  for (const p of ['/mobile/css/base.css', '/assets/logo.png', '/healthz', '/apix/y', '/api']) {
    assert.strictEqual(isApiPath(p), false, `${p} darf NICHT als API-Pfad gelten`);
  }
  // Robust gegen fehlenden/kaputten Input (skip-Prädikate laufen sehr früh)
  assert.strictEqual(isApiPath(undefined), false);
  assert.strictEqual(isApiPath(null), false);
});

test('isEventsPath erkennt den SSE-Pfad case-insensitiv', () => {
  for (const p of ['/api/events', '/API/events', '/Api/Events']) {
    assert.strictEqual(isEventsPath(p), true, `${p} muss als SSE-Pfad gelten`);
  }
  assert.strictEqual(isEventsPath('/api/events/ticket'), false);
  assert.strictEqual(isEventsPath('/api/noten'), false);
});
