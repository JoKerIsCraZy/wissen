/* ============================================================
   WISSen — Absenz-Modul-Detail bottom sheet (popup)

   Öffnet die Tagesliste (pro Lektion) eines Absenzen-Moduls in einem
   Overlay-Sheet, statt von der Absenzen-Liste wegzurouten. Getappt von einer
   Absenz-Card (views/absenzen.js).

   Verbatim-Klon von views/modul-sheet.js (Shell, Focus-Trap, Drag-to-Dismiss,
   Click-Soak-doClose, History-Back, ESC, Backdrop). Selbst-enthaltend — KEIN
   Reuse von computeWeighted/pruefungCard. Der Body zeigt eine Statline
   (Besucht/SOLL/Ist%/Min%, 2×2) + eine flache Tagesliste mit Status-Badge
   (.m-att-badge--*, kein gradeClass).

   Lifecycle (single path):
     openAbsenzModulSheet(code) → attach() mit Loading-Body → fetch →
     fillSuccessBody() mit vollem Inhalt. Schließen via:
       - Tap auf Backdrop
       - Close-Button
       - Escape
       - history.back (pushState-Eintrag)
       - Tab/Shift-Tab zyklisch im Sheet (Focus-Trap).

   Depends on globals from mobile.js shell:
     - apiFetch
   ============================================================ */
'use strict';

