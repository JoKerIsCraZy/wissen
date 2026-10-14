/* ============================================================
   WISSen — View: Stundenplan
   Day-grouped list of plan entries; each entry's plan-card opens an
   inline detail with floor-plan + chips on click.

   Depends on globals from mobile.js shell:
     - titleEl, main, loadView, loadingShell, errorShell, observeFresh, parseHash
   ============================================================ */
'use strict';

async function renderStundenplan() {
  titleEl.textContent = 'Stundenplan';
  await loadView('stundenplan', [{ path: '/api/stundenplan' }], drawStundenplan, (e) => {
    errorShell(e.message || 'Fehler beim Laden des Stundenplans');
  });
}
function drawStundenplan(data) {
  main.replaceChildren();
  const rows = (data && data.rows) || [];
  if (!rows.length) {
    main.innerHTML = '<div class="m-empty">Keine Stundenplan-Einträge.</div>';
    return;
  }
  const groups = new Map();
  rows.forEach((r) => {
    if (!groups.has(r.datum_iso)) groups.set(r.datum_iso, []);
    groups.get(r.datum_iso).push(r);
  });
  const sortedKeys = Array.from(groups.keys()).sort();
  sortedKeys.forEach((datum) => {
    const h = document.createElement('h2');
    h.className = 'm-day-h';
    h.textContent = formatDay(datum);
    main.append(h);
    const list = document.createElement('div');
    list.className = 'm-list';
    groups.get(datum).forEach((entry) => list.append(planCard(entry)));
    main.append(list);
  });
  observeFresh(main);

  // Deep-link auto-open: if the URL has ?focus=<id>, find that lesson card
  // and trigger its dropdown. Used when tapping a "Letzte Änderung" entry
  // on Aktuell or "Nächste Lektion" on Aktuell.
  try {
    const { params } = parseHash();
    const focusId = params.get('focus');
    if (focusId) {
      const card = main.querySelector('.m-plan-card[data-event-id="' + CSS.escape(focusId) + '"]');
      if (card) {
        const trigger = card.querySelector('.m-plan');
        if (trigger) trigger.click();
        // Wait for the dropdown's detail (incl. async RaumView layout) to
        // settle, then scroll the OPEN card into view. Manual scrollTo with
        // sticky-header offset is more reliable on mobile than
        // scrollIntoView({block:'center'}) which can race the iOS rubber-band
        // and the appbar's compositor layer.
        const scrollToCard = () => {
          try {
            const appbar = document.querySelector('.m-appbar');
            const bottomnav = document.querySelector('.m-bottomnav');
            const headerH = appbar ? appbar.getBoundingClientRect().height : 56;
            const footerH = bottomnav ? bottomnav.getBoundingClientRect().height : 0;
            const rect = card.getBoundingClientRect();
            const cardH = rect.height;
            const visibleH = window.innerHeight - headerH - footerH;
            // Card-Mitte mittig im sichtbaren Bereich zwischen Appbar und
            // Bottom-Nav platzieren — so bleibt der Day-Header (z.B.
            // "Donnerstag, 21. Mai") über der Card im Viewport sichtbar.
            // Fallback für Cards größer als visibleH: top-align unter der
            // Appbar (sonst würde der Anfang der Card oberhalb verschwinden).
            const cardMidPage = window.scrollY + rect.top + cardH / 2;
            const desiredMidViewport = headerH + visibleH / 2;
            const centeredTarget = cardMidPage - desiredMidViewport;
            const topAlignedTarget = window.scrollY + rect.top - headerH - 12;
            const target = cardH > visibleH ? topAlignedTarget : centeredTarget;
            window.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
          } catch (_) {
            try { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (__) {}
          }
        };
        // 3 rAFs + a short timeout: gives the inline RaumView SVG enough
        // time to lay out so the card's final height is known before we
        // measure offsets.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              scrollToCard();
              setTimeout(scrollToCard, 120);
              // Mirrors the desktop PlanEvent flash. Fire after the second
              // scroll attempt has had a beat to land so the user's eye is
              // already on the card when the pulses kick in.
              setTimeout(() => {
                card.classList.add('is-flash');
                setTimeout(() => card.classList.remove('is-flash'), 2500);
              }, 360);
            });
          });
        });
      }
    }
  } catch (_) { /* ignore */ }

  attachScrollTopFab();
}

