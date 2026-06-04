/* ============================================================
   WISSen — View: Absenzen
   Stats-Hero (Ø-Anwesenheit · Module unter Minimum · Abwesenheiten gesamt)
   + Filter (Suche + Typ-Chips + „Unter Minimum") + Modul-Liste. Jede Card
   öffnet das Absenz-Modul-Sheet mit der Tagesliste (pro Lektion).

   Vierte Daten-Achse, gespiegelt am Noten-Tab (views/noten.js). Anwesenheit-
   ist% rechts statt Note; „Neu"-Pill + observeFresh wie bei Noten.

   Depends on globals from mobile.js shell:
     - $, titleEl, main, apiFetch, skeletonShell, errorShell, observeFresh
   And from views/absenz-sheet.js:
     - window.openAbsenzModulSheet
   ============================================================ */
'use strict';

let absenzenState = { query: '', sort: 'name', typ: 'all', onlyUnterMin: false };

/* Bandgrenzen für die Anwesenheits-Tönung. Liegt die Ist-Anwesenheit unter
 * der Minimalanwesenheit des Moduls → fail (rot). Knapp darüber (< +5 Punkte)
 * → warning (gelb). Sonst good (grün). Ohne Minimum (null) fallback auf feste
 * 90/80-Bänder, damit die Farbe nie verschwindet. Spiegel von attendanceClass
 * auf Desktop (helpers.ts). */
function attendanceClass(ist, min) {
  if (ist == null) return 'm-att--none';
  const floor = (min != null && Number.isFinite(min)) ? min : 90;
  if (ist < floor) return 'm-att--fail';
  if (ist < floor + 5) return 'm-att--warn';
  return 'm-att--good';
}

function fmtPct(n) {
  if (n == null || !Number.isFinite(n)) return '–';
  return Math.round(n) + '%';
}

async function renderAbsenzen() {
  titleEl.textContent = 'Absenzen';
  skeletonShell('absenzen');
  try {
    const data = await apiFetch('/api/absenzen');
    drawAbsenzen(data);
  } catch (e) {
    if (e && e.silent) return;
    errorShell((e && e.message) || 'Fehler beim Laden der Absenzen');
  }
}

function drawAbsenzen(data) {
  main.replaceChildren();

  // Phantom-Duplikate (z. B. „Englisch …" als 0/0-Modul neben dem echten
  // Parallelmodul) entfernen, bevor Hero-Count, Chips und Liste sie nutzen.
  const rows = dedupAbsenzRows((data && data.rows) || []);
  const stats = (data && data.stats) || {};

  // Stats-Hero — drei KPI-Spalten (gleiche Markup-Klassen wie stats-View).
  main.append(buildAbsenzHero(stats, rows.length));

  // Empty-State: keine Module gescraped → freundlicher Hinweis statt
  // halbleerer Filter über einer leeren Liste.
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'm-empty';
    empty.textContent = 'Noch keine Absenzen-Daten — starte einen Scrape.';
    main.append(empty);
    return;
  }

  // Typ-Chips auf dem ANGEZEIGTEN Label deduplizieren (deriveAbsenzTypLabels),
  // nicht auf dem Rohwert — sonst mehrere optisch identische Chips.
  const typLabels = deriveAbsenzTypLabels(rows);

  const filter = buildAbsenzFilter(typLabels);
  main.append(filter);

  const list = document.createElement('div');
  list.className = 'm-list';
  list.id = 'absenzList';
  main.append(list);

  const search = filter.querySelector('#absenzSearch');
  search.value = absenzenState.query;
  search.addEventListener('input', () => {
    absenzenState.query = search.value;
    drawAbsenzList(rows);
  });
  filter.querySelectorAll('.m-chip[data-sort]').forEach((btn) => {
    btn.addEventListener('click', () => {
      absenzenState.sort = btn.dataset.sort;
      updateAbsenzChipActive(filter);
      drawAbsenzList(rows);
    });
  });
  filter.querySelectorAll('.m-chip[data-typ]').forEach((btn) => {
    btn.addEventListener('click', () => {
      // Toggle: erneuter Klick auf den aktiven Typ-Chip setzt auf „all" zurück.
      absenzenState.typ = (absenzenState.typ === btn.dataset.typ) ? 'all' : btn.dataset.typ;
      updateAbsenzChipActive(filter);
      drawAbsenzList(rows);
    });
  });
  const onlyChip = filter.querySelector('.m-chip[data-only]');
  if (onlyChip) {
    onlyChip.addEventListener('click', () => {
      absenzenState.onlyUnterMin = !absenzenState.onlyUnterMin;
      updateAbsenzChipActive(filter);
      drawAbsenzList(rows);
    });
  }
  updateAbsenzChipActive(filter);
  drawAbsenzList(rows);

  // Deep-link ?code=<kuerzel_code> aus der Push-Notification: das Modul-Sheet
  // direkt öffnen, sobald die Liste steht. mobile.js setzt ?focus nicht für
  // diese Route, also lesen wir den Hash hier selbst aus.
  openDeepLinkedAbsenzSheet(rows);

  // Scroll-to-Top FAB — gleiche Funktion wie Noten/Stundenplan. Die Route-
  // Guard in attachScrollTopFab whitelistet /noten + /stundenplan; ohne
  // /absenzen würde der FAB hier sofort wieder abbrechen. Defensiv per
  // typeof-Check, falls das stundenplan.js-Script nicht geladen ist.
  if (typeof attachScrollTopFab === 'function') attachScrollTopFab();
}

