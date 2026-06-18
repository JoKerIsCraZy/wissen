# MS-SSO-Login Beschleunigung — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Den Login-Flow von 15-20 s auf ~3-5 s im Normalfall bringen, indem die noch gültige Microsoft-Session wiederverwendet wird statt sie zu verwerfen, plus Entfernen blinder Wartezeiten.

**Architecture:** 3-Stufen-Kaskade in `ensureLoggedIn` (`src/scraper.js`): (1) gecachte Tocco-Session, (2) **neu**: stiller Re-SSO über den noch gültigen MS-Cookie, (3) voller E-Mail/Passwort-Login (heutige Methode, unverändert als Fallback). Stufe 2 wird **additiv** eingebaut; der gehärtete Volllogin bleibt byte-für-byte erhalten.

**Tech Stack:** Node.js (CommonJS), Playwright (chromium), `node:test` Unit-Tests, AES-256-GCM `secretCrypto` (unverändert).

## Global Constraints

- **Keine Crypto-Änderung.** `storage.json` bleibt verschlüsselt via `storageCrypto` (`enc:v1:`). Kein Wechsel auf `launchPersistentContext`/Klartext-Profil.
- **Stufe 3 (voller Login, `scraper.js:196-443`) bleibt logisch unverändert** außer den Sleep-Ersetzungen aus Task 6/7. Der neue Code darf den Volllogin-Fallback nicht brechen.
- **Keine Secrets/Cookie-Werte loggen.** Bestehende `redact()`-Nutzung beibehalten.
- **Gekappte Timeouts** auf jeden neuen Warte-Schritt — ein fehlgeschlagener stiller Versuch darf seine Wartezeit nicht oben auf den Volllogin draufpacken.
- Login-Verhalten ist fragil (viele Härtungs-Iterationen laut Code-Kommentaren) — additiv arbeiten, nicht umschreiben.

---

## Hintergrund / Diagnose (belegt am 2026-06-18)

Entschlüsselte `data/storage.json` enthielt:

| Cookie | Domain | Ablauf |
|--------|--------|--------|
| `ESTSAUTHPERSISTENT` | `.login.microsoftonline.com` | 2026-09-16 — **89 Tage gültig** ✅ |
| `ESTSAUTH` | `.login.microsoftonline.com` | Session |
| `nice_auth` | `wiss.tocco.ch` | 2026-06-18 11:30 — **abgelaufen** ❌ |
| `JSESSIONID` | `wiss.tocco.ch` | Session |

**Mechanismus:** Microsofts persistenter Cookie lebt 89 Tage (KMSI greift). Toccos `nice_auth` läuft nach Stunden ab → `/username` = anonymous → Cache-Miss. Heute macht `ensureLoggedIn` dann `browser.newContext()` **clean** (`scraper.js:202`) und wirft den gültigen MS-Cookie weg → voller Login. Live verifiziert: SSO-Button-Klick mit gültigem MS-Cookie ergibt nur Redirects (`/sso → login.microsoftonline.com/authorize → /nice2/sso-callback?code=… → ?openidStatus=successful`), **kein** Passwort.

**Fix:** Bei Cache-Miss mit vorhandenem State erst den **geseedeten** Context den SSO-Button klicken lassen (stiller Re-SSO). Nur wenn auch das MS-Cookie tot ist → voller Login.

**Live-verifiziert (2026-06-18, per Wegwerf-Test-Skript — inzwischen entfernt):** State geladen, `*.tocco.ch`-Cookies im RAM gestrippt (Tocco tot, MS-Cookie intakt). Ergebnis: `ESTSAUTHPERSISTENT` 89.8 Tage gültig, `nice_auth` abgelaufen → SSO-Button-Klick (gefunden via **Strategie 2** `getByRole('button', {name:/Office 365/i})`) loggt **ohne Passwort** in ~1.2 s ein, gesamt ~3.2 s ab Navigation. **Kritischer Fund:** Der Button erscheint erst **~1.5 s nach `domcontentloaded`** (SPA-Render). Eine Suche **direkt** nach `page.goto` liefert `null` → der erste Testlauf fiel fälschlich auf den Volllogin zurück. `trySilentReSSO` MUSS den Button mit Settle-Retry suchen (nicht einmalig sofort). Konstante dafür: `SSO_BUTTON_SETTLE_MS` (≈4000, gekappt durch `timeoutMs`), definiert neben `findSsoButton`.

---

## Aktueller Code — Ankerpunkte (`src/scraper.js`)

