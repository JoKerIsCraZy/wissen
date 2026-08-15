'use strict';

// Regression: der Auth-Failure-Limiter (10 Fehlversuche / 15min / IP) sprang
// bei `/API/...` nie an, weil sein skip-Prädikat byte-exakt auf '/api/' prüfte,
// die Route aber case-insensitiv matchte. Token-Raten war damit unbegrenzt
// möglich: der 15min- und der 6h-Lockout wurden schlicht nie erreicht.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

const auth = require('../../src/auth');
const ratelimitsFactory = require('../../src/ratelimits');

const TOKEN = 'a'.repeat(32);

function makeApp() {
  const app = express();
  const fakeLogger = { log: () => {} };
  const ratelimits = ratelimitsFactory.create({ logger: fakeLogger });

  // Mount-Reihenfolge wie in src/server.js
  app.use(ratelimits.authFailureLimiter);
  app.use(auth.requireAuth({ token: TOKEN, logger: fakeLogger }));

  const router = express.Router();
  router.get('/api/settings', (req, res) => res.json({ ok: true }));
  app.use(router);
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: '127.0.0.1', port, path, method: 'GET', headers: { Authorization: 'Bearer wrong' } },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    r.on('error', reject);
    r.end();
  });
}

test('Fehlversuche gegen /API/... zaehlen auf den Lockout ein', async () => {
  const app = makeApp();
  const { server, port } = await listen(app);
  try {
    // Limit ist 10 Fehlversuche pro 15min. Die ersten 10 liefern 401,
    // ab dem 11. muss der Limiter mit 429 sperren — trotz Uppercase-Pfad.
    let sawLockout = false;
    for (let i = 0; i < 14; i += 1) {
      const res = await get(port, '/API/settings');
      assert.notStrictEqual(res.status, 200, 'falscher Token darf nie 200 liefern');
      if (res.status === 429) { sawLockout = true; break; }
    }
    assert.ok(sawLockout, 'Brute-Force gegen /API/... muss in den Lockout laufen');
  } finally {
    server.close();
  }
});
