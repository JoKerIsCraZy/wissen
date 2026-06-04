/**
 * Tocco WISS Scraper — pure reusable module.
 *
 * Exports runScrape(config, onLog) which performs the full login + scrape
 * pipeline and returns structured data. No console.log, no process.env,
 * no process.exit. All I/O side channels go through onLog(message, level).
 */

const fs = require('node:fs');
const path = require('node:path');
const { parseGewichtPct } = require('./db/parsers');

// ---------- Absenzen-Konfig-Konstanten (Phase-0 bestätigt/justiert) ----------
// Diese drei Werte sind die einzigen echten Unbekannten des Absenzen-Slices
// (s. Spec §7 + §14 — Live-Spike). Sie sind hier zentral abgelegt, damit ein
// einziger Live-Lauf die TODOs schließen kann, ohne die Parser anzufassen.
//
// ABSENZEN_DETAIL_PATH : der Pfad-Teil der Detail-URL (analog zum Noten-Pfad
//   '/extranet/Meine-Bildung/Noten-für-Studierende'). Wird mit ?nocache=…
//   + ABSENZEN_DETAIL_HASH(id) zur vollen Detail-URL zusammengesetzt.
// ABSENZEN_DETAIL_HASH : baut das URL-Hash-Fragment, das Tocco als Detail-
//   Trigger erkennt. Live-Spike 2026-05-29: '#detail&key=<RegistrationPK>',
//   KEIN id=/input_type= (anders als Noten). key= ohne &name= reicht.
// ABSENZEN_DWR_CODE_RE : extrahiert das Kurzbezeichnung-Token (z.B.
//   'UIFZ-2524-020-S1-UEK-106') aus der DWR-Response — Join-Key Übersicht↔Detail.
const ABSENZEN_DETAIL_PATH = '/extranet/Meine-Bildung/Absenzen-für-Studierenden'; // Live-Spike 2026-05-29: gleicher Pfad wie Übersicht, Plural "Studierenden"
const ABSENZEN_DETAIL_HASH = (key) => '#detail&key=' + key; // Live-Spike 2026-05-29: key=<RegistrationPK>, KEIN id=/input_type=
const ABSENZEN_DWR_CODE_RE = /[A-Z]{2,}-\d{2,}-[\w-]+/; // Kurzbezeichnung (Spec §7)

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
    throw new Error('Playwright nicht installiert. Führe zuerst aus: npm install && npx playwright install chromium', { cause: e });
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
    throw new Error('Login fehlgeschlagen: ' + redact(e.message || ''), { cause: e });
  }
}

// ---------- Scraping ----------
async function waitForToccoLoad(page, label, onLog, settleMs = 600) {
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
  // Settle-Puffer: kurze Extra-Wartezeit NACH "Laden fertig", damit die SPA die
  // Tabelle fertig rendert, bevor innerText gelesen wird. Detail-Seiten geben
  // 300ms (warm, kleiner DOM); Übersichten bleiben bei 600ms (Default).
  await page.waitForTimeout(settleMs);
}

async function setPageSize(page, size, onLog, label) {
  // Label-Prefix, damit die 3 parallelen Page-Loads (Noten/Stundenplan/Absenzen)
  // in den Logs unterscheidbar sind — vorher liefen 3x „Setze Seitengröße…"
  // ohne Zuordnung.
  const tag = label ? '[' + label + '] ' : '';
  onLog(tag + '🔢 Setze Seitengröße auf ' + size + '...', 'info');

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
    onLog(tag + '  ⚠️  ' + inputInfo.reason, 'warn');
    return false;
  }
  onLog(tag + '  Input gefunden (aktueller Wert: ' + inputInfo.currentValue + ')', 'info');

  const sel = '#' + inputInfo.id;
  await page.click(sel, { clickCount: 3 }).catch(() => {});
  await page.fill(sel, '').catch(() => {});
  await page.type(sel, String(size), { delay: 50 });
  await page.keyboard.press('Enter');
  onLog(tag + '  ✓ ' + size + ' eingegeben + Enter', 'info');
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

