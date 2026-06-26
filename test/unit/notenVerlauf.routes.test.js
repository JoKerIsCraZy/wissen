'use strict';

// Unit-Tests für die GET /api/noten/verlauf-Route (Agent B, Blueprint §8b).
// Wir mounten die echte notenRoutes-Factory mit gestubbten deps und treiben
// den registrierten Handler direkt über Fake-req/res — kein TCP-Server.
//
// Besonderheit: getNotenStats wird in noten.js DIREKT aus ../db/stats
// importiert (nicht über deps.db). Damit wir lastFetchedNoten deterministisch
// steuern können, stubben wir dieses Modul im require-Cache BEVOR die Factory
// geladen wird (das Destructuring greift den Wert beim Laden ab).

const test = require('node:test');
const assert = require('node:assert/strict');

const statsPath = require.resolve('../../src/db/stats');
let stubStats = () => ({ lastFetchedNoten: null });
require.cache[statsPath] = {
  id: statsPath,
  filename: statsPath,
  loaded: true,
  exports: { getNotenStats: () => stubStats() }
};

const notenFactory = require('../../src/routes/noten');
const { MAX_VERLAUF_DAYS } = require('../../src/db/notenVerlauf');

// ---- Mini-Test-Harness: Handler aus dem express-Router-Stack ziehen + rufen ---

function findHandler(router, method, path) {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === path && l.route.methods[method]
  );
  if (!layer) throw new Error(`no ${method} ${path} handler`);
  const handlers = layer.route.stack.map((s) => s.handle);
  return handlers[handlers.length - 1];
}

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}

function callRoute(router, method, path, { params = {}, query = {}, body = {} } = {}) {
  const handler = findHandler(router, method, path);
  const req = { params, query, body };
  const res = fakeRes();
  handler(req, res);
  return res;
}

const noopLogger = { log() {} };

// Baut einen noten-Router mit gestubbter db.getNotenVerlauf + getNotenStats.
function makeRouter({ points = [], lastFetchedNoten = null } = {}) {
  stubStats = () => ({ lastFetchedNoten });
  const calls = [];
  const db = {
    getNotenVerlauf: (_d, opts) => {
      calls.push(opts);
      return points;
    }
  };
  const router = notenFactory({ db, logger: noopLogger, database: {} });
  return { router, calls };
}

// =============================================================================
// GET /api/noten/verlauf — Parameter-Validierung
// =============================================================================

test('GET /api/noten/verlauf?days=abc returns 400', () => {
  const { router, calls } = makeRouter();

  const res = callRoute(router, 'get', '/api/noten/verlauf', { query: { days: 'abc' } });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'Ungültiger days-Parameter');
  assert.equal(calls.length, 0, 'DB darf bei ungültigem Parameter nicht berührt werden');
});

test('GET /api/noten/verlauf?days=0 returns 400', () => {
  const { router, calls } = makeRouter();

  const res = callRoute(router, 'get', '/api/noten/verlauf', { query: { days: '0' } });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'Ungültiger days-Parameter');
  assert.equal(calls.length, 0);
});

test('GET /api/noten/verlauf?days=-5 returns 400', () => {
  const { router, calls } = makeRouter();

  const res = callRoute(router, 'get', '/api/noten/verlauf', { query: { days: '-5' } });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'Ungültiger days-Parameter');
  assert.equal(calls.length, 0);
});

test('GET /api/noten/verlauf?days=99999 clamps and echoes days===365', () => {
  const { router, calls } = makeRouter({ points: [] });

  const res = callRoute(router, 'get', '/api/noten/verlauf', { query: { days: '99999' } });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.days, MAX_VERLAUF_DAYS);
  assert.equal(res.body.days, 365);
  // Die geklammerte Fensterbreite wird an die DB-Schicht durchgereicht.
  assert.deepEqual(calls, [{ days: 365 }]);
});

test('trend is null for a single-point series', () => {
  const points = [{ day: '2026-06-26', value: 5.2, count: 11 }];
  const { router } = makeRouter({ points });

  const res = callRoute(router, 'get', '/api/noten/verlauf');

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.trend, null);
  assert.equal(res.body.first, '2026-06-26');
  assert.equal(res.body.last, '2026-06-26');
  assert.deepEqual(res.body.points, points);
});

test('trend/first/last are computed over the full returned points array', () => {
  const points = [
    { day: '2026-05-01', value: 4.0, count: 3 },
    { day: '2026-05-15', value: 4.6, count: 7 },
    { day: '2026-06-26', value: 5.2, count: 11 }
  ];
  const { router } = makeRouter({ points });

  const res = callRoute(router, 'get', '/api/noten/verlauf');

  assert.equal(res.statusCode, 200);
  // trend = round1(last - first) = round1(5.2 - 4.0) = 1.2
  assert.equal(res.body.trend, 1.2);
  assert.equal(res.body.first, '2026-05-01');
  assert.equal(res.body.last, '2026-06-26');
  assert.equal(res.body.points.length, 3);
});

test('fetchedAt mirrors getNotenStats().lastFetchedNoten', () => {
  const stamp = '2026-06-26T14:00:00.000Z';
  const points = [
    { day: '2026-05-01', value: 4.0, count: 3 },
    { day: '2026-06-26', value: 5.2, count: 11 }
  ];
  const { router } = makeRouter({ points, lastFetchedNoten: stamp });

  const res = callRoute(router, 'get', '/api/noten/verlauf');

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.fetchedAt, stamp);
});

test('GET /api/noten/verlauf returns 500 when db.getNotenVerlauf throws', () => {
  stubStats = () => ({ lastFetchedNoten: null });
  const db = {
    getNotenVerlauf: () => {
      throw new Error('disk I/O error');
    }
  };
  const router = notenFactory({ db, logger: noopLogger, database: {} });

  const res = callRoute(router, 'get', '/api/noten/verlauf');

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, 'Ein Datenbankfehler ist aufgetreten');
});

test('GET /api/noten/verlauf?days=[array] returns 400 (kein parseInt-Durchschlupf)', () => {
  const { router, calls } = makeRouter();

  // Express parst ?days=1&days=2 zu ['1','2'] — der Array-Guard muss 400 liefern,
  // statt still das erste Element zu nehmen.
  const res = callRoute(router, 'get', '/api/noten/verlauf', { query: { days: ['1', '2'] } });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'Ungültiger days-Parameter');
  assert.equal(calls.length, 0);
});
