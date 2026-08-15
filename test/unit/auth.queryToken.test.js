'use strict';

// Verifies that the API token is accepted ONLY via the Authorization header —
// auf keiner Route mehr als `?token=` im Query-String.
//
// Frueher war /api/events die Ausnahme, weil EventSource keine Custom-Header
// setzen kann. Der Token landete dadurch in jedem Reverse-Proxy-Access-Log.
// Ersetzt durch kurzlebige Einmal-Tickets (siehe test/unit/sseTicket.test.js).

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

const auth = require('../../src/auth');

const TOKEN = 'a'.repeat(32);

function makeApp() {
  const app = express();
  const fakeLogger = { log: () => {} };
  app.use(auth.requireAuth({ token: TOKEN, logger: fakeLogger }));
  app.get('/api/status', (req, res) => res.json({ ok: true }));
  app.get('/api/events', (req, res) => res.json({ ok: true }));
  app.get('/non-api', (req, res) => res.json({ ok: true }));
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('Authorization Bearer header works on /api/status', async () => {
  const app = makeApp();
  const { server, port } = await listen(app);
  try {
    const res = await get(port, '/api/status', { Authorization: `Bearer ${TOKEN}` });
    assert.strictEqual(res.status, 200);
  } finally {
    server.close();
  }
});

test('?token= query is REJECTED on /api/status (non-events)', async () => {
  const app = makeApp();
  const { server, port } = await listen(app);
  try {
    const res = await get(port, `/api/status?token=${TOKEN}`);
    assert.strictEqual(res.status, 401, '?token= must NOT authenticate non-events endpoints');
  } finally {
    server.close();
  }
});

test('?token= query is REJECTED on /api/events too (no exception left)', async () => {
  const app = makeApp();
  const { server, port } = await listen(app);
  try {
    const res = await get(port, `/api/events?token=${TOKEN}`);
    assert.strictEqual(
      res.status, 401,
      'der Token darf auf KEINER Route mehr aus der URL akzeptiert werden'
    );
  } finally {
    server.close();
  }
});

test('non-api routes pass through without auth', async () => {
  const app = makeApp();
  const { server, port } = await listen(app);
  try {
    const res = await get(port, '/non-api');
    assert.strictEqual(res.status, 200);
  } finally {
    server.close();
  }
});

test('missing token returns 401 on /api/status', async () => {
  const app = makeApp();
  const { server, port } = await listen(app);
  try {
    const res = await get(port, '/api/status');
    assert.strictEqual(res.status, 401);
  } finally {
    server.close();
  }
});

test('wrong token returns 401', async () => {
  const app = makeApp();
  const { server, port } = await listen(app);
  try {
    const res = await get(port, '/api/status', { Authorization: 'Bearer wrong-token' });
    assert.strictEqual(res.status, 401);
  } finally {
    server.close();
  }
});
