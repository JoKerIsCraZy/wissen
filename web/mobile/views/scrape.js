/* ============================================================
   WISSen — Scrape-Card (rendered at the top of Settings)
   Includes phase metadata + the live progress card + triggerScrape
   action. The shell (mobile.js) calls reRenderScrapeCardIfMounted()
   from updateStatus() on every SSE 'status' event.

   Depends on globals from mobile.js shell:
     - apiFetch, toast, scrapeState, scrapeTimerHandle, fetchInitialStatus
   ============================================================ */
'use strict';

/* ----- Phase metadata used by the scrape-card UI -----
 *
 * Seit dem Parallel-Fetch-Refactor laufen Noten + Stundenplan gleichzeitig
 * unter dem 'noten'-Phase-Indikator. Die separate 'stundenplan'-Phase wird
 * vom Scraper nicht mehr emittiert — sie ist aus PHASE_ORDER + Labels
 * entfernt. Defensive Mappings für 'stundenplan' werden NICHT als Safety
 * vorgehalten, weil das die Progress-Bar visuell verzerren würde
 * (activeIndex springt).
 *
 * 'absenzen_details' ist die LETZTE Phase (Absenz-Detail-Pass, nach
 * noten_details). MUSS in PHASE_ORDER stehen — sonst ist activeIndex=-1 wenn
 * der Scraper dort ist, kein Step wird aktiv und die Bar fällt auf 5% zurück.
 * Bei Autorun-Läufen, die NICHT der letzte des Tages sind, wird diese Phase
 * übersprungen — dann endet der Lauf nach 'Details' (Bar bei ~75 %), was ok
 * ist (die Card geht danach auf idle). */
const PHASE_ORDER = ['browser', 'login', 'noten', 'saving', 'noten_details', 'absenzen_details'];
const PHASE_LABELS = {
  starting:      'Initialisiere…',
  browser:       'Browser starten…',
  login:         'Anmelden…',
  noten:         'Noten + Stundenplan laden…',
  saving:        'Speichern…',
  noten_details: 'Modul-Details…',
  absenzen_details: 'Absenzen-Details…'
};
const PHASE_PILL_LABELS = {
  starting:      'startet…',
  browser:       'Browser…',
  login:         'Login…',
  noten:         'Noten + Plan…',
  saving:        'Speichern…',
  noten_details: 'Details…',
  absenzen_details: 'Absenzen-Details…'
};
const PHASE_SHORT_LABELS = ['Browser', 'Login', 'Noten + Plan', 'Speich.', 'Details', 'Absenzen'];

/* ============================================================
   Scrape-Card (Settings) — Status, Phase-Steps, Button, Progress.
   Mounted at the top of the settings-form. Re-rendered on every SSE
   status update via reRenderScrapeCardIfMounted().
   ============================================================ */
