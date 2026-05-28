/**
 * Tocco WISS Scraper — pure reusable module.
 *
 * Exports runScrape(config, onLog) which performs the full login + scrape
 * pipeline and returns structured data. No console.log, no process.env,
 * no process.exit. All I/O side channels go through onLog(message, level).
 */

const fs = require('node:fs');
const path = require('node:path');

// ---------- Security Helpers ----------
// Entfernt sensitive Query-Parameter aus Fehlermeldungen / URLs.
function redact(s) {
  if (s == null) return '';
  return String(s).replace(
    /([?&](?:password|passwd|code|access_token|refresh_token|token|secret|api[-_]?key)=)[^&\s]+/gi,
    '$1[REDACTED]'
  );
}

function isDebug() {
  return process.env.DEBUG_SCRAPER === 'true';
}

// ---------- Storage-State (Browser-Session) ----------
// storage.json enthält die MS-SSO-Session-Cookies (ESTSAUTH, JSESSIONID, …),
// die replaybar sind — wer die Datei liest, übernimmt den Schul-Account.
// Sie wird deshalb at-rest verschlüsselt, sofern `storageCrypto` (encrypt/
// decrypt aus secretCrypto) via config injiziert ist. Ohne Injection (z.B.
// Tests) bleibt das Verhalten Plaintext-Pfad-basiert.

// Serialisiert den Playwright-Storage-State zu dem, was auf Disk landet.
function serializeStorageState(stateObj, storageCrypto) {
  const json = JSON.stringify(stateObj);
  if (storageCrypto && typeof storageCrypto.encrypt === 'function') {
    return storageCrypto.encrypt(json);
  }
  return json;
}

// Liest gespeicherten Browser-State von Disk. Rückgabe:
//   - State-Objekt (entschlüsselt + geparst) → direkt an
//     browser.newContext({ storageState }) übergebbar,
//   - Dateipfad (ohne Crypto-Injection, z.B. Tests),
//   - null bei korrupter/unlesbarer Datei → Caller macht frischen Login.
// decrypt() reicht Plaintext ohne enc:-Prefix unverändert durch, daher
// migrieren Alt-Dateien beim nächsten erfolgreichen Login automatisch.
function readStorageState(storageFile, storageCrypto, onLog) {
  if (!storageCrypto || typeof storageCrypto.decrypt !== 'function') {
    return storageFile;
  }
  try {
    const raw = fs.readFileSync(storageFile, 'utf8');
    return JSON.parse(storageCrypto.decrypt(raw));
  } catch (e) {
    if (typeof onLog === 'function') {
      onLog('⚠️  storage.json unlesbar (' + ((e && e.message) || e) + ') → neuer Login', 'warn');
    }
    return null;
  }
}

// Wrapper für page.evaluate, der den Tocco-SPA-typischen Race
// "Execution context was destroyed, most likely because of navigation"
// abfängt: Tocco rendert Tabellen via DWR async nach und macht Hash-
// Navigationen während wir auslesen — der V8-Context kann mitten im
// evaluate verschwinden. Wir warten kurz auf den nächsten DOM-Ready
// und versuchen es erneut. Andere Fehler werden direkt durchgereicht.
async function safeEvaluate(page, fn, ...rest) {
  const MAX_ATTEMPTS = 3;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return rest.length > 0
        ? await page.evaluate(fn, rest[0])
        : await page.evaluate(fn);
    } catch (e) {
      lastErr = e;
      const msg = String((e && e.message) || '');
      const transient = /Execution context was destroyed/i.test(msg)
        || /Cannot find context with specified id/i.test(msg)
        || /Frame was detached/i.test(msg);
      if (!transient || attempt === MAX_ATTEMPTS) throw e;
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(400 * attempt).catch(() => {});
    }
  }
  throw lastErr;
}

// ---------- Browser Setup ----------
function requirePlaywright() {
  try { return require('playwright').chromium; }
  catch (e) {
    throw new Error('Playwright nicht installiert. Führe zuerst aus: npm install && npx playwright install chromium');
  }
}

// Schließt den Browser mit hartem 10s-Timeout. browser.close() kann hängen,
// wenn ein Page-Listener oder Frame-Detach stuck ist — dann pollt unsere
// 15min-Watchdog endlos auf einen Cleanup, der nie kommt. Race mit Timeout
// und SIGKILL-Fallback garantiert, dass der Chromium-Prozess freigegeben wird.
async function closeBrowserSafe(browser) {
  if (!browser) return;
  let timedOut = false;
  await Promise.race([
    browser.close().catch(() => {}),
    new Promise((resolve) => setTimeout(() => { timedOut = true; resolve(); }, 10000))
  ]);
  if (timedOut) {
    try {
      const proc = typeof browser.process === 'function' ? browser.process() : null;
      if (proc && typeof proc.kill === 'function') proc.kill('SIGKILL');
    } catch (_) { /* swallow */ }
  }
}

