'use strict';

// Unit-Tests für die Absenzen-Route-Validatoren + Response-Shapes (Agent D).
// Wir mounten die echte Router-Factory mit gestubbten deps und treiben die
// registrierten Handler direkt über Fake-req/res — kein TCP-Server, also reine
// Validierungs-/Handler-Logik (Route-E2E ist Integration und separat).

const test = require('node:test');
const assert = require('node:assert/strict');

const absenzenFactory = require('../../src/routes/absenzen');
const notenFactory = require('../../src/routes/noten');

// ---- Mini-Test-Harness: Handler aus dem express-Router-Stack ziehen + rufen ---

function findHandler(router, method, path) {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === path && l.route.methods[method]
  );
  if (!layer) throw new Error(`no ${method} ${path} handler`);
  // Letzter Handler in der Layer-Chain ist der eigentliche Route-Callback
  // (vorher können Middleware-Layer wie ratelimits sitzen).
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

// =============================================================================
// GET /api/absenzen
// =============================================================================

test('GET /api/absenzen → rows, count, stats-Tripel und fetchedAt', () => {
  const rows = [{ kuerzel_code: 'UIFZ-2524-020-S1-UEK-106' }, { kuerzel_code: 'X-1-A' }];
  const db = {
    getAbsenzen: () => rows,
    getAbsenzenStats: () => ({
      avgAnwesenheit: 95.5,
      unterMinimum: 2,
      abwesendGesamt: 7,
      lastFetchedAbsenzen: '2026-05-29T12:00:00Z'
    })
  };
  const router = absenzenFactory({ db, logger: noopLogger, database: {} });

  const res = callRoute(router, 'get', '/api/absenzen');

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.count, 2);
  assert.deepEqual(res.body.rows, rows);
  assert.deepEqual(res.body.stats, { avgAnwesenheit: 95.5, unterMinimum: 2, abwesendGesamt: 7 });
  assert.equal(res.body.fetchedAt, '2026-05-29T12:00:00Z');
});

test('GET /api/absenzen → fetchedAt fällt auf null wenn kein lastFetched', () => {
  const db = {
    getAbsenzen: () => [],
    getAbsenzenStats: () => ({ avgAnwesenheit: null, unterMinimum: 0, abwesendGesamt: 0 })
  };
  const router = absenzenFactory({ db, logger: noopLogger, database: {} });

  const res = callRoute(router, 'get', '/api/absenzen');

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.count, 0);
  assert.equal(res.body.fetchedAt, null);
});

test('GET /api/absenzen → DB-Fehler ergibt generischen 500 ohne e.message-Leak', () => {
  const secret = 'SQLITE_ERROR: no such column: absenzen.secret_path /opt/app/data.db';
  const logged = [];
  const db = {
    getAbsenzen: () => { throw new Error(secret); },
    getAbsenzenStats: () => ({})
  };
  const logger = { log: (m) => logged.push(m) };
  const router = absenzenFactory({ db, logger, database: {} });

  const res = callRoute(router, 'get', '/api/absenzen');

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, 'Ein Datenbankfehler ist aufgetreten');
  assert.ok(!String(res.body.error).includes('SQLITE_ERROR'));
  // Voller Fehler nur serverseitig im Log
  assert.ok(logged.some((m) => m.includes(secret)));
});

// =============================================================================
// GET /api/absenzen/:code/termine
// =============================================================================

