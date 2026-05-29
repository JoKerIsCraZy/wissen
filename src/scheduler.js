'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { DATA_DIR } = require('./auth');

// Wöchentlicher Detail-Refresh: jeden Samstag 03:00 Uhr.
// Hintergrund-Check ob neue ZP/LB hinzugekommen sind, ohne dass sich die
// Modulnote geändert hätte (Edge-Case ZP=5.5 + LB=5.5 → Schnitt bleibt 5.5).
const WEEKLY_DETAIL_DAY = 6;       // 0=So, 1=Mo, ..., 6=Sa
const WEEKLY_DETAIL_HOUR = 3;      // 03:00
const WEEKLY_DETAIL_FILE = path.join(DATA_DIR, '.weekly-detail-at');

function hmToMinutes(hm) {
  const [h, m] = String(hm || '').split(':').map(n => parseInt(n, 10));
  return (isNaN(h) ? 0 : h) * 60 + (isNaN(m) ? 0 : m);
}

// Ist `date` innerhalb des erlaubten Fensters (Wochentag + Zeit)?
function isWithinInterval(date, days, fromHm, toHm) {
  if (Array.isArray(days) && days.length && !days.includes(date.getDay())) return false;
  if (!fromHm || !toHm) return true;
  const cur = date.getHours() * 60 + date.getMinutes();
  const f = hmToMinutes(fromHm);
  const t = hmToMinutes(toHm);
  if (f === t) return true;
  if (f < t) return cur >= f && cur <= t;
  // Fenster geht über Mitternacht: z.B. 22:00–06:00
  return cur >= f || cur <= t;
}

// Sucht den Start des nächsten erlaubten Fensters nach `fromDate`
function nextWindowStart(fromDate, days, fromHm) {
  const [fh, fm] = String(fromHm || '00:00').split(':').map(n => parseInt(n, 10));
  for (let d = 0; d <= 8; d++) {
    const cand = new Date(fromDate);
    cand.setDate(cand.getDate() + d);
    cand.setHours(fh, fm, 0, 0);
    const dayOk = !Array.isArray(days) || !days.length || days.includes(cand.getDay());
    if (dayOk && cand > fromDate) return cand;
  }
  return null;
}

// Berechnet den nächsten Fire-Zeitpunkt basierend auf dem gewählten Mode.
// Mode 'interval':  jetzt + N Minuten, aber nur innerhalb Tag+Zeitfenster
// Mode 'weekly':    nächster Tag-Zeit-Slot aus scheduleDays × scheduleTimes
function computeNextRun(s, fromDate = new Date()) {
  if (s.scheduleMode === 'weekly') {
    if (!Array.isArray(s.scheduleDays) || !s.scheduleDays.length) return null;
    if (!Array.isArray(s.scheduleTimes) || !s.scheduleTimes.length) return null;

    let best = null;
    for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
      const candDate = new Date(fromDate);
      candDate.setDate(candDate.getDate() + dayOffset);
      if (!s.scheduleDays.includes(candDate.getDay())) continue;

      for (const hm of s.scheduleTimes) {
        const [h, m] = hm.split(':').map(n => parseInt(n, 10));
        const cand = new Date(candDate);
        cand.setHours(h, m, 0, 0);
        if (cand > fromDate && (!best || cand < best)) best = cand;
      }
    }
    return best;
  }

  // Interval: naive + N Minuten, dann Tag/Fenster prüfen
  const ms = Math.max(1, s.intervalMinutes) * 60 * 1000;
  const naiveNext = new Date(fromDate.getTime() + ms);

  if (isWithinInterval(naiveNext, s.scheduleDays, s.intervalTimeFrom, s.intervalTimeTo)) {
    return naiveNext;
  }
  // Außerhalb → springe auf Start des nächsten erlaubten Fensters
  return nextWindowStart(naiveNext, s.scheduleDays, s.intervalTimeFrom);
}

// True, wenn nach `runTime` KEIN weiterer geplanter Lauf am selben Kalendertag
// folgt — dann ist `runTime` der letzte Autorun-Lauf des Tages. Genutzt vom
// runScrapeCycle, um den (teuren) Absenz-Detail-Pass + Push nur 1×/Tag laufen
// zu lassen (Übersicht läuft weiterhin jeden Lauf). Reine Funktion → testbar.
// Vergleich über toDateString() (lokale Zeitzone, Zeit ignoriert).
function isLastScheduledRunOfDay(s, runTime = new Date()) {
  const after = computeNextRun(s, runTime);
  return !after || after.toDateString() !== runTime.toDateString();
}

// Berechnet den nächsten Samstag um WEEKLY_DETAIL_HOUR Uhr (lokale Zeit).
// Falls heute Samstag und es ist NACH der Uhrzeit → nächster Samstag.
function nextWeeklyDetailRun(fromDate = new Date()) {
  const target = new Date(fromDate);
  target.setHours(WEEKLY_DETAIL_HOUR, 0, 0, 0);
  let daysUntil = (WEEKLY_DETAIL_DAY - target.getDay() + 7) % 7;
  if (daysUntil === 0 && target <= fromDate) daysUntil = 7;
  target.setDate(target.getDate() + daysUntil);
  return target;
}

