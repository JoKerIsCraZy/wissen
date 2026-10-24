'use strict';

// Regression: Node2Shell (CVE-2026-111497) — Out-of-bounds-Write im
// Brotli-Decoder von Node.js. body-parser 2.x entpackt Request-Bodies mit
// `Content-Encoding: br` automatisch über node:zlib, und server.js mountet
// den JSON-Parser global VOR Healthcheck und Auth. Jeder, der Port 3000
// erreicht, konnte so ohne Token einen präparierten Brotli-Stream in den
// Decoder schieben. Das Body-Limit half nicht: es zählt die entpackten Bytes,
// der Overflow passiert schon beim Entpacken.
//
// jsonBody() muss jedes Content-Encoding ausser identity mit 415 ablehnen,
// bevor zlib überhaupt angefasst wird — und darf sonst nichts ändern.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const zlib = require('node:zlib');
const express = require('express');

const { jsonBody } = require('../../src/jsonBody');

const PAYLOAD = JSON.stringify({ hello: 'world' });

function makeApp(parser) {
  const app = express();
  let handlerCalls = 0;
  app.use(parser);
  app.post('/api/echo', (req, res) => {
    handlerCalls++;
    res.json({ body: req.body });
  });
  // Wie der Error-Handler in server.js: err.status an den Client durchreichen.
  app.use((err, req, res, _next) => {
    res.status(err.status || 500).json({ error: err.type || err.message });
  });
  return { app, calls: () => handlerCalls };
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

function post(port, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/api/echo',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length, ...headers }
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(text) });
        } catch (_) {
          reject(new Error(`Antwort ist kein JSON (HTTP ${res.statusCode}): ${text.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function withServer(parser, fn) {
  const { app, calls } = makeApp(parser);
  const { server, port } = await listen(app);
  try {
    await fn(port, calls);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('jsonBody parst unkomprimiertes JSON wie gewohnt', async () => {
  await withServer(jsonBody('8kb'), async (port, calls) => {
    const res = await post(port, Buffer.from(PAYLOAD));
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.json.body, { hello: 'world' });
    assert.strictEqual(calls(), 1);
  });
});

test('jsonBody akzeptiert explizites Content-Encoding: identity', async () => {
  await withServer(jsonBody('8kb'), async (port) => {
    const res = await post(port, Buffer.from(PAYLOAD), { 'Content-Encoding': 'identity' });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.json.body, { hello: 'world' });
  });
});

test('jsonBody lehnt Brotli-Bodies mit 415 ab, bevor der Decoder läuft', async () => {
  await withServer(jsonBody('8kb'), async (port, calls) => {
    const res = await post(port, zlib.brotliCompressSync(PAYLOAD), { 'Content-Encoding': 'br' });
    assert.strictEqual(res.status, 415);
    assert.strictEqual(res.json.error, 'encoding.unsupported');
    assert.strictEqual(calls(), 0, 'Route-Handler darf nie erreicht werden');
  });
});

test('jsonBody lehnt auch gzip und deflate ab — kein WISSen-Client komprimiert Bodies', async () => {
  const cases = [
    ['gzip', zlib.gzipSync],
    ['deflate', zlib.deflateSync]
  ];
  await withServer(jsonBody('8kb'), async (port, calls) => {
    for (const [encoding, compress] of cases) {
      const res = await post(port, compress(PAYLOAD), { 'Content-Encoding': encoding });
      assert.strictEqual(res.status, 415, `${encoding} muss abgelehnt werden`);
    }
    assert.strictEqual(calls(), 0);
  });
});

test('jsonBody lehnt auch Header-Varianten ab (Gross-/Kleinschreibung, Whitespace, Ketten)', async () => {
  const body = zlib.brotliCompressSync(PAYLOAD);
  await withServer(jsonBody('8kb'), async (port, calls) => {
    for (const encoding of ['BR', ' br ', 'br, gzip', 'identity, br']) {
      const res = await post(port, body, { 'Content-Encoding': encoding });
      assert.strictEqual(res.status, 415, `"${encoding}" muss abgelehnt werden`);
    }
    assert.strictEqual(calls(), 0);
  });
});

test('jsonBody behält das Größenlimit bei', async () => {
  const big = Buffer.from(JSON.stringify({ blob: 'x'.repeat(5 * 1024) }));
  await withServer(jsonBody('4kb'), async (port, calls) => {
    const res = await post(port, big);
    assert.strictEqual(res.status, 413);
    assert.strictEqual(calls(), 0);
  });
});

test('server.js mountet keinen nackten express.json() — sonst wäre der Decoder wieder erreichbar', () => {
  // Der Helper allein schützt nichts, wenn server.js ihn umgeht. Reine
  // Kommentarzeilen werden übersprungen, damit Erklärtexte nicht matchen.
  // Bewusst zeilenbasiert statt Regex-Stripping: Strings wie '/api/*' sähen
  // sonst wie ein Blockkommentar aus und würden echten Code verschlucken.
  const codeLines = fs.readFileSync(path.join(__dirname, '../../src/server.js'), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line));
  const bare = codeLines.filter((line) => /express\.(json|raw|text|urlencoded)\s*\(/.test(line));
  assert.deepStrictEqual(bare, [], 'server.js muss jsonBody() statt express.json() verwenden');
  assert.ok(codeLines.some((line) => /jsonBody\(/.test(line)), 'jsonBody() wird nicht gemountet');
});

test('Kontrolltest: express.json() ohne inflate:false entpackt Brotli — genau die Angriffsfläche', async () => {
  await withServer(express.json({ limit: '8kb' }), async (port) => {
    const res = await post(port, zlib.brotliCompressSync(PAYLOAD), { 'Content-Encoding': 'br' });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.json.body, { hello: 'world' });
  });
});