function buildAbsenzHero(stats, totalCount) {
  // Noten-Hero-Muster (.m-hero) statt 2×2-KPI-Grid: EINE dominante Kennzahl
  // links (Ø-Anwesenheit) + kompakte Meta-Spalte rechts. Hierarchie durch
  // Skala statt drei gleichwertiger Boxen (die bei 3 KPIs zum unschönen 2+1
  // wurden). Gespiegelt am Noten-Tab (views/noten.js drawNoten).
  const hero = document.createElement('section');
  hero.className = 'm-hero';
  hero.setAttribute('aria-label', 'Anwesenheits-Übersicht');

  const avg = (stats && stats.avgAnwesenheit != null) ? stats.avgAnwesenheit : null;
  const unterMin = (stats && stats.unterMinimum != null) ? stats.unterMinimum : 0;
  const abwesend = (stats && stats.abwesendGesamt != null) ? stats.abwesendGesamt : 0;

  // Dominante Kennzahl: Ø-Anwesenheit, getönt über feste 90er-Bänder (der
  // Schnitt hat kein modul-spezifisches Minimum).
  const left = document.createElement('div');
  const lab = document.createElement('div');
  lab.className = 'm-hero__label';
  lab.textContent = 'Ø Anwesenheit';
  const val = document.createElement('div');
  val.className = 'm-hero__value ' + (avg != null ? attendanceClass(avg, 90) : 'm-att--none');
  val.textContent = avg != null ? Math.round(avg) + '%' : '–';
  left.append(lab, val);

  // Kompakte Meta-Spalte rechts: Module · unter Minimum · Abwesenheiten.
  // „unter Minimum" wird rot getönt wenn > 0 — die kritische Kennzahl der
  // Anwesenheits-Sicht (Farbe semantisch, nicht dekorativ).
  const meta = document.createElement('div');
  meta.className = 'm-hero__meta';
  meta.append(
    absenzMetaRow(totalCount, totalCount === 1 ? 'Modul' : 'Module', false),
    absenzMetaRow(unterMin, 'unter Minimum', unterMin > 0),
    absenzMetaRow(abwesend, abwesend === 1 ? 'Abwesenheit' : 'Abwesenheiten', false),
  );

  hero.append(left, meta);
  return hero;
}

/* Eine Meta-Zeile im Absenzen-Hero: fette Zahl + Label (kein innerHTML →
 * XSS-sicher). `alert` tönt die ganze Zeile rot. */
function absenzMetaRow(num, label, alert) {
  const row = document.createElement('div');
  row.className = 'm-hero__metarow' + (alert ? ' m-hero__metarow--alert' : '');
  const strong = document.createElement('strong');
  strong.textContent = String(num);
  row.append(strong, document.createTextNode(' ' + label));
  return row;
}