// ---------- Fetch-Wrapper (läuft IM BROWSER, damit Session voll gilt) ----------
async function api(page, restBase, endpoint, opts = {}) {
  return safeEvaluate(page, async ({ url, opts }) => {
    try {
      const res = await fetch(url, {
        method: opts.method || 'GET',
        credentials: 'include',
        headers: { 'Accept': 'application/json', ...(opts.headers || {}) },
        body: opts.body
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (_) {}
      return { ok: res.ok, status: res.status, text, json };
    } catch (e) {
      return { ok: false, status: 0, text: String(e), json: null };
    }
  }, { url: restBase + endpoint, opts });
}

async function ensureLoggedIn(config, onLog, onPhase, onBrowser) {
  const { msEmail, msPassword, baseUrl, headless, slowMo, storageFile, cwd, storageCrypto } = config;
  const restBase = baseUrl + '/nice2';
  const chromium = requirePlaywright();
  if (typeof onPhase === 'function') onPhase('browser');
  onLog('🌐 Starte ' + (headless ? 'headless ' : 'sichtbaren ') + 'Chromium' + (slowMo ? ' (slow-mo ' + slowMo + 'ms)' : ''), 'info');
  const browser = await chromium.launch({ headless, slowMo });
  // Watchdog-Hook: gibt dem Aufrufer SOFORT eine Browser-Referenz, damit der
  // Watchdog den Browser auch killen kann wenn der Login-Flow hängt (vor
  // runScrape überhaupt resolved). Ohne diesen Callback wäre `scraped` im
  // runScrape.js noch null und der Watchdog könnte nichts tun.
  if (typeof onBrowser === 'function') {
    try { onBrowser(browser); } catch (_) { /* swallow — best-effort hook */ }
  }

  // 1. Versuch: gecachter State
  if (fs.existsSync(storageFile)) {
    onLog('♻️  Lade gespeicherten Browser-State (storage.json)...', 'info');
    const storageState = readStorageState(storageFile, storageCrypto, onLog);
    if (storageState != null) {
      const ctx = await browser.newContext({ storageState });
      const pg = await ctx.newPage();
      await pg.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await pg.waitForTimeout(1500);
      const chk = await api(pg, restBase, '/username');
      if (chk.ok && !chk.text.includes('anonymous')) {
        const u = (chk.json && chk.json.username) || '(user)';
        onLog('✅ Session gültig, eingeloggt als ' + u, 'info');
        return { browser, context: ctx, page: pg };
      }
      onLog('⏰ Gecachte Session ungültig → neuer Login', 'info');
      await pg.close().catch(() => {});
      await ctx.close().catch(() => {});
    }
  }

  // 2. Frischer Login
  if (typeof onPhase === 'function') onPhase('login');
  if (!msEmail || !msPassword) {
    await closeBrowserSafe(browser);
    throw new Error('MS_EMAIL + MS_PASSWORD fehlen in config.');
  }
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // kurzer Settle-Puffer statt networkidle (Tocco hat Dauer-Polling)
    await page.waitForTimeout(1500);
    onLog('📍 Geladen: ' + page.url(), 'info');

    // Falls die Seite schon direkt MS-Login zeigt (z.B. durch Session-Hint) → überspringen
    let alreadyAtMS = false;
    try {
      const host = new URL(page.url()).hostname;
      alreadyAtMS = /^login\.microsoft(online)?\.com$|^login\.live\.com$/.test(host);
    } catch (_) { /* invalid URL */ }

    let loginPage = page;
    if (!alreadyAtMS) {
      // Suche den "WISS Office 365" Button — mehrere Strategien
      onLog('🔍 Suche SSO-Button...', 'info');
      const strategies = [
        () => page.getByRole('link',   { name: /Office\s*365/i }),
        () => page.getByRole('button', { name: /Office\s*365/i }),
        () => page.getByText('WISS Office 365', { exact: false }),
        () => page.locator('a, button, input[type="submit"], input[type="button"]').filter({ hasText: /Office\s*365/i }),
        () => page.locator('input[value*="Office" i]'),
        () => page.locator('a[href*="saml" i], a[href*="oauth" i], a[href*="sso" i], a[href*="azure" i]').first()
      ];
      let clickTarget = null;
      for (let i = 0; i < strategies.length; i++) {
        const loc = strategies[i]().first();
        const n = await loc.count().catch(() => 0);
        if (n > 0) {
          clickTarget = loc;
          onLog('   Strategie ' + (i+1) + ' hat Button gefunden (' + n + ' Match' + (n>1?'es':'') + ')', 'info');
          break;
        }
      }

      if (!clickTarget) {
        // Diagnose: Screenshot + DOM-Dump NUR bei DEBUG_SCRAPER. Der Screenshot
        // kann die ausgefüllte MS-Login-Seite samt E-Mail zeigen und darf nicht
        // ungefragt persistent auf die Platte (Backup-/FS-Leak).
        if (isDebug()) {
          const shot = path.join(cwd, 'debug-no-button.png');
          await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
          onLog('❌ Kein SSO-Button gefunden. Screenshot: ' + shot, 'error');
        } else {
          onLog('❌ Kein SSO-Button gefunden. (DEBUG_SCRAPER=true für Screenshot.)', 'error');
        }

        if (isDebug()) {
          const allClickables = await safeEvaluate(page, () => {
            const items = Array.from(document.querySelectorAll('a, button, input[type="submit"], input[type="button"]'));
            return items.map(el => ({
              tag: el.tagName,
              text: (el.textContent || el.value || '').trim().slice(0, 60),
              href: el.href || null,
              id: el.id || null,
              cls: el.className || null
            })).filter(x => x.text || x.href);
          });
          onLog('   [DEBUG] Klickbare Elemente auf der Seite:', 'error');
          allClickables.slice(0, 20).forEach(c => onLog('     ' + c.tag + '  "' + c.text + '"  ' + (c.href || ''), 'error'));
        }
        throw new Error('SSO-Button nicht lokalisierbar');
      }

      onLog('🔴 Klicke SSO-Button...', 'info');
      const popupPromise = context.waitForEvent('page', { timeout: 10000 }).catch(() => null);
      const navPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => null);
      await clickTarget.click({ timeout: 10000 });
      const popup = await popupPromise;
      if (popup) {
        onLog('🪟 Popup erkannt → ' + popup.url(), 'info');
        await popup.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
        loginPage = popup;
      } else {
        await navPromise;
        onLog('➡️  Navigation in gleicher Seite → ' + page.url(), 'info');
      }
    } else {
      onLog('ℹ️  Bereits auf Microsoft — überspringe SSO-Button', 'info');
    }

    // E-Mail-Feld (Microsoft login) — auf loginPage (kann page oder popup sein)
    const emailSel = 'input[type="email"]:visible, input[name="loginfmt"]:visible';
    await loginPage.waitForSelector(emailSel, { state: 'visible', timeout: 25000 });
    onLog('📧 Email eingeben...', 'info');
    await loginPage.click(emailSel);
    await loginPage.fill(emailSel, msEmail);
    await loginPage.waitForTimeout(300);
    onLog('➡️  Weiter-Button klicken...', 'info');
    await loginPage.click('input[type="submit"]:visible, button[type="submit"]:visible');

    // Warten bis URL sich ändert oder Passwortseite geladen ist (Federated Login möglich)
    await loginPage.waitForTimeout(1500);
    onLog('📍 Nach Email: ' + loginPage.url(), 'info');

    // Passwort — mit größerer Toleranz + Sichtbarkeitscheck
    const pwSel = 'input[type="password"]:visible, input[name="passwd"]:visible, input#passwordInput:visible';
    try {
      await loginPage.waitForSelector(pwSel, { state: 'visible', timeout: 25000 });
    } catch (e) {
      // Screenshot NUR bei DEBUG_SCRAPER — er zeigt die MS-Login-Seite samt
      // ausgefüllter E-Mail; nicht ungefragt persistent auf die Platte.
      if (isDebug()) {
        const shot = path.join(cwd, 'debug-no-password.png');
        await loginPage.screenshot({ path: shot, fullPage: true }).catch(() => {});
        onLog('❌ Passwortfeld nicht gefunden. Screenshot: ' + shot, 'error');
      } else {
        onLog('❌ Passwortfeld nicht gefunden. (DEBUG_SCRAPER=true für Screenshot.)', 'error');
      }
      onLog('   URL: ' + redact(loginPage.url()), 'error');

      if (isDebug()) {
        const inputs = await safeEvaluate(loginPage, () => Array.from(document.querySelectorAll('input')).map(i => ({
          type: i.type, name: i.name || null, id: i.id || null,
          placeholder: i.placeholder || null, visible: i.offsetParent !== null
        })));
        onLog('   [DEBUG] Sichtbare Inputs:', 'error');
        inputs.filter(i => i.visible).forEach(i => onLog('     type=' + i.type + ' name=' + i.name + ' id=' + i.id + ' placeholder=' + i.placeholder, 'error'));
      }
      throw e;
    }

    onLog('🔑 Passwort eingeben...', 'info');
    const pwLoc = loginPage.locator(pwSel).first();
    await pwLoc.click();
    await loginPage.waitForTimeout(200);
    await pwLoc.fill('');
    await pwLoc.pressSequentially(msPassword, { delay: 20 });

    // Verify: Feld hat wirklich Inhalt (aber ohne Längen zu loggen).
    const pwLen = await pwLoc.evaluate(el => el.value.length).catch(() => 0);
    if (pwLen !== msPassword.length) {
      onLog('⚠️  Passwort-Eingabe unvollständig, versuche erneut...', 'warn');
      await pwLoc.click({ clickCount: 3 });
      await loginPage.keyboard.press('Delete');
      await pwLoc.pressSequentially(msPassword, { delay: 30 });
    }

    await loginPage.waitForTimeout(300);
    onLog('➡️  Anmelden-Button klicken...', 'info');
    await loginPage.click('input[type="submit"]:visible, button[type="submit"]:visible');
    await loginPage.waitForLoadState('domcontentloaded').catch(() => {});

    // "Angemeldet bleiben?" (KMSI) — Checkbox anhaken + Ja klicken
    onLog('⏳ Warte auf "Angemeldet bleiben"-Dialog...', 'info');
    try {
      await loginPage.waitForSelector(
        'input[name="DontShowAgain"], #KmsiCheckboxField, input#idBtn_Back, button#idSIButton9',
        { timeout: 15000 }
      );

      // Checkbox "Diese Meldung nicht mehr anzeigen" anhaken (falls vorhanden)
      const checkbox = loginPage.locator('input[name="DontShowAgain"], #KmsiCheckboxField').first();
      if (await checkbox.count().catch(() => 0)) {
        const isChecked = await checkbox.isChecked().catch(() => false);
        if (!isChecked) {
          onLog('☑️  "Angemeldet bleiben" Checkbox anhaken...', 'info');
          await checkbox.check({ timeout: 5000 }).catch(async () => {
            // Fallback: direkt klicken falls .check() nicht geht
            await checkbox.click({ force: true });
          });
          await loginPage.waitForTimeout(300);
        }
      }

      // "Ja" Button — mehrere mögliche Selektoren
      onLog('✔️  "Ja" klicken...', 'info');
      const yesBtn = loginPage.locator([
        'button#idSIButton9',
        'input#idSIButton9',
        'input[type="submit"][value="Ja"]',
        'input[type="submit"][value="Yes"]',
        'input[data-report-event="Signin_Submit"]',
        'input[type="submit"]:visible',
        'button[type="submit"]:visible'
      ].join(', ')).first();
      await yesBtn.click({ timeout: 10000 });
      await loginPage.waitForLoadState('domcontentloaded').catch(() => {});
    } catch (e) {
      onLog('ℹ️  KMSI-Dialog nicht erschienen oder schon durchgeklickt (' + redact((e.message || '').split('\n')[0]) + ')', 'info');
    }

    // Warten bis IRGENDWO (page oder popup) wieder auf tocco.ch
    onLog('⏳ Warte auf Redirect zurück zu Tocco...', 'info');
    await Promise.race([
      page.waitForURL(/tocco\.ch/, { timeout: 45000 }).catch(() => null),
      loginPage === page ? Promise.resolve() : loginPage.waitForURL(/tocco\.ch/, { timeout: 45000 }).catch(() => null)
    ]);
    // Wenn Popup: es schließt sich oft automatisch, Hauptseite lädt Tocco
    if (loginPage !== page && !loginPage.isClosed()) {
      await loginPage.close().catch(() => {});
    }
    // Hauptseite einmal reloaden falls sie noch auf Extranet-Landing steht
    if (!/tocco\.ch/.test(page.url()) || /extranet/i.test(page.url())) {
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    }
    await page.waitForTimeout(2000);

    const cookies = await context.cookies();
    const toccoCookies = cookies.filter(c => c.domain.includes('tocco.ch'));

    if (!toccoCookies.length) throw new Error('Keine Tocco-Cookies nach Login — Flow möglicherweise unterbrochen.');

    // Verify: /username auf der echten Seite (nicht extern!)
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const verify = await api(page, restBase, '/username');
    if (!verify.ok || verify.text.includes('anonymous')) {
      throw new Error('Login lief durch, aber /username = anonymous. URL: ' + redact(page.url()));
    }
    const u = (verify.json && verify.json.username) || '(user)';
    onLog('✅ Eingeloggt als ' + u, 'info');

    // Storage State für nächstes Mal speichern (mit restriktiven Permissions).
    // Die Session-Cookies sind replaybar → at-rest verschlüsseln (storageCrypto),
    // sofern injiziert. Wir holen den State als Objekt und schreiben selbst,
    // statt Playwright in eine .tmp schreiben zu lassen — sonst läge zwischendurch
    // ein unverschlüsselter Klartext-Dump auf der Platte.
    // Atomic-Write: erst tmp-Datei (0600), dann rename. Verhindert corrupt
    // storage.json, wenn der Prozess mitten im write crasht.
    const stateObj = await context.storageState();
    const payload = serializeStorageState(stateObj, storageCrypto);
    const storageTmp = storageFile + '.tmp';
    fs.writeFileSync(storageTmp, payload, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(storageTmp, 0o600); } catch (_) { /* Windows compat */ }
    try {
      fs.renameSync(storageTmp, storageFile);
    } catch (e) {
      // Fallback: rename schlägt z.B. auf Windows fehl wenn Ziel-File von
      // anderem Prozess gehalten wird. copy + unlink wäre nicht atomar.
      try { fs.unlinkSync(storageTmp); } catch (_) {}
      throw e;
    }
    onLog('💾 Browser-State gespeichert in storage.json', 'info');

    return { browser, context, page };
  } catch (e) {
    // Screenshot NUR bei DEBUG_SCRAPER — kann die MS-Login-Seite samt
    // ausgefüllter E-Mail enthalten; nicht ungefragt persistent auf die Platte.
    if (isDebug()) {
      try {
        const shot = path.join(cwd, 'login-error.png');
        await page.screenshot({ path: shot, fullPage: true });
        onLog('📸 Screenshot: ' + shot, 'error');
      } catch (_) {}
    }
    await closeBrowserSafe(browser);
    throw new Error('Login fehlgeschlagen: ' + redact(e.message || ''));
  }
}