test('GET /:code/termine → modul + rows bei gültigem Code', () => {
  const modul = { kuerzel_code: 'UIFZ-2524-020-S1-UEK-106', bezeichnung: '106 - Datenbanken' };
  const lektionen = [{ termin_iso: '2025-10-13', status: 'teilgenommen' }];
  const db = {
    getAbsenzRow: (_d, code) => (code === modul.kuerzel_code ? modul : null),
    getLektionen: () => lektionen
  };
  const router = absenzenFactory({ db, logger: noopLogger, database: {} });

  const res = callRoute(router, 'get', '/api/absenzen/:code/termine', {
    params: { code: 'UIFZ-2524-020-S1-UEK-106' }
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.modul, modul);
  assert.deepEqual(res.body.rows, lektionen);
});

test('GET /:code/termine → unbekannter Code liefert modul:null statt Fehler', () => {
  const db = { getAbsenzRow: () => null, getLektionen: () => [] };
  const router = absenzenFactory({ db, logger: noopLogger, database: {} });

  const res = callRoute(router, 'get', '/api/absenzen/:code/termine', {
    params: { code: 'GIBTS-1-NICHT' }
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.modul, null);
  assert.deepEqual(res.body.rows, []);
});

test('GET /:code/termine → leerer Code → 400, DB nie berührt', () => {
  let touched = false;
  const db = {
    getAbsenzRow: () => { touched = true; return null; },
    getLektionen: () => { touched = true; return []; }
  };
  const router = absenzenFactory({ db, logger: noopLogger, database: {} });

  const res = callRoute(router, 'get', '/api/absenzen/:code/termine', { params: { code: '' } });

  assert.equal(res.statusCode, 400);
  assert.equal(touched, false);
});

test('GET /:code/termine → zu langer Code (>128) → 400', () => {
  const db = { getAbsenzRow: () => null, getLektionen: () => [] };
  const router = absenzenFactory({ db, logger: noopLogger, database: {} });

  const longCode = 'A'.repeat(129);
  const res = callRoute(router, 'get', '/api/absenzen/:code/termine', { params: { code: longCode } });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'Ungültiger code');
});

test('GET /:code/termine → Injection-Zeichen (Leerzeichen/Quotes) → 400', () => {
  let touched = false;
  const db = {
    getAbsenzRow: () => { touched = true; return null; },
    getLektionen: () => { touched = true; return []; }
  };
  const router = absenzenFactory({ db, logger: noopLogger, database: {} });

  for (const bad of ["UEK-106' OR 1=1", 'has space', 'semi;colon', 'pipe|x', 'star*']) {
    const res = callRoute(router, 'get', '/api/absenzen/:code/termine', { params: { code: bad } });
    assert.equal(res.statusCode, 400, `expected 400 for ${bad}`);
  }
  assert.equal(touched, false);
});

test('GET /:code/termine → erlaubte Code-Zeichen (-, ., /, :) passieren', () => {
  let seenCode = null;
  const db = { getAbsenzRow: (_d, code) => { seenCode = code; return null; }, getLektionen: () => [] };
  const router = absenzenFactory({ db, logger: noopLogger, database: {} });

  const code = 'UIFZ-2524-020-S1-UEK-106.x/y:z';
  const res = callRoute(router, 'get', '/api/absenzen/:code/termine', { params: { code } });

  assert.equal(res.statusCode, 200);
  assert.equal(seenCode, code);
});

// =============================================================================
// noten.js — /api/seen & /api/dismiss akzeptieren jetzt zusätzlich 'absenzen'
// =============================================================================

function makeNotenRouter() {
  const seen = [];
  const dismissed = [];
  const db = {
    markSeen: (_d, kind, ids) => { seen.push({ kind, ids }); return ids.length; },
    dismissChanges: (_d, kind, ids) => {
      dismissed.push({ kind, ids });
      return ids == null ? 99 : ids.length;
    }
  };
  const router = notenFactory({ db, logger: noopLogger, database: {} });
  return { router, seen, dismissed };
}

test('POST /api/seen akzeptiert kind:"absenzen" und routet an markSeen', () => {
  const { router, seen } = makeNotenRouter();

  const res = callRoute(router, 'post', '/api/seen', {
    body: { kind: 'absenzen', ids: ['UIFZ-2524-020-S1-UEK-106', 'X-1-A'] }
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.updated, 2);
  assert.deepEqual(seen, [{ kind: 'absenzen', ids: ['UIFZ-2524-020-S1-UEK-106', 'X-1-A'] }]);
});

test('POST /api/seen lehnt unbekanntes kind weiterhin ab', () => {
  const { router } = makeNotenRouter();

  const res = callRoute(router, 'post', '/api/seen', { body: { kind: 'quatsch', ids: ['a'] } });

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /absenzen/);
});

test('POST /api/dismiss mit kind:"absenzen" + ids routet an dismissChanges', () => {
  const { router, dismissed } = makeNotenRouter();

  const res = callRoute(router, 'post', '/api/dismiss', {
    body: { kind: 'absenzen', ids: ['UIFZ-2524-020-S1-UEK-106'] }
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.dismissed, { noten: 0, stundenplan: 0, absenzen: 1 });
  assert.deepEqual(dismissed, [{ kind: 'absenzen', ids: ['UIFZ-2524-020-S1-UEK-106'] }]);
});

test('POST /api/dismiss kind:"absenzen" ohne ids → dismissAll für absenzen', () => {
  const { router, dismissed } = makeNotenRouter();

  const res = callRoute(router, 'post', '/api/dismiss', { body: { kind: 'absenzen' } });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.dismissed.absenzen, 99);
  assert.deepEqual(dismissed, [{ kind: 'absenzen', ids: null }]);
});

test('POST /api/dismiss all:true dismisst noten, stundenplan UND absenzen', () => {
  const { router, dismissed } = makeNotenRouter();

  const res = callRoute(router, 'post', '/api/dismiss', { body: { all: true } });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.dismissed, { noten: 99, stundenplan: 99, absenzen: 99 });
  assert.deepEqual(
    dismissed.map((d) => d.kind),
    ['noten', 'stundenplan', 'absenzen']
  );
});