// ---------- Absenzen-Parser (anker-getrieben, NICHT als Noten-Klon) ----------
// Übersichtsseite (innerText). Erwartetes Layout:
//   Kurzbezeichnung   Typ   Bezeichnung   SOLL   Besucht   Minimalanwesenheit   Anwesenheit
//   UIFZ-2524-020-S1-UEK-106   GE Überbetrieblicher Kurs   106 - Datenbanken
//     abfragen, …   45   45   90%   100%
//
// Record-Anker = Kurzbezeichnung-Code (ABSENZEN_DWR_CODE_RE am Zeilenanfang).
// Spalten in fixer Reihenfolge; `Bezeichnung` kann mehrzeilig/abgeschnitten
// sein → bis zum nächsten SOLL-Integer sammeln (analog parsePruefungen, das
// die Gewicht-Spalte am '%' erkennt statt feste Spalten zu zählen).
function parseAbsenzenOverview(text) {
  if (!text) return [];
  const lines = text.split('\n').map(l => l.replace(/\t/g, '').trim()).filter(Boolean);

  // Record-Anker: eine Zeile, die NUR aus einem Kurzbezeichnung-Code besteht.
  // ^…$ verhindert, dass eine Bezeichnungs-Zeile mit eingebettetem Code als
  // neuer Record fehlinterpretiert wird.
  const codeLineRe = new RegExp('^' + ABSENZEN_DWR_CODE_RE.source + '$');
  // Typ-Zeile, z.B. "GE Modul" / "GE Überbetrieblicher Kurs".
  const intRe = /^\d+$/;
  // Footer-/Pagination-Marker (gespiegelt von parseStundenplan).
  const stopMarkers = /^(Seite|Anzeige Eintrag|DIREKT ZU|Copyright|WISS & SOCIAL|RECHTLICHES|zu unserem|Datenschutz|Allg\.|Alle Rechte|Ein Unternehmen|Kalaidos)/i;

  // Semester aus dem Code ableiten (…-S1-…) — wie parseKuerzel, aber lokal,
  // weil der Code hier ein einzelnes Token (kein " / "-getrenntes kuerzel) ist.
  function semesterFromCode(code) {
    const m = code.match(/-S(\d+)-/);
    return m ? 'S' + m[1] : null;
  }

  // Sammelt einen Record ab Index `start` (der Code-Zeile) und liefert
  // { entry, next } (next = Index der nächsten zu prüfenden Zeile).
  function collectRecord(start) {
    const kuerzel_code = lines[start];
    // buf = alle Zeilen NACH dem Code bis zum nächsten Code/Stop.
    const buf = [];
    let i = start + 1;
    for (; i < lines.length; i++) {
      const l = lines[i];
      if (codeLineRe.test(l) || stopMarkers.test(l)) break;
      buf.push(l);
    }
    // buf-Layout: [ Typ-Token(s)…, Bezeichnung-Zeile(n)…, SOLL, Besucht,
    //              Minimal-%, Anwesenheit-% ]. Wir gehen von HINTEN, weil die
    //              letzten vier Spalten zuverlässig numerisch/%-förmig sind:
    //   anwesenheit (% am Ende) · minimal (% am Ende) · besucht (int) · soll (int)
    // Die ersten zwei numerischen Felder von vorne sind SOLL/Besucht; alles
    // davor (ab buf[0]) ist Typ + Bezeichnung.
    const sollIdx = buf.findIndex(l => intRe.test(l));
    if (sollIdx < 1) {
      // Kein SOLL gefunden oder direkt am Anfang (= kein Typ/Bezeichnung) →
      // defekter Record, überspringen.
      return { entry: null, next: i };
    }
    const typ = buf[0] || '';
    const bezeichnung = buf.slice(1, sollIdx).join(' ').trim();
    const soll = parseGewichtPct(buf[sollIdx]);
    const besucht = parseGewichtPct(buf[sollIdx + 1]);
    // Die beiden %-Spalten: erstes %-Feld nach besucht = Minimal, letztes = Ist.
    let minimal_pct = null;
    let anwesenheit_pct_scraped = null;
    const pctVals = [];
    for (let j = sollIdx + 2; j < buf.length; j++) {
      if (/%/.test(buf[j])) pctVals.push(parseGewichtPct(buf[j]));
    }
    if (pctVals.length >= 2) {
      minimal_pct = pctVals[0];
      anwesenheit_pct_scraped = pctVals[pctVals.length - 1];
    } else if (pctVals.length === 1) {
      // Nur ein %-Wert sichtbar → konservativ als Ist werten (Minimal nullable).
      anwesenheit_pct_scraped = pctVals[0];
    }

    return {
      entry: {
        kuerzel_code,
        typ,
        bezeichnung,
        semester: semesterFromCode(kuerzel_code),
        soll,
        besucht,
        minimal_pct,
        anwesenheit_pct_scraped
      },
      next: i
    };
  }

  const entries = [];
  let i = 0;
  while (i < lines.length) {
    if (stopMarkers.test(lines[i])) break;
    if (codeLineRe.test(lines[i])) {
      const { entry, next } = collectRecord(i);
      if (entry) entries.push(entry);
      i = next;
    } else {
      i++;
    }
  }
  return entries;
}

// Deutsches Langdatum + Zeitspanne → ISO + Zeiten.
//   'Montag, 13. Oktober 2025, 08:30 - 12:00'
//     → { termin_iso:'2025-10-13', zeit_von:'08:30', zeit_bis:'12:00' }
// parsers.js parseDatum (DD.MM.YY) reicht NICHT — hier sind deutsche
// Monatsnamen + Wochentag-Präfix im Spiel. Trennzeichen '-'/'–' tolerieren.
// Rückgabe null bei nicht-parsebarem Input (Caller behandelt das defensiv).
function parseTerminLangDatum(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const MONATE = {
    januar: 1, februar: 2, 'märz': 3, maerz: 3, april: 4, mai: 5, juni: 6,
    juli: 7, august: 8, september: 9, oktober: 10, november: 11, dezember: 12
  };
  // Tag · Monatsname · Jahr (Wochentag-Präfix optional/ignoriert). Ein
  // optionales Komma zwischen Monat und Jahr wird toleriert (kann durch
  // Zell-Umbruch im innerText entstehen, z.B. 'Oktober, 2025').
  const dm = raw.match(/(\d{1,2})\.\s*([A-Za-zÄÖÜäöü]+),?\s+(\d{4})/);
  if (!dm) return null;
  const tag = parseInt(dm[1], 10);
  const monatName = dm[2].toLowerCase();
  const monat = MONATE[monatName];
  const jahr = parseInt(dm[3], 10);
  if (!monat || !Number.isFinite(tag) || !Number.isFinite(jahr)) return null;
  // Zeitspanne: HH:MM [-–] HH:MM (Bindestrich oder Gedankenstrich).
  const tm = raw.match(/(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})/);
  const pad = (n) => String(n).padStart(2, '0');
  const padTime = (t) => {
    const mm = t.match(/^(\d{1,2}):(\d{2})$/);
    return mm ? pad(parseInt(mm[1], 10)) + ':' + mm[2] : t;
  };
  return {
    termin_iso: jahr + '-' + pad(monat) + '-' + pad(tag),
    zeit_von: tm ? padTime(tm[1]) : '',
    zeit_bis: tm ? padTime(tm[2]) : ''
  };
}