// ---------- Scraping ----------
async function waitForToccoLoad(page, label, onLog) {
  const LOADING_REGEX = /daten\s+werden\s+(ü|ue)bertragen|wird\s+geladen|loading|l(ä|ae)dt/i;
  const MAX_WAIT = 60000;
  const POLL_MS = 400;
  const start = Date.now();
  let sawLoading = false;
  let ticks = 0;

  while (Date.now() - start < MAX_WAIT) {
    const state = await safeEvaluate(page, (regexSrc) => {
      const re = new RegExp(regexSrc.pattern, regexSrc.flags);
      const txt = document.body ? (document.body.innerText || '') : '';
      return { loading: re.test(txt), bodyLen: txt.length };
    }, { pattern: LOADING_REGEX.source, flags: LOADING_REGEX.flags }).catch(() => ({ loading: false, bodyLen: 0 }));

    if (state.loading) {
      sawLoading = true;
      if (ticks % 3 === 0) {
        onLog('  ⏳ ' + (label ? label + ': ' : '') + '"Daten werden übertragen..." seit ' + ((Date.now()-start)/1000).toFixed(1) + 's', 'progress');
      }
    } else if (sawLoading) {
      onLog('  ✓ ' + (label ? label + ': ' : '') + 'Laden abgeschlossen nach ' + ((Date.now()-start)/1000).toFixed(1) + 's', 'info');
      break;
    } else if (Date.now() - start > 3000 && state.bodyLen > 100) {
      onLog('  ✓ ' + (label ? label + ': ' : '') + 'Kein Lade-Indikator', 'info');
      break;
    }
    ticks++;
    await page.waitForTimeout(POLL_MS);
  }

  if (Date.now() - start >= MAX_WAIT) {
    onLog('  ⚠️  Max-Wait erreicht', 'warn');
  }
  await page.waitForTimeout(600);
}