/* Floating "Nach oben" pill — Mirror der Desktop ScrollTopFab.svelte.
 * Erscheint wenn die Seite > 400px gescrollt ist, smooth-scrollt beim
 * Klick zurück nach oben. Single-instance: vorhandener FAB wird entfernt
 * bevor ein neuer gebaut wird; hashchange räumt automatisch auf wenn der
 * User die Stundenplan-Route verlässt.
 *
 * Emil-Framework angewendet:
 *   - Frequency = "occasional" (nur bei langen Listen sichtbar) → Animation OK
 *   - Purpose = spatial-consistency-Affordance, "back to top"
 *   - Easing = ease-out (entry/exit) via project-Token --ease
 *   - Duration = 180ms — Emils tooltip/popover-Range
 *   - Aus scale(0): nein → 0.96 + opacity 0 + 8px translateY
 *   - Active scale(0.94) für tactile feedback
 *   - prefers-reduced-motion: nur opacity, keine transforms
 *
 * Impeccable / WISSen-Lane: surface-2 background, border-soft border,
 * text-mute icon — passt zum dichten Tool-Look ohne Akzent zu schreien. */
let fabCleanup = null;
function attachScrollTopFab() {
  if (fabCleanup) { fabCleanup(); fabCleanup = null; }

  // Route-Guard: noten.js / stundenplan.js rufen attachScrollTopFab() am
  // ENDE ihres async Renders auf (nach `await apiFetch`). Wechselt der
  // User den Tab bevor der Render fertig ist, lief der FAB sonst verspätet
  // los und hängte sich an document.body — auf der FALSCHEN View. Da er
  // position:fixed/z-index:40 ist, überlagerte er dort Content, z.B. den
  // vollbreiten "Auf Update prüfen"-Button unten in den Settings. Ist die
  // aktuelle Route keine FAB-Route, brechen wir ab (der alte FAB wurde
  // oben bereits via fabCleanup entfernt).
  const path = (location.hash || '').slice(1).split('?')[0];
  if (path !== '/noten' && path !== '/stundenplan') return;

  const fab = document.createElement('button');
  fab.type = 'button';
  fab.className = 'm-scroll-top-fab';
  fab.setAttribute('aria-label', 'Nach oben scrollen');
  fab.setAttribute('title', 'Nach oben');
  fab.innerHTML =
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" '
    + 'stroke="currentColor" stroke-width="2.4" stroke-linecap="round" '
    + 'stroke-linejoin="round" aria-hidden="true">'
    + '<polyline points="18 15 12 9 6 15"/>'
    + '</svg>';

  const update = () => {
    fab.classList.toggle('is-visible', window.scrollY > 400);
  };
  const onClick = () => {
    const reduceMotion = (() => {
      try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
      catch (_) { return false; }
    })();
    window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
  };
  const onHashChange = () => {
    if (fabCleanup) { fabCleanup(); fabCleanup = null; }
  };

  window.addEventListener('scroll', update, { passive: true });
  fab.addEventListener('click', onClick);
  window.addEventListener('hashchange', onHashChange);

  document.body.appendChild(fab);
  update();

  fabCleanup = () => {
    window.removeEventListener('scroll', update);
    window.removeEventListener('hashchange', onHashChange);
    try { fab.remove(); } catch (_) { /* ignore */ }
  };
}

