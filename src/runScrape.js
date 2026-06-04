'use strict';

const path = require('node:path');

const { escapeHtml } = require('./shared/escapeHtml');
const { DATA_DIR } = require('./auth');
const secretCrypto = require('./secretCrypto');

// =============================================================
// Helpers (pure / used by routes too)
// =============================================================

function maskSettings(s, ALLOW_UI_CREDENTIALS) {
  const hasPw = typeof s.msPassword === 'string' && s.msPassword.length > 0;
  const hasTg = typeof s.telegramToken === 'string' && s.telegramToken.length > 0;

  const out = {
    // Scheduler/UI-Felder
    autoRun: s.autoRun,
    intervalMinutes: s.intervalMinutes,
    intervalTimeFrom: s.intervalTimeFrom,
    intervalTimeTo: s.intervalTimeTo,
    scheduleMode: s.scheduleMode,
    scheduleDays: s.scheduleDays,
    scheduleTimes: s.scheduleTimes,
    manualScrapeFullDetails: s.manualScrapeFullDetails,
    headless: s.headless,
    slowMo: s.slowMo,
    port: s.port,
    telegramEnabled: s.telegramEnabled,
    telegramAllowedUserId: s.telegramAllowedUserId,
    // URL-Felder readonly anzeigen, aber als gelockt markieren (env-only)
    baseUrl: s.baseUrl,
    notenUrl: s.notenUrl,
    stundenplanUrl: s.stundenplanUrl,
    absenzenUrl: s.absenzenUrl,
    urlsLocked: true,
    // Secret-Indikatoren
    emailSet: Boolean(s.msEmail),
    passwordSet: hasPw,
    telegramTokenSet: hasTg,
    // Flag für Frontend
    allowUiCredentials: ALLOW_UI_CREDENTIALS
  };

  // Nur wenn ALLOW_UI_CREDENTIALS=true: echte Werte mit senden,
  // damit das Formular sie anzeigen/editieren kann (ist hinter Auth).
  if (ALLOW_UI_CREDENTIALS) {
    out.msEmail = s.msEmail || '';
    out.userPk = s.userPk || '';
  }

  return out;
}

function buildScraperConfig(s) {
  return {
    msEmail: s.msEmail,
    msPassword: s.msPassword,
    baseUrl: s.baseUrl,
    notenUrl: s.notenUrl,
    stundenplanUrl: s.stundenplanUrl,
    absenzenUrl: s.absenzenUrl,
    headless: s.headless,
    slowMo: s.slowMo,
    storageFile: path.join(DATA_DIR, 'storage.json'),
    cwd: DATA_DIR,
    detailScrapeConcurrency: s.detailScrapeConcurrency,
    // storage.json at-rest verschlüsseln (replaybare SSO-Session-Cookies).
    storageCrypto: { encrypt: secretCrypto.encrypt, decrypt: secretCrypto.decrypt }
  };
}

// ---------- logPushResult ----------
// Aggregiert sent/removed/errors aus push.notifyGradeChanges /
// notifyRoomChanges (kann allSettled-Array oder einzelnes Result sein) und
// schreibt es in den Logger. Damit landen Probleme wie VAPID-Drift oder
// gestorbene Subscriptions im /api/logs statt silent in einem .catch zu
// verschwinden.
function makeLogPushResult(logger) {
  return function logPushResult(kind, r) {
    if (!r) return;
    let sent = 0, removed = 0;
    const errors = [];
    const items = Array.isArray(r) ? r : [{ status: 'fulfilled', value: r }];
    for (const it of items) {
      if (it.status !== 'fulfilled' || !it.value) continue;
      sent += it.value.sent || 0;
      removed += it.value.removed || 0;
      if (Array.isArray(it.value.errors)) errors.push(...it.value.errors);
    }
    if (!sent && !removed && !errors.length) return;
    const parts = ['sent=' + sent];
    if (removed) parts.push('removed=' + removed);
    if (errors.length) parts.push('errors=' + errors.length);
    logger.log('🔔 Web-Push (' + kind + '): ' + parts.join(' '), errors.length ? 'warn' : 'info');
    errors.slice(0, 3).forEach((e) => {
      logger.log('   ↳ ' + (e.status || '?') + ' ' + (e.message || 'unknown'), 'warn');
    });
  };
}