async function setPageSize(page, size, onLog) {
  onLog('🔢 Setze Seitengröße auf ' + size + '...', 'info');

  // Finde den Page-Size Combobox über Nachbarschaft zu "Anzeige Eintrag"-Text
  const inputInfo = await safeEvaluate(page, () => {
    const all = Array.from(document.querySelectorAll('*'));
    const anchor = all.find(el =>
      el.children.length === 0 &&
      /Anzeige\s+Eintrag/i.test(el.textContent || '')
    );
    if (!anchor) return { found: false, reason: 'Anzeige Eintrag Text nicht gefunden' };

    // Walk up bis ein Container gefunden wird, der einen x-form-text Input enthält
    let container = anchor.parentElement;
    for (let i = 0; i < 15 && container; i++) {
      const input = container.querySelector('input.x-form-text, input.x-form-field');
      if (input) {
        input.id = input.id || ('tocco-pagesize-' + Date.now());
        return { found: true, id: input.id, currentValue: input.value };
      }
      container = container.parentElement;
    }
    return { found: false, reason: 'Kein Input in Toolbar gefunden' };
  });

  if (!inputInfo.found) {
    onLog('  ⚠️  ' + inputInfo.reason, 'warn');
    return false;
  }
  onLog('  Input gefunden (aktueller Wert: ' + inputInfo.currentValue + ')', 'info');

  const sel = '#' + inputInfo.id;
  await page.click(sel, { clickCount: 3 }).catch(() => {});
  await page.fill(sel, '').catch(() => {});
  await page.type(sel, String(size), { delay: 50 });
  await page.keyboard.press('Enter');
  onLog('  ✓ ' + size + ' eingegeben + Enter', 'info');
  return true;
}

async function scrapePage(page, url, label, onLog, options = {}) {
  onLog('📖 Lade ' + label + ': ' + url, 'info');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitForToccoLoad(page, label, onLog);

  if (options.afterLoad) {
    const changed = await options.afterLoad(page);
    if (changed) {
      await page.waitForTimeout(500); // kurze Wartezeit damit Loading-Indikator erscheint
      await waitForToccoLoad(page, label, onLog);
    }
  }

  return safeEvaluate(page, () => {
    const tables = Array.from(document.querySelectorAll('table')).map(tbl => {
      const rows = Array.from(tbl.querySelectorAll('tr'));
      return rows.map(tr => Array.from(tr.querySelectorAll('th, td')).map(c => (c.innerText || '').trim().replace(/\s+/g, ' ')));
    }).filter(t => t.length > 0 && t.some(r => r.some(c => c)));

    const main = document.querySelector('main, #main, .main-content, .content, article, body');
    const text = main ? (main.innerText || '').trim() : '';

    return { tables, text, url: location.href, title: document.title };
  });
}

// ---------- Text-Parser (Tabellen-HTML ist wertlos bei Tocco, Text hat die Daten) ----------
function parseNoten(text) {
  const lines = text.split('\n').map(l => l.replace(/\t/g, '').trim()).filter(Boolean);
  const startIdx = lines.findIndex(l => /^Fach-Bezeichnung$/i.test(l));
  if (startIdx < 0) return [];

  // Stopp-Marker: alles nach Pagination oder Footer ignorieren
  const stopMarkers = /^(Seite|Anzeige Eintrag|DIREKT ZU|Copyright|WISS & SOCIAL|RECHTLICHES|zu unserem|Datenschutz|Allg\.)/i;

  const entries = [];
  let current = null;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (stopMarkers.test(l)) break;
    if (/^\d+$/.test(l)) {
      if (current && current.length >= 3) entries.push(current.slice(0, 4));
      current = [];
    } else if (current !== null && current.length < 4) {
      // Note ist das 4. Feld — nimm nur wenn es wie eine Note aussieht (X.X, leer, oder kurz)
      if (current.length === 3) {
        // 4. Position = Note; akzeptiere nur sinnvolle Werte
        if (/^\d+([.,]\d+)?$/.test(l) || l === '' || l.length <= 10) {
          current.push(l);
        } else {
          // Sieht nicht nach Note aus → Entry hat keine Note, fertig
          entries.push(current.slice(0, 4));
          current = null;
        }
      } else {
        current.push(l);
      }
    }
  }
  if (current && current.length >= 3) entries.push(current.slice(0, 4));

  return entries.map(e => ({
    fach: e[0] || '',
    kuerzel: e[1] || '',
    typ: e[2] || '',
    note: /^\d+([.,]\d+)?$/.test(e[3] || '') ? e[3] : ''
  }));
}

