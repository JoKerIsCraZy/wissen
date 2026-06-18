/* ============================================================
   WISSen — View: Aktuell
   Floor-Plan strip (current event's room) + current/next event card +
   "Letzte Änderung" + "Nächste Lektion" tiles + "Heute danach" list.

   Depends on globals from mobile.js shell:
     - titleEl, main, apiFetch, loadingShell, errorShell, observeFresh
     - planCard (from views/stundenplan.js), formatDay (from views/stundenplan.js)
   ============================================================ */
'use strict';

// Tile open/close state survives re-renders + tab navigation. Once the user
// opens a dropdown manually, it stays open until they close it themselves —
// even if the SSE-driven refresh rebuilds the DOM.
const aktuellTileState = {
  nextLessonOpen: false,
  lastChangedOpen: false,
};


/* Swipe-to-dismiss für die Letzte-Änderung-Liste — Emil-Framework:
 *   - Pointer-Capture auf li damit der gesamte Swipe an einer Hand bleibt.
 *   - Links: 1:1 mit dem Finger. Rechts: gedämpft (rubber-band 0.2x) damit
 *     der User merkt dass die Richtung nichts macht ohne harten Stop.
 *   - Distance- ODER Velocity-Threshold (Emils 0.11 px/ms) — schneller
 *     Flick reicht.
 *   - Click-Suppression nach echtem Drag (>8px) damit der Modul-Sheet-Open
 *     nicht versehentlich auf einem Swipe-Release feuert.
 *   - Multi-Touch-Schutz: laufender Drag → zweite Geste ignorieren.
 *   - prefers-reduced-motion: kein Drag-Verhalten, X-Button-fallback bleibt.
 *
 * Beim Dismiss: animiert das li transform translateX(-110%) + opacity 0,
 * collapsed dann die Höhe auf 0, ruft schließlich /api/dismiss und entfernt
 * das li aus dem DOM. `onDismissed(change)` wird optimistisch mitgerufen,
 * damit der Caller abhängige UI (Tile-Header, Count-Badge) nachziehen kann. */
function attachSwipeToDismiss(li, btn, change, onDismissed) {
  const reduceMotion = (() => {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch (_) { return false; }
  })();
  if (reduceMotion) return;

  const DISMISS_PX = 100;
  const VELOCITY_THRESHOLD = 0.11;

  // Backdrop: rote Hintergrund-Schicht mit Trash-Icon, die beim Linkswisch
  // sichtbar wird. Liegt UNTER dem Button (CSS z-index).
  const swipeBg = li.querySelector('.m-now-tile__change-bg');

  let dragging = false;
  let pointerId = null;
  let startX = 0;
  let lastX = 0;
  let lastTime = 0;
  let dragMoved = false;

  // Click-Suppression auf der Capture-Phase damit es VOR dem Bubble-Click
  // auf btn feuert. stopImmediatePropagation killt alle weiteren Listener.
  li.addEventListener('click', (e) => {
    if (dragMoved) {
      e.preventDefault();
      e.stopImmediatePropagation();
      dragMoved = false;
    }
  }, true);

  li.addEventListener('pointerdown', (e) => {
    if (dragging) return;
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    dragging = true;
    pointerId = e.pointerId;
    startX = lastX = e.clientX;
    lastTime = performance.now();
    dragMoved = false;
    try { li.setPointerCapture(pointerId); } catch (_) {}
    btn.style.transition = 'none';
    if (swipeBg) swipeBg.style.transition = 'none';
  });

  li.addEventListener('pointermove', (e) => {
    if (!dragging || e.pointerId !== pointerId) return;
    const dx = e.clientX - startX;
    if (Math.abs(dx) > 8) dragMoved = true;
    lastX = e.clientX;
    lastTime = performance.now();
    // Rechts gedämpft (rubber-band), links 1:1
    const tx = dx > 0 ? dx * 0.2 : dx;
    btn.style.transform = 'translateX(' + tx + 'px)';

    // Visual feedback: Backdrop-Opacity steigt mit Linkswisch-Progress an.
    // 0 → invisible bei Start, 1 → voll sichtbar ab DISMISS_PX-Threshold.
    // Über Threshold hinaus stays at 1 (vollständig revealed).
    if (swipeBg && tx < 0) {
      const progress = Math.min(1, Math.abs(tx) / DISMISS_PX);
      swipeBg.style.opacity = String(progress);
      // "Threshold-Überschreitung"-Marker: oberhalb 100% wird der
      // Backdrop "armed" (saturate stärker, Icon scale-up). Zeigt dem
      // User dass das Loslassen jetzt das Item entfernen wird.
      if (progress >= 1) {
        swipeBg.classList.add('is-armed');
      } else {
        swipeBg.classList.remove('is-armed');
      }
    } else if (swipeBg) {
      swipeBg.style.opacity = '0';
      swipeBg.classList.remove('is-armed');
    }
  });

  function dismissItem() {
    // Item rutscht komplett nach links raus, Backdrop bleibt revealed
    const h = li.getBoundingClientRect().height;
    btn.style.transition = 'transform 220ms var(--ease), opacity 180ms var(--ease)';
    btn.style.transform = 'translateX(-110%)';
    btn.style.opacity = '0';
    if (swipeBg) {
      swipeBg.style.transition = 'opacity 200ms var(--ease)';
      swipeBg.style.opacity = '1';
    }
    setTimeout(() => {
      // Höhe collapsen damit nachfolgende Items aufrutschen
      li.style.height = h + 'px';
      li.style.overflow = 'hidden';
      li.style.transition = 'height 200ms var(--ease), margin 200ms var(--ease), padding 200ms var(--ease), opacity 160ms var(--ease)';
      requestAnimationFrame(() => {
        li.style.height = '0';
        li.style.marginTop = '0';
        li.style.marginBottom = '0';
        li.style.paddingTop = '0';
        li.style.paddingBottom = '0';
        li.style.opacity = '0';
      });
      setTimeout(() => { try { li.remove(); } catch (_) {} }, 220);
    }, 200);

    // Backend-Call mit success/error-Toast als verbalisiertes Feedback.
    // Visuell ist das Item zwar schon weg (animation läuft parallel), aber
    // der Toast bestätigt den User'n-actio explizit oder zeigt einen
    // Server-Fehler mit Reload-Empfehlung.
    try {
      const body = change.kind === 'noten'
        ? { kind: 'noten', ids: [change.row.kuerzel_id || change.row.id] }
        : { kind: 'stundenplan', ids: [change.row.id] };
      apiFetch('/api/dismiss', { method: 'POST', body }).then(() => {
        if (typeof toast === 'function') {
          toast(change.kind === 'noten' ? 'Note entfernt' : 'Zimmerwechsel entfernt');
        }
      }).catch((e) => {
        if (typeof toast === 'function') {
          toast((e && e.message) || 'Fehler beim Entfernen — bitte neu laden', 'err');
        }
      });
    } catch (_) { /* ignore */ }

    // Abhängige UI (Tile-Header mit Top-Eintrag + Count-Badge) sofort
    // nachziehen — optimistisch, analog zur li-Entfernung oben. Ohne das
    // zeigt der zugeklappte Header den entfernten Eintrag bis zum nächsten
    // Voll-Re-Render (Seitenwechsel/Refresh).
    if (typeof onDismissed === 'function') {
      try { onDismissed(change); } catch (_) { /* ignore */ }
    }
  }

  function snapBack() {
    btn.style.transition = 'transform 220ms var(--ease)';
    btn.style.transform = '';
    if (swipeBg) {
      swipeBg.style.transition = 'opacity 200ms var(--ease)';
      swipeBg.style.opacity = '0';
      swipeBg.classList.remove('is-armed');
    }
    const cleanup = () => {
      btn.style.transition = '';
      if (swipeBg) swipeBg.style.transition = '';
      btn.removeEventListener('transitionend', cleanup);
    };
    btn.addEventListener('transitionend', cleanup);
  }

  function onPointerEnd(e) {
    if (!dragging || e.pointerId !== pointerId) return;
    dragging = false;
    try { li.releasePointerCapture(pointerId); } catch (_) {}
    pointerId = null;
    const totalDx = e.clientX - startX;
    const recentDt = Math.max(performance.now() - lastTime, 1);
    const recentDx = e.clientX - lastX;
    const velocity = Math.abs(recentDx) / recentDt;
    const shouldDismiss = totalDx < -DISMISS_PX
      || (totalDx < -20 && recentDx < 0 && velocity > VELOCITY_THRESHOLD);
    if (shouldDismiss) {
      dismissItem();
    } else {
      snapBack();
    }
  }
  li.addEventListener('pointerup', onPointerEnd);
  li.addEventListener('pointercancel', onPointerEnd);
}