(function () {
  let activeSheet = null;          // { overlay, sheet, close, prevFocus, titleId }
  let titleIdCounter = 0;

  function nextTitleId() {
    titleIdCounter += 1;
    return 'm-absenz-sheet-title-' + titleIdCounter;
  }

  /* Status-Normalisierung → Anzeige-Label + Badge-Tonklasse. status ist die
   * normalisierte Kategorie aus dem Backend (Vertrag §4.3). status_raw wird
   * für die Anzeige bevorzugt (echter Tocco-Wortlaut), das Label hier ist der
   * Fallback wenn kein Roh-String mitkam. */
  function statusInfo(cat) {
    switch (cat) {
      case 'teilgenommen':
        return { label: 'Teilgenommen', cls: 'm-att-badge--teilgenommen' };
      case 'offen':
        return { label: 'Offen', cls: 'm-att-badge--offen' };
      case 'abwesend_entschuldigt':
        return { label: 'Entschuldigt', cls: 'm-att-badge--entschuldigt' };
      case 'abwesend_unentschuldigt':
        return { label: 'Unentschuldigt', cls: 'm-att-badge--unentschuldigt' };
      default:
        return { label: 'Unbekannt', cls: 'm-att-badge--offen' };
    }
  }

  function fmtPct(n) {
    if (n == null || !Number.isFinite(n)) return '–';
    return Math.round(n) + '%';
  }
  function fmtNum(n) {
    if (n == null || !Number.isFinite(n)) return '–';
    return Number.isInteger(n) ? String(n) : n.toFixed(2);
  }

  function attendanceClass(ist, min) {
    if (ist == null) return 'm-att--none';
    const floor = (min != null && Number.isFinite(min)) ? min : 90;
    if (ist < floor) return 'm-att--fail';
    if (ist < floor + 5) return 'm-att--warn';
    return 'm-att--good';
  }

  /* Build the persistent overlay + sheet shell (head + empty body). The body
   * gets filled via fillSuccessBody() so loading → success/error swap doesn't
   * remount the overlay (and doesn't lose focus state). */
  function buildShell(initialTitle) {
    const titleId = nextTitleId();
    const overlay = document.createElement('div');
    overlay.className = 'm-sheet-overlay';

    const sheet = document.createElement('div');
    sheet.className = 'm-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-labelledby', titleId);

    sheet.innerHTML =
      '<header class="m-sheet__head">' +
        '<div class="m-sheet__handle" aria-hidden="true"></div>' +
        '<h2 class="m-sheet__title"></h2>' +
        '<button type="button" class="m-sheet__close" aria-label="Schließen">' +
          '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<line x1="18" y1="6" x2="6" y2="18"></line>' +
            '<line x1="6" y1="6" x2="18" y2="18"></line>' +
          '</svg>' +
        '</button>' +
      '</header>' +
      '<div class="m-sheet__body"></div>';

    const titleEl = sheet.querySelector('.m-sheet__title');
    titleEl.id = titleId;
    titleEl.textContent = initialTitle || 'Absenzen';

    overlay.append(sheet);
    return { overlay, sheet, titleId };
  }

  function fillLoadingBody(sheet) {
    const body = sheet.querySelector('.m-sheet__body');
    body.replaceChildren();
    body.innerHTML = '<div class="m-loading"><div class="m-spinner"></div>Lade Absenzen …</div>';
  }

  function fillErrorBody(sheet, msg) {
    const body = sheet.querySelector('.m-sheet__body');
    body.replaceChildren();
    const err = document.createElement('div');
    err.className = 'm-error';
    err.setAttribute('role', 'alert');
    err.textContent = msg;
    body.append(err);
  }

  function fillSuccessBody(sheet, data) {
    const modul = (data && data.modul) || {};
    const rows = (data && data.rows) || [];

    sheet.querySelector('.m-sheet__title').textContent =
      modul.bezeichnung || modul.kuerzel_code || 'Absenzen';

    const body = sheet.querySelector('.m-sheet__body');
    body.replaceChildren();

    // Statline — 4 Kennzahlen, 2×2 (Besucht · SOLL / Ist% · Min%). Eigene Klasse
    // damit das 4-Spalten-Grid sich vom 2-Spalten-Noten-Statline unterscheidet.
    body.append(buildStatline(modul));

    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'm-empty';
      empty.textContent = 'Für dieses Modul sind noch keine Lektionen erfasst.';
      body.append(empty);
      return;
    }

    const list = document.createElement('div');
    list.className = 'm-list';
    rows.forEach((r) => list.append(lektionCard(r)));
    body.append(list);
  }

  function buildStatline(modul) {
    const stats = document.createElement('div');
    stats.className = 'm-modul-statline m-absenz-statline';

    stats.append(
      // 2×2-Grid (grid-template-columns: 1fr 1fr): linke Spalte = „Ist"-Paar
      // (Besucht über Ist%), rechte Spalte = „Soll/Ziel"-Paar (SOLL über Min%).
      // Reihenfolge füllt zeilenweise: [Besucht, SOLL] / [Ist%, Min%].
      statCol('Besucht', fmtNum(modul.besucht), ''),
      statCol('SOLL', fmtNum(modul.soll), ''),
      statCol('Ist %', fmtPct(modul.anwesenheit_pct),
        attendanceClass(modul.anwesenheit_pct, modul.minimal_pct)),
      statCol('Min %', modul.minimal_pct != null ? fmtPct(modul.minimal_pct) : '–', ''),
    );
    return stats;
  }

  function statCol(labelText, valueText, valueExtraClass) {
    const stat = document.createElement('div');
    stat.className = 'm-stat';
    const val = document.createElement('div');
    val.className = 'm-stat__value' + (valueExtraClass ? ' ' + valueExtraClass : '');
    val.textContent = valueText;
    const lab = document.createElement('div');
    lab.className = 'm-stat__label';
    lab.textContent = labelText;
    stat.append(val, lab);
    return stat;
  }

  /* Eine Lektion-Zeile: Termin links (mit Zeitspanne), Status-Badge rechts.
   * Selbst-enthaltend — kein pruefungCard-Reuse. status_raw bevorzugt für die
   * Anzeige (echter Tocco-Wortlaut), Fallback auf das normalisierte Label. */
  function lektionCard(r) {
    const card = document.createElement('div');
    card.className = 'm-card';

    const inner = document.createElement('div');
    inner.className = 'm-absenz-lekt';

    const bodyCol = document.createElement('div');
    bodyCol.className = 'm-absenz-lekt__body';

    const t = document.createElement('div');
    t.className = 'm-card__title m-card__title--sm';
    // termin_raw ist das volle deutsche Langdatum inkl. Zeitspanne; Fallback
    // auf ISO + Zeit falls der Roh-String fehlt.
    t.textContent = r.termin_raw
      || [r.termin_iso, [r.zeit_von, r.zeit_bis].filter(Boolean).join(' – ')]
        .filter(Boolean).join(', ')
      || '—';
    bodyCol.append(t);

    // Untertitel: Ist/Soll-Lektionen + Anwesenheit der Lektion.
    const subParts = [];
    if (r.lektionen_ist != null && r.lektionen_soll != null) {
      subParts.push(fmtNum(r.lektionen_ist) + '/' + fmtNum(r.lektionen_soll) + ' Lekt.');
    }
    if (r.anwesenheit_pct != null) subParts.push(fmtPct(r.anwesenheit_pct));
    if (subParts.length) {
      const s = document.createElement('div');
      s.className = 'm-card__sub';
      s.textContent = subParts.join(' · ');
      bodyCol.append(s);
    }

    const info = statusInfo(r.status);
    const badge = document.createElement('span');
    badge.className = 'm-att-badge ' + info.cls;
    // status_raw bevorzugen (echter Wortlaut), aber gekürzt; Fallback Label.
    badge.textContent = info.label;
    // Voller Roh-String als Tooltip + aria, falls er vom Label abweicht.
    if (r.status_raw && r.status_raw !== info.label) {
      badge.title = r.status_raw;
      badge.setAttribute('aria-label', r.status_raw);
    }

    inner.append(bodyCol, badge);
    card.append(inner);
    return card;
  }

  /* Focus-trap: Tab from last focusable wraps to first, Shift-Tab from first
   * wraps to last. Keeps keyboard users inside the dialog while it's open. */
  const FOCUSABLE_SEL =
    'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), ' +
    'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function focusables(sheet) {
    return Array.from(sheet.querySelectorAll(FOCUSABLE_SEL))
      .filter((el) => !el.hasAttribute('hidden'));
  }

  function trapTab(sheet, e) {
    if (e.key !== 'Tab') return;
    const list = focusables(sheet);
    if (list.length === 0) {
      e.preventDefault();
      sheet.focus();
      return;
    }
    const first = list[0];
    const last = list[list.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !sheet.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (active === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  /* Drag-to-dismiss — folgt dem Sonner/Vaul-Pattern + Emils Animations-
   * Framework:
   *   - Greift auf der Sheet-Header-Area (Handle + Title). Body bleibt
   *     scrollbar. Click auf den X-Button wird ausgeschlossen.
   *   - DOWN: 1:1 mit dem Finger (transform translateY = dy).
   *   - UP:  geclampt (Sheet sitzt am unteren Viewport-Rand).
   *   - Release-Entscheidung: Drag-to-End ONLY (75% der Sheet-Höhe), kein
   *     Velocity- oder Mid-Distance-Auto-Close.
   *   - Multi-touch-Protection: zweite Geste während aktivem Drag ignoriert.
   *   - Entry-Animation während Drag deaktiviert; CSS-Token --ease für Snap-
   *     Back. Identisch zum Noten-Sheet (modul-sheet.js). */
  function attachDragToDismiss(sheet, doClose) {
    const head = sheet.querySelector('.m-sheet__head');
    if (!head) return;

    // Threshold-Modell: "Drag-to-End ONLY". Auto-Close auf Release wurde
    // komplett entfernt. Das Sheet schließt nur wenn der User es physisch
    // FAST KOMPLETT aus dem Viewport zieht. Jeder partielle Drag — egal wie
    // schnell der Flick — snapped zurück. Schwelle: 75% der Sheet-Höhe.
    const DISMISS_RATIO = 0.75;

    let dragging = false;
    let pointerId = null;
    let startY = 0;
    let lastY = 0;
    let lastTime = 0;

    function setTransform(dy) {
      sheet.style.transform = dy === 0 ? '' : 'translateY(' + dy + 'px)';
    }

    head.addEventListener('pointerdown', (e) => {
      // Multi-touch-Protection: laufender Drag → zweite Geste ignorieren
      if (dragging) return;
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      // Close-Button hat eigenen Click-Handler — nicht als Drag werten
      if (e.target.closest('.m-sheet__close')) return;
      dragging = true;
      pointerId = e.pointerId;
      startY = lastY = e.clientY;
      lastTime = performance.now();
      try { head.setPointerCapture(pointerId); } catch (_) {}
      // Entry-Animation pausieren — sheetIn kollidiert sonst mit unserem
      // inline-transform während die Animation noch läuft (frische Sheets)
      sheet.style.animation = 'none';
      sheet.style.transition = 'none';
    });

    head.addEventListener('pointermove', (e) => {
      if (!dragging || e.pointerId !== pointerId) return;
      const dy = e.clientY - startY;
      lastY = e.clientY;
      lastTime = performance.now();
      // Hochziehen wird komplett geclampt — sonst würde der Hintergrund
      // unter dem Sheet sichtbar. Nur DOWN bewegt das Sheet.
      setTransform(dy < 0 ? 0 : dy);
    });

    function onPointerEnd(e) {
      if (!dragging || e.pointerId !== pointerId) return;
      dragging = false;
      try { head.releasePointerCapture(pointerId); } catch (_) {}
      pointerId = null;
      const totalDy = e.clientY - startY;
      // Drag-to-End ONLY: dismiss nur wenn der User das Sheet physisch fast
      // vollständig aus dem Viewport gezogen hat. Keine Velocity-Erkennung.
      const sheetHeight = sheet.offsetHeight || 200;
      const shouldDismiss = totalDy >= sheetHeight * DISMISS_RATIO;

      if (shouldDismiss) {
        // Drag-Dismiss → doClose({ instant: true }). Die Synth-Click-Abwehr
        // läuft komplett in doClose via "Click-Soak"-Pattern (s. dort).
        doClose({ instant: true });
      } else {
        // Snap-zurück mit gleichem ease-Token (220ms, modal/drawer-Bereich).
        sheet.style.transition = 'transform 220ms var(--ease)';
        sheet.style.transform = '';
        const cleanup = () => {
          sheet.style.transition = '';
          sheet.removeEventListener('transitionend', cleanup);
        };
        sheet.addEventListener('transitionend', cleanup);
      }
    }
    head.addEventListener('pointerup', onPointerEnd);
    head.addEventListener('pointercancel', onPointerEnd);
  }

  function attach(initialTitle) {
    // Tear down any previous sheet so we never have two stacked.
    if (activeSheet) close(activeSheet);

    const { overlay, sheet, titleId } = buildShell(initialTitle);
    fillLoadingBody(sheet);

    document.body.append(overlay);

    const prevFocus = document.activeElement;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    /* Auto-focus the close button so screen-reader users (and keyboard
     * users) land *inside* the dialog. Using the close button as the
     * default landing point follows iOS/Material sheet conventions. */
    requestAnimationFrame(() => {
      const closeBtn = sheet.querySelector('.m-sheet__close');
      if (closeBtn) closeBtn.focus({ preventScroll: true });
    });

    const handle = {
      overlay,
      sheet,
      titleId,
      prevFocus,
      prevOverflow,
      close: null
    };

    function doClose(opts) {
      if (activeSheet !== handle) return;
      activeSheet = null;
      document.body.style.overflow = prevOverflow;
      overlay.classList.add('is-closing');

      if (opts && opts.instant) {
        // ════════════════════════════════════════════════════════════════
        // Drag-Dismiss-Pfad: "Click-Soak"-Architektur
        // ════════════════════════════════════════════════════════════════
        // Statt das Overlay sofort aus dem DOM zu entfernen lassen wir es
        // 150ms als UNSICHTBARER, KLICKBARER Schild stehen. Drei Properties
        // zusammen ergeben den Schild:
        //   1. sheet.style.display = 'none'   → visuelles Sheet sofort weg
        //   2. overlay.style.opacity = '0'     → kein Backdrop-Dimming mehr
        //   3. overlay.style.pointerEvents = 'auto' (KRITISCH) → Overlay
        //      fängt weiter ALLE Clicks; der vom Browser nach touchend
        //      synthetisierte Click landet auf dem Overlay statt auf einer
        //      Card darunter. Der Overlay-Click-Handler feuert mit
        //      activeSheet === null → no-op. Synth-Click absorbiert.
        // Nach 150ms wird das Overlay endgültig entfernt — der reale User-
        // Tap (Finger-Lift + Reposition + Tap ist ≥150ms) landet dann direkt
        // auf der gewünschten Card.
        sheet.style.display = 'none';
        overlay.style.opacity = '0';
        overlay.style.pointerEvents = 'auto';
        setTimeout(() => { try { overlay.remove(); } catch (_) {} }, 150);
      } else {
        // X-Close / Backdrop-Click / Esc / Back-Button:
        // 220ms-Slide-Out-Animation via CSS (.is-closing .m-sheet) + inert um
        // Mid-Animation-Taps zu blocken. Hier kein Click-Soak, weil zwischen
        // Click und nächstem Tap genug Zeit ist.
        try { overlay.setAttribute('inert', ''); } catch (_) {}
        setTimeout(() => { try { overlay.remove(); } catch (_) {} }, 220);
      }
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('popstate', onPop);
      // Drag-Dismiss (opts.instant): WEDER focus() NOCH history.back(). Beim
      // Drag-Down ist der Finger oft direkt über einer anderen Card; beide
      // Side-Effects würden den nächsten Tap stören (prevFocus.focus()
      // triggert impliziten Scroll-into-View, history.back() aktiviert den
      // Android-swipe-back-Detector). Bei den anderen Close-Pfaden ist
      // zwischen Click und nächstem Tap genug Zeit → Focus/History wie bisher.
      if (!(opts && opts.instant)) {
        if (prevFocus && typeof prevFocus.focus === 'function') {
          try { prevFocus.focus({ preventScroll: true }); } catch (_) {}
        }
        try { if (history.state && history.state.absenzSheet) history.back(); } catch (_) {}
      } else {
        // Drag-Dismiss: History-Eintrag still ersetzen statt poppen.
        try {
          if (history.state && history.state.absenzSheet) {
            history.replaceState(null, '', location.href);
          }
        } catch (_) {}
      }
    }
    handle.close = doClose;

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) doClose();
    });
    sheet.querySelector('.m-sheet__close').addEventListener('click', doClose);

    /* Drag-to-dismiss — Sonner/Vaul-Pattern. Reduced-motion respektieren:
     * kein Drag, dann reicht Schließen-Button + Esc + Backdrop. */
    const reduceMotion = (() => {
      try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
      catch (_) { return false; }
    })();
    if (!reduceMotion) attachDragToDismiss(sheet, doClose);

    function onKey(e) {
      if (e.key === 'Escape') { doClose(); return; }
      trapTab(sheet, e);
    }
    document.addEventListener('keydown', onKey);

    // Push einen Sheet-Marker auf den History-Stack, damit Hardware-Back
    // (Android) und Browser-Back den Sheet schließen statt von der Route
    // wegzunavigieren. location.hash bleibt unverändert.
    history.pushState({ absenzSheet: true }, '', location.hash || location.href);
    function onPop() {
      // Wenn unser Marker nicht mehr im state ist → Back wurde ausgelöst,
      // Sheet schließen.
      const st = history.state;
      if (!st || !st.absenzSheet) doClose();
    }
    window.addEventListener('popstate', onPop);

    activeSheet = handle;
    return handle;
  }

  function close(handle) {
    if (handle && handle.close) handle.close();
  }

  async function openAbsenzModulSheet(code) {
    if (!code) return;
    const handle = attach(code);
    try {
      const data = await apiFetch(
        '/api/absenzen/' + encodeURIComponent(code) + '/termine'
      );
      // If user closed it during the fetch, abandon the result.
      if (activeSheet !== handle) return;
      fillSuccessBody(handle.sheet, data);
    } catch (e) {
      if (e && e.silent) return;
      if (activeSheet !== handle) return;
      fillErrorBody(handle.sheet, (e && e.message) || 'Fehler beim Laden');
    }
  }

  function closeActive() {
    if (activeSheet) activeSheet.close();
  }

  // Expose
  window.openAbsenzModulSheet = openAbsenzModulSheet;
  window.closeAbsenzModulSheet = closeActive;
})();