function parseStundenplan(text) {
  const lines = text.split('\n').map(l => l.replace(/\t/g, '').trim()).filter(Boolean);
  const dateRegex = /^(\d{2}\.\d{2}\.\d{2,4})\s+(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})/;
  // Klassenformat: UIFZ-2524-020, UIFZ-2524-020/021, etc.
  const klasseRegex = /^[A-Z]{2,}[-]\d{2,}[-]\d{2,}(\/\d+)?$/;
  // Explizite Footer-/Button-Texte, die ausserhalb der Datentabelle stehen
  const stopMarkers = /^(Seite|Anzeige Eintrag|DIREKT ZU|Copyright|WISS & SOCIAL|RECHTLICHES|zu unserem|Datenschutz|Allg\.|Alle Rechte|Ein Unternehmen|Kalaidos|Termine exportieren|iCal)/i;

  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(dateRegex);
    if (!m) continue;

    const fields = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (dateRegex.test(l) || /^\d+$/.test(l)) break;
      if (stopMarkers.test(l)) break;
      fields.push(l);
      // Strukturelle Grenze: sobald wir eine Klasse + genau 1 weiteres Feld
      // (= Veranstaltung) gesammelt haben → Eintrag komplett, Schluss.
      // Das fängt ALLE Footer-Leakage-Fälle ab, unabhängig von Texten.
      if (fields.length >= 2 && klasseRegex.test(fields[fields.length - 2])) {
        break;
      }
    }

    // Mapping:
    //   fields[0]           = Raum
    //   fields[last]        = Veranstaltung
    //   fields[last-1]      = Klasse (UIFZ-...)
    //   Dozent              = erstes Feld dazwischen mit Komma
    const raum = fields[0] || '';
    const veranstaltung = fields[fields.length - 1] || '';
    const klasse = fields[fields.length - 2] || '';
    const middle = fields.slice(1, Math.max(1, fields.length - 2));
    const dozent = middle.find(f => f.includes(',')) || '';

    // Sanity-Check: wenn klasse nicht dem Pattern entspricht, ist der Eintrag kaputt
    // → überspringen statt Müll in die DB schreiben.
    if (!klasseRegex.test(klasse)) continue;

    entries.push({
      datum: m[1],
      zeit: m[2] + ' – ' + m[3],
      raum,
      dozent,
      klasse,
      veranstaltung
    });
  }
  return entries;
}

// ---------- DWR-Intercept (Modul-Detail-IDs) ----------
// Tocco lädt die Noten-Tabelle via DWR (Direct Web Remoting) — die Response
// ist JS-Wire-Format (nicht JSON). Pro Modulzeile enthält sie:
//   - die Detail-PK (für die Detail-URL #detail&id=NNNN&input_type=grades)
//   - das kuerzel im Format "32359 / UIFZ-... / 231 - ..."
// Wir hängen einen Response-Listener an die Page, sammeln die Responses
// und parsen daraus das Mapping kuerzel_id → detail_id.
function startDwrCapture(page, urlMatcher) {
  const responses = [];
  const handler = async (resp) => {
    try {
      if (!urlMatcher.test(resp.url())) return;
      const text = await resp.text();
      if (text) responses.push(text);
    } catch (_) { /* ignore */ }
  };
  page.on('response', handler);
  return {
    stop() { try { page.off('response', handler); } catch (_) {} },
    getResponses() { return responses.slice(); }
  };
}

// Parst eine DWR-Response (oder mehrere konkateniert) und liefert
// { kuerzel_id: detail_id }. Tolerant gegen kleine Format-Schwankungen.
function parseDwrIdMap(text) {
  const map = {};
  if (!text) return map;

  // 1. Alle "relInput.relEvent.label" → value: "NNNN / ..." Treffer
  //    mit ihrer Stringposition, um sie später dem nächsten Input_data-Block
  //    zuordnen zu können.
  const labels = [];
  const labelRe = /"relInput\.relEvent\.label"[\s\S]*?value:\s*"(\d+)[^"]*"/g;
  let m;
  while ((m = labelRe.exec(text)) !== null) {
    labels.push({ pos: m.index, kuerzelId: m[1] });
  }

  // 2. Alle Input_data-Block-PKs (das ist die Modul-Note-Detail-ID).
  //    Andere PrimaryKeys im Block (für Event/Input_type-Relationen) sind nicht
  //    gemeint — nur die mit entityName:"Input_data".
  const ids = [];
  const idRe = /entityName:\s*"Input_data"[\s\S]*?key:\s*new\s+nice2\.entity\.PrimaryKey\('(\d+)'\)/g;
  while ((m = idRe.exec(text)) !== null) {
    ids.push({ pos: m.index, detailId: m[1] });
  }

  // 3. Pair up: für jede detail_id die zeitlich davor letzte Label.
  //    (Im DWR-Wire-Format kommt das Cell-Mapping VOR dem sources-Block.)
  for (const id of ids) {
    let best = null;
    for (const lab of labels) {
      if (lab.pos < id.pos && (!best || lab.pos > best.pos)) best = lab;
    }
    if (best && best.kuerzelId) {
      // Erstes Mapping gewinnt — falls gleicher kuerzel mehrfach erscheint
      // (z.B. wegen Pagination), nimm das erste.
      if (!map[best.kuerzelId]) map[best.kuerzelId] = id.detailId;
    }
  }
  return map;
}

// ---------- Detail-Page-Scrape (Prüfungen pro Modul) ----------
async function scrapeModulDetail(page, baseUrl, detailId, onLog) {
  // Defensiv: detailId muss numerisch sein (Tocco-PK). Verhindert URL-Fragment-
  // Injection, falls die DWR-Response je etwas Nicht-Numerisches enthält oder
  // ein Aufrufer mal manipulierten Input durchschleust.
  if (!/^\d+$/.test(String(detailId))) {
    throw new Error('Ungültige detailId: ' + String(detailId).slice(0, 32));
  }
  const url = baseUrl
    + '/extranet/Meine-Bildung/Noten-für-Studierende'
    + '?nocache=' + Date.now()
    + '#detail&id=' + detailId
    + '&input_type=grades';

  onLog('  📖 Detail ' + detailId + ' lädt...', 'info');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitForToccoLoad(page, 'Detail ' + detailId, onLog);

  // Gleiche Strategie wie in scrapePage: aus dem Main-Container den InnerText holen.
  const text = await safeEvaluate(page, () => {
    const main = document.querySelector('main, #main, .main-content, .content, article, body');
    return main ? (main.innerText || '').trim() : '';
  });

  return parsePruefungen(text);
}

