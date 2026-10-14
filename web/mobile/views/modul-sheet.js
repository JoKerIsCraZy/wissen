/* ============================================================
   WISSen — Modul-Detail bottom sheet (popup)

   Opens the same content as the /modul/<id> route in an overlay sheet
   instead of routing away from the Noten list. Tapped from a note card.

   Lifecycle (single path):
     openModulSheet(id, code) → attach() with loading body → fetch →
     swapBody() with full content. Close via:
       - tap on backdrop
       - close button
       - Escape key
       - history.back (pushState entry)
       - Tab/Shift-Tab cycles inside the sheet (focus trap).

   Shares helpers with views/modul.js (computeWeighted, pruefungCard).

   Depends on globals from mobile.js shell:
     - apiFetch
     - gradeClass, buildTitle
   And from views/modul.js:
     - computeWeighted, pruefungCard
   ============================================================ */
'use strict';

(function () {
  let activeSheet = null;          // { overlay, sheet, close, prevFocus, titleId }
  let titleIdCounter = 0;

  /* Bereits geladene Modul-Details (kuerzelId → API-Antwort). Erneutes
   * Öffnen zeigt sofort den letzten Stand und aktualisiert im Hintergrund
   * (stale-while-revalidate). Lebt nur bis zum nächsten Seiten-Reload. */
  const detailCache = new Map();

  function nextTitleId() {
    titleIdCounter += 1;
    return 'm-sheet-title-' + titleIdCounter;
  }

  /* Build the persistent overlay + sheet shell (head + empty body). The body
   * gets filled via swapBody() so loading → success/error swap doesn't
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
    titleEl.textContent = initialTitle || 'Modul';

    overlay.append(sheet);
    return { overlay, sheet, titleId };
  }

  function fillLoadingBody(sheet) {
    const body = sheet.querySelector('.m-sheet__body');
    body.replaceChildren();
    body.innerHTML = '<div class="m-loading m-loading--deferred"><div class="m-spinner"></div>Lade Modul …</div>';
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
    sheet.querySelector('.m-sheet__title').textContent =
      buildTitle(data.kuerzelCode, data.fachName);
    const body = sheet.querySelector('.m-sheet__body');
    body.replaceChildren();

    const rows = (data && data.rows) || [];
    const computed = computeWeighted(rows);

    const stats = document.createElement('div');
    stats.className = 'm-modul-statline';
    stats.innerHTML =
      '<div class="m-stat"><div class="m-stat__value ' + gradeClass(data.modulNote) + '">' +
        (data.modulNote != null ? data.modulNote.toFixed(1) : '—') +
      '</div><div class="m-stat__label">Modulnote</div></div>' +
      '<div class="m-stat"><div class="m-stat__value ' + gradeClass(computed) + '">' +
        (computed != null ? computed.toFixed(2) : '—') +
      '</div><div class="m-stat__label">Berechnet</div></div>';
    body.append(stats);

    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'm-empty';
      empty.textContent = 'Für dieses Modul sind noch keine ZP/LB-Noten erfasst.';
      body.append(empty);
      return;
    }

    const groups = [
      { label: 'Zwischenprüfungen', filter: (r) => r.pruefung_typ === 'ZP' },
      { label: 'Lernbeurteilungen', filter: (r) => r.pruefung_typ === 'LB' },
      { label: 'Weitere',           filter: (r) => r.pruefung_typ !== 'ZP' && r.pruefung_typ !== 'LB' }
    ];
    groups.forEach((g) => {
      const items = rows.filter(g.filter);
      if (!items.length) return;
      const h = document.createElement('h3');
      h.className = 'm-section-h';
      h.innerHTML = '<span>' + g.label + '</span><span class="m-section-h__count">' + items.length + '</span>';
      body.append(h);
      const list = document.createElement('div');
      list.className = 'm-list';
      items.forEach((p) => list.append(pruefungCard(p)));
      body.append(list);
    });
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
   *   - UP:  gedämpft (rubber-band, factor 0.2). Emil: "things in real life
   *     don't suddenly stop; they slow down first" — kein harter Stop.
   *   - Release-Entscheidung: Distanz > 100px ODER velocity > 0.11 px/ms
   *     (Emils Empfehlung — ein schneller Flick reicht auch ohne Distanz).
   *   - Multi-touch-Protection: zweite Geste während aktivem Drag wird
   *     ignoriert (Emil: "switching fingers mid-drag causes the element to
   *     jump to the new position").
   *   - Entry-Animation während Drag deaktiviert; CSS-Token --ease
   *     (cubic-bezier(.2,.7,.2,1)) wird für sowohl Snap-Back als auch
   *     Dismiss-Out genutzt — konsistent zum bestehenden sheetOut-Keyframe. */
  function attachDragToDismiss(sheet, doClose) {
    const head = sheet.querySelector('.m-sheet__head');
    if (!head) return;

    // Threshold-Modell: "Drag-to-End ONLY". Auto-Close auf Release
    // wurde komplett entfernt. Das Sheet schließt nur wenn der User
    // es physisch FAST KOMPLETT aus dem Viewport zieht (Top-Edge in
    // Reichweite vom unteren Display-Rand). Jeder partielle Drag —
    // egal wie schnell der Flick — snapped zurück.
    //
    // Warum so strikt: der vorherige Threshold-basierte Auto-Close
    // ("schon weit genug runter → schließen on release") hat mehr
    // Verwirrung gestiftet als geholfen. User wussten nicht ob das
    // Sheet jetzt schließt oder zurück snappt, und die Browser-Quirks
    // beim Auto-Close (Synth-Click auf Cards unter dem Touch-End)
    // brauchten komplexe Workarounds (Click-Soak etc).
    //
    // Mit Drag-to-End-Only:
    //   - User-Intent ist immer eindeutig (Sheet sichtbar weg = close)
    //   - Finger landet am unteren Display-Rand wo keine Cards sind →
    //     kein Synth-Click-auf-Card-Problem mehr
    //   - Snap-Back-Animation klar sichtbar bei jedem Non-Dismiss-Release
    //
    // Schwelle: 75% der Sheet-Höhe. Bei einem 600px-hohen Sheet muss
    // der User mindestens 450px ziehen — visuell ist das Sheet dann
    // fast ganz aus dem Bildschirm.
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
      // unter dem Sheet sichtbar (Sheet sitzt am unteren Viewport-Rand,
      // jede UP-Bewegung schiebt es ÜBER den unteren Rand). Nur DOWN
      // bewegt das Sheet.
      setTransform(dy < 0 ? 0 : dy);
    });

    function onPointerEnd(e) {
      if (!dragging || e.pointerId !== pointerId) return;
      dragging = false;
      try { head.releasePointerCapture(pointerId); } catch (_) {}
      pointerId = null;
      const totalDy = e.clientY - startY;
      // Drag-to-End ONLY: dismiss nur wenn der User das Sheet
      // physisch fast vollständig aus dem Viewport gezogen hat. Keine
      // Velocity-Erkennung, kein Mid-Distance-Auto-Close.
      const sheetHeight = sheet.offsetHeight || 200;
      const shouldDismiss = totalDy >= sheetHeight * DISMISS_RATIO;

      if (shouldDismiss) {
        // Drag-Dismiss → doClose({ instant: true }). Die Synth-Click-
        // Abwehr läuft komplett in doClose via "Click-Soak"-Pattern:
        // Sheet wird sofort unsichtbar, Overlay bleibt für 150ms als
        // unsichtbarer Schild stehen (pointer-events: auto) und frisst
        // den synthetisierten Click. Kein document-level Suppressor
        // mehr nötig — der Mechanismus ist lokal am Overlay verankert.
        // Architektur-Begründung: ein document-Listener konnte nicht
        // zuverlässig zwischen "Synth-Click vom Drag" und "echtem User-
        // Tap" unterscheiden (Time-Gate war fragil). Beim Click-Soak
        // ist der Synth-Click per Konstruktion auf das Overlay gerichtet
        // (Topmost-Element an touchend-Koordinaten) während der User
        // sein Finger hebt + repositioniert + tappt → ≥150ms später ist
        // das Overlay weg und Cards sind frei.
        doClose({ instant: true });
      } else {
        // Snap-zurück mit gleichem ease-Token. Emil: response-side animation
        // soll snappy sein → 220ms ist innerhalb des "modal/drawer"-Bereichs
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
        // 150ms als UNSICHTBARER, KLICKBARER Schild stehen. Folgende drei
        // Properties zusammen ergeben den Schild:
        //
        //   1. sheet.style.display = 'none'
        //      Das visuelle Sheet ist sofort weg — User sieht die Noten-
        //      Liste, denkt der Dismiss ist durch.
        //
        //   2. overlay.style.opacity = '0'
        //      Die Backdrop-Fläche ist unsichtbar (kein Backdrop-Dimming
        //      mehr). User sieht keinen visuellen Indikator dass das
        //      Overlay noch da ist.
        //
        //   3. overlay.style.pointerEvents = 'auto'  (KRITISCH)
        //      Overlay deckt weiter den ganzen Viewport ab und FÄNGT ALLE
        //      Clicks. Genau das wollen wir: der vom Browser nach touchend
        //      synthetisierte Click landet auf dem Overlay statt auf
        //      einer Note-Card darunter.
        //
        // Der Overlay-Click-Handler (oben weiter unten registriert,
        // `if (e.target === overlay) doClose()`) feuert dann mit
        // activeSheet === null → early return → no-op. Synth-Click ist
        // absorbiert ohne dass eine Card aufgeht.
        //
        // Nach 150ms wird das Overlay endgültig entfernt — der reale
        // User-Tap (Finger-Lift + Reposition + Tap ist physiologisch
        // ≥150ms) landet dann direkt auf der gewünschten Card.
        //
        // Vorteil gegenüber document-level Suppressor (vorherige Iteration):
        //   - Kein Time-Gate-Tuning nötig
        //   - Kein Risiko echte User-Taps zu fressen wenn der Synth-Click
        //     ausbleibt
        //   - Bug-Fix ist lokal am Overlay verankert, nicht global im
        //     document
        sheet.style.display = 'none';
        overlay.style.opacity = '0';
        overlay.style.pointerEvents = 'auto';
        setTimeout(() => { try { overlay.remove(); } catch (_) {} }, 150);
      } else {
        // X-Close / Backdrop-Click / Esc / Back-Button:
        // 220ms-Slide-Out-Animation via CSS (.is-closing .m-sheet) +
        // inert um Mid-Animation-Taps zu blocken. Hier kein Click-Soak
        // weil zwischen Click und nächstem Tap genug Zeit ist.
        try { overlay.setAttribute('inert', ''); } catch (_) {}
        setTimeout(() => { try { overlay.remove(); } catch (_) {} }, 220);
      }
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('popstate', onPop);
      // Drag-Dismiss (opts.instant): WEDER focus() NOCH history.back().
      //
      // Wenn der User per Drag-Down dismisst, ist sein Finger oft direkt
      // über einer anderen Note-Card, und er tappt diese innerhalb von
      // ~50-150ms — gleicher Frame in dem doClose läuft. In diesem
      // Fenster machen BEIDE side-effects Ärger:
      //   - prevFocus.focus(): triggert auf Android Chromium einen
      //     impliziten Scroll-into-View (preventScroll wird nicht zu
      //     100% respektiert), der die Card-Positionen minimal verschiebt
      //     → erster Tap landet auf falscher Position oder dahinter
      //   - history.back(): aktiviert auf Android den system swipe-back-
      //     Gesture-Detector, der den nächsten Touch als
      //     "Navigation-Geste" interpretiert statt als Tap → Click
      //     wird verschluckt
      // Drag-bis-zum-Ende funktioniert weil der Finger am Bildschirmrand
      // landet und der User physisch ~200-300ms braucht bis er eine Card
      // antippt; beide Side-Effects haben dann genug Zeit zu settlen.
      //
      // X-Close / Backdrop / Esc / Browser-Back: hier soll Focus/History
      // wie bisher restauriert werden (Accessibility + Back-Stack-
      // Konsistenz), das war nie das Problem weil zwischen Click und
      // nächstem Tap genug Zeit ist.
      if (!(opts && opts.instant)) {
        if (prevFocus && typeof prevFocus.focus === 'function') {
          try { prevFocus.focus({ preventScroll: true }); } catch (_) {}
        }
        try { if (history.state && history.state.modulSheet) history.back(); } catch (_) {}
      } else {
        // Drag-Dismiss: History-Eintrag still ersetzen statt poppen.
        // Hardware-Back danach geht durch ohne unsere popstate-Handler,
        // weil die schon removed sind — ist kein Problem, der Eintrag
        // ist dann nur "nutzlos" aber funktional unsichtbar.
        try {
          if (history.state && history.state.modulSheet) {
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

    /* Drag-to-dismiss — Sonner/Vaul-Pattern. Pointer-Capture auf den Header
     * (Handle + Title-Area) damit der Sheet bei einer DOWN-Geste der Hand
     * folgt; loslassen entscheidet via Distanz-+Velocity-Threshold ob
     * geschlossen wird oder zurück snappt. UP-Drag ist gedämpft (rubber-band)
     * statt blockiert — fühlt sich natürlicher an als ein harter Stop.
     *
     * Reduced-motion respektieren: kein Drag, dann reicht Schließen-Button +
     * Esc + Backdrop für Dismissal-Pfade. */
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
    // wegzunavigieren. location.hash bleibt unverändert (URL ändert sich
    // nicht sichtbar — wir nutzen nur den state-Slot).
    history.pushState({ modulSheet: true }, '', location.hash || location.href);
    function onPop() {
      // Wenn unser Marker nicht mehr im state ist → Back wurde ausgelöst
      // (oder eine andere Navigation hat ihn weggespült), Sheet schließen.
      // Bei state.modulSheet === true wären wir noch auf unserem eigenen
      // Eintrag — passiert nur falls jemand mit forward-Navigation
      // zurückkommt, was wir hier ignorieren.
      const st = history.state;
      if (!st || !st.modulSheet) doClose();
    }
    window.addEventListener('popstate', onPop);

    activeSheet = handle;
    return handle;
  }

  function close(handle) {
    if (handle && handle.close) handle.close();
  }

  async function openModulSheet(kuerzelId, kuerzelCode) {
    if (!kuerzelId) return;
    const cached = detailCache.get(kuerzelId);
    const handle = attach(kuerzelCode || 'Modul');
    // Synchron vor dem ersten Paint — der Lade-Body wird nie sichtbar.
    if (cached) fillSuccessBody(handle.sheet, cached);
    try {
      const data = await apiFetch(
        '/api/noten/' + encodeURIComponent(kuerzelId) + '/pruefungen'
      );
      detailCache.set(kuerzelId, data);
      // If user closed it during the fetch, abandon the result.
      if (activeSheet !== handle) return;
      // Unveränderter Stand → nicht neu rendern (kein Sprung beim Lesen).
      if (cached && JSON.stringify(cached) === JSON.stringify(data)) return;
      fillSuccessBody(handle.sheet, data);
    } catch (e) {
      if (e && e.silent) return;
      if (activeSheet !== handle) return;
      // Mit Cache bleibt der letzte Stand stehen; das nächste Öffnen lädt neu.
      if (cached) return;
      fillErrorBody(handle.sheet, (e && e.message) || 'Fehler beim Laden');
    }
  }

  function closeActive() {
    if (activeSheet) activeSheet.close();
  }

  // Expose
  window.openModulSheet = openModulSheet;
  window.closeModulSheet = closeActive;
})();