async function renderAktuell() {
  titleEl.textContent = 'Aktuell';
  loadingShell();
  try {
    const [planData, notenData] = await Promise.all([
      apiFetch('/api/stundenplan'),
      apiFetch('/api/noten')
    ]);
    drawAktuell(planData, notenData);
  } catch (e) {
    if (e.silent) return;
    errorShell(e.message || 'Fehler beim Laden');
  }
}
// Static-analyser hint: renderAktuell is consumed by the router in mobile.js
// (separate <script>). void-tag silences CodeQL's js/unused-local-variable.
void renderAktuell;

/* iOS-PWA-Install-Hint — Safari unterstützt keinen automatischen
 * beforeinstallprompt; User muss manuell über "Teilen → Zum Home-
 * Bildschirm" gehen. Wir blenden EINMAL einen dezenten Hinweis ein.
 * Dismissal liegt in localStorage mit 30-Tage-Cooldown, damit der
 * Hint nicht nach jedem Cache-Wipe wieder auftaucht. */
const IOS_HINT_KEY = 'tocco.iosInstallHintDismissedAt';
const IOS_HINT_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000; // 30 Tage

function shouldShowIosInstallHint() {
  try {
    if (typeof window === 'undefined') return false;
    // Bereits als PWA installiert → nichts zeigen
    const standalone = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
    const iosStandalone = window.navigator && window.navigator.standalone === true;
    if (standalone || iosStandalone) return false;
    // Nur iOS Safari interessiert uns — Android Chrome zeigt selbst einen Prompt
    const ua = (window.navigator && window.navigator.userAgent) || '';
    if (!/iPhone|iPad|iPod/.test(ua)) return false;
    // 30-Tage-Cooldown
    const lastDismiss = parseInt(localStorage.getItem(IOS_HINT_KEY) || '0', 10);
    if (Number.isFinite(lastDismiss) && lastDismiss > 0) {
      if (Date.now() - lastDismiss < IOS_HINT_COOLDOWN_MS) return false;
    }
    return true;
  } catch (_) {
    return false;
  }
}

function buildIosInstallHint() {
  const banner = document.createElement('div');
  banner.className = 'm-ios-hint';
  banner.setAttribute('role', 'note');
  banner.innerHTML =
    '<span class="m-ios-hint__icon" aria-hidden="true">📱</span>' +
    '<span class="m-ios-hint__text">' +
      'Tipp: <strong>Teilen → Zum Home-Bildschirm</strong> — als App installieren' +
    '</span>' +
    '<button type="button" class="m-ios-hint__close" aria-label="Hinweis schließen">' +
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<line x1="18" y1="6" x2="6" y2="18"/>' +
        '<line x1="6" y1="6" x2="18" y2="18"/>' +
      '</svg>' +
    '</button>';
  banner.querySelector('.m-ios-hint__close').addEventListener('click', () => {
    try { localStorage.setItem(IOS_HINT_KEY, String(Date.now())); } catch (_) {}
    banner.remove();
  });
  return banner;
}

