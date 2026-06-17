'use strict';

/**
 * loginBridge — liefert eine BEREITS EINGELOGGTE Playwright-Page auf der Noten-
 * Seite (damit die DWR-Engine geladen ist, die producer.run für getDetailData
 * braucht) und eine close()-Funktion, die den Browser sauber schliesst.
 *
 * Die Login-Mechanik (MS-SSO + storage.json-Cookie-Cache) wird 1:1 aus
 * scraper.js wiederverwendet (ensureLoggedIn) — KEINE Duplikation des fragilen
 * SSO-Flows. ensureLoggedIn liefert { browser, context, page }; wir navigieren
 * die zurückgegebene Page nur noch auf die Noten-Seite, damit nice2 + DWR laden.
 *
 * Wird ausschliesslich vom REST-Producer-Pfad (config.dataSource === 'rest')
 * verwendet — der DOM-Scraper-Pfad bleibt unberührt.
 */

const { ensureLoggedIn, closeBrowserSafe } = require('../scraper');

const DEFAULT_NOTEN_PATH = '/extranet/Meine-Bildung/Noten-f%C3%BCr-Studierende';

/**
 * Ermittelt die Noten-URL aus der Config. Bevorzugt config.notenUrl; fällt
 * sonst auf baseUrl + Standard-Noten-Pfad zurück.
 * @param {{notenUrl?:string, baseUrl?:string}} config
 * @returns {string}
 */
function resolveNotenUrl(config) {
  if (config && config.notenUrl) return config.notenUrl;
  const base = (config && config.baseUrl) || 'https://wiss.tocco.ch';
  return base.replace(/\/+$/, '') + DEFAULT_NOTEN_PATH;
}

/**
 * Loggt ein (reuse ensureLoggedIn) und öffnet die Noten-Seite (lädt DWR-Engine).
 * @param {object} config  Scraper-Config-Form (msEmail, msPassword, baseUrl,
 *   notenUrl, headless, slowMo, storageFile, cwd, storageCrypto, onBrowserReady)
 * @param {(msg:string, level?:string)=>void} [onLog]
 * @param {(phase:string)=>void} [onPhase]
 * @returns {Promise<{ page:import('playwright').Page, close:()=>Promise<void> }>}
 */
async function loginAndOpen(config, onLog, onPhase) {
  const log = typeof onLog === 'function' ? onLog : () => {};
  const phase = typeof onPhase === 'function' ? onPhase : () => {};

  // ensureLoggedIn validiert Credentials und wirft selbst bei fehlendem
  // SSO-Button / anonymem /username. onBrowserReady (für den Watchdog) wird
  // — falls vom Aufrufer gesetzt — durchgereicht, exakt wie im Scraper-Pfad.
  const { browser, page } = await ensureLoggedIn(
    config, log, phase, config && config.onBrowserReady
  );

  // close kapselt das harte 10s-Close-mit-SIGKILL-Muster. Idempotent genug:
  // ein zweiter Aufruf läuft gegen einen bereits geschlossenen Browser → no-op.
  const close = async () => { await closeBrowserSafe(browser); };

  try {
    const notenUrl = resolveNotenUrl(config);
    phase('rest_noten_page');
    log('🌐 REST-Bridge: öffne Noten-Seite (DWR-Engine) ' + notenUrl, 'info');
    // domcontentloaded — Tocco pollt dauernd, networkidle würde nie resolven.
    // Die DWR-Engine lädt asynchron nach; producer.run wartet via getDwrSsid.
    await page.goto(notenUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (err) {
    // Navigation fehlgeschlagen → Browser nicht verwaisen lassen.
    await close();
    throw err;
  }

  return { page, close };
}

module.exports = { loginAndOpen, resolveNotenUrl };