// Watchdog: kappt den Scrape-Cycle hart, wenn er > SCRAPE_TIMEOUT_MS hängt.
// Häufige Ursachen für Hänger: Playwright-Protokoll-Stall vor seinem eigenen
// Timeout, MS Conditional-Access-Loop, Tocco-SSO-Redirect-Bug. Ohne Watchdog
// bleibt `state.running=true` für immer → Scheduler feuert nie wieder, manuelle
// Trigger werden mit "already_running" abgelehnt → silent total failure.
// Konfigurierbar via SCRAPE_TIMEOUT_MS, default 15 min.
//
// Budget-Hinweis (Absenzen-Achse): Seit der vierten Daten-Achse läuft pro
// Cycle ein ZWEITER Detail-Pass (Absenzen) zusätzlich zum Noten-Detail-Pass.
// Beim wöchentlichen Voll-Refresh verdoppelt sich damit grob die Detail-
// Navigation. Beide Pässe teilen sich denselben Page-Pool, also steigt die
// Wandzeit additiv (nicht multiplikativ). 15 min reichen für die übliche
// Modulanzahl; bei sehr vielen Modulen den Default via SCRAPE_TIMEOUT_MS
// erhöhen. Die >=5-Timeout-Warn wird für beide Pässe separat gespiegelt.
const SCRAPE_TIMEOUT_MS = (() => {
  const env = parseInt(process.env.SCRAPE_TIMEOUT_MS, 10);
  return Number.isFinite(env) && env > 0 ? env : 15 * 60 * 1000;
})();

// Entscheidet, ob dieser Cycle einen VOLL-Detail-Refresh macht (ALLE Module
// mit detail_id neu detail-scrapen, statt nur geänderte/fehlende). Pure +
// testbar. Trigger:
//   - 'weekly'    : Sa-03:00-Backstop-Timer (deckt auch autoRun=aus ab).
//   - 'manual'    : nur wenn der User manualScrapeFullDetails aktiviert hat.
//   - 'scheduled' : am LETZTEN geplanten Lauf des Tages (opts.isLastRunOfDay)
//                   → täglicher Voll-Refresh am Tagesende. Ersetzt den reinen
//                   wöchentlichen Rhythmus: neue benotete LB (ohne Modulnoten-
//                   Änderung) und Module ohne Modulnote werden so täglich statt
//                   nur samstags nachgezogen.
// 'telegram'/'boot' lösen bewusst KEINEN Voll-Refresh aus (inkrementell).
function isFullDetailRefresh(reason, opts, settings) {
  if (reason === 'weekly') return true;
  if (reason === 'manual') return !!(settings && settings.manualScrapeFullDetails === true);
  if (reason === 'scheduled') return !!(opts && opts.isLastRunOfDay === true);
  return false;
}