// Formatiert ein Date / ISO-String für menschen-lesbare Logs als
// "HH:mm dd.MM.yyyy" (lokale Zeitzone — Node honoriert TZ env var).
function formatLocalDateTime(d) {
  if (d == null) return '–';
  const date = (d instanceof Date) ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return String(d);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())} `
       + `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`;
}

// Factory: ties scheduler to the runtime collaborators (state + settings + logger
// + runScrapeCycle). runScrapeCycle is injected to break the circular dependency
// between scheduler.js and runScrape.js (runScrape needs to call scheduleNext()
// after each run, scheduler needs to call runScrapeCycle() when timer fires).
function init({ state, settings, logger, runScrapeCycle }) {
  function clearTimer() {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    state.nextRun = null;
  }

  function clearWeeklyTimer() {
    if (state.weeklyTimer) {
      clearTimeout(state.weeklyTimer);
      state.weeklyTimer = null;
    }
  }

  function loadWeeklyDetailState() {
    try {
      const v = fs.readFileSync(WEEKLY_DETAIL_FILE, 'utf8').trim();
      // Strikte Validierung: muss ISO-8601 Date sein (YYYY-MM-DDTHH:...) und
      // Date.parse() muss eine finite Zahl zurückgeben. Verhindert dass eine
      // korrumpierte Datei (Disk-Full, partial-write) die ganze Scheduler-
      // Logik kaputtmacht — overdue-Detection rechnet sonst mit NaN.
      if (v && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v))) {
        state.lastWeeklyDetailAt = v;
      }
    } catch (_) { /* not yet written */ }
  }

  function persistWeeklyDetailState() {
    try {
      fs.writeFileSync(WEEKLY_DETAIL_FILE, state.lastWeeklyDetailAt || '', { encoding: 'utf8', mode: 0o600 });
    } catch (e) {
      logger.log('⚠️  Konnte ' + WEEKLY_DETAIL_FILE + ' nicht schreiben: ' + (e && e.message ? e.message : e), 'warn');
    }
  }

  function scheduleWeeklyDetailRefresh() {
    clearWeeklyTimer();
    const now = Date.now();

    // Catch-Up: wenn letzter Lauf > 7 Tage zurück (oder noch nie gelaufen),
    // beim nächsten möglichen Slot starten — nicht auf nächsten Samstag warten.
    // Slot = jetzt + 90s (damit Boot/UI initial fertig ist).
    let next;
    const lastMs = state.lastWeeklyDetailAt ? Date.parse(state.lastWeeklyDetailAt) : NaN;
    const overdue = !Number.isFinite(lastMs) || (now - lastMs) > 7 * 24 * 3600 * 1000;
    if (overdue) {
      next = new Date(now + 90 * 1000);
      logger.log('🗓️  Wochen-Check überfällig — triggert in 90s', 'info');
    } else {
      next = nextWeeklyDetailRun();
    }

    const ms = Math.max(1000, next.getTime() - now);
    state.weeklyTimer = setTimeout(() => {
      runScrapeCycle('weekly').catch(() => { /* state.lastError ist gesetzt */ });
    }, ms);
    // setTimeout-Delay max ~24.8 Tage (2^31 ms) — bei einer Woche immer ok.
    logger.log(`🗓️  Nächster Wochen-Detail-Refresh: ${formatLocalDateTime(next)} (in ${Math.round(ms/3600000)}h)`, 'info');
  }

  function scheduleNext() {
    clearTimer();
    const s = settings.load();
    if (!s.autoRun) return;

    const next = computeNextRun(s);
    if (!next) {
      logger.log('⚠️  Scheduler: kein gültiger Slot (Tage oder Uhrzeiten leer?)', 'warn');
      return;
    }
    const ms = Math.max(1000, next.getTime() - Date.now());
    state.nextRun = next.toISOString();

    // Ist dieser geplante Lauf der LETZTE des Tages? Nur dann läuft der
    // Absenz-Detail-Pass + Push mit (Übersicht läuft bei jedem Lauf). Snapshot
    // zur Schedule-Zeit; eine Settings-Änderung re-scheduled ohnehin neu.
    const isLastRunOfDay = isLastScheduledRunOfDay(s, next);

    state.timer = setTimeout(() => {
      runScrapeCycle('scheduled', { isLastRunOfDay }).catch(() => {});
    }, ms);

    const friendly = s.scheduleMode === 'weekly'
      ? next.toLocaleString('de-DE', { weekday: 'short' })
      : `in ${Math.round(ms/60000)} min`;
    const absLabel = isLastRunOfDay ? ' · inkl. Absenz-Details (letzter Lauf des Tages)' : '';
    logger.log(`⏰ Nächster Scrape: ${formatLocalDateTime(next)} (${friendly})${absLabel}`, 'info');
    // broadcastStatus wird von runScrapeCycle (sse) selbst getriggert; hier
    // nicht doppelt — der ursprüngliche Code hat das nach scheduleNext gemacht
    // damit /api/status sofort den nextRun zeigt.
    sseBroadcastStatus();
  }

  // Lazy-bind, damit das Modul auch ohne sse-Aufruf importiert werden kann
  // (z.B. von Tests). Die Bindung erfolgt beim ersten Call.
  let sseBroadcastStatus = () => {};
  function bindSse(broadcastStatus) {
    sseBroadcastStatus = broadcastStatus;
  }

  return {
    clearTimer,
    clearWeeklyTimer,
    scheduleNext,
    scheduleWeeklyDetailRefresh,
    loadWeeklyDetailState,
    persistWeeklyDetailState,
    bindSse
  };
}

module.exports = {
  // Pure helpers (testable + reusable)
  hmToMinutes,
  isWithinInterval,
  nextWindowStart,
  computeNextRun,
  isLastScheduledRunOfDay,
  nextWeeklyDetailRun,
  formatLocalDateTime,
  WEEKLY_DETAIL_DAY,
  WEEKLY_DETAIL_HOUR,
  WEEKLY_DETAIL_FILE,
  // Factory
  init
};