// Text-Parser für die Detail-Tabelle.
// Erwartetes Layout (innerText):
//   Ergebnis
//   Bewertung: 5.000
//
//   Prüfung   Bezeichnung   Gewicht   Bewertung
//   1         LB 1          25%       4.800
//   2         LB 2          25%       4.700
//   ...
//   Zurück zur Übersicht
//
// Bezeichnung kann mehrzeilig sein (z.B. "Mündliche\nPrüfung") — daher
// erkennen wir die Gewichts-Spalte am "%" Zeichen statt feste Spalten zu zählen.
function parsePruefungen(text) {
  if (!text) return [];
  const lines = text.split('\n').map(l => l.replace(/\t+/g, ' ').trim()).filter(Boolean);

  // Header finden — entweder 4 separate Zeilen ("Prüfung"/"Bezeichnung"/"Gewicht"/"Bewertung")
  // oder eine kombinierte Zeile. Bei der 4-Zeilen-Variante prüfen wir ALLE 4
  // Spalten-Headertexte, damit eine fremde Tabelle die mit "Prüfung\nBezeichnung"
  // beginnt nicht versehentlich getroffen wird.
  let dataStart = -1;
  for (let i = 0; i < lines.length - 3; i++) {
    if (/^Pr(ü|ue)fung$/i.test(lines[i])
        && /^Bezeichnung$/i.test(lines[i + 1])
        && /^Gewicht$/i.test(lines[i + 2])
        && /^Bewertung$/i.test(lines[i + 3])) {
      dataStart = i + 4; // 4 Header-Spalten als separate Zeilen
      break;
    }
    if (/Pr(ü|ue)fung\s+Bezeichnung\s+Gewicht\s+Bewertung/i.test(lines[i])) {
      dataStart = i + 1; // Header in einer Zeile
      break;
    }
  }
  if (dataStart < 0) return [];

  const stopMarkers = /^(Zur(ü|ue)ck|Seite|Anzeige Eintrag|DIREKT ZU|Copyright|WISS|RECHTLICHES|zu unserem|Datenschutz|Allg\.|Alle Rechte|Ein Unternehmen|Kalaidos)/i;

  function commitEntry(buf, out) {
    if (buf.length < 4) return;
    // Spaltenpositionen erkennen:
    //   buf[0]              = Pruefung-Nr (eine Ziffer)
    //   buf[gewichtIdx]     = Gewicht (enthält %)
    //   buf[gewichtIdx+1]   = Bewertung (numerisch)
    //   dazwischen          = Bezeichnung (kann multi-token sein)
    let gewichtIdx = -1;
    for (let i = 1; i < buf.length - 1; i++) {
      if (/%/.test(buf[i])) { gewichtIdx = i; break; }
    }
    if (gewichtIdx < 2) {
      // Fallback: Annahme Bezeichnung = 1 Token
      gewichtIdx = 2;
    }
    const bezeichnung = buf.slice(1, gewichtIdx).join(' ').trim();
    const gewicht     = buf[gewichtIdx];
    const bewertung   = buf[gewichtIdx + 1];

    const nr = parseInt(buf[0], 10);
    if (!Number.isFinite(nr)) return;

    out.push({
      pruefung_nr: nr,
      bezeichnung,
      gewicht,
      bewertung,
      bewertung_raw: bewertung
    });
  }

  const entries = [];
  let buf = [];
  for (let i = dataStart; i < lines.length; i++) {
    const l = lines[i];
    if (stopMarkers.test(l)) break;
    // Eine neue Zeile beginnt mit einer 1-2-stelligen Pruefung-Nr.
    // Aber: eine Bewertung wie "4.800" enthält auch eine Ziffer am Anfang —
    // die wird unten von commitEntry korrekt behandelt, weil sie nach dem
    // %-Token kommt. Hier reicht: \d{1,2}$
    if (/^\d{1,2}$/.test(l)) {
      commitEntry(buf, entries);
      buf = [l];
    } else if (buf.length) {
      buf.push(l);
    }
    // else: noch keine erste Nr gesehen — überspringen
  }
  commitEntry(buf, entries);
  return entries;
}

/* ---------- Detail-Page-Pool ----------
 *
 * Begrenzt die Anzahl gleichzeitig geöffneter Detail-Pages auf `size`.
 * Pool-Pages werden lazy via context.newPage() erstellt und nach
 * Verwendung wieder in den freien Slot zurückgelegt — bei vielen Detail-
 * Scrapes über den gleichen Cycle bleiben sie offen und werden recycled
 * (Tocco-Session ist „warm", erste navigations sparen den Cold-Start).
 *
 * acquire() returnt eine Page (existiert schon im Pool ODER neu erstellt
 * bis size erreicht ist ODER wartet bis ein Slot frei wird).
 * release(page) gibt die Page zurück in den freien Slot — wartende
 * acquire()-Promises werden in FIFO-Reihenfolge bedient.
 * drain() schließt alle Pages und unblockt wartende acquires (mit null,
 * die Caller müssen darauf vorbereitet sein — wird beim closeBrowser
 * aufgerufen). */
function createDetailPagePool(context, size) {
  const free = [];     // verfügbare Pages
  const all = [];      // alle jemals erstellten Pages (für drain())
  let waiters = [];    // Promise-resolve-Funktionen die auf eine Page warten
  let creating = 0;    // Anzahl Pages, die gerade async via newPage() erstellt werden
  let drained = false;

  async function acquire() {
    if (drained) throw new Error('detail-page-pool already drained');
    if (free.length > 0) return free.shift();
    // Synchron-Slot-Reservierung: `creating` wird VOR dem await
    // inkrementiert. Sonst Race wenn N parallel-acquire()-Promises
    // gleichzeitig `all.length < size` sehen und alle newPage()
    // feuern (Pool-Größe wird ignoriert, N Pages statt size).
    if (all.length + creating < size) {
      creating++;
      try {
        const page = await context.newPage();
        // Drain-Race: drain() kann während des newPage()-await gefeuert
        // haben. Dann ist die Page orphan — sofort schließen + throw,
        // damit der acquire-Caller nicht eine Page bekommt die nirgends
        // mehr getrackt wird.
        if (drained) {
          try { await page.close(); } catch (_) {}
          throw new Error('detail-page-pool drained during page creation');
        }
        all.push(page);
        return page;
      } finally {
        creating--;
      }
    }
    // Pool voll → warten bis jemand release()ed
    return new Promise((resolve) => { waiters.push(resolve); });
  }

  function release(page) {
    if (drained) {
      // Pool wurde inzwischen geschlossen — Page ist evtl. schon weg.
      try { page && page.close(); } catch (_) {}
      return;
    }
    if (waiters.length > 0) {
      const resolve = waiters.shift();
      resolve(page);
      return;
    }
    free.push(page);
  }

  // discard(page): Page hat sich als unbrauchbar erwiesen (Frame-detached,
  // Target-closed, Connection-closed). Entferne sie aus dem Pool +
  // schließe sie best-effort. Wartende acquires werden NICHT direkt
  // bedient — der Pool darf neue Pages erstellen, weil all.length jetzt
  // wieder unter `size` liegt. Sonst würde ein einzelner poisoned Page
  // alle nachfolgenden Detail-Scrapes blockieren (cascading failure).
  function discard(page) {
    if (!page) return;
    const idx = all.indexOf(page);
    if (idx !== -1) all.splice(idx, 1);
    const freeIdx = free.indexOf(page);
    if (freeIdx !== -1) free.splice(freeIdx, 1);
    try { page.close(); } catch (_) { /* swallow */ }
    // Wenn ein Slot frei ist UND Waiters warten → einer kann jetzt
    // einen frischen acquire-Aufruf machen. Hier: leeren waiter mit
    // null aufwecken? Nein — der existierende acquire-Pfad würde dann
    // sehen dass all.length < size und newPage() feuern. Sauberer:
    // wir wecken einen waiter mit null auf und der Caller throw't, was
    // ihm einen Retry auf der höheren Ebene erlaubt. Aber das ändert
    // das Vertrags-Verhalten von acquire (returnt aktuell nie null
    // außer drained). Stattdessen lassen wir den waiter weiter warten
    // und vertrauen darauf dass eine andere release() in Kürze einen
    // wakeup auslöst — bei N parallelen Detail-Scrapes ist das immer
    // der Fall.
  }

  async function drain() {
    drained = true;
    // Wartende acquires aufwecken — mit null, damit die Caller throw
    // können oder gracefully abbrechen.
    const ws = waiters;
    waiters = [];
    for (const r of ws) r(null);
    // Alle Pages schließen — best-effort, ein Close-Fehler darf den
    // Browser-Close-Pfad nicht killen.
    for (const p of all) {
      try { await p.close(); } catch (_) {}
    }
    all.length = 0;
    free.length = 0;
  }

  return { acquire, release, drain, discard };
}