function renderScrapeCard(container) {
  if (!container) return;
  container.replaceChildren();

  const status = scrapeState.status || {};
  const running = !!status.running;
  const phase = status.currentPhase || (running ? 'starting' : null);
  const hasError = !running && !!status.lastError;

  const card = document.createElement('div');
  card.className = 'm-scrape';

  // Top row: pill + last-run
  const top = document.createElement('div');
  top.className = 'm-scrape__top';
  const pill = document.createElement('span');
  pill.className = 'm-scrape__pill ' +
    (running ? 'm-scrape__pill--running' :
     hasError ? 'm-scrape__pill--error' : 'm-scrape__pill--idle');
  const dot = document.createElement('span');
  dot.className = 'm-scrape__dot';
  const lab = document.createElement('span');
  lab.textContent = running
    ? (PHASE_PILL_LABELS[phase] || 'läuft…')
    : (hasError ? 'Fehler' : 'bereit');
  pill.append(dot, lab);

  const lastRun = document.createElement('div');
  lastRun.className = 'm-scrape__lastrun';
  lastRun.textContent = status.lastRun
    ? 'Letzter Lauf ' + fmtRelative(status.lastRun)
    : 'noch kein Lauf';
  if (status.lastRun) lastRun.title = new Date(status.lastRun).toLocaleString('de-CH');

  top.append(pill, lastRun);
  card.append(top);

  // Button — primary CTA
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'm-scrape__btn';
  btn.disabled = running;
  if (running) {
    const sp = document.createElement('span');
    sp.className = 'm-spinner-sm';
    btn.append(sp);
    const t = document.createElement('span');
    t.textContent = 'Abfrage läuft…';
    btn.append(t);
  } else {
    const ic = document.createElement('span');
    ic.setAttribute('aria-hidden', 'true');
    ic.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 4 20 12 6 20 6 4"/></svg>';
    btn.append(ic);
    const t = document.createElement('span');
    t.textContent = 'Jetzt abfragen';
    btn.append(t);
  }
  btn.addEventListener('click', triggerScrape);
  card.append(btn);

  // Progress (only while running)
  if (running) {
    const steps = document.createElement('div');
    steps.className = 'm-scrape__steps';
    // Spaltenzahl autoritativ aus PHASE_ORDER — hält das Grid synchron mit der
    // Phasenliste, damit die Punkt-Mitte zur Fortschrittsbalken-Berechnung
    // unten (activeIndex / PHASE_ORDER.length) passt.
    steps.style.gridTemplateColumns = 'repeat(' + PHASE_ORDER.length + ', 1fr)';
    const activeIndex = phase ? PHASE_ORDER.indexOf(phase) : -1;
    PHASE_ORDER.forEach((p, i) => {
      const step = document.createElement('div');
      step.className = 'm-scrape__step';
      if (activeIndex >= 0) {
        if (i < activeIndex) step.classList.add('is-done');
        else if (i === activeIndex) step.classList.add('is-active');
      }
      const sd = document.createElement('div');
      sd.className = 'm-scrape__step-dot';
      const sl = document.createElement('div');
      sl.textContent = PHASE_SHORT_LABELS[i];
      step.append(sd, sl);
      steps.append(step);
    });
    card.append(steps);

    const bar = document.createElement('div');
    bar.className = 'm-scrape__bar';
    const fill = document.createElement('div');
    fill.className = 'm-scrape__bar-fill';
    const total = PHASE_ORDER.length;
    const pct = activeIndex < 0
      ? 5
      : Math.min(100, Math.round(((activeIndex + 0.5) / total) * 100));
    // Compositor-Animation: scaleX statt width — kein Layout-Reflow pro Frame.
    // CSS hält die Bar auf width: 100 %; der Fortschritt wird durch
    // transform: scaleX(pct/100) mit transform-origin: left dargestellt.
    fill.style.transform = 'scaleX(' + (pct / 100) + ')';
    bar.append(fill);
    card.append(bar);

    const caption = document.createElement('div');
    caption.className = 'm-scrape__caption';
    const lab2 = document.createElement('span');
    lab2.textContent = PHASE_LABELS[phase] || 'Läuft…';
    const timer = document.createElement('span');
    timer.id = 'scrapeTimer';
    timer.textContent = formatElapsed(status.phaseStartedAt);
    caption.append(lab2, timer);
    card.append(caption);
  }

  // Error banner (last run failed)
  if (hasError) {
    const err = document.createElement('div');
    err.className = 'm-scrape__error';
    err.textContent = String(status.lastError).slice(0, 200);
    card.append(err);
  }

  container.append(card);

  // Live timer when running
  if (running && status.phaseStartedAt && !scrapeTimerHandle) {
    scrapeTimerHandle = setInterval(() => {
      const t = document.getElementById('scrapeTimer');
      if (!t) return;
      const live = scrapeState.status && scrapeState.status.phaseStartedAt;
      t.textContent = formatElapsed(live || status.phaseStartedAt);
    }, 1000);
  } else if (!running && scrapeTimerHandle) {
    clearInterval(scrapeTimerHandle);
    scrapeTimerHandle = null;
  }
}

function reRenderScrapeCardIfMounted() {
  const el = document.getElementById('scrapeCard');
  if (el) renderScrapeCard(el);
}

function fmtRelative(iso) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '–';
  const diff = Math.max(0, Date.now() - t);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'gerade eben';
  const min = Math.floor(sec / 60);
  if (min < 60) return 'vor ' + min + ' Min';
  const hr = Math.floor(min / 60);
  if (hr < 24) return 'vor ' + hr + ' Std';
  const d = Math.floor(hr / 24);
  return 'vor ' + d + ' Tag' + (d > 1 ? 'en' : '');
}
function formatElapsed(iso) {
  if (!iso) return '0:00';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '0:00';
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m + ':' + String(s).padStart(2, '0');
}

async function triggerScrape() {
  // Optimistisches Update — Pill schaltet sofort, der nächste Status-Event
  // (SSE oder die /api/abfrage-Response) korrigiert ggf.
  scrapeState.status = Object.assign({}, scrapeState.status, {
    running: true, currentPhase: 'starting', phaseStartedAt: new Date().toISOString()
  });
  reRenderScrapeCardIfMounted();
  try {
    const r = await apiFetch('/api/abfrage', { method: 'POST', body: {} });
    if (r && r.triggered === false) {
      // 200 mit reason → server hat NICHT gestartet, optimistisches Update zurückrollen
      if (r.reason === 'already_running') {
        toast('Abfrage läuft bereits');
      } else if (r.reason === 'cooldown') {
        toast('Cooldown aktiv — bitte ' + (r.retryInSec || 60) + 's warten', 'err');
        scrapeState.status = Object.assign({}, scrapeState.status, { running: false });
        reRenderScrapeCardIfMounted();
      } else {
        toast('Abfrage nicht gestartet (' + (r.reason || 'unbekannt') + ')', 'err');
        scrapeState.status = Object.assign({}, scrapeState.status, { running: false });
        reRenderScrapeCardIfMounted();
      }
      // Echten Status nachladen damit UI mit Server synchron ist
      fetchInitialStatus();
      return;
    }
    toast('Abfrage gestartet');
  } catch (e) {
    if (e.silent) return;
    // 429 cooldown response landet hier (apiFetch wirft bei 429)
    scrapeState.status = Object.assign({}, scrapeState.status, {
      running: false
    });
    reRenderScrapeCardIfMounted();
    toast(e.message || 'Abfrage-Start fehlgeschlagen', 'err');
  }
}