function formatDay(iso) {
  try {
    const d = new Date(iso + 'T00:00:00');
    const opts = { weekday: 'long', day: 'numeric', month: 'short' };
    return d.toLocaleDateString('de-DE', opts);
  } catch (_) {
    return iso;
  }
}
function planCard(entry) {
  const card = document.createElement('div');
  // .m-plan-card already overrides .m-card padding/flex via the CSS rule.
  card.className = 'm-card m-plan-card' + (entry.isFresh ? ' is-fresh' : '');
  if (entry.id != null) {
    // Used by deep-link auto-open (e.g. ?focus=<id> from the Aktuell tile).
    card.dataset.eventId = String(entry.id);
  }
  if (entry.isFresh && entry.id != null) {
    card.dataset.freshKind = 'stundenplan';
    card.dataset.freshId = String(entry.id);
    // Visible affordance only; parent trigger button gets the SR announcement
    // via aria-label below.
    const pill = document.createElement('span');
    pill.className = 'm-card__fresh-pill';
    pill.setAttribute('aria-hidden', 'true');
    pill.textContent = 'Neu';
    card.append(pill);
  }

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'm-plan';
  trigger.setAttribute('aria-expanded', 'false');
  trigger.innerHTML =
    '<div class="m-plan__time">' +
      '<div class="m-plan__from"></div>' +
      '<div class="m-plan__to"></div>' +
    '</div>' +
    '<div class="m-plan__divider"></div>' +
    '<div class="m-plan__main">' +
      '<div class="m-plan__name"></div>' +
      '<div class="m-plan__sub"></div>' +
    '</div>' +
    '<svg class="m-plan__chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<polyline points="6 9 12 15 18 9"/>' +
    '</svg>';
  trigger.querySelector('.m-plan__from').textContent = entry.zeit_von || '';
  trigger.querySelector('.m-plan__to').textContent   = entry.zeit_bis || '';
  trigger.querySelector('.m-plan__name').textContent = entry.veranstaltung || '';
  trigger.querySelector('.m-plan__sub').textContent  = [entry.raum, entry.dozent].filter(Boolean).join(' · ');
  // Rich label so SR users hear context + freshness even with the chevron
  // hidden from the AT tree.
  const trigParts = [
    'Lektions-Details',
    (entry.zeit_von || '') + ' bis ' + (entry.zeit_bis || ''),
    entry.veranstaltung || ''
  ];
  if (entry.raum) trigParts.push('in ' + entry.raum);
  if (entry.isFresh) trigParts.push('frisch');
  trigger.setAttribute('aria-label', trigParts.filter(Boolean).join(', '));
  card.append(trigger);

  const detail = document.createElement('div');
  detail.className = 'm-plan__detail';
  detail.hidden = true;
  card.append(detail);

  let raumViewHandle = null;
  let opened = false;

  function buildDetail() {
    detail.replaceChildren();
    // Resolve RaumView at click-time, not at card creation, so if the
    // /floorplans/raumview.js script wasn't ready yet we still get it.
    const RV = (typeof window !== 'undefined') ? window.RaumView : null;
    const isOnline = !!(RV && entry.raum && RV.isOnlineRoom(entry.raum));
    const floorKey = RV && entry.raum && !isOnline ? RV.roomToFloor(entry.raum) : null;

    // <dl>: Raum / Zeit / Dozent / Klasse — same layout as Nächste-Lektion
    // tile dropdown so both surfaces feel consistent.
    const dl = document.createElement('dl');
    dl.className = 'm-plan__dl';
    function addRow(label, value, mono) {
      if (!value) return;
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      if (mono) dd.className = 'mono';
      dd.textContent = value;
      dl.append(dt, dd);
    }
    addRow('Raum', isOnline ? (entry.raum || 'Online') : (entry.raum || '—'), true);
    addRow('Zeit', (entry.zeit_von || '') + '–' + (entry.zeit_bis || ''), true);
    addRow('Dozent', entry.dozent, false);
    addRow('Klasse', entry.klasse, true);
    detail.append(dl);

    if (floorKey) {
      const floorWrap = document.createElement('div');
      floorWrap.className = 'm-plan__floor';
      try {
        // Custom caption ABOVE the plan; RaumView's own caption is hidden
        // via CSS (.m-plan__floor .raumview__caption { display: none }).
        const cap = document.createElement('div');
        cap.className = 'm-plan__floor-caption';
        const tag = document.createElement('span');
        tag.className = 'm-plan__floor-tag';
        tag.textContent = floorKey === 'og4' ? '4. OG' : floorKey === 'og2' ? '2. OG' : '';
        const roomEl = document.createElement('span');
        roomEl.className = 'm-plan__floor-room mono';
        roomEl.textContent = (RV.normalizeRoom ? RV.normalizeRoom(entry.raum) : entry.raum) || '';
        cap.append(tag, roomEl);
        floorWrap.append(cap);

        raumViewHandle = RV.create(entry.raum, { mode: 'inline' });
        floorWrap.append(raumViewHandle.element);
        detail.append(floorWrap);
      } catch (err) {
        console.warn('[m-plan] RaumView.create failed:', err);
      }
    }
  }

  function close() {
    if (!opened) return;
    opened = false;
    card.classList.remove('is-open');
    trigger.setAttribute('aria-expanded', 'false');
    detail.hidden = true;
    if (raumViewHandle) {
      try { raumViewHandle.destroy(); } catch (_) {}
      raumViewHandle = null;
    }
    detail.replaceChildren();
  }

  function open() {
    if (opened) return;
    // Close any other open card first — only one at a time.
    document.querySelectorAll('.m-plan-card.is-open').forEach((c) => {
      const ev = new CustomEvent('m-plan-close-other');
      c.dispatchEvent(ev);
    });
    opened = true;
    card.classList.add('is-open');
    trigger.setAttribute('aria-expanded', 'true');
    detail.hidden = false;
    buildDetail();
  }

  card.addEventListener('m-plan-close-other', close);

  trigger.addEventListener('click', () => {
    if (opened) close(); else open();
  });

  return card;
}