// =============================================================
// Factory: returns the runScrapeCycle function bound to its collaborators.
// =============================================================
function create({ state, db, scraper, bot, push, settings, logger, sse, scheduler }) {
  const logPushResult = makeLogPushResult(logger);

  async function runScrapeCycle(reason, opts = {}) {
    if (state.running) {
      logger.log(`⚠️  Scrape bereits aktiv — Trigger "${reason}" ignoriert`, 'warn');
      return { triggered: false, reason: 'already_running' };
    }

    const s = settings.load();
    if (!s.msEmail || !s.msPassword) {
      const msg = 'msEmail / msPassword fehlen — scrape abgebrochen.';
      state.lastError = msg;
      logger.log('❌ ' + msg, 'error');
      sse.broadcastStatus(settings, state);
      return { triggered: false, reason: 'missing_credentials' };
    }

    state.running = true;
    state.lastError = null;
    if (reason === 'weekly') {
      // Attempt-Marker (#1): auch ein FEHLGESCHLAGENER Weekly-Lauf markiert
      // "versucht", damit scheduleWeeklyDetailRefresh bei Dauerfehler nicht alle
      // 90s neu feuert (Endlos-Retry des teuersten Scrapes), sondern auf Backoff
      // geht. lastWeeklyDetailAt bleibt success-only (Overdue-Berechnung).
      state.lastWeeklyDetailAttemptAt = new Date().toISOString();
    }
    scheduler.clearTimer();
    sse.setPhase(state, settings, 'starting');
    logger.log(`🚀 Scrape gestartet (reason=${reason})`, 'info');

    const startTs = Date.now();
    let result = null;
    let database = null;
    let scraped = null;
    // earlyBrowser wird vom scraper via onBrowserReady-Callback gesetzt,
    // sobald chromium.launch() resolved hat. Damit kann der Watchdog den
    // Browser ALSBALD killen — auch wenn der Hänger im Login-Flow auftritt
    // BEVOR scraper.runScrape überhaupt sein result-Objekt zurückliefert.
    let earlyBrowser = null;

    // Watchdog-Setup: nach SCRAPE_TIMEOUT_MS State zurücksetzen + best-effort
    // Browser schließen. Die Orphan-Promise läuft evtl. weiter, aber state ist
    // entsperrt → Scheduler kann wieder feuern, neue manuelle Trigger gehen
    // durch. `watchdogFired` wird im finally geprüft damit wir nicht doppelt
    // cleanup machen + nicht stale-data pushen.
    let watchdogFired = false;
    const watchdog = setTimeout(() => {
      if (!state.running) return; // schon fertig, no-op
      watchdogFired = true;
      const minutes = Math.round(SCRAPE_TIMEOUT_MS / 60000);
      logger.log(`⚠️  Scrape-Watchdog: ${minutes} min ohne Fortschritt — state wird zurückgesetzt (Orphan-Scrape läuft evtl. im Hintergrund)`, 'error');
      state.lastError = `Scrape-Watchdog-Timeout nach ${minutes} min`;
      state.running = false;
      sse.setPhase(state, settings, null);
      sse.broadcastStatus(settings, state);
      sse.broadcastSse('scrape_done', {
        ok: false,
        error: state.lastError,
        stats: null,
        finishedAt: new Date().toISOString()
      });
      // Best-effort: Browser killen, damit hängender Playwright-Await throws.
      // Erst über scraped.closeBrowser (wenn schon resolved), sonst via
      // earlyBrowser-Referenz aus onBrowserReady-Callback. earlyBrowser deckt
      // den frühen Hänger-Pfad ab (z.B. MS Conditional-Access-Loop), bevor
      // runScrape() überhaupt resolved.
      if (scraped && typeof scraped.closeBrowser === 'function') {
        scraped.closeBrowser().catch(() => { /* swallow */ });
      } else if (earlyBrowser) {
        try {
          earlyBrowser.close().catch(() => {});
        } catch (_) { /* swallow */ }
        // 5s Grace + SIGKILL-Fallback, weil .close() bei einem hängenden
        // Frame oder Listener nicht zurückkehrt.
        setTimeout(() => {
          try {
            const proc = typeof earlyBrowser.process === 'function' ? earlyBrowser.process() : null;
            if (proc && typeof proc.kill === 'function') proc.kill('SIGKILL');
          } catch (_) { /* swallow */ }
        }, 5000).unref?.();
      }
      try { scheduler.scheduleNext(); } catch (_) { /* swallow */ }
      // Weekly-Backstop ebenfalls neu armen (#7) — sonst stirbt der Wochen-
      // Detail-Refresh bei einem Watchdog-Timeout bis zum nächsten Reboot
      // (kritisch wenn autoRun=aus, dann ist Weekly der einzige Voll-Refresh).
      try { scheduler.scheduleWeeklyDetailRefresh(); } catch (_) { /* swallow */ }
    }, SCRAPE_TIMEOUT_MS);
    watchdog.unref?.();

    try {
      const cfg = {
        ...buildScraperConfig(s),
        // onBrowserReady wird vom scraper sofort nach chromium.launch()
        // synchron aufgerufen — damit haben wir eine Browser-Handle BEVOR
        // der erste Page-Load passiert.
        onBrowserReady: (b) => { earlyBrowser = b; }
      };
      scraped = await scraper.runScrape(
        cfg,
        (msg, level) => logger.log(msg, level),
        (phase) => sse.setPhase(state, settings, phase)
      );
      result = scraped;

      // Persistieren
      sse.setPhase(state, settings, 'saving');
      database = db.getInstance();
      const nStats = db.saveNoten(database, scraped.noten || []);

      // detail_id-Mapping aus DWR-Response in der noten-Tabelle persistieren
      let detailIdsUpdated = 0;
      if (scraped.detailIdMap && Object.keys(scraped.detailIdMap).length) {
        detailIdsUpdated = db.updateDetailIds(database, scraped.detailIdMap);
      }

      const sStats = db.saveStundenplan(database, scraped.stundenplan || []);
      const pruned = db.pruneVergangen(database);

      // Absenzen-Übersicht persistieren (vierte Daten-Achse). saveAbsenzen ist
      // best-effort-tolerant: scraped.absenzen ist [] wenn der Best-Effort-
      // Scrape rejectete → reines NO-OP, kein Crash für Noten/Stundenplan.
      const aStats = db.saveAbsenzen(database, scraped.absenzen || []);
      // detail_id-Mapping (kuerzel_code → detail_id) aus DWR persistieren.
      if (scraped.absenzDetailIdMap && Object.keys(scraped.absenzDetailIdMap).length) {
        db.updateAbsenzDetailIds(database, scraped.absenzDetailIdMap);
      }

      // Modul-Detail-Scrape: alle Module mit gradeChange (new/changed) UND
      // alle benoteten Module ohne bisherige Pruefungen-Daten (Backfill).
      const changedKuerzelIds = (nStats.gradeChanges || [])
        .map(c => c.kuerzel_id)
        .filter(Boolean);

      const detailStats = { modulesScraped: 0, totalEntries: 0, errors: 0 };
      // Modul-Liste je nach Modus:
      //   Voll-Refresh → ALLE Module mit detail_id (Cooldown ignoriert, auch
      //                  Module OHNE Modulnote — siehe getKuerzelnWithDetailId)
      //   sonst        → nur Module mit gradeChange ODER ohne bisherige Prüfungen
      // Voll-Refresh greift: wöchentlicher Sa-Backstop, manueller Trigger mit
      // aktiviertem Toggle, UND der letzte geplante Lauf des Tages (täglicher
      // Voll-Refresh am Tagesende). Siehe isFullDetailRefresh().
      const isWeekly = reason === 'weekly';
      const fullDetailRefresh = isFullDetailRefresh(reason, opts, s);

      // Absenz-Detail-Pass + Push laufen NICHT bei jedem Autorun-Lauf, sondern
      // nur beim LETZTEN geplanten Lauf des Tages (opts.isLastRunOfDay, vom
      // Scheduler gesetzt). Manuelle/Telegram/weekly Läufe machen Absenzen immer
      // voll (explizite bzw. Voll-Refresh-Aktion). Die Absenz-ÜBERSICHT
      // (saveAbsenzen oben) läuft weiterhin jeden Lauf → Ø-Anwesenheit bleibt
      // stündlich frisch; nur die teure Tagesliste + Push warten auf den
      // Tages-Abschlusslauf. Autorun feuert nur an scheduleDays → „nur an
      // eingestellten Tagen" ist dadurch automatisch erfüllt.
      const runAbsenzDetail = reason !== 'scheduled' || opts.isLastRunOfDay === true;
      const toScrape = fullDetailRefresh
        ? db.getKuerzelnWithDetailId(database).map(r => ({ kuerzel_id: r.kuerzel_id, detail_id: r.detail_id }))
        : db.getKuerzelnNeedingDetailScrape(database, changedKuerzelIds);

      // Wochen-Diff-Sammlung: pro Modul welche Prüfungen sind NEU dazugekommen
      const weeklyReport = []; // { kuerzel_id, fach_name, semester, kuerzel_code, added: [...] }
      // Pro Modul welche bestehenden Prüfungen ihre Bewertung geändert haben.
      // Im Gegensatz zu addedEntries läuft das in JEDEM Scrape-Mode (nicht nur
      // weekly), weil Tocco eine Korrektur an einer ZP/LB jederzeit pushen kann
      // und der User den Diff sehen will.
      const pruefungenChanges = []; // { kuerzel_id, fach_name, semester, kuerzel_code, changed: [...] }

      if (toScrape.length && typeof scraped.scrapeDetail === 'function') {
        sse.setPhase(state, settings, 'noten_details');
        const refreshLabel = isWeekly
          ? ' (wöchentlicher Voll-Refresh)'
          : (reason === 'scheduled' && opts.isLastRunOfDay)
            ? ' (täglicher Voll-Refresh, letzter Lauf des Tages)'
            : (fullDetailRefresh ? ' (manueller Voll-Refresh)' : '');
        logger.log(`📥 Detail-Scrape für ${toScrape.length} Modul(e)${refreshLabel} — parallel via Page-Pool`, 'info');

        // Phase 1: parallel Detail-Scrapes feuern. Der Page-Pool im Scraper
        // limited die Concurrency intern (default 4) — wir können hier
        // gefahrlos alle Module gleichzeitig anwerfen. Promise.allSettled,
        // damit ein einzelner Fehler nicht die ganzen Detail-Daten verliert.
        const fetchResults = await Promise.allSettled(
          toScrape.map(async (m) => {
            const detail = await scraped.scrapeDetail(m.detail_id);
            return { m, detail };
          })
        );

        // Detail-Phase-Diagnose: Wenn deutlich viele Detail-Scrapes mit
        // Timeouts gescheitert sind, ist Tocco vermutlich gerade langsam.
        // Echtes Backoff lohnt nicht (Single-User, max 1×/Cycle), aber als
        // Warning im /api/logs hilft es Operator zu verstehen was los war.
        const timeouts = fetchResults.filter((r) =>
          r.status === 'rejected' && /Timeout|MAX_WAIT/i.test((r.reason && r.reason.message) || '')
        ).length;
        if (timeouts >= 5) {
          logger.log(`  ⚠️  ${timeouts} Detail-Scrape-Timeouts — Tocco evtl. langsam`, 'warn');
        }

        // Phase 2: sequenziell DB-Save + Diff-Sammlung. SQLite WAL hat nur
        // einen Writer; parallele savePruefungen würden gegen SQLITE_BUSY
        // laufen. Side effects (logger, state) bleiben deterministisch in
        // toScrape-Reihenfolge, damit Logs lesbar bleiben.
        for (let i = 0; i < fetchResults.length; i += 1) {
          const m = toScrape[i];
          const r = fetchResults[i];
          if (r.status === 'rejected') {
            detailStats.errors++;
            const errMsg = (r.reason && r.reason.message) ? r.reason.message : String(r.reason);
            logger.log(`  ❌ Detail-Scrape ${m.kuerzel_id}: ${errMsg}`, 'warn');
          } else {
            // scrapeDetail liefert { entries, expectedCount }; expectedCount =
            // "Anzahl Prüfungen: N" → Lösch-Schutz gegen Teil-Scrapes (#6).
            const { detail } = r.value;
            const entries = (detail && Array.isArray(detail.entries)) ? detail.entries : [];
            const expectedCount = (detail && Number.isFinite(detail.expectedCount)) ? detail.expectedCount : null;
            if (entries && entries.length) {
              const ps = db.savePruefungen(database, m.kuerzel_id, entries, { expectedCount });
              detailStats.modulesScraped++;
              detailStats.totalEntries += (ps.inserted + ps.updated);
              logger.log(`  ✓ ${m.kuerzel_id} → ${entries.length} Prüfung(en)`, 'info');
              if (ps.incomplete) {
                logger.log(`  ⚠️  ${m.kuerzel_id}: Teil-Scrape erkannt (${ps.scrapedCount}/${ps.expectedCount}) — Lösch-Schutz aktiv, keine Prüfung gelöscht`, 'warn');
              }
              // Beim Voll-Refresh (wöchentlich ODER manuell): NEUE Prüfungen
              // die nicht von einem gradeChange-Push abgedeckt sind → eigener
              // Push-Eintrag. Ohne das würde ein manueller Voll-Refresh zwar
              // alle Detailseiten laden, neu entdeckte Prüfungen aber still
              // verschlucken.
              if (fullDetailRefresh && ps.addedEntries && ps.addedEntries.length) {
                const isAlreadyCovered = changedKuerzelIds.includes(m.kuerzel_id);
                if (!isAlreadyCovered) {
                  const modulRow = db.getNotenRow(database, m.kuerzel_id);
                  weeklyReport.push({
                    kuerzel_id: m.kuerzel_id,
                    fach_name:  modulRow ? modulRow.fach_name : null,
                    semester:   modulRow ? modulRow.semester : null,
                    kuerzel_code: modulRow ? modulRow.kuerzel_code : null,
                    added:      ps.addedEntries
                  });
                }
              }
              // Wert-Änderungen an bestehenden Prüfungen werden IMMER gesammelt
              // (auch im Normal-Mode), weil Tocco LB/ZP-Korrekturen jederzeit
              // pushen kann. Wird unten als Anhang in die Modul-Push-Nachricht
              // gepackt — falls der gradeChange-Push das Modul ohnehin abdeckt,
              // hängen wir den Diff als Detail an. Falls nicht (Schnitt-Rundung
              // identisch geblieben), wird ein eigener Push erzeugt.
              if (ps.changedEntries && ps.changedEntries.length) {
                const modulRow = db.getNotenRow(database, m.kuerzel_id);
                pruefungenChanges.push({
                  kuerzel_id:   m.kuerzel_id,
                  fach_name:    modulRow ? modulRow.fach_name : null,
                  semester:     modulRow ? modulRow.semester : null,
                  kuerzel_code: modulRow ? modulRow.kuerzel_code : null,
                  changed:      ps.changedEntries
                });
              }
            } else {
              logger.log(`  ⏭️  ${m.kuerzel_id} → keine Prüfungs-Daten gefunden`, 'info');
            }
          }
          // Cooldown-Marker NUR bei nicht-rejectetem Outcome (Erfolg ODER
          // leer-aber-valide). Ein transienter Fehler (Timeout, Frame detached)
          // darf KEINEN 12h-Cooldown setzen (#10) — sonst blockiert ein
          // einmaliger Fehler den Backfill bis zu 12h. Bei reject → kein Marker
          // → nächster Cycle versucht es erneut.
          if (r.status !== 'rejected') {
            try { db.markDetailScraped(database, m.kuerzel_id); } catch (_) { /* ignore */ }
          }
        }
      }

      // =========================================================
      // Absenzen-Detail-Pass — Klon des Noten-Detail-Pass oben, gegen die
      // Absenzen-Achse. Inkrementell (geänderte Module + wöchentlicher Voll-
      // Refresh), geteilter Detail-Page-Pool im Scraper. Best-effort: ein
      // Detail-Fehler verliert nie die ganze Absenzen-Übersicht.
      // =========================================================
      const absenzDetailStats = { modulesScraped: 0, totalEntries: 0, errors: 0 };
      // Cold-Start-Schutz Schicht 2 (§9): changedCodes enthält per Vertrag
      // KEINE Erst-Inserts → eine Neuinstallation mit historischen Absenzen
      // pusht 0×. Der absenzReport sammelt nur push-würdige Module.
      const absenzReport = []; // { kuerzel_code, bezeichnung, lektionen: [...] }
      const aChangedCodes = (aStats && Array.isArray(aStats.changedCodes)) ? aStats.changedCodes : [];
      // Absenzen werden bei JEDEM Scrape VOLL detail-gescrapt (alle Module mit
      // detail_id) — nur ~35 Module, und so bleibt nie eine Tagesliste leer
      // (User-Wunsch: alle Module sauber). Der inkrementelle Pfad
      // (getAbsenzenNeedingDetailScrape) entfällt für Absenzen bewusst.
      // Push bleibt korrekt: newAbwesend wird unten nur für geänderte Module
      // (isCovered via aChangedCodes) bzw. beim Voll-Refresh in den Report
      // aufgenommen — re-scrapte UNVERÄNDERTE Lektionen erzeugen 0 Push.
      const toScrapeAbs = db.getAbsenzenWithDetailId(database);

      if (toScrapeAbs.length && runAbsenzDetail && typeof scraped.scrapeAbsenzenDetail === 'function') {
        sse.setPhase(state, settings, 'absenzen_details');
        const refreshLabelAbs = isWeekly
          ? ' (wöchentlicher Voll-Refresh)'
          : (reason === 'scheduled' && opts.isLastRunOfDay)
            ? ' (täglicher Voll-Refresh, letzter Lauf des Tages)'
            : (fullDetailRefresh ? ' (manueller Voll-Refresh)' : '');
        logger.log(`📥 Absenz-Detail-Scrape für ${toScrapeAbs.length} Modul(e)${refreshLabelAbs} — parallel via Page-Pool`, 'info');

        // Phase 1: parallel feuern — der Page-Pool limited Concurrency intern.
        // Promise.allSettled, damit ein einzelner Fehler die Detail-Daten der
        // übrigen Module nicht verliert.
        const absFetchResults = await Promise.allSettled(
          toScrapeAbs.map(async (m) => {
            const entries = await scraped.scrapeAbsenzenDetail(m.detail_id);
            return { m, entries };
          })
        );

        const absTimeouts = absFetchResults.filter((r) =>
          r.status === 'rejected' && /Timeout|MAX_WAIT/i.test((r.reason && r.reason.message) || '')
        ).length;
        if (absTimeouts >= 5) {
          logger.log(`  ⚠️  ${absTimeouts} Absenz-Detail-Scrape-Timeouts — Tocco evtl. langsam`, 'warn');
        }

        // Phase 2: SEQUENZIELL DB-Save + Diff-Sammlung. SQLite WAL hat nur einen
        // Writer; parallele saveLektionen liefen gegen SQLITE_BUSY.
        for (let i = 0; i < absFetchResults.length; i += 1) {
          const m = toScrapeAbs[i];
          const r = absFetchResults[i];
          if (r.status === 'rejected') {
            absenzDetailStats.errors++;
            const errMsg = (r.reason && r.reason.message) ? r.reason.message : String(r.reason);
            logger.log(`  ❌ Absenz-Detail-Scrape ${m.kuerzel_code}: ${errMsg}`, 'warn');
          } else {
            const { entries } = r.value;
            // Empty-Input NO-OP wird in saveLektionen behandelt (kein Delete,
            // kein Push) — wir rufen es trotzdem auf, damit der Vertrag (jeder
            // Outcome → markAbsenzDetailScraped) erfüllt bleibt.
            const ls = db.saveLektionen(database, m.kuerzel_code, entries || []);
            if (entries && entries.length) {
              absenzDetailStats.modulesScraped++;
              absenzDetailStats.totalEntries += (ls.inserted + ls.updated);
              logger.log(`  ✓ ${m.kuerzel_code} → ${entries.length} Lektion(en)`, 'info');
            } else {
              logger.log(`  ⏭️  ${m.kuerzel_code} → keine Lektions-Daten gefunden`, 'info');
            }
            // Cold-Start-Schutz Schicht 2 (§9): newAbwesend nur dann in den
            // Push-Report, wenn das Modul in diesem Zyklus NICHT erst-eingefügt
            // wurde. changedCodes enthält per Vertrag keine Erst-Inserts.
            // Beim Voll-Refresh (weekly/manuell) dürfen auch nicht-changed
            // Module pushen — analog zur Noten-weeklyReport-not-already-covered-
            // Logik —, aber weiterhin nur für Module mit prev-Zeile, was durch
            // changedCodes ODER eine bereits existierende Übersicht (Backfill)
            // abgedeckt ist. Erst-Inserts bleiben über changedCodes-Filter raus.
            if (ls.newAbwesend && ls.newAbwesend.length) {
              // isCovered: Modul-Übersicht hat sich in diesem Zyklus geändert
              // (besucht/anwesenheit_pct-Delta) — equivalent zum gradeChanges-
              // Pfad bei Noten. fullDetailRefresh deckt zusätzlich den weekly/
              // manuellen Voll-Refresh ab (not-already-covered-Logik wie Noten-
              // weeklyReport). Erst-Inserts sind nie in aChangedCodes → eine
              // Neuinstallation mit historischen Absenzen pusht 0× (§9).
              const isCovered = aChangedCodes.includes(m.kuerzel_code);
              // Cold-Start-Schutz (#2): beim Voll-Refresh NUR pushen, wenn das
              // Modul in diesem Lauf NICHT erstbefüllt wurde (ls.coldStart) —
              // sonst pusht eine Neuinstallation alle historischen Absenzen.
              if (isCovered || (fullDetailRefresh && !ls.coldStart)) {
                absenzReport.push({
                  kuerzel_code: m.kuerzel_code,
                  bezeichnung:  m.bezeichnung != null ? m.bezeichnung : null,
                  lektionen:    ls.newAbwesend
                });
              }
            }
          }
          // Cooldown-/Scraped-Marker setzen bei JEDEM Outcome (§4.2-Vertrag).
          try { db.markAbsenzDetailScraped(database, m.kuerzel_code); } catch (_) { /* ignore */ }
        }
      } else if (toScrapeAbs.length && !runAbsenzDetail) {
        logger.log('  ⏭️  [Absenzen] Detail-Pass + Push übersprungen — nicht der letzte Autorun-Lauf des Tages (Übersicht wurde aktualisiert)', 'info');
      }

      if (isWeekly) {
        state.lastWeeklyDetailAt = new Date().toISOString();
        scheduler.persistWeeklyDetailState();
        logger.log(`🔍 Wochen-Check fertig — ${weeklyReport.length} Modul(e) mit neuen Prüfungen`, 'info');
      }

      state.lastStats = {
        noten: nStats,
        stundenplan: sStats,
        pruned,
        detailIdsUpdated,
        detail: detailStats,
        weeklyReport: fullDetailRefresh ? weeklyReport : null,
        pruefungenChanges,
        // Vierte Achse: aStats (inserted/updated/changedCodes) + absenzReport
        // (push-würdige Module mit newAbwesend-Lektionen) + Detail-Counts.
        absenzen: { ...aStats, absenzReport, detail: absenzDetailStats },
        fetchedAt: scraped.fetchedAt,
        counts: {
          noten: (scraped.noten || []).length,
          stundenplan: (scraped.stundenplan || []).length,
          absenzen: (scraped.absenzen || []).length
        }
      };
      state.lastRun = new Date().toISOString();

      const dur = ((Date.now() - startTs) / 1000).toFixed(1);
      logger.log(
        `✅ Scrape fertig in ${dur}s — Noten: ${nStats.inserted} neu / ${nStats.updated} updated / ${nStats.changed} Note geändert. Stundenplan: ${sStats.inserted} neu / ${sStats.updated} updated / ${pruned} vergangen entfernt. Details: ${detailStats.modulesScraped} Modul(e) / ${detailStats.totalEntries} Prüfung(en)${detailStats.errors ? ' / ' + detailStats.errors + ' Fehler' : ''}. Absenzen: ${aStats.inserted} neu / ${aStats.updated} updated / ${absenzDetailStats.modulesScraped} Detail(s)${absenzDetailStats.errors ? ' / ' + absenzDetailStats.errors + ' Fehler' : ''}.`,
        'info'
      );
    } catch (err) {
      const message = (err && err.message) ? err.message : String(err);
      // M3: state.lastError fliesst via /api/status + SSE an alle authentifizierten
      // Clients — roher Exception-Text kann interne Hostnames/Pfade/Playwright-
      // Internals enthalten. Daher nur eine generische, nicht-sensitive Meldung in
      // state.lastError; der Volltext bleibt ausschliesslich im Server-Log.
      state.lastError = 'Scrape fehlgeschlagen — Details im Server-Log';
      logger.log('❌ Scrape-Fehler: ' + message, 'error');
    } finally {
      // finally enthält NUR Cleanup der immer laufen muss — kein return hier
      // (no-unsafe-finally). Die Post-Processing-Logik inkl. watchdogFired-Check
      // läuft nach dem try/catch/finally im Normalfluss.
      clearTimeout(watchdog);
      // DB-Singleton bleibt offen — wird nur beim Server-Shutdown geschlossen.
      // Browser sicher schließen (wird seit der Detail-Page-Erweiterung NICHT
      // mehr automatisch von runScrape geschlossen — Aufrufer-Verantwortung).
      if (scraped && typeof scraped.closeBrowser === 'function') {
        try { await scraped.closeBrowser(); } catch (_) { /* swallow */ }
      }
    }

    // Wenn der Watchdog schon gefeuert hat, hat er state + SSE bereits sauber
    // zurückgesetzt. Wir DÜRFEN hier nicht nochmal state mutieren oder
    // scrape_done broadcasten, sonst sieht der User erst "Watchdog-Timeout"
    // und dann "Scrape fertig" mit halben Daten. Auch keine Telegram/Push-
    // Notifications für die unvollständige Stats senden.
    if (watchdogFired) {
      return { triggered: false, reason: 'watchdog_timeout' };
    }

    {
      state.running = false;
      sse.setPhase(state, settings, null);
      sse.broadcastStatus(settings, state);
      sse.broadcastSse('scrape_done', {
        ok: !state.lastError,
        error: state.lastError,
        stats: state.lastStats,
        finishedAt: new Date().toISOString()
      });
      // Telegram push
      try {
        if (state.lastError) {
          // escapeHtml — damit Fehlermeldungen mit <, >, & den HTML-Parser nicht kaputtmachen
          bot.notify('❌ <b>Scrape-Fehler</b>\n<code>' + escapeHtml(String(state.lastError)) + '</code>');
        } else {
          const gc = state.lastStats && state.lastStats.noten && state.lastStats.noten.gradeChanges;
          // Map<kuerzel_id, [changedEntries...]> — wird sowohl von Telegram
          // (als Detail-Anhang im Modul-Push) als auch vom Standalone-Push
          // genutzt für Module deren Schnitt sich nicht geändert hat.
          const pcAll = (state.lastStats && state.lastStats.pruefungenChanges) || [];
          const pcByKuerzel = {};
          for (const m of pcAll) {
            if (m.kuerzel_id) pcByKuerzel[m.kuerzel_id] = m.changed;
          }
          if (gc && gc.length) {
            let currentStats = null;
            let pruefungenByKuerzel = null;
            try {
              const statDb = db.getInstance();
              currentStats = db.getStats(statDb);
              // Pruefungen für betroffene Module einsammeln (best-effort)
              pruefungenByKuerzel = {};
              for (const c of gc) {
                if (!c.kuerzel_id) continue;
                pruefungenByKuerzel[c.kuerzel_id] = db.getPruefungen(statDb, c.kuerzel_id);
              }
            } catch (_) { /* fallback */ }
            bot.notifyGradeChanges(gc, currentStats, pruefungenByKuerzel, pcByKuerzel);
          }
          const rc = state.lastStats && state.lastStats.stundenplan && state.lastStats.stundenplan.roomChanges;
          if (rc && rc.length) {
            bot.notifyRoomChanges(rc);
          }

          // Standalone-Push für Prüfungs-Wert-Änderungen wenn der Modul-Schnitt
          // sich NICHT geändert hat (Edge case: Tocco-Rundung verschluckt den
          // Diff). gradeChanges-Module sind hier ausgeschlossen, weil deren
          // Push schon den Anhang trägt.
          const gcKuerzelIds = new Set((gc || []).map(c => c.kuerzel_id).filter(Boolean));
          const pcStandalone = pcAll.filter(m => m.kuerzel_id && !gcKuerzelIds.has(m.kuerzel_id));
          if (pcStandalone.length) {
            bot.notifyPruefungenChanges(pcStandalone);
          }

          // Web-Push (PWA) parallel zum Telegram-Bot — best-effort. Wir loggen
          // sent/removed/errors damit eine kaputte Subscription (z.B. nach
          // VAPID-Drift) im /api/logs sichtbar ist statt silent zu sterben.
          if (push) {
            try {
              const gcAll = state.lastStats && state.lastStats.noten && state.lastStats.noten.gradeChanges;
              if (gcAll && gcAll.length) {
                // pcByKuerzel als optionaler Diff-Anhang für die Push-Body
                push.notifyGradeChanges(gcAll, undefined, pcByKuerzel)
                  .then((r) => logPushResult('grade', r))
                  .catch((e) => logger.log('🔔 Push (Noten) Fehler: ' + (e && e.message), 'warn'));
              }
              if (rc && rc.length) {
                push.notifyRoomChanges(rc)
                  .then((r) => logPushResult('room', r))
                  .catch((e) => logger.log('🔔 Push (Stundenplan) Fehler: ' + (e && e.message), 'warn'));
              }
              if (pcStandalone.length && typeof push.notifyPruefungenChanges === 'function') {
                push.notifyPruefungenChanges(pcStandalone)
                  .then((r) => logPushResult('pruef', r))
                  .catch((e) => logger.log('🔔 Push (Prüfungen) Fehler: ' + (e && e.message), 'warn'));
              }
            } catch (_) { /* push ist best-effort */ }
          }
          // Wöchentlicher Detail-Refresh: Push für Module mit neuen ZP/LB
          // die NICHT bereits durch einen gradeChange-Push abgedeckt waren.
          const wr = state.lastStats && state.lastStats.weeklyReport;
          if (wr && wr.length) {
            bot.notifyWeeklyDetailReport(wr);
            // Web-Push parallel zum Telegram-Report (#12) — vorher nur Telegram.
            if (push && typeof push.notifyWeeklyDetailReport === 'function') {
              push.notifyWeeklyDetailReport(wr, database)
                .then((r) => logPushResult('detail', r))
                .catch((e) => logger.log('🔔 Push (Detail-Check) Fehler: ' + (e && e.message), 'warn'));
            }
          }

          // Absenzen: Push bei neuer/geänderter Nicht-Teilnahme (§4.4). Der
          // absenzReport ist bereits durch den Cold-Start-Schutz (§9) gefiltert
          // — Erst-Inserts mit historischen Absenzen pushen 0×. Telegram +
          // Web-Push best-effort, analog zu den Noten/Stundenplan-Dispatches.
          const ar = state.lastStats && state.lastStats.absenzen && state.lastStats.absenzen.absenzReport;
          if (ar && ar.length) {
            bot.notifyNeueAbsenzen(ar);
            if (push && typeof push.notifyNeueAbsenzen === 'function') {
              push.notifyNeueAbsenzen(ar, database)
                .then((r) => logPushResult('absenz', r))
                .catch((e) => logger.log('🔔 Push (Absenzen) Fehler: ' + (e && e.message), 'warn'));
            }
          }
        }
      } catch (_) { /* notify ist best-effort */ }
      scheduler.scheduleNext();
      scheduler.scheduleWeeklyDetailRefresh();
    }

    return { triggered: true, result };
  }

  return { runScrapeCycle, logPushResult, maskSettings, buildScraperConfig };
}

module.exports = { create, maskSettings, buildScraperConfig, makeLogPushResult, isFullDetailRefresh };