// Detail-Tabelle einer Modul-Absenz (innerText). Erwartetes Layout:
//   Termin   Lektionen Soll   Lektionen Ist   Anwesenheit (%)   Status
//   Montag, 13. Oktober 2025, 08:30 - 12:00   4.00   4.00   100%   Teilgenommen
//   Dienstag, 14. Oktober 2025, 13:30 - 17:00   4.00   0.00   0%
//     Nicht teilgenommen unentschuldigt
//
// Record-TRENNER = deutscher Wochentag/Langdatum (NICHT Spalten-Zählung):
//   sobald eine Zeile mit "<Wochentag>," beginnt, startet ein neuer Record.
// Innerhalb: Termin-Zeile → parseTerminLangDatum; danach Lektionen Soll/Ist
// (Dezimal 4.00), Anwesenheit %, Status (Rest-Wort/Phrase). Status wird ROH
// emittiert — Normalisierung ist Sache des DB-Slices (normalizeAbsenzStatus).
function parseAbsenzLektionen(text) {
  if (!text) return [];
  const lines = text.split('\n').map(l => l.replace(/\t/g, '').trim()).filter(Boolean);

  const weekdayRe = /^(Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag),/i;
  const decRe = /^\d+(?:[.,]\d+)?$/;       // Lektionen-Dezimal (4.00 / 0.00)
  const pctRe = /%/;                       // Anwesenheit-%
  const stopMarkers = /^(Zur(ü|ue)ck|Seite|Anzeige Eintrag|DIREKT ZU|Copyright|WISS|RECHTLICHES|zu unserem|Datenschutz|Allg\.|Alle Rechte|Ein Unternehmen|Kalaidos)/i;

  // Sammelt die rohen Zeilen eines Records (ab Wochentag-Zeile bis zum nächsten
  // Wochentag/Stop) und mappt sie auf den Lektion-Eintrag.
  function commitRecord(buf) {
    if (!buf.length) return null;
    // Die Termin-Beschreibung kann über mehrere Zeilen brechen, falls Tocco
    // sie umbricht — wir nehmen so viele führende Nicht-Dezimal-/Nicht-%-Zeilen
    // wie nötig, bis die erste Dezimalzahl (Lektionen Soll) auftaucht.
    let k = 0;
    const terminParts = [];
    while (k < buf.length && !decRe.test(buf[k]) && !pctRe.test(buf[k])) {
      terminParts.push(buf[k]);
      k++;
    }
    // Mehrere Termin-Zeilen entstehen NUR durch Tocco-Umbruch innerhalb einer
    // Zelle (kein eigenes Trennzeichen) → mit Space joinen, Mehrfach-Spaces
    // kollabieren. Ein Komma-Join würde 'Oktober' + '2025' fälschlich zu
    // 'Oktober, 2025' machen und parseTerminLangDatum brechen.
    const termin_raw = terminParts.join(' ').replace(/\s+/g, ' ').trim();
    const parsed = parseTerminLangDatum(termin_raw) || { termin_iso: '', zeit_von: '', zeit_bis: '' };

    // Ab k: erste Dezimalzahl = Soll, zweite = Ist, %-Zeile = Anwesenheit,
    //       Rest (zusammengefügt) = Status-Rohstring.
    const decs = [];
    let anwesenheit_pct = null;
    const statusParts = [];
    for (let j = k; j < buf.length; j++) {
      const l = buf[j];
      // Anwesenheits-Spalte = eine REINE Prozent-Zelle (z.B. "0%"/"100%") ohne
      // Buchstaben. Ein buchstabenhaltiger Status wie "Abwesend 50%" enthält
      // ebenfalls ein %, darf aber NICHT als anwesenheit_pct verschluckt werden
      // — sonst ginge der Status (und damit der Push) verloren.
      if (pctRe.test(l) && anwesenheit_pct == null && !/[A-Za-zÄÖÜäöüß]/.test(l)) {
        anwesenheit_pct = parseGewichtPct(l);
      } else if (decRe.test(l) && decs.length < 2) {
        decs.push(parseGewichtPct(l));
      } else {
        // Alles andere ist Status-Text (kann mehrzeilig sein).
        statusParts.push(l);
      }
    }

    return {
      termin_iso: parsed.termin_iso,
      zeit_von: parsed.zeit_von,
      zeit_bis: parsed.zeit_bis,
      termin_raw,
      lektionen_soll: decs.length > 0 ? decs[0] : null,
      lektionen_ist: decs.length > 1 ? decs[1] : null,
      anwesenheit_pct,
      status_raw: statusParts.join(' ').trim()
    };
  }

  const entries = [];
  let buf = [];
  let started = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (stopMarkers.test(l)) break;
    if (weekdayRe.test(l)) {
      if (started) {
        const e = commitRecord(buf);
        if (e) entries.push(e);
      }
      buf = [l];
      started = true;
    } else if (started) {
      buf.push(l);
    }
    // else: noch kein Record gestartet (Header-Zeilen) — überspringen.
  }
  if (started) {
    const e = commitRecord(buf);
    if (e) entries.push(e);
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
  // Pending body-Reads tracken: resp.text() ist async. Eine grosse Antwort
  // (z.B. die Page-Size-100-Suche mit ALLEN Modulen) ist beim synchronen
  // Abgriff evtl. noch nicht fertig gelesen → getResponses() muss die Reads
  // abwarten, sonst wird nur die kleine, schnelle Seite-1-Antwort (25 Module)
  // erfasst und die Module ab Position 26 bekommen nie eine detail_id.
  const pending = [];
  const handler = (resp) => {
    if (!urlMatcher.test(resp.url())) return;
    const p = resp.text()
      .then((text) => { if (text) responses.push(text); })
      .catch(() => { /* ignore */ });
    pending.push(p);
  };
  page.on('response', handler);
  return {
    stop() { try { page.off('response', handler); } catch (_) {} },
    async getResponses() {
      await Promise.allSettled(pending);
      return responses.slice();
    }
  };
}

