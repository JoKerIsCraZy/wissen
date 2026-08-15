'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { parseTrustProxy, TRUST_PROXY_DEFAULT } = require('../../src/auth');

// Regression: der frühere Default `1` liess Express den letzten
// X-Forwarded-For-Eintrag als req.ip übernehmen — auch ohne Proxy davor.
// Da der Server auf 0.0.0.0 bindet (und docker-compose.yml 3000:3000 ohne
// Proxy published), konnte ein direkt verbundener Angreifer pro Request eine
// neue Fake-IP setzen und bekam damit jedes Mal einen frischen Rate-Limit-
// Bucket. Der Auth-Lockout (10/15min bzw. 50/6h) hat dadurch nie gegriffen.

test('parseTrustProxy unset → loopback (kein blindes XFF-Vertrauen)', () => {
  assert.strictEqual(parseTrustProxy(undefined), 'loopback');
  assert.strictEqual(parseTrustProxy(null), 'loopback');
  assert.strictEqual(parseTrustProxy(''), 'loopback');
  assert.strictEqual(TRUST_PROXY_DEFAULT, 'loopback');
});

test('parseTrustProxy integer string → number (explizites Opt-in bleibt möglich)', () => {
  assert.strictEqual(parseTrustProxy('0'), 0);
  assert.strictEqual(parseTrustProxy('1'), 1);
  assert.strictEqual(parseTrustProxy('2'), 2);
});

test('parseTrustProxy "true"/"false" → boolean', () => {
  assert.strictEqual(parseTrustProxy('true'), true);
  assert.strictEqual(parseTrustProxy('false'), false);
});

test('parseTrustProxy "loopback" → "loopback"', () => {
  assert.strictEqual(parseTrustProxy('loopback'), 'loopback');
});

test('parseTrustProxy CIDR list → array', () => {
  assert.deepStrictEqual(
    parseTrustProxy('10.0.0.0/8,127.0.0.1'),
    ['10.0.0.0/8', '127.0.0.1']
  );
});

test('parseTrustProxy single CIDR → string', () => {
  assert.strictEqual(parseTrustProxy('192.168.0.0/16'), '192.168.0.0/16');
});

test('parseTrustProxy unlesbarer Wert → loopback statt 1 Hop', () => {
  // Ein Tippfehler darf nicht in "vertraue dem XFF-Header" resultieren.
  assert.strictEqual(parseTrustProxy('ja-bitte'), 'loopback');
  assert.strictEqual(parseTrustProxy('nonsense,auch-nonsense'), 'loopback');
});

// ---------- Verhaltenstest gegen echtes Express ----------
//
// Geprüft wird die von Express kompilierte Trust-Funktion (addr, hopIndex) =>
// bool. Sie entscheidet, ob ein Absender als vertrauenswürdiger Proxy gilt und
// sein X-Forwarded-For also req.ip setzen darf. Das ist exakt die Eigenschaft,
// an der die Luecke hing — und sie laesst sich hier direkt pruefen, ohne einen
// Socket von einer Nicht-Loopback-Adresse zu brauchen.

test('Default vertraut nur Loopback-Hops — ein direkter Client kann req.ip nicht setzen', () => {
  const app = express();
  app.set('trust proxy', parseTrustProxy(undefined));
  const trust = app.get('trust proxy fn');

  // Reverse-Proxy auf demselben Host: vertrauenswürdig (der übliche Fall).
  assert.strictEqual(trust('127.0.0.1', 0), true);
  assert.strictEqual(trust('::1', 0), true);

  // Genau das ist der Fix: ein direkt verbundener Client — ob aus dem LAN
  // oder aus dem Internet — gilt NICHT als Proxy. Sein X-Forwarded-For wird
  // ignoriert, req.ip bleibt die echte Socket-Adresse, und der Rate-Limiter
  // bucketet ihn korrekt.
  assert.strictEqual(trust('192.168.1.50', 0), false, 'LAN-Client darf nicht als Proxy gelten');
  assert.strictEqual(trust('203.0.113.7', 0), false, 'Internet-Client darf nicht als Proxy gelten');
  assert.strictEqual(trust('10.0.0.5', 0), false, 'Docker-Bridge-Adresse ist kein impliziter Proxy');
});

test('Kontrolltest: der alte Default 1 vertraute JEDEM direkten Peer', () => {
  const app = express();
  app.set('trust proxy', 1);
  const trust = app.get('trust proxy fn');
  // Mit hop-count 1 ist jeder Absender an Position 0 vertrauenswürdig — egal
  // welche Adresse. Genau dadurch konnte ein beliebiger Client req.ip via
  // X-Forwarded-For frei waehlen und pro Request einen neuen Limiter-Bucket
  // bekommen.
  assert.strictEqual(trust('203.0.113.7', 0), true, 'das war die Luecke');
  assert.strictEqual(trust('192.168.1.50', 0), true);
});

test('explizites TRUST_PROXY=1 bleibt fuer Proxy-Setups moeglich', () => {
  const app = express();
  app.set('trust proxy', parseTrustProxy('1'));
  const trust = app.get('trust proxy fn');
  assert.strictEqual(trust('172.18.0.2', 0), true, 'Opt-in muss weiterhin funktionieren');
});