- `ensureLoggedIn(config, onLog, onPhase, onBrowser)` — ~Zeile 160-458.
- **Stufe 1 (Cache):** Zeile 176-194. `readStorageState()` → `browser.newContext({ storageState })` → `pg.goto(baseUrl)` → `pg.waitForTimeout(1500)` (Z.183) → `api(pg, restBase, '/username')`. Gültig = `chk.ok && !chk.text.includes('anonymous')`.
- **Stufe 2 (heute clean):** Zeile 202 `const context = await browser.newContext();`
- **SSO-Button-Strategien:** Zeile 222-239 (`getByRole('button', { name: /Office\s*365/i })` u.a.).
- **E-Mail-Feld-Selektor:** Zeile 289 `const emailSel = 'input[type="email"]:visible, input[name="loginfmt"]:visible';`
- **Logged-in-Check:** `api(page, restBase, '/username')`, `restBase = baseUrl + '/nice2'` (Z.162).
- **Doppel-Navigation am Ende:** Zeile 401-404 **und** 412-413 (zweimal `page.goto(baseUrl)` + Sleep).
- **Blinde Sleeps:** Z.183 (1500, Cache), 208 (1500), 294 (300), 299 (1500), 333 (200), 346 (300), 369 (300), 404 (2000), 413 (1500).
- Tests: `test/unit/*.test.js`, `node:test` + `node:assert` (siehe `test/unit/safeEvaluate.test.js`, `storageState.test.js`).
- Test-Runner: `npm test` (siehe `package.json`).

---

## File Structure

- **Modify:** `src/scraper.js` — neue Helper `isLoggedIn(page, restBase)` und `trySilentReSSO(...)`; Kaskade in `ensureLoggedIn`; Sleep-Ersetzungen; Doppel-Nav entfernen.
- **Create:** `test/unit/login-cascade.test.js` — Unit-Tests für `isLoggedIn` + die Branch-Entscheidung von `trySilentReSSO` gegen Fake-Page-Objekte.
- Keine weiteren Dateien. Crypto, loginBridge, runScrape unberührt.

---

### Task 1: `isLoggedIn`-Helper extrahieren (pure, testbar)

**Files:**
- Modify: `src/scraper.js` (neue Funktion oberhalb `ensureLoggedIn`, ~nach `api()` Z.158)
- Test: `test/unit/login-cascade.test.js`

**Interfaces:**
- Produces: `async function isLoggedIn(page, restBase): Promise<{ ok: boolean, username: string|null }>` — kapselt `api(page, restBase, '/username')` + die `anonymous`-Prüfung. Wird von Stufe 1, Stufe 2 (Re-SSO) und der Schluss-Verifikation genutzt (DRY).

- [ ] **Step 1: Failing test schreiben** (`test/unit/login-cascade.test.js`)

```js
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
```

- [ ] **Step 2: Test fails verifizieren**

Run: `npm test` (oder `node --test test/unit/login-cascade.test.js`)
Expected: FAIL — `__test` undefined.

- [ ] **Step 3: Helper + Test-Export implementieren** (`src/scraper.js`)

```js
// Kapselt die /username-Prüfung. apiFn ist injizierbar (Default: das echte api()),
// damit der Branch ohne echten Browser testbar ist.
async function isLoggedIn(page, restBase, apiFn = api) {
  const chk = await apiFn(page, restBase, '/username');
  const ok = !!(chk && chk.ok && !String(chk.text || '').includes('anonymous'));
  const username = ok ? ((chk.json && chk.json.username) || '(user)') : null;
  return { ok, username };
}
```

Am Dateiende `module.exports` ergänzen (bestehende Exports beibehalten):

```js
module.exports.__test = { isLoggedIn };
```

- [ ] **Step 4: Tests grün verifizieren**

Run: `npm test`
Expected: PASS (3/3 neue Tests).

- [ ] **Step 5: Stufe 1 auf den Helper umstellen** (`src/scraper.js:184-188`)

Ersetze die inline-Prüfung im Cache-Pfad:

```js
const { ok, username } = await isLoggedIn(pg, restBase);
if (ok) {
  onLog('✅ Session gültig, eingeloggt als ' + (username || '(user)'), 'info');
  return { browser, context: ctx, page: pg };
}
```

- [ ] **Step 6: Commit**

```bash
git add src/scraper.js test/unit/login-cascade.test.js
git commit -m "refactor(scraper): isLoggedIn-Helper extrahieren + testen"
```

---

### Task 2: Stiller Re-SSO als Funktion

**Files:**
- Modify: `src/scraper.js` (neue Funktion oberhalb `ensureLoggedIn`)
- Test: `test/unit/login-cascade.test.js`