// Greift den POST-Body + die Header der ERSTEN passenden DWR-Request ab. Damit
// können wir die Such-Request der Seite faithfully REPLAYEN (aktiver fetch) —
// mit hochgesetztem Paging-Limit. Das ist deterministisch und ersetzt das
// fragile passive Mitschneiden der „richtigen" Response: Live-Spike 2026-05-29
// hat bewiesen, dass EINE Suche mit limit:1000 ALLE Zeilen liefert (35/35
// Registration-PKs) — Tocco paginiert NICHT. Der passive Abgriff erwischte
// dagegen nur die schnelle limit-25-Initialantwort → 25 IDs, die 10 Module ab
// Position 26 bekamen nie eine detail_id.
function startDwrRequestCapture(page, urlMatcher) {
  let first = null;
  const handler = (req) => {
    if (first) return;
    if (req.method() !== 'POST') return;
    if (!urlMatcher.test(req.url())) return;
    let postData = null;
    try { postData = req.postData(); } catch (_) { /* postData bleibt null */ }
    if (!postData) return;
    first = { url: req.url(), postData, headers: req.headers() };
  };
  page.on('request', handler);
  return {
    stop() { try { page.off('request', handler); } catch (_) {} },
    getFirst() { return first; }
  };
}

// Ersetzt das Paging-Limit (und setzt Offset auf 0) in einem abgegriffenen
// DWR-Such-Body, damit EINE Request alle Zeilen zurückgibt. Die offset/limit-
// Referenz-IDs werden aus dem Paging-Objekt abgeleitet → robust gegen
// c0-eNN-Index-Verschiebungen über Sessions/Formulare hinweg.
function bumpDwrPagingLimit(postData, limit) {
  if (!postData) return postData;
  const m = /Paging:\{offset:reference:(c0-e\d+),\s*limit:reference:(c0-e\d+)\}/.exec(postData);
  if (!m) return postData;
  const offsetRef = m[1];
  const limitRef = m[2];
  return postData
    .replace(new RegExp('(^|\\n)' + limitRef + '=number:\\d+'), '$1' + limitRef + '=number:' + limit)
    .replace(new RegExp('(^|\\n)' + offsetRef + '=number:\\d+'), '$1' + offsetRef + '=number:0');
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

// Absenzen-Variante von parseDwrIdMap: Mapping-Key ist der Text-Kurzbezeichnung-
// Code (Absenzen zeigt keine numerische Übersichts-ID — der Code ist der
// Join-Key Übersicht↔Detail). Defensiv (Spec §7): wir wissen Phase-0 noch nicht
// sicher, welcher DWR-String die label trägt (Text-Code vs. numerische ID),
// daher koppeln wir das nächstgelegene Kurzbezeichnung-Token an die nächste
// PrimaryKey. Bei 0 Mappings → Log-Warn + {} (Detail-Scrape ruht, Übersicht
// funktioniert weiter). `dwrTexts` ist ein Array von DWR-Response-Strings.
function parseAbsenzenIdMap(dwrTexts, onLog) {
  const log = typeof onLog === 'function' ? onLog : () => {};
  const map = {};
  const texts = Array.isArray(dwrTexts) ? dwrTexts : (dwrTexts ? [dwrTexts] : []);

  for (const text of texts) {
    if (!text) continue;

    // 1. Alle Kurzbezeichnung-Tokens mit ihrer Stringposition.
    const codes = [];
    const codeRe = new RegExp(ABSENZEN_DWR_CODE_RE.source, 'g');
    let m;
    while ((m = codeRe.exec(text)) !== null) {
      codes.push({ pos: m.index, code: m[0] });
    }

    // 2. Registration-PKs = die ECHTEN Detail-IDs. Live-Spike 2026-05-29: pro
    //    Zeile gibt es eine GETEILTE Event_type-PK (pro Kurs-Typ, NICHT
    //    eindeutig — daher kollabierten früher alle "Modul" auf 139, alle "UEK"
    //    auf 143) UND genau eine Registration-PK (eindeutig pro Modul). Wire-Form:
    //      entityName:"Registration",entityType:"STANDARD",key:new nice2.entity.PrimaryKey('297250')
    //    Nur diese Registration-PK ist die korrekte detail_id (URL #detail&key=<PK>).
    const regRe = /entityName:"Registration",entityType:"[^"]*",key:new\s+nice2\.entity\.PrimaryKey\('(\d+)'\)/g;
    while ((m = regRe.exec(text)) !== null) {
      const pkPos = m.index;
      const detailId = m[1];
      // Nächstgelegene Kurzbezeichnung VOR dieser Registration-Entität — sie
      // steht in derselben Zeile vor dem Registration-Block (Spike-bestätigt).
      let best = null;
      for (const c of codes) {
        if (c.pos < pkPos && (!best || c.pos > best.pos)) best = c;
      }
      if (best && best.code && !map[best.code]) map[best.code] = detailId;
    }
  }

  if (Object.keys(map).length === 0) {
    log('  ⚠️  Keine Absenzen-Detail-IDs aus DWR extrahiert — Detail-Scrape ruht (Übersicht funktioniert weiter)', 'warn');
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
  await waitForToccoLoad(page, 'Detail ' + detailId, onLog, 300);

  // Gleiche Strategie wie in scrapePage: aus dem Main-Container den InnerText holen.
  const text = await safeEvaluate(page, () => {
    const main = document.querySelector('main, #main, .main-content, .content, article, body');
    return main ? (main.innerText || '').trim() : '';
  });

  // Liefert { entries, expectedCount }. expectedCount = "Anzahl Prüfungen: N"
  // von der Seite → Vollständigkeits-Signal für den Lösch-Schutz in
  // savePruefungen (Teil-Scrape darf keine validen Noten löschen, #6).
  return { entries: parsePruefungen(text), expectedCount: parseAnzahlPruefungen(text) };
}

// Zieht die Soll-Anzahl Prüfungen aus dem Detail-Text ("Anzahl Prüfungen: 4").
// Tocco rendert Label + Zahl als getrennte Zeilen → \s* (inkl. Zeilenumbruch)
// überbrückt das. null wenn nicht lesbar (Caller behandelt das als "unbekannt"
// → konservativer 2-Strike-Lösch-Schutz statt Sofort-Löschung).
function parseAnzahlPruefungen(text) {
  if (!text || typeof text !== 'string') return null;
  const m = text.match(/Anzahl\s+Pr(?:ü|ue)fungen\s*:?\s*(\d+)/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
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
    // Mind. Nr + Bezeichnung + Gewicht. Eine noch UNBENOTETE Prüfung (z.B. eine
    // frisch angelegte "LB 4") hat genau diese 3 Spalten — Tocco rendert die
    // leere Bewertungs-Zelle als " ", was nach trim()+filter(Boolean) komplett
    // wegfällt. Solche Zeilen wollen wir trotzdem erfassen (Anzeige als "—"),
    // aber mit LEERER Bewertung emittieren → der DB-Layer macht daraus NULL und
    // computeWeighted lässt sie aus dem Schnitt raus.
    if (buf.length < 3) return;
    // Spaltenpositionen erkennen:
    //   buf[0]              = Pruefung-Nr (eine Ziffer)
    //   buf[gewichtIdx]     = Gewicht (enthält %)
    //   buf[gewichtIdx+1]   = Bewertung (numerisch ODER fehlend bei unbenotet)
    //   dazwischen          = Bezeichnung (kann multi-token sein)
    // Das Gewicht am "%" erkennen — auch wenn es das LETZTE Token ist (leere
    // Bewertung dahinter). Das frühere `buf.length - 1` (letztes Token
    // ausgeschlossen) verschluckte genau diese unbenoteten Zeilen.
    let gewichtIdx = -1;
    for (let i = 1; i < buf.length; i++) {
      if (/%/.test(buf[i])) { gewichtIdx = i; break; }
    }
    if (gewichtIdx < 2) {
      // Kein %-Gewichts-Anker gefunden → nur die alte 4-Spalten-Heuristik
      // erlauben, damit wir aus Footer-/Müll-Resten keine Phantom-Prüfungen
      // mit leerer Note erfinden.
      if (buf.length < 4) return;
      gewichtIdx = 2;
    }
    const bezeichnung = buf.slice(1, gewichtIdx).join(' ').trim();
    const gewicht     = buf[gewichtIdx] || '';
    // Bewertung = Token NACH dem Gewicht; fehlt es (unbenotete Prüfung) → ''.
    const bewertung   = gewichtIdx + 1 < buf.length ? buf[gewichtIdx + 1] : '';

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
    // Eine neue Prüfungs-Zeile beginnt mit einer 1-2-stelligen Pruefung-Nr.
    // Eine echte Bewertung ("4.800") matcht ^\d{1,2}$ NICHT (Dezimalpunkt) und
    // wird korrekt als Bewertung der laufenden Zeile gepusht. Eine UNBENOTETE
    // Zeile hat gar keine Bewertungs-Zeile (Tocco rendert die leere Zelle als
    // " " → weggefiltert) → die nächste Nr startet sauber die Folge-Zeile.
    //
    // WICHTIG: NICHT versuchen, eine "blanke Ganzzahl direkt nach dem Gewicht"
    // als Note zu interpretieren — bei unbenoteten Zeilen ist diese Ganzzahl die
    // Prüfungs-Nr der NÄCHSTEN Zeile (z.B. LB 1 leer, dann "2" = LB 2). Beide
    // sind 1-stellig und nicht unterscheidbar. Tocco rendert Noten ohnehin immer
    // 3-stellig ("4.700"), also gibt es keinen realen Bare-Integer-Noten-Fall.
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

// ---------- Detail-Page-Scrape (Lektionen pro Absenz-Modul) ----------
// Spiegelt scrapeModulDetail, aber für die Absenzen-Detail-Route. detailId wird
// gegen ^\d+$ validiert (Anti-URL-Fragment-Injection). URL aus den Phase-0-
// Konfig-Konstanten zusammengesetzt; bei Format-Drift schließt ein einziger
// Live-Lauf die TODOs, ohne den Parser anzufassen.
async function scrapeAbsenzModulDetail(page, baseUrl, detailId, onLog) {
  if (!/^\d+$/.test(String(detailId))) {
    throw new Error('Ungültige Absenz-detailId: ' + String(detailId).slice(0, 32));
  }
  const url = baseUrl
    + ABSENZEN_DETAIL_PATH
    + '?nocache=' + Date.now()
    + ABSENZEN_DETAIL_HASH(detailId);

  onLog('  📖 Absenz-Detail ' + detailId + ' lädt...', 'info');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitForToccoLoad(page, 'Absenz-Detail ' + detailId, onLog, 300);

  const text = await safeEvaluate(page, () => {
    const main = document.querySelector('main, #main, .main-content, .content, article, body');
    return main ? (main.innerText || '').trim() : '';
  });

  return parseAbsenzLektionen(text);
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
  if (!cfg.absenzenUrl) throw new Error('config.absenzenUrl fehlt');
  if (!cfg.storageFile) throw new Error('config.storageFile fehlt');
  if (!cfg.cwd) throw new Error('config.cwd fehlt');

  const { browser, context, page: notenPage } = await ensureLoggedIn(cfg, log, phase, cfg.onBrowserReady);

  // Zweite Page im selben BrowserContext — teilt sich Cookies/Storage mit der
  // Noten-Page, also voll-eingeloggt ohne zweiten SSO-Flow. Wird nach dem
  // Stundenplan-Scrape geschlossen; Detail-Scrapes nutzen nur die Noten-Page.
  let planPage = null;
  // Dritte Page für die Absenzen-Übersicht — best-effort. Gleicher Context,
  // also voll-eingeloggt. Wird nach dem Parse geschlossen (success-path UND
  // im catch). Ein Fehler hier darf Noten/Stundenplan NIE abbrechen.
  let absenzenPage = null;
  // Detail-Page-Pool wird erst nach dem Parallel-Fetch aufgebaut — vorher
  // null, damit der catch-Block per null-Check sauber drainen kann.
  let detailPool = null;

  const detailIdMap = {};
  let dwrCapture = null;
  let notenDwrReqCapture = null;
  let absDwrCapture = null;
  let absDwrReqCapture = null;

  try {
    planPage = await context.newPage();
    absenzenPage = await context.newPage();

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
    // ZUSÄTZLICH den REQUEST der Noten-Suche abgreifen (Body + Header), um ihn
    // danach mit limit:1000 aktiv zu REPLAYEN — sonst erfasst das passive
    // Mitschneiden oft nur die limit-25-Initialantwort und Module ab Position 26
    // bekommen NIE eine detail_id (Bug 2026-06: 169/188/190 fehlten). Spiegelt
    // den Absenzen-Voll-Suche-Pfad. Vor dem Promise.all registrieren.
    notenDwrReqCapture = startDwrRequestCapture(notenPage, /SearchService\.search/i);

    // ZWEITE DWR-Capture — per-Page auf der Absenzen-Page, keine Kreuz-
    // kontamination mit dem Noten-Mapping (beide Listener hängen an
    // verschiedenen Pages). Vor dem Promise.all registrieren, damit auch der
    // erste SearchService.search-Call der Absenzen-Tabelle erfasst wird.
    absDwrCapture = startDwrCapture(absenzenPage, /SearchService\.search/i);

    // ZUSÄTZLICH den REQUEST der Absenzen-Suche abgreifen (Body + Header), um
    // ihn danach mit hohem Paging-Limit aktiv zu replayen (deterministisch alle
    // Module). Muss vor dem Promise.all registriert sein, damit die erste
    // SearchService.search-Request der Tabelle erfasst wird.
    absDwrReqCapture = startDwrRequestCapture(absenzenPage, /SearchService\.search/i);

    // Alle drei Page-Loads parallel. Jede ruft setPageSize(100) als afterLoad
    // — unabhängige DOM-Mutationen pro Page, kein Race. waitForToccoLoad
    // pollt jeweils auf dem eigenen Document, also kein cross-page-Konflikt.
    // Der Absenzen-Scrape ist BEST-EFFORT: .catch → leerer Text, damit ein
    // Fehler hier Noten/Stundenplan nie abbricht (Spec §6).
    const [notenRaw, spRaw, absRaw] = await Promise.all([
      scrapePage(notenPage, cfg.notenUrl, 'Noten', log, {
        afterLoad: (p) => setPageSize(p, 100, log, 'Noten')
      }),
      scrapePage(planPage, cfg.stundenplanUrl, 'Stundenplan', log, {
        afterLoad: (p) => setPageSize(p, 100, log, 'Stundenplan')
      }),
      scrapePage(absenzenPage, cfg.absenzenUrl, 'Absenzen', log, {
        afterLoad: (p) => setPageSize(p, 100, log, 'Absenzen')
      }).catch(() => ({ text: '' })),
    ]);

    const noten = parseNoten(notenRaw.text || '');
    const stundenplan = parseStundenplan(spRaw.text || '');

    // Absenzen parsen + DWR-Capture UNBEDINGT abholen+stoppen (auch wenn der
    // Best-Effort-Scrape rejectete — sonst Listener-Leak auf der Page). Der
    // Listener-Stop ist von einem Scrape-Fehler entkoppelt.
    const absenzen = parseAbsenzenOverview(absRaw.text || '');
    let absenzDetailIdMap = {};

    // PRIMÄR: aktive Voll-Suche. Wir replayen die echte Such-Request der Seite
    // (robust gegen Spalten-/Form-Änderungen) mit gebumptem Paging-Limit und
    // parsen genau diese EINE Antwort → deterministisch ALLE Module, kein
    // Capture-Race, keine Abhängigkeit von der UI-Seitengröße. Best-effort:
    // ein Fehler hier fällt auf die passiv erfassten Responses zurück.
    try {
      // absDwrReqCapture ist hier garantiert gesetzt (Zuweisung vor Promise.all,
      // Fehler davor landen im äusseren catch) → kein Truthy-Guard nötig.
      const firstReq = absDwrReqCapture.getFirst();
      if (firstReq && absenzenPage) {
        const bumpedBody = bumpDwrPagingLimit(firstReq.postData, 1000);
        // Vom Browser verbotene/automatische Header herausfiltern — fetch setzt
        // sie selbst; die fachlichen x-*-Header bleiben erhalten.
        const safeHeaders = {};
        for (const [k, v] of Object.entries(firstReq.headers || {})) {
          const lk = k.toLowerCase();
          if (lk === 'content-length' || lk === 'host' || lk === 'cookie' ||
              lk === 'connection' || lk === 'accept-encoding') continue;
          safeHeaders[k] = v;
        }
        const fullText = await absenzenPage.evaluate(async (a) => {
          const r = await fetch(a.url, { method: 'POST', headers: a.headers, body: a.body, credentials: 'include' });
          return await r.text();
        }, { url: firstReq.url, headers: safeHeaders, body: bumpedBody });
        absenzDetailIdMap = parseAbsenzenIdMap([fullText], log);
        if (Object.keys(absenzDetailIdMap).length) {
          log('  [Absenzen] 🔑 ' + Object.keys(absenzDetailIdMap).length + ' Detail-IDs via Voll-Suche (limit 1000)', 'info');
        }
      }
    } catch (e) {
      log('  [Absenzen] ⚠️  Voll-Suche fehlgeschlagen (' + (e && e.message ? e.message : e) + ') — Fallback auf passiv erfasste Responses', 'warn');
    }
    // Stop ist null-sicher im try (Property-Zugriff ist drin); kein Guard nötig.
    try { absDwrReqCapture.stop(); } catch (_) {} absDwrReqCapture = null;

    // FALLBACK: passiv mitgeschnittene Search-Responses — nur falls die
    // Voll-Suche 0 lieferte (z.B. Body-Abgriff fehlgeschlagen). Capture in jedem
    // Fall stoppen, sonst Listener-Leak auf der Page.
    const absDwrTexts = await absDwrCapture.getResponses();
    absDwrCapture.stop();
    absDwrCapture = null;
    if (Object.keys(absenzDetailIdMap).length === 0) {
      absenzDetailIdMap = parseAbsenzenIdMap(absDwrTexts, log);
      if (Object.keys(absenzDetailIdMap).length) {
        log('  [Absenzen] 🔑 ' + Object.keys(absenzDetailIdMap).length + ' Detail-IDs (passiv erfasst, Fallback)', 'info');
      }
    }

    // PRIMÄR: Noten-Such-Request faithful mit limit:1000 REPLAYEN → deterministisch
    // ALLE Module (statt nur der passiv erfassten limit-25-Initialantwort, die
    // Module ab Position 26 verschluckt). Spiegelt den Absenzen-Voll-Suche-Pfad.
    try {
      const firstReq = notenDwrReqCapture && notenDwrReqCapture.getFirst();
      if (firstReq) {
        const bumpedBody = bumpDwrPagingLimit(firstReq.postData, 1000);
        const safeHeaders = {};
        for (const [k, v] of Object.entries(firstReq.headers || {})) {
          const lk = k.toLowerCase();
          if (lk === 'content-length' || lk === 'host' || lk === 'cookie' ||
              lk === 'connection' || lk === 'accept-encoding') continue;
          safeHeaders[k] = v;
        }
        const fullText = await notenPage.evaluate(async (a) => {
          const r = await fetch(a.url, { method: 'POST', headers: a.headers, body: a.body, credentials: 'include' });
          return await r.text();
        }, { url: firstReq.url, headers: safeHeaders, body: bumpedBody });
        const fullMap = parseDwrIdMap(fullText);
        for (const [k, v] of Object.entries(fullMap)) {
          if (!detailIdMap[k]) detailIdMap[k] = v;
        }
        if (Object.keys(detailIdMap).length) {
          log('  [Noten] 🔑 ' + Object.keys(detailIdMap).length + ' Modul-Detail-IDs via Voll-Suche (limit 1000)', 'info');
        }
      }
    } catch (e) {
      log('  [Noten] ⚠️  Voll-Suche fehlgeschlagen (' + (e && e.message ? e.message : e) + ') — Fallback auf passiv erfasste Responses', 'warn');
    }
    try { if (notenDwrReqCapture) notenDwrReqCapture.stop(); } catch (_) {} notenDwrReqCapture = null;

    // DWR-Listener stoppen — alle weiteren Detail-Calls sollen nicht das
    // ID-Mapping verfälschen. Vor dem Stop noch alle gesammelten Responses
    // abholen.
    const dwrTexts = await dwrCapture.getResponses();
    dwrCapture.stop();
    dwrCapture = null;

    // FALLBACK/Ergänzung: passiv mitgeschnittene Responses füllen nur Lücken
    // (first-wins) — die Voll-Suche oben hat Priorität.
    for (const t of dwrTexts) {
      const partial = parseDwrIdMap(t);
      for (const [k, v] of Object.entries(partial)) {
        if (!detailIdMap[k]) detailIdMap[k] = v;
      }
    }
    const idCount = Object.keys(detailIdMap).length;
    const notenCount = noten.length;
    if (idCount) {
      log('  [Noten] 🔑 ' + idCount + ' Modul-Detail-IDs aus DWR extrahiert', 'info');
      // Schärfere Sanity-Warnung: schon eine einzige fehlende ID ist verdächtig
      // (vorher erst < 50% → ein 25/28-Miss rutschte still durch).
      if (notenCount > 0 && idCount < notenCount) {
        log('  [Noten] ⚠️  DWR-ID-Map hat nur ' + idCount + '/' + notenCount + ' Module — Detail-Scrape überspringt die fehlenden', 'warn');
      }
    } else if (notenCount > 0) {
      log('  [Noten] ⚠️  Keine Modul-Detail-IDs gefunden — Detail-Scrape wird übersprungen', 'warn');
    }

    // Stundenplan-Page wird nicht mehr gebraucht — Detail-Scrapes laufen
    // alle auf Pool-Pages aus dem selben Context (Session schon „warm").
    // Schließen wir, um Page-RAM zu sparen. Best-effort: ein Close-Fehler
    // darf den Erfolg nicht killen.
    try { await planPage.close(); } catch (_) { /* swallow */ }
    planPage = null;

    // Absenzen-Übersichts-Page wird nicht mehr gebraucht — Detail-Scrapes
    // laufen auf Pool-Pages aus dem selben Context. Schließen (wie planPage),
    // best-effort.
    try { await absenzenPage.close(); } catch (_) { /* swallow */ }
    absenzenPage = null;

    // Stufe 2 — Detail-Scrape-Pool. Pool-Größe via Setting:
    // detailScrapeConcurrency (Default 4, konservativ wegen Tocco-
    // Server-Last + RAM). Pool wird lazy gefüllt; erste Detail-Calls
    // werden also weniger parallel laufen als der Soll-Wert sagt.
    const POOL_DEFAULT = 6;  // 4 → 6: Detail-Phase ist der Flaschenhals; 6 Pool-
                             // Pages ~720 MB Peak (vertretbar). Bei wenig RAM via
                             // detailScrapeConcurrency wieder runtersetzen.
    const poolSize = Math.max(1, Math.min(
      Number(cfg.detailScrapeConcurrency) || POOL_DEFAULT,
      10 // Hard cap — Tocco hat keine offiziellen Rate-Limits; >10 parallele
         // Pages aus einer Session bringen kaum mehr, kosten aber linear RAM.
    ));
    detailPool = createDetailPagePool(context, poolSize);
    log('  🏊 Detail-Page-Pool initialisiert (Soll-Größe ' + poolSize + ')', 'info');
    // RAM-Diagnose: ~120 MB/Pool-Page → 6 Pages + 2 Stage-1-Pages ~ 800 MB-1 GB
    // peak. Wenn wir hier schon nahe am Limit sind, lieber Pool kleiner halten
    // (detailScrapeConcurrency) oder OOM-Profilbild zur Hand haben. Nur Logging.
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

    // SEPARATES Warm-Tracking für Absenzen-Detail-Scrapes: die notenUrl-Wärmung
    // initialisiert evtl. nicht die Absenzen-#detail-Route (andere SPA-View).
    // Daher pro Detail-Art separat warmen (NICHT warmedPages teilen, Spec §8) —
    // wir laden die Absenzen-Übersichtsseite, damit der Hash-Wechsel danach als
    // Detail-Trigger erkannt wird.
    const absenzenWarmedPages = new WeakSet();
    async function ensureAbsenzenWarm(page) {
      if (absenzenWarmedPages.has(page)) return;
      log('  🔥 Pool-Page warm-up (Absenzen-Seite laden + SPA-Init)', 'info');
      await page.goto(cfg.absenzenUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await waitForToccoLoad(page, 'Absenzen-Pool-Warmup', log);
      absenzenWarmedPages.add(page);
    }

    return {
      noten,
      stundenplan,
      absenzen,
      detailIdMap,
      absenzDetailIdMap,
      rawText: { noten: notenRaw.text, stundenplan: spRaw.text, absenzen: absRaw.text },
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
      scrapeAbsenzenDetail: async (detailId) => {
        // Teilt sich denselben detailPool wie scrapeDetail, aber mit eigenem
        // Warm-Tracking (absenzenWarmedPages) — eine notenUrl-gewärmte Page ist
        // für die Absenzen-#detail-Route evtl. nicht warm (Spec §8).
        let page = await detailPool.acquire();
        if (!page) {
          throw new Error('detail-page-pool drained — scrape cycle ended');
        }
        try {
          await ensureAbsenzenWarm(page);
          return await scrapeAbsenzModulDetail(page, cfg.baseUrl, detailId, log);
        } catch (e) {
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
    if (notenDwrReqCapture) try { notenDwrReqCapture.stop(); } catch (_) {}
    if (absDwrCapture) try { absDwrCapture.stop(); } catch (_) {}
    if (absDwrReqCapture) try { absDwrReqCapture.stop(); } catch (_) {}
    // planPage best-effort cleanup — wenn schon null (success-path), no-op.
    if (planPage) { try { await planPage.close(); } catch (_) {} }
    // absenzenPage analog (mirror planPage:1052,1144).
    if (absenzenPage) { try { await absenzenPage.close(); } catch (_) {} }
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
  parseAnzahlPruefungen,
  parseAbsenzenOverview,
  parseAbsenzLektionen,
  parseTerminLangDatum,
  parseAbsenzenIdMap,
  bumpDwrPagingLimit,
  safeEvaluate,
  createDetailPagePool,
  serializeStorageState,
  readStorageState
};