function buildAbsenzFilter(typLabels) {
  const filter = document.createElement('div');
  filter.className = 'm-filter';

  const search = document.createElement('div');
  search.className = 'm-search';
  search.innerHTML =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>' +
    // aria-label weil Placeholder kein Label-Ersatz ist (WCAG H44).
    '<input id="absenzSearch" type="search" aria-label="Module suchen" placeholder="Modul-Code oder Bezeichnung suchen" autocomplete="off" spellcheck="false" />';
  filter.append(search);

  const chips = document.createElement('div');
  chips.className = 'm-chips';
  chips.setAttribute('role', 'tablist');

  const sortAz = document.createElement('button');
  sortAz.type = 'button';
  sortAz.className = 'm-chip';
  sortAz.dataset.sort = 'name';
  sortAz.textContent = 'A–Z';
  chips.append(sortAz);

  // Typ-Chips nur wenn es mehr als eine Typ-GRUPPE gibt — sonst toter Filter.
  // typLabels enthält bereits die kollabierten Anzeige-Labels (Dedup in
  // drawAbsenzen) → hier NICHT erneut kürzen.
  if (typLabels.length > 1) {
    typLabels.forEach((label) => {
      const c = document.createElement('button');
      c.type = 'button';
      c.className = 'm-chip';
      c.dataset.typ = label;
      c.textContent = label;
      c.setAttribute('aria-label', 'Filter: ' + label);
      chips.append(c);
    });
  }

  const onlyChip = document.createElement('button');
  onlyChip.type = 'button';
  onlyChip.className = 'm-chip';
  onlyChip.dataset.only = '1';
  onlyChip.textContent = 'Unter Minimum';
  chips.append(onlyChip);

  filter.append(chips);
  return filter;
}

/* Lange Typ-Strings („GE Überbetrieblicher Kurs") für den Chip kürzen, aber
 * das volle Wort bleibt im aria-label (siehe buildAbsenzFilter). */
function shortTypLabel(typ) {
  const t = String(typ || '');
  if (/überbetrieb/i.test(t)) return 'ÜK';
  if (/modul/i.test(t)) return 'Modul';
  return t.length > 14 ? t.slice(0, 13) + '…' : t;
}

/* Distinkte Chip-Labels aus den Roh-Typen ableiten. Tocco liefert viele
 * Roh-Typen („GE Modul", „Modul", „PE Modul", „Parallelmodul", „GE/PE
 * Überbetrieblicher Kurs", „Semester"), die shortTypLabel auf wenige Gruppen
 * kollabiert („Modul"/„ÜK"/„Semester"). Dedup MUSS auf dem angezeigten Label
 * passieren — sonst entstehen mehrere optisch identische Chips (z. B. 4×
 * „Modul", 2× „ÜK"). Der Listen-Filter (drawAbsenzList) matcht konsistent
 * ebenfalls auf shortTypLabel(r.typ). */
// Typ-Labels, die NICHT als Filter-Chip erscheinen sollen. „Semester" sind die
// Gesamt-Semester-Registrierungen (UIFZ-P …) — als Filter unerwünscht. Die
// Zeilen selbst bleiben in der Liste (unter „alle") sichtbar.
const ABSENZ_HIDDEN_TYP_LABELS = new Set(['Semester']);

function deriveAbsenzTypLabels(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return Array.from(new Set(
    list.map((r) => r && r.typ).filter(Boolean).map(shortTypLabel),
  )).filter((label) => !ABSENZ_HIDDEN_TYP_LABELS.has(label));
}

/* Eine Lektion gilt als „leer", wenn weder Soll- noch Ist-Lektionen vorhanden
 * sind (0 oder null). */
function isLeereLektion(r) {
  const soll = r && r.soll;
  const besucht = r && r.besucht;
  return (soll == null || soll === 0) && (besucht == null || besucht === 0);
}

/* Phantom-Duplikate ausblenden. Tocco listet manche Module DOPPELT: einmal als
 * regulären „Modul"-Eintrag mit 0/0 Lektionen (dort wird die Anwesenheit nicht
 * geführt) und einmal als „Parallelmodul" mit den ECHTEN Lektionen — z. B.
 * „Englisch Niveau 3 Semester 2": 0/0 vs. 48/48. Eine Zeile wird nur dann
 * übersprungen, wenn sie 0/0 hat UND eine ANDERE Zeile mit gleicher Bezeichnung
 * echte Lektionen trägt (= echtes Duplikat). Eindeutige 0/0-Module („Start",
 * noch nicht gestartete ÜK/Module) bleiben sichtbar. */
function dedupAbsenzRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const hatEchteLektionen = new Set();
  for (const r of list) {
    if (r && r.bezeichnung && !isLeereLektion(r)) hatEchteLektionen.add(r.bezeichnung);
  }
  return list.filter((r) => {
    if (!r) return false;
    if (isLeereLektion(r) && r.bezeichnung && hatEchteLektionen.has(r.bezeichnung)) return false;
    return true;
  });
}

function updateAbsenzChipActive(root) {
  root.querySelectorAll('.m-chip[data-sort]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.sort === absenzenState.sort));
  });
  root.querySelectorAll('.m-chip[data-typ]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.typ === absenzenState.typ));
  });
  const oc = root.querySelector('.m-chip[data-only]');
  if (oc) oc.setAttribute('aria-pressed', String(absenzenState.onlyUnterMin));
}

/* Ein Modul gilt als „unter Minimum", wenn seine Ist-Anwesenheit unter der
 * Minimalanwesenheit liegt. Ohne Minimum kann es nicht „unter Minimum" sein. */
function isUnterMinimum(r) {
  if (r.minimal_pct == null || !Number.isFinite(r.minimal_pct)) return false;
  if (r.anwesenheit_pct == null || !Number.isFinite(r.anwesenheit_pct)) return false;
  return r.anwesenheit_pct < r.minimal_pct;
}

/* Sortier-Schlüssel für A–Z: Modulname OHNE führende Modulnummer. bezeichnung
 * ist oft „106 - Datenbanken …" → ohne das „106 - "-Präfix wird nach dem NAMEN
 * (Datenbanken …) sortiert statt nach der Nummer. Module ohne Nummern-Präfix
 * (z. B. „Englisch Niveau 3 …") bleiben unverändert. */
function absenzSortName(r) {
  const bez = ((r && (r.bezeichnung || r.kuerzel_code)) || '').trim();
  return bez.replace(/^\d+\s*[-–]\s*/, '');
}

function drawAbsenzList(rows) {
  const list = $('#absenzList');
  if (!list) return;
  list.replaceChildren();

  const q = absenzenState.query.trim().toLowerCase();
  let filtered = rows.slice();

  if (absenzenState.typ !== 'all') {
    // absenzenState.typ hält das Anzeige-Label (z. B. „Modul"), das die Chips
    // tragen. Gegen das kollabierte Label der Zeile matchen, NICHT gegen den
    // Rohwert — sonst träfe „Modul" nur eine der mehreren Roh-Untermengen
    // (bzw. nie, weil State=Label gegen Row=Rohwert verglichen würde).
    filtered = filtered.filter((r) => shortTypLabel(r.typ) === absenzenState.typ);
  }
  if (absenzenState.onlyUnterMin) {
    filtered = filtered.filter(isUnterMinimum);
  }
  if (q) {
    filtered = filtered.filter((r) => {
      const hay = [r.kuerzel_code, r.bezeichnung, r.typ, r.semester]
        .filter(Boolean).join(' ').toLowerCase();
      return hay.indexOf(q) !== -1;
    });
  }

  // A–Z nach MODULNAME (führende Modulnummer ignoriert, siehe absenzSortName) —
  // sonst sortierte „106 - …" nach der Zahl und wirkte zufällig. 'de' +
  // sensitivity:'base' → saubere, case-/diakritik-tolerante Alpha-Sortierung.
  filtered.sort((a, b) => absenzSortName(a).localeCompare(absenzSortName(b), 'de', { sensitivity: 'base' }));

  if (!filtered.length) {
    const e = document.createElement('div');
    e.className = 'm-empty';
    e.textContent = 'Keine Treffer für die aktuellen Filter.';
    list.append(e);
    return;
  }

  filtered.forEach((row) => list.append(absenzCard(row)));
  observeFresh(list);
}