**Interfaces:**
- Consumes: `isLoggedIn` (Task 1), die SSO-Button-Strategien (heute inline Z.222-239 — in Step 1 in eine Helper-Funktion `findSsoButton(page)` ziehen).
- Produces:
  - `function findSsoButton(page): Locator|null-artig` — kapselt die 6 Selektor-Strategien, gibt den ersten Treffer-Locator zurück (oder `null`).
  - `async function trySilentReSSO(page, restBase, { baseUrl, timeoutMs = 8000 }, onLog): Promise<boolean>` — klickt den SSO-Button im geseedeten Context und gewinnt per `Promise.race`: eingeloggt (`isLoggedIn` true) vs. E-Mail-Feld sichtbar. Rückgabe `true` = still eingeloggt, `false` = Passwort nötig/Timeout.
    - **Settle-Retry (live-verifiziert nötig):** Der SSO-Button erscheint erst ~1.5 s nach `domcontentloaded`. `trySilentReSSO` darf `findSsoButton` NICHT nur einmal direkt nach `goto` aufrufen, sondern muss bis `SSO_BUTTON_SETTLE_MS` (gekappt durch `timeoutMs`) auf ihn pollen, sonst greift der stille Re-SSO nie.

- [ ] **Step 1: `findSsoButton` extrahieren** — die Schleife aus `ensureLoggedIn` (Z.222-239) in eine eigene Funktion verschieben, in `ensureLoggedIn` durch Aufruf ersetzen. Verhalten identisch.

```js
async function findSsoButton(page) {
  const strategies = [
    () => page.getByRole('link',   { name: /Office\s*365/i }),
    () => page.getByRole('button', { name: /Office\s*365/i }),
    () => page.getByText('WISS Office 365', { exact: false }),
    () => page.locator('a, button, input[type="submit"], input[type="button"]').filter({ hasText: /Office\s*365/i }),
    () => page.locator('input[value*="Office" i]'),
    () => page.locator('a[href*="saml" i], a[href*="oauth" i], a[href*="sso" i], a[href*="azure" i]').first()
  ];
  for (const make of strategies) {
    const loc = make().first();
    const n = await loc.count().catch(() => 0);
    if (n > 0) return loc;
  }
  return null;
}
```

- [ ] **Step 2: Failing test für die Branch-Logik** (Fake-Page)

```js
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
```

- [ ] **Step 3: Test fails verifizieren** — `npm test` → FAIL (`trySilentReSSO` undefined).

- [ ] **Step 4: `trySilentReSSO` implementieren**

```js
// Versucht den stillen Re-SSO im bereits geseedeten Context (MS-Cookie noch gültig).
// Klickt den SSO-Button und entscheidet per Race: eingeloggt vs. Email-Feld sichtbar.
// timeoutMs kappt den Versuch hart, damit ein Fehlschlag nicht den Volllogin verzögert.
// findSsoButton/apiFn injizierbar für Tests.
async function trySilentReSSO(page, restBase, opts, onLog, apiFn = api) {
  const { baseUrl, timeoutMs = 8000, findSsoButton: findFn = findSsoButton } = opts;
  const emailSel = 'input[type="email"]:visible, input[name="loginfmt"]:visible';
  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => {});
    // evtl. schon still eingeloggt nach Navigation?
    if ((await isLoggedIn(page, restBase, apiFn)).ok) return true;

    // Settle-Retry: der SSO-Button rendert erst ~1.5s nach domcontentloaded
    // (SPA). Live-verifiziert 2026-06-18: einmalige Suche direkt nach goto
    // liefert null → unnötiger Volllogin. Daher auf den Button pollen.
    let btn = await findFn(page);
    const settleDeadline = Date.now() + Math.min(timeoutMs, SSO_BUTTON_SETTLE_MS);
    while (!btn && Date.now() < settleDeadline) {
      await page.waitForTimeout(300).catch(() => {});
      btn = await findFn(page);
    }
    if (!btn) return false; // kein Button → kann nichts Stilles tun
    onLog('🔁 Stiller Re-SSO: SSO-Button klicken (MS-Session evtl. noch gültig)...', 'info');
    await btn.click({ timeout: timeoutMs }).catch(() => {});

    // Race: eingeloggt (poll /username) vs. Email-Feld sichtbar (= Passwort nötig).
    const deadline = Date.now() + timeoutMs;
    const emailAppeared = page.waitForSelector(emailSel, { state: 'visible', timeout: timeoutMs })
      .then(() => 'email').catch(() => null);
    const becameLoggedIn = (async () => {
      while (Date.now() < deadline) {
        if ((await isLoggedIn(page, restBase, apiFn)).ok) return 'in';
        await page.waitForTimeout(400).catch(() => {});
      }
      return null;
    })();
    const winner = await Promise.race([emailAppeared, becameLoggedIn]);
    return winner === 'in';
  } catch (_) {
    return false;
  }
}
```

