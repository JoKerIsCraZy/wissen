/* ============================================================
   WISSen — View: Noten
   Hero average + filter chips + sortable module list. Each card links
   into the Modul-Detail view.

   Depends on globals from mobile.js shell:
     - $, titleEl, main, apiFetch, loadingShell, errorShell, observeFresh
     - gradeClass, fmtGrade, modulNummerOf, buildTitle
   ============================================================ */
'use strict';

let notenState = { query: '', sort: 'fach', onlyWithGrade: false };

// BK-Filter: dreistellige Modulnummer, ohne Niveau-Suffixe (-Nx = Mathe, Englisch, …)
function isBkRow(r) {
  const code = r.kuerzel_code || '';
  if (!code || /-N\d+$/i.test(code)) return false;
  return /(?<!\d)\d{3}(?!\d)/.test(code);
}

async function renderNoten() {
  titleEl.textContent = 'Noten';
  skeletonShell('noten');
  try {
    const data = await apiFetch('/api/noten');
    drawNoten(data);
  } catch (e) {
    if (e.silent) return;
    errorShell(e.message || 'Fehler beim Laden der Noten');
  }
}
function drawNoten(data) {
  main.replaceChildren();

  if (data && data.avg != null) {
    const rows = data.rows || [];
    const totalCount = data.count || 0;
    const gradedCount = rows.filter((r) => r.note != null).length;

    // BK-Schnitt aus den Noten-Rows berechnen
    const bkFiltered = rows.filter(r => isBkRow(r) && r.note != null);
    const bkAvg = bkFiltered.length > 0
      ? bkFiltered.reduce((s, r) => s + r.note, 0) / bkFiltered.length
      : null;

    const hero = document.createElement('div');
    hero.className = 'm-hero';

    const left = document.createElement('div');
    const lab = document.createElement('div'); lab.className = 'm-hero__label'; lab.textContent = 'Durchschnitt';
    const val = document.createElement('div');
    val.className = 'm-hero__value ' + gradeClass(data.avg);
    val.textContent = data.avg.toFixed(2);
    left.append(lab, val);

    if (bkAvg != null) {
      const mid = document.createElement('div');
      const bkLab = document.createElement('div'); bkLab.className = 'm-hero__label'; bkLab.textContent = 'BK-Schnitt';
      const bkVal = document.createElement('div');
      bkVal.className = 'm-hero__value ' + gradeClass(bkAvg);
      bkVal.textContent = bkAvg.toFixed(2);
      mid.append(bkLab, bkVal);
      hero.append(left, mid);
    } else {
      hero.append(left);
    }

    const right = document.createElement('div'); right.className = 'm-hero__meta';
    right.innerHTML =
      '<div class="m-hero__metarow"><strong>' + gradedCount + '</strong> Benotet</div>' +
      '<div class="m-hero__metarow"><strong>' + totalCount + '</strong> Module</div>';
    hero.append(right);
    main.append(hero);
  }
  if (data && data.bySemester) {
    const semHero = document.createElement('div');
    semHero.className = 'm-card m-sem-grid';
    Object.entries(data.bySemester).forEach(function (entry) {
      const sem = entry[0];
      const avg = entry[1];
      const col = document.createElement('div');
      col.className = 'm-sem-grid__col';
      // textContent statt innerHTML: `sem` kommt aus der API (Scrape-Daten) —
      // via innerHTML wäre das ein XSS-Vektor bei manipuliertem Semester-String.
      const sub = document.createElement('div');
      sub.className = 'm-card__sub';
      sub.textContent = 'Ø ' + sem;
      const grade = document.createElement('div');
      grade.className = 'm-card__grade m-card__grade--sm ' + gradeClass(avg);
      grade.textContent = avg != null ? avg.toFixed(2) : '—';
      col.append(sub, grade);
      semHero.append(col);
    });
    if (semHero.children.length) main.append(semHero);
  }

  const filter = document.createElement('div');
  filter.className = 'm-filter';
  filter.innerHTML =
    '<div class="m-search">' +
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>' +
      // aria-label weil Placeholder kein Label-Ersatz ist (WCAG H44) — visueller
      // Hint bleibt im placeholder, Screenreader bekommen ein dediziertes Label.
      '<input id="notenSearch" type="search" aria-label="Module suchen" placeholder="Modul-Nr. oder Name suchen" autocomplete="off" spellcheck="false" />' +
    '</div>' +
    '<div class="m-chips" role="tablist">' +
      '<button type="button" class="m-chip" data-sort="fach">A–Z</button>' +
      '<button type="button" class="m-chip" data-sort="low">Tiefste</button>' +
      '<button type="button" class="m-chip" data-sort="high">Höchste</button>' +
      '<button type="button" class="m-chip" data-only="1">Nur benotete</button>' +
    '</div>';
  main.append(filter);

  const list = document.createElement('div');
  list.className = 'm-list';
  list.id = 'notenList';
  main.append(list);

  const search = filter.querySelector('#notenSearch');
  search.value = notenState.query;
  search.addEventListener('input', () => {
    notenState.query = search.value;
    drawNotenList(data && data.rows ? data.rows : []);
  });
  filter.querySelectorAll('.m-chip[data-sort]').forEach((btn) => {
    btn.addEventListener('click', () => {
      notenState.sort = btn.dataset.sort;
      updateChipActive(filter);
      drawNotenList(data && data.rows ? data.rows : []);
    });
  });
  const onlyChip = filter.querySelector('.m-chip[data-only]');
  onlyChip.addEventListener('click', () => {
    notenState.onlyWithGrade = !notenState.onlyWithGrade;
    updateChipActive(filter);
    drawNotenList(data && data.rows ? data.rows : []);
  });
  updateChipActive(filter);
  drawNotenList(data && data.rows ? data.rows : []);

  // Scroll-to-Top FAB — Mirror der Desktop ScrollTopFab.svelte; gleiche
  // Funktion aus stundenplan.js, weil beide Views lange Listen rendern.
  // Single-instance: bestehender FAB wird in attachScrollTopFab() entfernt
  // bevor ein neuer gebaut wird, hashchange räumt automatisch auf.
  if (typeof attachScrollTopFab === 'function') attachScrollTopFab();
}
function updateChipActive(root) {
  root.querySelectorAll('.m-chip[data-sort]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.sort === notenState.sort));
  });
  const oc = root.querySelector('.m-chip[data-only]');
  oc.setAttribute('aria-pressed', String(notenState.onlyWithGrade));
}
function drawNotenList(rows) {
  const list = $('#notenList');
  if (!list) return;
  list.replaceChildren();
  const q = notenState.query.trim().toLowerCase();
  let filtered = rows.slice();
  if (notenState.onlyWithGrade) filtered = filtered.filter(r => r.note != null);
  if (q) {
    filtered = filtered.filter((r) => {
      const hay = [r.fach_name, r.kuerzel_code, r.kuerzel_full, r.fach_code,
        modulNummerOf(r.kuerzel_code)].filter(Boolean).join(' ').toLowerCase();
      return hay.indexOf(q) !== -1;
    });
  }
  if (notenState.sort === 'fach') {
    filtered.sort((a, b) => (a.fach_name || '').localeCompare(b.fach_name || ''));
  } else if (notenState.sort === 'low') {
    filtered.sort((a, b) => {
      if (a.note == null && b.note == null) return 0;
      if (a.note == null) return 1;
      if (b.note == null) return -1;
      return a.note - b.note;
    });
  } else if (notenState.sort === 'high') {
    filtered.sort((a, b) => {
      if (a.note == null && b.note == null) return 0;
      if (a.note == null) return 1;
      if (b.note == null) return -1;
      return b.note - a.note;
    });
  }
  if (!filtered.length) {
    const e = document.createElement('div');
    e.className = 'm-empty';
    e.textContent = 'Keine Treffer für die aktuellen Filter.';
    list.append(e);
    return;
  }
  filtered.forEach((row) => list.append(noteCard(row)));
  observeFresh(list);
}
function noteCard(row) {
  // Tap opens the Modul detail in a bottom-sheet popup instead of routing
  // to /modul/<id> — keeps the user in the Noten list with their scroll
  // position. The hash route still works for deep-links from elsewhere.
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'm-card is-clickable' + (row.isFresh ? ' is-fresh' : '');
  card.addEventListener('click', () => {
    if (typeof window.openModulSheet === 'function') {
      window.openModulSheet(row.kuerzel_id, row.kuerzel_code);
    } else {
      // Defensive fallback: if the sheet script didn't load, route as before.
      location.hash = '#/modul/' + encodeURIComponent(row.kuerzel_id) +
        '?code=' + encodeURIComponent(row.kuerzel_code || '');
    }
  });
  if (row.isFresh && row.kuerzel_id) {
    card.dataset.freshKind = 'noten';
    card.dataset.freshId = row.kuerzel_id;
  }
  // Rich aria-label so screen-reader users hear what tapping does, including
  // freshness state. Without this, VoiceOver only reads the visible text.
  const labelParts = [
    'Modul-Detail öffnen',
    buildTitle(row.kuerzel_code, row.fach_name),
    row.note != null ? 'Note ' + row.note.toFixed(1) : 'noch keine Note',
  ];
  if (row.isFresh) labelParts.push('frisch');
  card.setAttribute('aria-label', labelParts.join(', '));

  const main_ = document.createElement('div');
  main_.className = 'm-card__main';
  const title = document.createElement('div');
  title.className = 'm-card__title';
  title.textContent = buildTitle(row.kuerzel_code, row.fach_name);
  const sub = document.createElement('div');
  sub.className = 'm-card__sub';
  sub.textContent = [row.semester, row.typ].filter(Boolean).join(' · ') || '—';
  main_.append(title, sub);

  const grade = document.createElement('div');
  grade.className = 'm-card__grade ' + gradeClass(row.note);
  grade.textContent = fmtGrade(row.note);

  card.append(main_, grade);

  if (row.isFresh) {
    // Echter <span> statt CSS ::after — Screen-Reader lesen das zuverlässig.
    // aria-hidden weil das parent <button> ein aria-label hat das schon
    // "frisch" erwähnt; sonst würde "Neu" doppelt vorgelesen.
    const pill = document.createElement('span');
    pill.className = 'm-card__fresh-pill';
    pill.setAttribute('aria-hidden', 'true');
    pill.textContent = 'Neu';
    card.append(pill);
  }
  return card;
}
