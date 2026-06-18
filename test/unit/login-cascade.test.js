'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { __test } = require('../../src/scraper');

test('isLoggedIn: gültige Session → ok=true + username', async () => {
  const fakePage = { _resp: { ok: true, text: '{"username":"max.muster"}', json: { username: 'max.muster' } } };
  // api() wird via Injection ersetzt: __test.isLoggedIn nutzt den injizierten apiFn
  const res = await __test.isLoggedIn(fakePage, 'https://x/nice2', async () => fakePage._resp);
  assert.equal(res.ok, true);
  assert.equal(res.username, 'max.muster');
});

test('isLoggedIn: anonymous → ok=false', async () => {
  const res = await __test.isLoggedIn({}, 'https://x/nice2', async () => ({ ok: true, text: 'anonymous', json: null }));
  assert.equal(res.ok, false);
});

test('isLoggedIn: HTTP-Fehler → ok=false', async () => {
  const res = await __test.isLoggedIn({}, 'https://x/nice2', async () => ({ ok: false, text: '', json: null }));
  assert.equal(res.ok, false);
});

test('trySilentReSSO: still eingeloggt → true (kein Passwort)', async () => {
  let loggedIn = false;
  const fakePage = {
    goto: async () => { loggedIn = true; },            // Navigation „loggt ein"
    waitForSelector: async () => { await new Promise(r => setTimeout(r, 50)); throw new Error('kein Email-Feld'); },
  };
  const apiFn = async () => loggedIn
    ? { ok: true, text: '{"username":"u"}', json: { username: 'u' } }
    : { ok: true, text: 'anonymous', json: null };
  const ok = await __test.trySilentReSSO(
    fakePage, 'https://x/nice2',
    { baseUrl: 'https://x', timeoutMs: 1000, findSsoButton: async () => ({ click: async () => {} }) },
    () => {}, apiFn
  );
  assert.equal(ok, true);
});

test('trySilentReSSO: Email-Feld erscheint → false (Passwort nötig)', async () => {
  const fakePage = {
    goto: async () => {},
    waitForSelector: async () => true,                 // Email-Feld sofort sichtbar
  };
  const apiFn = async () => ({ ok: true, text: 'anonymous', json: null });
  const ok = await __test.trySilentReSSO(
    fakePage, 'https://x/nice2',
    { baseUrl: 'https://x', timeoutMs: 1000, findSsoButton: async () => ({ click: async () => {} }) },
    () => {}, apiFn
  );
  assert.equal(ok, false);
});