`module.exports.__test` erweitern: `{ isLoggedIn, trySilentReSSO, findSsoButton }`.

- [ ] **Step 5: Tests grün** — `npm test` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/scraper.js test/unit/login-cascade.test.js
git commit -m "feat(scraper): trySilentReSSO + findSsoButton extrahieren & testen"
```

---

### Task 3: Kaskade in `ensureLoggedIn` verdrahten

**Files:**
- Modify: `src/scraper.js` — Cache-Miss-Übergang (Z.190-202) erweitern.

**Interfaces:**
- Consumes: `trySilentReSSO`, `isLoggedIn`, `serializeStorageState` (bestehend).

- [ ] **Step 1:** Im Cache-Pfad, **bevor** `pg`/`ctx` geschlossen werden (heute Z.190-193), den stillen Re-SSO einschieben:

```js
onLog('⏰ Gecachte Tocco-Session abgelaufen → versuche stillen Re-SSO', 'info');
if (typeof onPhase === 'function') onPhase('login');
const silent = await trySilentReSSO(pg, restBase, { baseUrl }, onLog);
if (silent) {
  const { username } = await isLoggedIn(pg, restBase);
  onLog('✅ Stiller Re-SSO erfolgreich, eingeloggt als ' + (username || '(user)'), 'info');
  // frischen State (neuer nice_auth) speichern → nächster Lauf trifft evtl. Stufe 1
  try {
    const stateObj = await ctx.storageState();
    const payload = serializeStorageState(stateObj, storageCrypto);
    const storageTmp = storageFile + '.tmp';
    fs.writeFileSync(storageTmp, payload, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(storageTmp, 0o600); } catch (_) {}
    fs.renameSync(storageTmp, storageFile);
    onLog('💾 Browser-State aktualisiert (Re-SSO)', 'info');
  } catch (e) {
    onLog('⚠️  State-Speichern nach Re-SSO fehlgeschlagen: ' + redact((e && e.message) || ''), 'warn');
  }
  return { browser, context: ctx, page: pg };
}
onLog('↩️  Stiller Re-SSO fehlgeschlagen → voller Login', 'info');
await pg.close().catch(() => {});
await ctx.close().catch(() => {});
```

> Stufe 3 (voller Login ab Z.196/202) bleibt unverändert und übernimmt, wenn wir hier durchfallen.

- [ ] **Step 2: Bestehende Tests laufen lassen** — `npm test` → alle grün (keine Regression in `storageState.test.js`, `safeEvaluate.test.js`).

- [ ] **Step 3: Commit**

```bash
git add src/scraper.js
git commit -m "feat(scraper): 3-Stufen-Login-Kaskade (Cache → stiller Re-SSO → Volllogin)"
```

---

### Task 4: Manuelle Live-Verifikation (kein Auto-Test)

**Files:** keine.

- [ ] **Step 1:** `nice_auth` künstlich invalidieren: `data/storage.json` behalten, aber sicherstellen dass die Tocco-Session tot ist (z.B. >Session-Timeout warten oder testweise eine Abfrage triggern nachdem `nice_auth` abgelaufen ist).
- [ ] **Step 2:** Abfrage auslösen, Log prüfen. Erwartung: `🔁 Stiller Re-SSO …` → `✅ Stiller Re-SSO erfolgreich …`, **kein** `📧 Email eingeben…`. Dauer ~3-5 s statt 15-20 s.
- [ ] **Step 3:** Negativfall (MS-Cookie wirklich tot, z.B. nach 90 Tagen) → `↩️ … → voller Login`, dann normaler Volllogin. Funktioniert weiterhin.

---

### Task 5: Doppel-Navigation am Ende entfernen

**Files:**
- Modify: `src/scraper.js:401-413`

- [ ] **Step 1:** Die zwei aufeinanderfolgenden `page.goto(baseUrl)` (Z.401-404 und Z.412-413) zu **einer** Navigation + einem `isLoggedIn`-Check zusammenfassen:

```js
// nur EINE finale Navigation; vorher: zwei volle SPA-Loads + 2× Sleep.
if (!/tocco\.ch/.test(page.url()) || /extranet/i.test(page.url())) {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
}
const cookies = await context.cookies();
const toccoCookies = cookies.filter(c => c.domain.includes('tocco.ch'));
if (!toccoCookies.length) throw new Error('Keine Tocco-Cookies nach Login — Flow möglicherweise unterbrochen.');