// ---------- Public API ----------
// runScrape(config, onLog, onPhase?)
//   onLog(message, level)           — free-form log messages
//   onPhase(phase)                  — coarse progress phases:
//     'browser'      → Chromium launch
//     'login'        → Microsoft SSO login flow (only if no cached session)
//     'noten'        → Noten + Stundenplan parallel laden + parsen
//                      (separate 'stundenplan'-Phase entfällt — beide
//                       Page-Loads laufen gleichzeitig im selben Context;
//                       Noten dominieren visuell durch DWR-Capture und
//                       Modulanzahl, daher bleibt der Phase-Indikator hier).
//     'noten_details' → loading + parsing per-module detail pages (aufrufer-getriggert)
//   Caller may layer 'saving' / null on top after runScrape returns.
//
// ⚠️ BROWSER-LIFECYCLE: runScrape lässt den Playwright-Browser auf der Happy-Path
//    OFFEN, damit der Aufrufer via result.scrapeDetail(...) zusätzliche Pages
//    laden kann. DER AUFRUFER MUSS result.closeBrowser() in einem finally-Block
//    rufen, sonst leakt ein Chromium-Prozess. Auf dem Error-Path wird der
//    Browser intern geschlossen — der zurückgeworfene Error braucht kein
//    closeBrowser() mehr.
//
// Result enthält neben { noten, stundenplan, rawText, fetchedAt } zusätzlich:
//   detailIdMap   { '<kuerzel_id>': '<detail_id>' }   — aus DWR-Response
//   scrapeDetail  async (detailId) => Pruefungen-Array — Aufrufer kann
//                 nach runScrape() einzelne Module nachscrapen, OHNE den
//                 Browser zu schließen. Browser bleibt offen bis closeBrowser().
//   closeBrowser  async () => void                    — schließt den Playwright-Browser.
//                 PFLICHT-Aufruf via finally — siehe Hinweis oben.
//
//   Detail-Scrapes:
//     `result.scrapeDetail(detail_id)` ruft im Hintergrund eine Page aus
//     einem Pool (Größe: config.detailScrapeConcurrency, Default 4).
//     Caller kann scrapeDetail() parallel rufen — der Pool limited die
//     gleichzeitig aktiven Detail-Pages automatisch.
async function runScrape(config, onLog, onPhase) {
  const log = onLog || (() => {});
  const phase = typeof onPhase === 'function' ? onPhase : () => {};
  const cfg = {
    baseUrl: 'https://wiss.tocco.ch',
    headless: true,
    slowMo: 0,
    ...config
  };

  if (!cfg.notenUrl) throw new Error('config.notenUrl fehlt');
  if (!cfg.stundenplanUrl) throw new Error('config.stundenplanUrl fehlt');
  if (!cfg.storageFile) throw new Error('config.storageFile fehlt');
  if (!cfg.cwd) throw new Error('config.cwd fehlt');

  const { browser, context, page: notenPage } = await ensureLoggedIn(cfg, log, phase, cfg.onBrowserReady);

  // Zweite Page im selben BrowserContext — teilt sich Cookies/Storage mit der
  // Noten-Page, also voll-eingeloggt ohne zweiten SSO-Flow. Wird nach dem
  // Stundenplan-Scrape geschlossen; Detail-Scrapes nutzen nur die Noten-Page.
  let planPage = null;
  // Detail-Page-Pool wird erst nach dem Parallel-Fetch aufgebaut — vorher
  // null, damit der catch-Block per null-Check sauber drainen kann.
  let detailPool = null;

  let detailIdMap = {};
  let dwrCapture = null;

  try {
    planPage = await context.newPage();

    // Phase bleibt 'noten' während der gesamten Parallel-Fetch-Periode.
    // Der separate 'stundenplan'-Phase-Indikator entfällt, weil beide
    // Page-Loads gleichzeitig laufen — Noten dominieren visuell (DWR-Capture
    // + größere Modulliste). 'stundenplan'-Phase wird aus dem Orchestrator-
    // Pipeline herausgenommen; der nächste Phase-Sprung ist direkt 'saving'.
    phase('noten');

    // DWR-Capture NUR auf der Noten-Page registrieren — der Listener ist
    // per-Page (page.on('response')), und der Stundenplan macht keine
    // DWR-Calls. So bleibt das ID-Mapping sauber, auch wenn beide Pages
    // gleichzeitig fetchen.
    dwrCapture = startDwrCapture(notenPage, /SearchService\.search/i);

    // Beide Page-Loads parallel. Beide rufen setPageSize(100) als afterLoad
    // — unabhängige DOM-Mutationen pro Page, kein Race. waitForToccoLoad
    // pollt jeweils auf dem eigenen Document, also kein cross-page-Konflikt.
    const [notenRaw, spRaw] = await Promise.all([
      scrapePage(notenPage, cfg.notenUrl, 'Noten', log, {
        afterLoad: (p) => setPageSize(p, 100, log)
      }),
      scrapePage(planPage, cfg.stundenplanUrl, 'Stundenplan', log, {
        afterLoad: (p) => setPageSize(p, 100, log)
      }),
    ]);

    const noten = parseNoten(notenRaw.text || '');
    const stundenplan = parseStundenplan(spRaw.text || '');

    // DWR-Listener stoppen — alle weiteren Detail-Calls sollen nicht das
    // ID-Mapping verfälschen. Vor dem Stop noch alle gesammelten Responses
    // abholen.
    const dwrTexts = dwrCapture.getResponses();
    dwrCapture.stop();
    dwrCapture = null;

    // ID-Map aus den gesammelten Responses parsen (unverändert zur sequentiellen
    // Variante — die Logik ist von der Parallelität nicht betroffen).
    for (const t of dwrTexts) {
      const partial = parseDwrIdMap(t);
      for (const [k, v] of Object.entries(partial)) {
        if (!detailIdMap[k]) detailIdMap[k] = v;
      }
    }
    const idCount = Object.keys(detailIdMap).length;
    const notenCount = noten.length;
    if (idCount) {
      log('  🔑 ' + idCount + ' Modul-Detail-IDs aus DWR extrahiert', 'info');
      if (notenCount > 0 && idCount < notenCount * 0.5) {
        log('  ⚠️  DWR-ID-Map hat nur ' + idCount + '/' + notenCount + ' Module — Tocco-Format könnte sich geändert haben', 'warn');
      }
    } else if (notenCount > 0) {
      log('  ⚠️  Keine Modul-Detail-IDs gefunden — Detail-Scrape wird übersprungen', 'warn');
    }

    // Stundenplan-Page wird nicht mehr gebraucht — Detail-Scrapes laufen
    // alle auf Pool-Pages aus dem selben Context (Session schon „warm").
    // Schließen wir, um Page-RAM zu sparen. Best-effort: ein Close-Fehler
    // darf den Erfolg nicht killen.
    try { await planPage.close(); } catch (_) { /* swallow */ }
    planPage = null;

    // Stufe 2 — Detail-Scrape-Pool. Pool-Größe via Setting:
    // detailScrapeConcurrency (Default 4, konservativ wegen Tocco-
    // Server-Last + RAM). Pool wird lazy gefüllt; erste Detail-Calls
    // werden also weniger parallel laufen als der Soll-Wert sagt.
    const POOL_DEFAULT = 4;
    const poolSize = Math.max(1, Math.min(
      Number(cfg.detailScrapeConcurrency) || POOL_DEFAULT,
      8  // Hard cap — Tocco hat keine offiziellen Rate-Limits, aber 8+
         // parallele DWR-Calls aus einer Session sind unrealistisch.
    ));
    detailPool = createDetailPagePool(context, poolSize);
    log('  🏊 Detail-Page-Pool initialisiert (Soll-Größe ' + poolSize + ')', 'info');
    // RAM-Diagnose: 4 Pool-Pages + 2 Stage-1-Pages ~ 600 MB peak. Wenn
    // wir hier schon nahe am Limit sind, lieber Pool kleiner halten oder
    // OOM-Profilbild zur Hand haben. Reines Logging, keine Aktion.
    try {
      const rss = process.memoryUsage().rss;
      log(`  📊 RSS at pool-init: ${(rss / 1024 / 1024).toFixed(0)} MB, pool-size ${poolSize}`, 'info');
    } catch (_) { /* memoryUsage() ist in Node immer verfügbar — paranoid */ }

    // Warmup-Tracking: frische Pool-Pages haben noch nie Tocco geladen,
    // also ist die SPA nicht initialisiert. scrapeModulDetail navigiert
    // mit `?nocache=…#detail&id=NNN` — der Hash wird auf einer Page mit
    // initialisierter SPA als Detail-Trigger erkannt, auf einer frischen
    // Page nur als Standard-URL behandelt (Resultat: die Noten-Übersicht
    // statt der Detail-Tabelle → parsePruefungen findet keinen Header →
    // „keine Prüfungs-Daten gefunden").
    //
    // Fix: Beim ersten acquire einer Page navigieren wir sie auf
    // `notenUrl` (gleicher Pfad wie der Initial-Noten-Scrape) und
    // warten auf waitForToccoLoad, damit die SPA fertig initialisiert
    // ist. Subsequent Detail-Scrapes auf der recycled Page sind dann
    // schnell — der Hash-Wechsel reicht.
    //
    // WeakSet ist hier richtig statt Set: Pages werden bei drain()
    // geschlossen, GC kann sie einsammeln, ohne dass das Set sie
    // künstlich am Leben hält.
    const warmedPages = new WeakSet();
    async function ensureWarm(page) {
      if (warmedPages.has(page)) return;
      log('  🔥 Pool-Page warm-up (Noten-Seite laden + SPA-Init)', 'info');
      await page.goto(cfg.notenUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await waitForToccoLoad(page, 'Pool-Warmup', log);
      warmedPages.add(page);
    }

    return {
      noten,
      stundenplan,
      detailIdMap,
      rawText: { noten: notenRaw.text, stundenplan: spRaw.text },
      fetchedAt: new Date().toISOString(),
      scrapeDetail: async (detailId) => {
        let page = await detailPool.acquire();
        if (!page) {
          // Pool wurde gedrained während wir gewartet haben
          throw new Error('detail-page-pool drained — scrape cycle ended');
        }
        try {
          await ensureWarm(page);
          return await scrapeModulDetail(page, cfg.baseUrl, detailId, log);
        } catch (e) {
          // Pool-Page-Health-Tracking: bei strukturellen Browser-Fehlern
          // (Frame detached, Target closed, Connection closed) ist die
          // Page „poisoned" — Wiederverwendung führt zu cascading-failures
          // („keine Prüfungs-Daten gefunden" obwohl Modul existiert). Wir
          // droppen sie aus dem Pool statt sie zu releasen.
          const msg = (e && e.message) || '';
          if (/Frame was detached|Target.*closed|Connection closed|Protocol error/i.test(msg)) {
            log('  💀 Pool-Page poisoned, dropped: ' + msg, 'warn');
            detailPool.discard(page);
            page = null; // im finally NICHT releasen
          }
          throw e;
        } finally {
          if (page) detailPool.release(page);
        }
      },
      closeBrowser: async () => {
        // Pool zuerst drainen — die Pages sind in der gleichen Browser-
        // Hierarchie, also würde browser.close() sie zwar mitnehmen, aber
        // saubererer Cleanup-Pfad ist explizit per-Page.
        try { await detailPool.drain(); } catch (_) {}
        await closeBrowserSafe(browser);
      }
    };
  } catch (err) {
    if (dwrCapture) try { dwrCapture.stop(); } catch (_) {}
    // planPage best-effort cleanup — wenn schon null (success-path), no-op.
    if (planPage) { try { await planPage.close(); } catch (_) {} }
    // Pool drainen, falls schon erstellt — best-effort. detailPool ist als
    // `let … = null` deklariert, also reicht ein simpler null-Check.
    if (detailPool) { try { await detailPool.drain(); } catch (_) {} }
    await closeBrowserSafe(browser);
    throw err;
  }
}

module.exports = {
  runScrape,
  redact,
  // Exposed for tests / ad-hoc usage
  parseDwrIdMap,
  parsePruefungen,
  safeEvaluate,
  createDetailPagePool,
  serializeStorageState,
  readStorageState
};