function drawAktuell(planData, notenData) {
  main.replaceChildren();
  if (shouldShowIosInstallHint()) {
    main.append(buildIosInstallHint());
  }
  const plan = (planData && planData.rows) || [];
  const noten = (notenData && notenData.rows) || [];
  const now = new Date();
  const combine = (d, t) => new Date(d + 'T' + (t || '00:00') + ':00');
  const isSameDay = (a, b) =>
    a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();

  const sorted = plan.slice().sort((a, b) =>
    (a.datum_iso + a.zeit_von).localeCompare(b.datum_iso + b.zeit_von));
  const currentEvent = sorted.find((e) => {
    const start = combine(e.datum_iso, e.zeit_von);
    const end = combine(e.datum_iso, e.zeit_bis);
    return start <= now && now < end;
  }) || null;
  const nextEventToday = sorted.find((e) => {
    const start = combine(e.datum_iso, e.zeit_von);
    return start > now && isSameDay(start, now);
  }) || null;
  const nextEvent = sorted.find((e) =>
    combine(e.datum_iso, e.zeit_von) > now) || null;
  // The Now-card shows currentEvent if there is one, otherwise nextEventToday.
  // The "Nächste Lektion" tile only appears WHILE in-session — once a current
  // event ends and the next one becomes the cardEvent, the tile would
  // duplicate the card, so we hide it.
  const cardEvent = currentEvent || nextEventToday;
  const nextTile = currentEvent ? nextEventToday : null;
  // "Heute noch" lists what's left of today after the card and the
  // next-lesson tile. Skipping both prevents duplicate listings.
  const todayRest = sorted.filter((e) => {
    if (cardEvent && e.id === cardEvent.id) return false;
    if (nextTile && e.id === nextTile.id) return false;
    const start = combine(e.datum_iso, e.zeit_von);
    return isSameDay(start, now) && start > now;
  });

  // Merged fresh-changes list: notes + Stundenplan rows (Zimmerwechsel),
  // sorted desc by fetched_at. Drives the Letzte-Änderung dropdown.
  const freshChanges = [];
  noten.forEach((n) => {
    if (!(n.isFresh === 1 || n.isFresh === true)) return;
    const ts = n.fetched_at ? new Date(n.fetched_at).getTime() : NaN;
    if (Number.isFinite(ts)) freshChanges.push({ kind: 'noten', row: n, ts });
  });
  plan.forEach((p) => {
    if (!(p.isFresh === 1 || p.isFresh === true)) return;
    const ts = p.fetched_at ? new Date(p.fetched_at).getTime() : NaN;
    if (Number.isFinite(ts)) freshChanges.push({ kind: 'plan', row: p, ts });
  });
  freshChanges.sort((a, b) => b.ts - a.ts);

  // BK-Schnitt: dreistellige Modulnummer ohne Niveau-Suffixe (-Nx = Mathe, Englisch, …)
  // Gleiche Logik wie stats/+page.svelte isBkModule.
  function isBkRow(r) {
    const code = r.kuerzel_code || '';
    if (!code || /-N\d+$/i.test(code)) return false;
    return /(?<!\d)\d{3}(?!\d)/.test(code);
  }
  const bkRows = noten.filter(r => isBkRow(r) && r.note != null);
  const bkAvg = bkRows.length > 0
    ? bkRows.reduce((s, r) => s + r.note, 0) / bkRows.length
    : null;

  const RV = (typeof window !== 'undefined') ? window.RaumView : null;

  // Builds the captioned RaumView block (pill above + inline floor-plan
  // below) used in both the Now-Card "Nächste Lektion" branches AND the
  // Nächste-Lektion tile dropdown. Returns null when the room can't be
  // resolved to a floor (online lectures, unknown rooms) so callers just
  // omit the section instead of rendering an empty wrapper.
  function buildFloorView(raum) {
    if (!raum || !RV || RV.isOnlineRoom(raum)) return null;
    const floorKey = RV.roomToFloor(raum);
    if (!floorKey) return null;
    try {
      const fp = document.createElement('div');
      fp.className = 'm-now-tile__floor';
      const cap = document.createElement('div');
      cap.className = 'm-now-tile__floor-caption';
      const tag = document.createElement('span');
      tag.className = 'm-now-tile__floor-tag';
      tag.textContent = floorKey === 'og4' ? '4. OG' : floorKey === 'og2' ? '2. OG' : '';
      const room = document.createElement('span');
      room.className = 'm-now-tile__floor-room mono';
      room.textContent = (RV.normalizeRoom ? RV.normalizeRoom(raum) : raum) || '';
      cap.append(tag, room);
      fp.append(cap);
      const view = RV.create(raum, { mode: 'inline' });
      fp.append(view.element);
      return fp;
    } catch (err) {
      console.warn('[aktuell] buildFloorView failed:', err);
      return null;
    }
  }

  // Now-card — Floor-Plan is embedded INSIDE the card (below the meta).
  const card = document.createElement('div');
  card.className = 'm-card m-now-card';

  if (currentEvent) {
    card.classList.add('m-now-card--active');
    card.innerHTML =
      '<div class="m-now-card__lbl">Aktuell</div>' +
      '<div class="m-now-card__time"></div>' +
      '<div class="m-now-card__title"></div>' +
      '<div class="m-now-card__meta"></div>';
    card.querySelector('.m-now-card__time').textContent =
      currentEvent.zeit_von + '–' + currentEvent.zeit_bis;
    card.querySelector('.m-now-card__title').textContent =
      currentEvent.veranstaltung || '—';
    const metaParts = [];
    if (currentEvent.raum) metaParts.push(currentEvent.raum);
    if (currentEvent.dozent) metaParts.push(currentEvent.dozent);
    card.querySelector('.m-now-card__meta').textContent = metaParts.join(' · ');
    /* Floor-Plan der laufenden Lektion direkt in der Aktuell-Card: zeigt auf
     * einen Blick WO der User gerade hin muss/ist, ohne in den Stundenplan zu
     * wechseln. buildFloorView gibt null bei Online-/unbekannten Räumen zurück
     * — dann bleibt die Card schlank (nur die Meta-Zeile). */
    const fp = buildFloorView(currentEvent.raum);
    if (fp) card.append(fp);
  } else if (nextEventToday) {
    card.innerHTML =
      '<div class="m-now-card__lbl">Nächste Lektion</div>' +
      '<div class="m-now-card__time"></div>' +
      '<div class="m-now-card__title"></div>' +
      '<div class="m-now-card__meta"></div>';
    card.querySelector('.m-now-card__time').textContent =
      nextEventToday.zeit_von + '–' + nextEventToday.zeit_bis;
    card.querySelector('.m-now-card__title').textContent =
      nextEventToday.veranstaltung || '—';
    const metaParts = [];
    if (nextEventToday.raum) metaParts.push(nextEventToday.raum);
    if (nextEventToday.dozent) metaParts.push(nextEventToday.dozent);
    if (nextEventToday.klasse) metaParts.push(nextEventToday.klasse);
    const startMs = combine(nextEventToday.datum_iso, nextEventToday.zeit_von).getTime();
    metaParts.push(fmtRelativeFuture(startMs, now.getTime()));
    card.querySelector('.m-now-card__meta').textContent = metaParts.join(' · ');
    const fp = buildFloorView(nextEventToday.raum);
    if (fp) card.append(fp);
  } else {
    card.classList.add('m-now-card--idle');
    card.innerHTML =
      '<div class="m-now-card__lbl">Heute</div>' +
      '<div class="m-now-card__title"></div>' +
      '<div class="m-now-card__meta"></div>';
    card.querySelector('.m-now-card__title').textContent =
      todayRest.length === 0 && sorted.some((e) => isSameDay(combine(e.datum_iso, e.zeit_von), now))
        ? 'Tagesende erreicht'
        : 'Heute keine Lektionen';
    if (nextEvent) {
      const startMs = combine(nextEvent.datum_iso, nextEvent.zeit_von).getTime();
      const inX = fmtRelativeFuture(startMs, now.getTime());
      card.querySelector('.m-now-card__meta').textContent =
        'Nächste Lektion: ' + formatDay(nextEvent.datum_iso) + ' um '
        + nextEvent.zeit_von + ' · ' + inX;
      // Show full module title + room block for the upcoming lesson so the
      // idle Now-card stops being a blank meta line and actually previews
      // what's next. Lives below the meta line for hierarchy.
      const sub = document.createElement('div');
      sub.className = 'm-now-card__next';
      const title = document.createElement('div');
      title.className = 'm-now-card__next-title';
      title.textContent = nextEvent.veranstaltung || '—';
      sub.append(title);
      const subMeta = document.createElement('div');
      subMeta.className = 'm-now-card__next-meta';
      const subParts = [];
      if (nextEvent.zeit_von && nextEvent.zeit_bis) {
        subParts.push(nextEvent.zeit_von + '–' + nextEvent.zeit_bis);
      }
      if (nextEvent.raum) subParts.push(nextEvent.raum);
      if (nextEvent.dozent) subParts.push(nextEvent.dozent);
      if (nextEvent.klasse) subParts.push(nextEvent.klasse);
      subMeta.textContent = subParts.join(' · ');
      sub.append(subMeta);
      card.append(sub);
      const fp = buildFloorView(nextEvent.raum);
      if (fp) card.append(fp);
    }
  }
  // Notenschnitt + BK-Schnitt — ganz oben, vor der Now-Card
  const notenAvg = notenData && notenData.avg != null ? notenData.avg : null;
  if (notenAvg != null) {
    const schnittShell = document.createElement('div');
    schnittShell.className = 'm-now-tile-shell m-schnitt-shell';
    const strip = document.createElement('div');
    strip.className = 'm-schnitt-strip';
    strip.setAttribute('aria-label',
      'Notenschnitt ' + notenAvg.toFixed(2)
      + (bkAvg != null ? ', BK-Schnitt ' + bkAvg.toFixed(2) : ''));

    const primary = document.createElement('div');
    primary.className = 'm-schnitt-strip__item';
    const primLbl = document.createElement('span');
    primLbl.className = 'm-schnitt-strip__lbl';
    primLbl.textContent = 'Notenschnitt';
    const primVal = document.createElement('span');
    primVal.className = 'm-schnitt-strip__val mono ' + gradeClass(notenAvg);
    primVal.textContent = notenAvg.toFixed(2);
    primary.append(primLbl, primVal);
    strip.append(primary);

    if (bkAvg != null) {
      const bkItem = document.createElement('div');
      bkItem.className = 'm-schnitt-strip__item';
      const bkLbl = document.createElement('span');
      bkLbl.className = 'm-schnitt-strip__lbl';
      bkLbl.textContent = 'BK-Schnitt';
      const bkVal = document.createElement('span');
      bkVal.className = 'm-schnitt-strip__val mono ' + gradeClass(bkAvg);
      bkVal.textContent = bkAvg.toFixed(2);
      bkItem.append(bkLbl, bkVal);
      strip.append(bkItem);
    }

    schnittShell.append(strip);
    main.append(schnittShell);
  }

  main.append(card);

  // Two living tiles
  const tilesWrap = document.createElement('div');
  tilesWrap.className = 'm-now-tiles';

  const chevSvg =
    '<svg class="m-now-tile__chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<polyline points="9 6 15 12 9 18"/>' +
    '</svg>';

  // "Nächste Lektion" tile — only while in-session. Click expands inline to
  // show full details + Floor-Plan instead of routing away (user wanted to
  // glance without leaving the Now page).
  if (nextTile) {
    const shell = document.createElement('div');
    shell.className = 'm-now-tile-shell';

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'm-now-tile m-now-tile--btn';
    trigger.setAttribute('aria-expanded', 'false');
    trigger.innerHTML =
      '<div class="m-now-tile__body">' +
        '<div class="m-now-tile__lbl">Nächste Lektion</div>' +
        '<div class="m-now-tile__val"></div>' +
        '<div class="m-now-tile__sub"></div>' +
      '</div>' + chevSvg;
    trigger.querySelector('.m-now-tile__val').textContent =
      nextTile.zeit_von + '–' + nextTile.zeit_bis;
    const subParts = [];
    if (nextTile.veranstaltung) subParts.push(nextTile.veranstaltung);
    if (nextTile.raum) subParts.push(nextTile.raum);
    const nextTileStartMs = combine(nextTile.datum_iso, nextTile.zeit_von).getTime();
    subParts.push(fmtRelativeFuture(nextTileStartMs, now.getTime()));
    trigger.querySelector('.m-now-tile__sub').textContent = subParts.join(' · ');

    const panel = document.createElement('div');
    panel.className = 'm-now-tile__panel';
    panel.hidden = true;

    const dl = document.createElement('dl');
    dl.className = 'm-now-tile__dl';
    function addRow(label, value, mono) {
      if (!value) return;
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      if (mono) dd.className = 'mono';
      dd.textContent = value;
      dl.append(dt, dd);
    }
    addRow('Raum', nextTile.raum, true);
    addRow('Zeit', nextTile.zeit_von + '–' + nextTile.zeit_bis, true);
    addRow('Dozent', nextTile.dozent, false);
    addRow('Klasse', nextTile.klasse, false);
    panel.append(dl);

    if (nextTile.raum && RV && !RV.isOnlineRoom(nextTile.raum) && RV.roomToFloor(nextTile.raum)) {
      try {
        // Custom caption ABOVE the plan (geographic anchor before the visual);
        // RaumView still renders its own caption below — we hide it via CSS.
        const fp = document.createElement('div');
        fp.className = 'm-now-tile__floor';

        const cap = document.createElement('div');
        cap.className = 'm-now-tile__floor-caption';
        const tag = document.createElement('span');
        tag.className = 'm-now-tile__floor-tag';
        const floorKey = RV.roomToFloor(nextTile.raum);
        tag.textContent = floorKey === 'og4' ? '4. OG' : floorKey === 'og2' ? '2. OG' : '';
        const room = document.createElement('span');
        room.className = 'm-now-tile__floor-room mono';
        room.textContent = (RV.normalizeRoom ? RV.normalizeRoom(nextTile.raum) : nextTile.raum) || '';
        cap.append(tag, room);
        fp.append(cap);

        const view = RV.create(nextTile.raum, { mode: 'inline' });
        fp.append(view.element);
        panel.append(fp);
      } catch (err) {
        console.error('[aktuell] Next-tile Floor-Plan failed', err);
      }
    }

    // Restore persisted open state so a re-render (SSE refresh, tab switch)
    // keeps the dropdown the way the user left it.
    if (aktuellTileState.nextLessonOpen) {
      panel.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      shell.classList.add('m-now-tile-shell--open');
    }

    trigger.addEventListener('click', () => {
      const open = panel.hidden;
      panel.hidden = !open;
      trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
      shell.classList.toggle('m-now-tile-shell--open', open);
      aktuellTileState.nextLessonOpen = open;
    });

    shell.append(trigger, panel);
    tilesWrap.append(shell);
  }

  // Letzte Note — module whose grade was most recently recorded/changed,
  // regardless of isFresh. Mirrors the V2 dashboard's "Letzte Note" pill so
  // both surfaces show the same module here. Tap → openModulSheet popup.
  //
  // Sortier-Key ist note_recorded_at (aus noten_history — wird NUR bei echter
  // Neuanlage/Wert-Änderung geschrieben), NICHT fetched_at: fetched_at wird
  // bei jedem Scrape für jede Note neu gesetzt, wäre als "neueste"-Key also
  // faktisch zufällig. fetched_at bleibt nur Fallback falls History fehlt.
  (function buildLastNoteTile() {
    let lastNote = null;
    let lastTs = -Infinity;
    for (let i = 0; i < noten.length; i += 1) {
      const n = noten[i];
      if (n.note == null) continue;
      const stamp = n.note_recorded_at || n.fetched_at;
      const ts = stamp ? new Date(stamp).getTime() : NaN;
      if (!Number.isFinite(ts)) continue;
      if (ts > lastTs) { lastTs = ts; lastNote = n; }
    }
    if (!lastNote) return;

    const shell = document.createElement('div');
    shell.className = 'm-now-tile-shell';

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'm-now-tile m-now-tile--btn';

    const grade = lastNote.note != null
      ? lastNote.note.toFixed(2)
      : (lastNote.note_raw && lastNote.note_raw.trim() ? lastNote.note_raw : '—');
    const num = modulNummerOf(lastNote.kuerzel_code) || '';
    const name = lastNote.fach_name || lastNote.kuerzel_full || '';
    const when = fmtRelativePast(lastNote.note_recorded_at || lastNote.fetched_at, now.getTime());

    trigger.innerHTML =
      '<div class="m-now-tile__body">' +
        '<div class="m-now-tile__lbl">Letzte Note</div>' +
        '<div class="m-now-tile__val mono ' + gradeClass(lastNote.note) + '"></div>' +
        '<div class="m-now-tile__sub"></div>' +
      '</div>' + chevSvg;
    trigger.querySelector('.m-now-tile__val').textContent = grade;
    const subParts = [];
    if (num) subParts.push(num);
    if (name) subParts.push(name);
    if (when) subParts.push(when);
    trigger.querySelector('.m-now-tile__sub').textContent = subParts.join(' · ');

    trigger.setAttribute('aria-label',
      'Modul-Detail öffnen: ' + (name || num)
      + ', Note ' + grade
      + (when ? ', ' + when : ''));

    trigger.addEventListener('click', () => {
      if (typeof window.openModulSheet === 'function') {
        window.openModulSheet(lastNote.kuerzel_id || lastNote.id, lastNote.kuerzel_code);
      } else {
        location.hash = '#/modul/'
          + encodeURIComponent(lastNote.kuerzel_id || lastNote.id);
      }
    });

    shell.append(trigger);
    tilesWrap.append(shell);
  })();

  // Letzte-Änderung — dropdown listing every fresh-flagged change
  // (Notes + Zimmerwechsel) sorted newest-first. Disabled when empty.
  (function buildLastChangedTile() {
    const shell = document.createElement('div');
    shell.className = 'm-now-tile-shell';

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'm-now-tile m-now-tile--btn';
    trigger.setAttribute('aria-expanded', 'false');

    // Trigger-Inhalt (Top-Eintrag + Count-Badge) als Funktion, damit der
    // Einzel-Swipe-Dismiss den zugeklappten Header live nachziehen kann.
    // Vorher wurde der Header nur einmal beim Build gerendert — ein
    // weggeswipter Eintrag blieb dort bis zum nächsten Voll-Re-Render
    // sichtbar (Seitenwechsel/Refresh). innerHTML-Neuaufbau ist safe:
    // Event-Listener hängen am trigger-Element selbst, nicht an Kindern.
    function renderTriggerContent() {
      const top = freshChanges[0] || null;
      trigger.disabled = freshChanges.length === 0;

      const lblHtml = '<div class="m-now-tile__lbl">Letzte Änderung'
        + (freshChanges.length > 1 ? ' <span class="m-now-tile__count mono">' + freshChanges.length + '</span>' : '')
        + '</div>';

      let valHtml = '';
      let subHtml = '';
      let nameHtml = '';
      if (!top) {
        valHtml = '<div class="m-now-tile__val m-now-tile__val--empty">—</div>';
        subHtml = '<div class="m-now-tile__sub">Nichts neu</div>';
      } else if (top.kind === 'noten') {
        // Modul-Note auf 2 Kommastellen formatieren — Tocco's note_raw
        // liefert "5.500" was zu viel ist. note (REAL) ist die Quelle.
        const noteText = top.row.note != null
          ? top.row.note.toFixed(2)
          : (top.row.note_raw && top.row.note_raw.trim() ? top.row.note_raw : '—');
        valHtml = '<div class="m-now-tile__val"></div>';
        subHtml = '<div class="m-now-tile__sub"></div>';
        nameHtml = noteText;
      } else {
        valHtml = '<div class="m-now-tile__kind">Zimmerwechsel</div>';
        subHtml = '<div class="m-now-tile__sub"></div>';
      }
      trigger.innerHTML =
        '<div class="m-now-tile__body">' + lblHtml + valHtml + subHtml + '</div>'
        + chevSvg;

      if (top && top.kind === 'noten') {
        const valCell = trigger.querySelector('.m-now-tile__val');
        // Diff-Anzeige im Top-Tile: prev_note → note wenn vorher ein anderer
        // Wert gespeichert war. Sonst nur die aktuelle Note.
        const topHasDiff = top.row.prev_note != null
          && top.row.note != null
          && top.row.prev_note !== top.row.note;
        if (topHasDiff) {
          const prevSpan = document.createElement('span');
          prevSpan.className = 'm-now-tile__val-prev mono';
          prevSpan.title = 'Vorheriger Wert';
          prevSpan.textContent = Number(top.row.prev_note).toFixed(2);
          const arrowSpan = document.createElement('span');
          arrowSpan.className = 'm-now-tile__val-arrow';
          arrowSpan.setAttribute('aria-hidden', 'true');
          arrowSpan.textContent = '→';
          const currSpan = document.createElement('span');
          currSpan.className = 'm-now-tile__val-curr';
          currSpan.textContent = nameHtml;
          valCell.append(prevSpan, arrowSpan, currSpan);
        } else {
          valCell.textContent = nameHtml;
        }
        // Sub-Zeile: Modulnummer + Modulname (konsistent zur Letzte-Änderung-
        // Liste unten und zum Desktop-Dashboard).
        const topModNum = modulNummerOf(top.row.kuerzel_code);
        const topFach = (top.row.fach_name || top.row.kuerzel_code || '');
        trigger.querySelector('.m-now-tile__sub').textContent =
          (topModNum ? topModNum + ' - ' : '') + topFach;
      } else if (top && top.kind === 'plan') {
        trigger.querySelector('.m-now-tile__sub').textContent =
          ((top.row.veranstaltung || '') + (top.row.raum ? ' · ' + top.row.raum : '')).trim();
      }
    }
    renderTriggerContent();

    shell.append(trigger);

    if (freshChanges.length === 0) {
      tilesWrap.append(shell);
      return;
    }

    const panel = document.createElement('ul');
    panel.className = 'm-now-tile__changes';
    panel.hidden = true;

    // "Alle gelesen"-Action-Row als FIRST-LI im Panel — Pendant zum Desktop-
    // Header-Button. Nur wenn freshChanges > 0 (sonst zeigen wir das Tile
    // eh nicht erweitert an).
    const actionLi = document.createElement('li');
    actionLi.className = 'm-now-tile__action-row';
    const actionBtn = document.createElement('button');
    actionBtn.type = 'button';
    actionBtn.className = 'm-now-tile__dismiss-all';
    actionBtn.textContent = 'Alle gelesen';
    actionBtn.setAttribute('aria-label', 'Alle Änderungen als gelesen markieren');
    actionBtn.addEventListener('click', async () => {
      if (actionBtn.disabled) return;
      actionBtn.disabled = true;
      const oldText = actionBtn.textContent;
      actionBtn.textContent = '…';
      const totalBefore = freshChanges.length;
      try {
        await apiFetch('/api/dismiss', { method: 'POST', body: { all: true } });
        if (typeof toast === 'function') {
          toast(totalBefore + ' Änderung' + (totalBefore === 1 ? '' : 'en') + ' entfernt');
        }
        // Re-render Aktuell (rebuilds das Tile, freshChanges ist jetzt leer)
        if (typeof renderAktuell === 'function') {
          await renderAktuell();
        }
      } catch (e) {
        actionBtn.textContent = oldText;
        actionBtn.disabled = false;
        if (typeof toast === 'function') {
          toast((e && e.message) || 'Fehler beim Entfernen', 'err');
        }
      }
    });
    actionLi.append(actionBtn);
    panel.append(actionLi);

    freshChanges.forEach((c) => {
      const li = document.createElement('li');
      li.className = 'm-now-tile__change-item';

      // Swipe-Backdrop: liegt UNTER dem Button und wird beim Linkswisch
      // sichtbar. Roter Gradient + Trash-Icon rechts, opacity wird live
      // mit dem Swipe-Progress getrieben. pointer-events:none damit der
      // Backdrop nicht selbst klickbar wird.
      const swipeBg = document.createElement('div');
      swipeBg.className = 'm-now-tile__change-bg';
      swipeBg.setAttribute('aria-hidden', 'true');
      swipeBg.innerHTML =
        '<span class="m-now-tile__change-bg-label">Entfernen</span>' +
        '<svg class="m-now-tile__change-bg-icon" viewBox="0 0 24 24" '
        + 'width="20" height="20" fill="none" stroke="currentColor" '
        + 'stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">'
        + '<polyline points="3 6 5 6 21 6"/>'
        + '<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>'
        + '<path d="M10 11v6"/>'
        + '<path d="M14 11v6"/>'
        + '</svg>';
      li.append(swipeBg);

      // Real <button> so screen-readers announce the action correctly and
      // we don't burn through the URL bar history with hash transitions.
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'm-now-tile__change';
      if (c.kind === 'noten') {
        // Format mirrors desktop /+page Letzte-Änderung:
        //   - hat prev_note → ✎ + "Modulnummer - Modulname: 5.00 → 5.50"
        //   - sonst (neu)  → ＋ + "Modulnummer - Modulname: Neue Note 5.50"
        const grade = c.row.note != null
          ? c.row.note.toFixed(2)
          : (c.row.note_raw && c.row.note_raw.trim() ? c.row.note_raw : '—');
        const hasDiff = c.row.prev_note != null
          && c.row.note != null
          && c.row.prev_note !== c.row.note;
        const modNum = modulNummerOf(c.row.kuerzel_code);
        const fachName = (c.row.fach_name || c.row.kuerzel_code || '');
        const titlePrefix = (modNum ? modNum + ' - ' : '') + fachName + ': ';

        const iconSpan = document.createElement('span');
        iconSpan.className = 'm-now-tile__change-icon m-now-tile__change-icon--'
          + (hasDiff ? 'note-change' : 'note-new');
        iconSpan.setAttribute('aria-hidden', 'true');
        iconSpan.textContent = hasDiff ? '✎' : '＋';

        const bodySpan = document.createElement('span');
        bodySpan.className = 'm-now-tile__change-body';

        const titleSpan = document.createElement('span');
        titleSpan.className = 'm-now-tile__change-title';
        // Title: "Modulnummer - Modulname: " + dynamic value-block
        titleSpan.append(document.createTextNode(titlePrefix));

        const diffSpan = document.createElement('span');
        diffSpan.className = 'm-now-tile__change-diff mono';
        if (hasDiff) {
          const prevSpan = document.createElement('span');
          prevSpan.title = 'Vorheriger Wert';
          prevSpan.textContent = Number(c.row.prev_note).toFixed(2);
          const arrowSpan = document.createElement('span');
          arrowSpan.className = 'm-now-tile__change-arrow';
          arrowSpan.setAttribute('aria-hidden', 'true');
          arrowSpan.textContent = ' → ';
          const currSpan = document.createElement('span');
          currSpan.textContent = grade;
          diffSpan.append(prevSpan, arrowSpan, currSpan);
        } else {
          diffSpan.textContent = 'Neue Note ' + grade;
        }
        titleSpan.append(diffSpan);

        bodySpan.append(titleSpan);

        btn.replaceChildren(iconSpan, bodySpan);
        const ariaGrade = hasDiff
          ? 'Note ' + Number(c.row.prev_note).toFixed(2) + ' geändert auf ' + grade
          : 'Neue Note ' + grade;
        btn.setAttribute('aria-label',
          'Modul-Detail öffnen: ' + fachName + ', ' + ariaGrade);
        btn.addEventListener('click', () => {
          if (typeof window.openModulSheet === 'function') {
            window.openModulSheet(c.row.kuerzel_id || c.row.id, c.row.kuerzel_code);
          } else {
            location.hash = '#/modul/' + encodeURIComponent(c.row.kuerzel_id || c.row.id);
          }
        });
      } else {
        btn.innerHTML =
          '<span class="m-now-tile__change-icon" aria-hidden="true">⇄</span>' +
          '<span class="m-now-tile__change-body">' +
            '<span class="m-now-tile__change-title"></span>' +
          '</span>';
        btn.querySelector('.m-now-tile__change-title').textContent =
          (c.row.veranstaltung || '—') + ' → ' + (c.row.raum || '—');
        btn.setAttribute('aria-label',
          'Zimmerwechsel: ' + (c.row.veranstaltung || '') + ' jetzt in ' + (c.row.raum || ''));
        // Deep-link to the plan with ?focus=<id>; planCard auto-opens that
        // entry's dropdown so the user lands directly on the moved lesson.
        const id = c.row.id != null ? String(c.row.id) : '';
        btn.addEventListener('click', () => {
          location.hash = id
            ? '#/stundenplan?focus=' + encodeURIComponent(id)
            : '#/stundenplan';
        });
      }
      li.append(btn);
      panel.append(li);

      // Swipe-to-dismiss — Emil/Vaul-Pattern. Nach links swipen entfernt
      // den Eintrag; rechts ist gedämpft (rubber-band, factor 0.2). Release
      // entscheidet via Distanz (>100px) ODER velocity (>0.11 px/ms) ob
      // dismiss oder snap-back. Click-Suppression: wenn dragMoved=true, wird
      // der Click in der Capture-Phase auf li gestoppt damit er die Modul-
      // Sheet / Stundenplan-Navigation nicht auslöst.
      attachSwipeToDismiss(li, btn, c, (change) => {
        // Eintrag aus dem Daten-Array nehmen und den zugeklappten Header
        // (Top-Eintrag + Count-Badge) live nachziehen — sonst zeigt das
        // Tile den weggeswipten Eintrag bis zum nächsten Voll-Re-Render.
        const idx = freshChanges.indexOf(change);
        if (idx !== -1) freshChanges.splice(idx, 1);
        renderTriggerContent();
        if (!freshChanges.length) {
          // Letzter Eintrag entfernt → Leer-Zustand wie beim Build mit
          // 0 Änderungen: Panel zu, Open-State vergessen (trigger ist via
          // renderTriggerContent bereits disabled, Label zeigt "Nichts neu").
          panel.hidden = true;
          shell.classList.remove('m-now-tile-shell--open');
          trigger.setAttribute('aria-expanded', 'false');
          aktuellTileState.lastChangedOpen = false;
        }
      });
    });

    // Restore persisted open state so re-renders don't collapse the panel.
    if (aktuellTileState.lastChangedOpen) {
      panel.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      shell.classList.add('m-now-tile-shell--open');
    }

    /* Smooth Open + Close für das Letzte-Änderung-Dropdown — animiert die
     * Höhe von 0 ↔ natürlicher Inhaltshöhe. JS-driven weil die Liste
     * variable Inhalte hat und CSS height:auto nicht direkt animierbar
     * ist. Pattern:
     *   Open:  panel.hidden=false → height=0 → rAF → height=scrollHeight →
     *          transitionend → height='' (auto, bleibt flexibel)
     *   Close: height=scrollHeight (fix) → rAF → height=0 → transitionend →
     *          panel.hidden=true (raus aus dem Tab-Order)
     * Reduced-motion: instant toggle ohne Animation. */
    const reduceMotion = (() => {
      try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
      catch (_) { return false; }
    })();

    /* Open-Animation: Layout-Höhe sofort auf natural, damit das Document
     * direkt seine End-Größe hat und ein parallel laufender window.scrollTo
     * scrollen kann (sonst cappt der Browser den Scroll am noch zu kurzen
     * Document). Visuell wird das Panel via opacity + translateY weich
     * eingeblendet — fühlt sich an wie ein Slide-In ohne dass die Layout-
     * Höhe selbst animiert werden muss. */
    function animateOpen() {
      panel.hidden = false;
      // Inline-CSS-Animation (tilePanelIn) ausschalten und PERMANENT
      // ausgeschaltet lassen — wenn cleanup das `animation` reseted, würde
      // die CSS-Regel `animation: tilePanelIn 200ms` wieder kicken und
      // den Inhalt erneut von opacity:0 fade-in animieren → der User sieht
      // einen Flicker / "Einträge verschwinden und kommen wieder".
      panel.style.animation = 'none';
      // Layout direkt auf natural lassen (height:auto, kein Clamp). Damit
      // wächst das Document sofort und Auto-Scroll hat genug Platz.
      panel.style.opacity = '0';
      panel.style.transform = 'translateY(-6px)';
      void panel.offsetHeight;
      panel.style.transition = 'opacity 200ms var(--ease), transform 200ms var(--ease)';
      requestAnimationFrame(() => {
        panel.style.opacity = '1';
        panel.style.transform = '';
      });
      const cleanup = (e) => {
        if (e.propertyName !== 'opacity') return;
        panel.removeEventListener('transitionend', cleanup);
        panel.style.transition = '';
        panel.style.opacity = '';
        panel.style.transform = '';
        // animation BLEIBT 'none' — siehe Kommentar oben.
      };
      panel.addEventListener('transitionend', cleanup);
    }

    function animateClose() {
      panel.style.animation = 'none';
      panel.style.overflow = 'hidden';
      // Aktuelle Höhe als fixen Pixel-Wert setzen, damit der Übergang
      // einen definierten Startpunkt hat (auto → 0 transitioniert nicht).
      panel.style.height = panel.scrollHeight + 'px';
      panel.style.opacity = '1';
      void panel.offsetHeight;
      panel.style.transition = 'height 200ms var(--ease), opacity 160ms var(--ease)';
      requestAnimationFrame(() => {
        panel.style.height = '0px';
        panel.style.opacity = '0';
      });
      const cleanup = (e) => {
        if (e.propertyName !== 'height') return;
        panel.removeEventListener('transitionend', cleanup);
        panel.hidden = true;
        panel.style.transition = '';
        panel.style.height = '';
        panel.style.opacity = '';
        panel.style.overflow = '';
        // animation BLEIBT 'none' — siehe Kommentar in animateOpen.
      };
      panel.addEventListener('transitionend', cleanup);
    }

    trigger.addEventListener('click', () => {
      const open = panel.hidden;
      trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
      shell.classList.toggle('m-now-tile-shell--open', open);
      aktuellTileState.lastChangedOpen = open;

      if (reduceMotion) {
        panel.hidden = !open;
      } else if (open) {
        animateOpen();
      } else {
        animateClose();
      }

      // Auto-Scroll beim Öffnen — bringt die Tile-Shell so weit nach oben
      // dass ihr TOP direkt unter der Appbar sitzt (keinen Pixel höher).
      // Damit hat das Dropdown den maximalen vertikalen Spielraum ohne
      // dass der Tile-Header (LETZTE ÄNDERUNG-Label + Wert-Zeile) aus dem
      // Sichtbereich verschwindet.
      //
      // Emil-Framework angewendet:
      //   - Frequency = "occasional" (Tile wird sporadisch geöffnet, nicht
      //     100+/day) → smooth scroll ist OK, nicht Über-Animation.
      //   - Purpose = spatial consistency — der User sieht den Inhalt
      //     ohne manuell scrollen zu müssen.
      //   - prefers-reduced-motion → instant scroll statt smooth.
      //   - Threshold 24px (nicht 0 oder 8px), damit Mini-Ruckler bei
      //     bereits-fast-oben-Tile übersprungen werden.
      //
      // Overflow-Check via panel.scrollHeight wäre theoretisch eleganter
      // (nur scrollen wenn Dropdown wirklich nicht reinpasst), ist aber
      // mid-animation Browser-abhängig unzuverlässig. Always-scroll ist
      // hier robuster und stört bei kleinen Dropdowns nicht — der Sprung
      // ist klein wenn das Tile schon nah dran ist.
      if (open) {
        requestAnimationFrame(() => {
          try {
            const appbar = document.querySelector('.m-appbar');
            const headerH = appbar ? appbar.getBoundingClientRect().height : 56;
            const shellRect = shell.getBoundingClientRect();
            const desiredOffset = shellRect.top - headerH;
            if (desiredOffset > 24) {
              window.scrollTo({
                top: window.scrollY + desiredOffset,
                behavior: reduceMotion ? 'auto' : 'smooth'
              });
            }
          } catch (_) { /* ignore */ }
        });
      }
    });

    shell.append(panel);
    tilesWrap.append(shell);
  })();

  main.append(tilesWrap);

  // Heute noch
  if (todayRest.length > 0) {
    const restHead = document.createElement('h2');
    restHead.className = 'm-day-h';
    restHead.textContent = 'Heute noch';
    main.append(restHead);
    const restList = document.createElement('div');
    restList.className = 'm-list';
    todayRest.forEach((entry) => restList.append(planCard(entry)));
    main.append(restList);
  }

  observeFresh(main);
}