const verify = await isLoggedIn(page, restBase);
if (!verify.ok) {
  throw new Error('Login lief durch, aber /username = anonymous. URL: ' + redact(page.url()));
}
onLog('✅ Eingeloggt als ' + (verify.username || '(user)'), 'info');
```

- [ ] **Step 2:** `npm test` grün. Manuell: Volllogin testen → landet eingeloggt.
- [ ] **Step 3: Commit**

```bash
git add src/scraper.js
git commit -m "perf(scraper): redundante zweite Tocco-Navigation nach Login entfernen"
```

---

### Task 6: Blinde Sleeps → ereignisbasiert (Login-Pfad)

**Files:**
- Modify: `src/scraper.js` (Z.183, 208, 294, 299, 333, 346, 369)

**Prinzip:** Jeden `waitForTimeout(N)` durch ein Warten auf das *tatsächliche* Ereignis ersetzen, mit demselben Maximal-Timeout als Cap. Schneller im Normalfall, gleiche Robustheit.

- [ ] **Step 1:** Z.183 (Cache-Pfad, nach `pg.goto`): `await pg.waitForTimeout(1500)` → entfernen; `isLoggedIn` (Task 1) wird direkt aufgerufen, `api()` hat eigenen Retry (`safeEvaluate`). Falls nötig kleiner Puffer `await pg.waitForLoadState('domcontentloaded').catch(()=>{})`.
- [ ] **Step 2:** Z.208 (`waitForTimeout(1500)` nach initialem `goto`): ersetzen durch `await page.waitForLoadState('domcontentloaded').catch(()=>{})` + Button-Suche, die ohnehin auf das Element wartet.
- [ ] **Step 3:** Z.299 (`waitForTimeout(1500)` nach Email-Submit): ersetzen — das folgende `waitForSelector(pwSel, …)` (Z.305) wartet bereits auf das Passwortfeld. Sleep ersatzlos streichen.
- [ ] **Step 4:** Z.294/333/346/369 (300/200/300/300 ms rund um Eingaben): zu kurzen, gezielten Waits machen oder streichen, wo direkt ein `waitForSelector`/`click` folgt. Konservativ: nur streichen, wo ein nachfolgendes Event-Wait existiert; sonst belassen.
- [ ] **Step 5:** `pressSequentially(msPassword, { delay: 20 })` (Z.335): unverändert lassen (Reliability), **außer** Messung zeigt Bedarf — die Verify-Retry-Logik (Z.338-344) bleibt.
- [ ] **Step 6:** `npm test` grün; manueller Volllogin erfolgreich.
- [ ] **Step 7: Commit**

```bash
git add src/scraper.js
git commit -m "perf(scraper): blinde waitForTimeout durch ereignisbasierte Waits ersetzen"
```

---

### Task 7: Schluss-Sleep nach Redirect

**Files:**
- Modify: `src/scraper.js:404` (das `waitForTimeout(2000)` nach Redirect zu Tocco)

- [ ] **Step 1:** Durch ein Warten auf den eingeloggten Zustand ersetzen (Poll auf `isLoggedIn` mit Cap 5000 ms statt fixe 2000 ms blind).
- [ ] **Step 2:** `npm test` grün; manueller Volllogin erfolgreich.
- [ ] **Step 3: Commit**

```bash
git add src/scraper.js
git commit -m "perf(scraper): festen 2s-Redirect-Sleep durch Login-Poll ersetzen"
```

---

## Self-Review-Checkliste

- [ ] Stufe 3 (Volllogin) logisch unverändert? (nur Sleep-Ersetzungen)
- [ ] Crypto unangetastet? (`storageCrypto`, `enc:v1:`)
- [ ] Keine Cookie-Werte/Secrets im Log?
- [ ] Jeder neue Warte-Schritt hat einen Timeout-Cap?
- [ ] `__test`-Export entfernt keine bestehenden Exports?
- [ ] `npm test` komplett grün, inkl. bestehender `storageState`/`safeEvaluate`-Tests?
- [ ] Manuell: stiller Re-SSO greift (Log zeigt kein Passwort) **und** Volllogin-Fallback funktioniert?

## Erwartetes Ergebnis

| Fall | Vorher | Nachher |
|------|--------|---------|
| Tocco-Session gültig | ~3-5 s | ~3-5 s (unverändert) |
| Tocco tot, MS-Cookie gültig (**Normalfall**) | 15-20 s | **~3-5 s, kein Passwort** |
| MS-Cookie auch tot (selten) | 15-20 s | ~8-12 s (Volllogin, Sleeps entschlackt) |