function absenzCard(row) {
  // Tap öffnet das Absenz-Modul-Sheet (Tagesliste) statt zu routen — hält den
  // User in der Liste mit seiner Scroll-Position (gleiches Pattern wie Noten).
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'm-card is-clickable' + (row.isFresh ? ' is-fresh' : '');
  const code = row.kuerzel_code || '';
  card.addEventListener('click', () => {
    if (typeof window.openAbsenzModulSheet === 'function') {
      window.openAbsenzModulSheet(code);
    }
  });
  if (row.isFresh && code) {
    card.dataset.freshKind = 'absenzen';
    card.dataset.freshId = code;
  }

  // Rich aria-label so Screen-Reader hören was der Tap tut + Anwesenheit +
  // Frisch-State. Ohne das liest VoiceOver nur den sichtbaren Text.
  const labelParts = [
    'Absenz-Detail öffnen',
    absenzTitle(row),
    row.anwesenheit_pct != null
      ? ('Anwesenheit ' + Math.round(row.anwesenheit_pct) + ' Prozent')
      : 'Anwesenheit unbekannt',
  ];
  if (isUnterMinimum(row)) labelParts.push('unter Minimum');
  if (row.isFresh) labelParts.push('frisch');
  card.setAttribute('aria-label', labelParts.join(', '));

  const main_ = document.createElement('div');
  main_.className = 'm-card__main';
  const title = document.createElement('div');
  title.className = 'm-card__title';
  title.textContent = absenzTitle(row);
  const sub = document.createElement('div');
  sub.className = 'm-card__sub';
  // Untertitel: Typ + Soll/Besucht-Spanne, falls vorhanden.
  const subParts = [];
  if (row.typ) subParts.push(shortTypLabel(row.typ));
  if (row.besucht != null && row.soll != null) {
    subParts.push(fmtNum(row.besucht) + '/' + fmtNum(row.soll) + ' Lekt.');
  }
  if (row.minimal_pct != null) subParts.push('min. ' + Math.round(row.minimal_pct) + '%');
  sub.textContent = subParts.join(' · ') || '—';
  main_.append(title, sub);

  // Anwesenheit-ist% rechts (statt Note). Tönung via attendanceClass.
  const att = document.createElement('div');
  att.className = 'm-card__grade ' + attendanceClass(row.anwesenheit_pct, row.minimal_pct);
  att.textContent = fmtPct(row.anwesenheit_pct);

  card.append(main_, att);

  if (row.isFresh) {
    // Echter <span> statt CSS ::after — Screen-Reader lesen das zuverlässig.
    // aria-hidden, weil das <button>-aria-label „frisch" schon erwähnt.
    const pill = document.createElement('span');
    pill.className = 'm-card__fresh-pill';
    pill.setAttribute('aria-hidden', 'true');
    pill.textContent = 'Neu';
    card.append(pill);
  }
  return card;
}

/* Titel der Card: Modul-Code als führendes Token + Bezeichnung. Die
 * Absenzen-Quelle hat keine numerische Modulnummer, deshalb nutzen wir den
 * kuerzel_code direkt (gekürzt auf das aussagekräftige Ende). */
function absenzTitle(row) {
  const bez = (row.bezeichnung || '').trim();
  if (bez) return bez;
  return row.kuerzel_code || 'Modul';
}

function fmtNum(n) {
  if (n == null || !Number.isFinite(n)) return '–';
  // Ganzzahlig wenn ohne Nachkommastelle, sonst eine Stelle.
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/* Push-Deep-Link: /mobile/#/absenzen?code=<kuerzel_code> öffnet das Modul-
 * Sheet direkt. Wir lesen den Hash selbst, weil mobile.js nur ?focus für
 * Noten/Stundenplan auswertet. Nur einmal pro Render auslösen. */
function openDeepLinkedAbsenzSheet(rows) {
  try {
    const h = window.location.hash || '';
    const qIdx = h.indexOf('?');
    if (qIdx === -1) return;
    const params = new URLSearchParams(h.slice(qIdx + 1));
    const code = params.get('code');
    if (!code) return;
    // Nur öffnen, wenn der Code tatsächlich in der Liste existiert — sonst
    // ein leeres/fehlerndes Sheet bei verwaisten Push-Links.
    const exists = rows.some((r) => r.kuerzel_code === code);
    if (exists && typeof window.openAbsenzModulSheet === 'function') {
      window.openAbsenzModulSheet(code);
    }
  } catch (_) { /* defensiv — Deep-Link ist best-effort */ }
}
