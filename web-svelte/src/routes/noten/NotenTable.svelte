<script lang="ts">
  /* Sortable module table for /noten with inline-expansion (Pruefungen) rows.
   * Pure presentational — sort + open + load actions are passed in as
   * callbacks so the parent owns the source of truth.
   */
  import { onMount } from 'svelte';
  import { slide } from 'svelte/transition';
  import { expoOut, cubicOut } from 'svelte/easing';

  import type { PruefungRow } from '#lib/api/types.js';
  import {
    gradeClass,
    fmtGrade,
    fmtRelative,
    statusLabel,
    rowKey,
    type IndexedRow,
    type SortKey,
  } from './helpers';

  interface Props {
    loading: boolean;
    modules: IndexedRow[] | null;
    sorted: IndexedRow[];
    sortBy: SortKey;
    sortDir: 'asc' | 'desc';
    openId: string | null;
    /** Row whose pruefungen are pre-loading (between click and mount). */
    pendingOpenId: string | null;
    pruefungenCache: Map<string, PruefungRow[]>;
    pruefungenLoading: Set<string>;
    pruefungenError: Map<string, string>;
    setSort: (key: SortKey) => void;
    toggleRow: (r: IndexedRow) => Promise<void> | void;
    loadPruefungenFor: (id: string) => Promise<void> | void;
  }

  let {
    loading,
    modules,
    sorted,
    sortBy,
    sortDir,
    openId,
    pendingOpenId,
    pruefungenCache,
    pruefungenLoading,
    pruefungenError,
    setSort,
    toggleRow,
    loadPruefungenFor,
  }: Props = $props();

  /* Honour prefers-reduced-motion for the row-reveal slide — Svelte's
   * built-in transitions don't auto-disable, so we collapse duration to
   * 0 when the user has it set. Reactive via matchMedia change-listener:
   * if the OS toggles its setting mid-session, the next open/close picks
   * up the new value instead of staying pinned to the mount-time read. */
  let prefersReducedMotion = $state(false);
  const slideDuration = $derived(prefersReducedMotion ? 0 : 320);
  const slideOutDuration = $derived(prefersReducedMotion ? 0 : 220);

  onMount(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    prefersReducedMotion = mql.matches;
    const onChange = (e: MediaQueryListEvent): void => {
      prefersReducedMotion = e.matches;
    };
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  });

  function sortClass(key: SortKey): string {
    if (sortBy !== key) return '';
    return sortDir === 'asc' ? 'is-asc' : 'is-desc';
  }
  function sortAria(key: SortKey): 'ascending' | 'descending' | 'none' {
    if (sortBy !== key) return 'none';
    return sortDir === 'asc' ? 'ascending' : 'descending';
  }

  function onRowKey(e: KeyboardEvent, r: IndexedRow): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      void toggleRow(r);
    } else if (e.key === 'Escape' && openId === rowKey(r)) {
      e.preventDefault();
      // Parent owns openId — surfacing the "close" action via toggleRow
      // when the same row is open already collapses it.
      void toggleRow(r);
    }
  }
</script>

<div class="tbl-wrap">
  <table class="tbl">
    <!-- Explicit column grid. With table-layout: fixed the browser uses
         these widths verbatim, so the trigger row + the colspan=6 detail
         row + the flash overlay can never perturb column alignment. -->
    <colgroup>
      <col style="width: 88px" />
      <col />
      <col style="width: 64px" />
      <col style="width: 90px" />
      <col style="width: 140px" />
      <col class="col-updated" style="width: 120px" />
    </colgroup>
    <thead>
      <tr>
        <th scope="col" class={sortClass('number')} aria-sort={sortAria('number')}>
          <button type="button" class="tbl__sort-btn" onclick={() => setSort('number')}>
            Nr. <span class="sort-arrow" aria-hidden="true"></span>
          </button>
        </th>
        <th scope="col" class={sortClass('name')} aria-sort={sortAria('name')}>
          <button type="button" class="tbl__sort-btn" onclick={() => setSort('name')}>
            Modul <span class="sort-arrow" aria-hidden="true"></span>
          </button>
        </th>
        <th scope="col" class={sortClass('semester')} aria-sort={sortAria('semester')}>
          <button type="button" class="tbl__sort-btn" onclick={() => setSort('semester')}>
            S <span class="sort-arrow" aria-hidden="true"></span>
          </button>
        </th>
        <th scope="col" class="tbl__right {sortClass('note')}" aria-sort={sortAria('note')}>
          <button type="button" class="tbl__sort-btn tbl__sort-btn--right" onclick={() => setSort('note')}>
            Note <span class="sort-arrow" aria-hidden="true"></span>
          </button>
        </th>
        <th scope="col" class={sortClass('status')} aria-sort={sortAria('status')}>
          <button type="button" class="tbl__sort-btn" onclick={() => setSort('status')}>
            Status <span class="sort-arrow" aria-hidden="true"></span>
          </button>
        </th>
        <th scope="col" class="tbl__right {sortClass('updated')}" aria-sort={sortAria('updated')}>
          <button type="button" class="tbl__sort-btn tbl__sort-btn--right" onclick={() => setSort('updated')}>
            Updated <span class="sort-arrow" aria-hidden="true"></span>
          </button>
        </th>
      </tr>
    </thead>
    <tbody>
      {#if loading && !modules}
        <tr>
          <td colspan="6" class="tbl__empty">Lade Daten…</td>
        </tr>
      {:else if !modules}
        <tr>
          <td colspan="6" class="tbl__empty">Keine Daten verfügbar.</td>
        </tr>
      {:else if !sorted.length}
        <tr>
          <td colspan="6" class="tbl__empty">Keine Einträge — Filter prüfen.</td>
        </tr>
      {:else}
        {#each sorted as r (rowKey(r))}
          {@const id = rowKey(r)}
          {@const isOpen = openId === id}
          {@const status = statusLabel(r)}
          <tr
            class="tbl__row"
            class:is-fresh={r.isFresh === 1}
            class:is-expanded={isOpen}
            class:is-pending={pendingOpenId === id}
            tabindex="0"
            role="button"
            aria-expanded={isOpen}
            aria-controls={isOpen ? `pruef-${id}` : undefined}
            aria-label={`Modul-Detail ${isOpen ? 'schliessen' : 'oeffnen'}: ${r._name}`}
            data-row-id={id}
            onclick={() => toggleRow(r)}
            onkeydown={(e) => onRowKey(e, r)}
          >
            <td class="tbl__cell-number">
              {#if r._code}
                <span class="fach-code mono">{r._code}</span>
              {:else}
                <span class="text-dim">—</span>
              {/if}
            </td>
            <td class="tbl__cell-name">
              <div class="fach-name">{r._name}</div>
            </td>
            <td>
              {#if r.semester}
                <span class="sem-badge mono sem-badge--{r.semester.toLowerCase()}">
                  {r.semester}
                </span>
              {:else}
                <span class="text-dim">—</span>
              {/if}
            </td>
            <td class="tbl__right">
              <span class="note-cell mono {gradeClass(r.note)}">{fmtGrade(r.note)}</span>
            </td>
            <td>
              <span class="status-pill status-pill--{status.tone}">
                <span class="status-pill__dot" aria-hidden="true"></span>
                {status.text}
              </span>
            </td>
            <td class="tbl__right">
              <span class="updated-cell mono">{fmtRelative(r.fetched_at)}</span>
              <!-- Kein zusätzlicher Pending-Dot mehr neben der Cell — die
                   eigentliche Lade-Anzeige sitzt im aufgeklappten Detail-Row
                   (pruefungenLoading-Branch). Der externe Dot war meistens
                   nur kurz sichtbar (schnelle API) und wirkte wie ein
                   Glitch + verursachte Layout-Shift in der right-cell. -->
            </td>
          </tr>
          <!-- Detail row mounts conditionally; the smooth open/close runs on
               the inner .pruef div via Svelte's slide. Svelte keeps the
               parent TR alive until the child's out-transition completes,
               so the close animates fully before the row vanishes. -->
          {#if isOpen}
            <tr class="tbl__detail-row" id={`pruef-${id}`}>
              <td colspan="6" class="tbl__detail-cell">
                <div
                  class="pruef"
                  role="region"
                  aria-live="polite"
                  aria-label={`Prüfungen für ${r._name}`}
                  in:slide={{ duration: slideDuration, easing: expoOut }}
                  out:slide={{ duration: slideOutDuration, easing: cubicOut }}
                >
                  <div class="pruef__title">Prüfungen</div>
                  {#if pruefungenLoading.has(id)}
                    <!-- Defensive fallback: parent pre-loads pruefungen
                         before mounting this row, so this should rarely
                         render. If it does (race / stale cache), at least
                         it's a small one-line placeholder, not a 3-row
                         skeleton that fights the slide-in. -->
                    <div class="pruef__hint mono">Lade Prüfungen…</div>
                  {:else if pruefungenError.has(id)}
                    <div class="pruef__error">
                      {pruefungenError.get(id)}
                      <button
                        type="button"
                        class="pruef__retry"
                        onclick={(e) => {
                          e.stopPropagation();
                          void loadPruefungenFor(id);
                        }}
                      >
                        Erneut
                      </button>
                    </div>
                  {:else if (pruefungenCache.get(id) ?? []).length === 0}
                    <div class="pruef__hint">Keine Prüfungen erfasst.</div>
                  {:else}
                    <div class="pruef-list">
                      {#each pruefungenCache.get(id) ?? [] as p (p.id)}
                        {@const tCls = p.pruefung_typ === 'ZP'
                          ? 'pruef-typ--zp'
                          : p.pruefung_typ === 'LB'
                            ? 'pruef-typ--lb'
                            : 'pruef-typ--other'}
                        {@const hasDiff = p.prev_bewertung != null
                          && p.bewertung != null
                          && p.prev_bewertung !== p.bewertung}
                        <div class="pruef-row">
                          <span class="pruef-typ mono {tCls}">{p.pruefung_typ}</span>
                          <span class="pruef-row__label">
                            {p.bezeichnung || `${p.pruefung_typ} ${p.pruefung_nr}`}
                          </span>
                          <!-- Reihenfolge: NOTE links — GEWICHT rechts. So
                               liest sich's natürlich "Note 4.7 mit Gewicht
                               25%" und alle Noten landen in der gleichen
                               vertikalen Linie über alle Prüfungen. -->
                          <span class="pruef-row__note mono {gradeClass(p.bewertung)}">
                            {#if hasDiff}
                              <span class="pruef-row__prev mono {gradeClass(p.prev_bewertung)}"
                                    title="Vorheriger Wert">
                                {fmtGrade(p.prev_bewertung)}
                              </span>
                              <span class="pruef-row__arrow mono" aria-hidden="true">→</span>
                            {/if}
                            {fmtGrade(p.bewertung)}
                          </span>
                          <span class="pruef-row__weight mono">
                            {p.gewicht_pct != null ? p.gewicht_pct + '%' : (p.gewicht ?? '—')}
                          </span>
                        </div>
                      {/each}
                    </div>
                  {/if}
                </div>
              </td>
            </tr>
          {/if}
        {/each}
      {/if}
    </tbody>
  </table>
</div>

<style>
  .mono {
    font-family: var(--font-mono);
    font-feature-settings: 'tnum' 1, 'zero' 1;
  }

  /* ---------- Table ---------- */
  .tbl-wrap {
    overflow-x: auto;
  }
  .tbl {
    width: 100%;
    border-collapse: collapse;
    font-size: 13.5px;
    /* Fixed layout: column widths come from the <th width="…"> hints only,
     * NOT from cell content. Without this, the colspan=6 detail row (the
     * Prüfungen panel) and the flash overlay can perturb the auto-layout
     * calculation and visually shift the trigger row's columns out of
     * alignment with the header. Modul-cell has no explicit width so it
     * absorbs the leftover horizontal space. */
    table-layout: fixed;
  }
  .tbl thead th {
    text-align: left;
    padding: 0;
    border-bottom: 1px solid var(--border-soft);
    background: var(--surface-header);
  }
  .tbl thead th.tbl__right { text-align: right; }

  /* Real <button> inside <th> — keyboard-operable widget with aria-sort
   * preserved on the th itself. Replaces the previous tabindex-on-th
   * pattern that wasn't reachable to assistive tech. */
  .tbl__sort-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 10px 16px;
    background: transparent;
    border: 0;
    color: var(--text-dim);
    font: inherit;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.10em;
    text-align: inherit;
    user-select: none;
    cursor: pointer;
    transition: color var(--t-fast) var(--ease);
  }
  .tbl__sort-btn--right {
    justify-content: flex-end;
  }
  @media (hover: hover) and (pointer: fine) {
    .tbl__sort-btn:hover { color: var(--text); }
  }
  .tbl__sort-btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .tbl__sort-btn .sort-arrow {
    display: inline-block;
    width: 10px;
    color: var(--text-dim);
  }
  .tbl thead th.is-asc .tbl__sort-btn,
  .tbl thead th.is-desc .tbl__sort-btn { color: var(--text); }
  .tbl thead th.is-asc .sort-arrow::after {
    content: '↑';
    color: var(--accent);
  }
  .tbl thead th.is-desc .sort-arrow::after {
    content: '↓';
    color: var(--accent);
  }

  .tbl tbody tr.tbl__row {
    border-bottom: 1px solid var(--border-soft);
    cursor: pointer;
    transition: background var(--t-fast) var(--ease);
  }
  .tbl tbody tr.tbl__row.is-fresh {
    background: var(--warning-soft);
  }
  @media (hover: hover) and (pointer: fine) {
    .tbl tbody tr.tbl__row:hover { background: var(--surface-2); }
    .tbl tbody tr.tbl__row.is-fresh:hover { background: var(--warning-soft-strong); }
  }
  .tbl tbody tr.tbl__row.is-expanded {
    background: var(--surface-2);
  }

  /* Deep-link flash: two yellow pulses on the focused row AND its expanded
   * detail row. `:global` because .is-flash is added at runtime via JS.
   *
   * Implementation note: animates `background-color` directly on the TR
   * instead of using a `::before` overlay. Table-row pseudo-elements with
   * `position: absolute` are rendered inconsistently across browsers (Chrome
   * historically rendered them as table-cell content, which would push real
   * <td>s sideways and break column alignment). Animating bg-color avoids
   * that whole class of layout corruption while staying compositor-cheap. */
  .tbl tbody tr.tbl__row:global(.is-flash),
  .tbl tbody tr.tbl__row:global(.is-flash) + tr.tbl__detail-row {
    animation: noten-row-flash 2400ms ease-out;
  }
  @keyframes noten-row-flash {
    0%   { background-color: transparent; }
    15%  { background-color: var(--warning-flash); }
    35%  { background-color: transparent; }
    55%  { background-color: var(--warning-flash); }
    100% { background-color: transparent; }
  }
  @media (prefers-reduced-motion: reduce) {
    .tbl tbody tr.tbl__row:global(.is-flash),
    .tbl tbody tr.tbl__row:global(.is-flash) + tr.tbl__detail-row {
      animation: none;
    }
  }
  .tbl td {
    padding: 11px 16px;
    vertical-align: middle;
  }
  .tbl td.tbl__right { text-align: right; }
  .tbl__empty {
    padding: 32px 16px !important;
    text-align: center;
    color: var(--text-dim);
    font-size: 13px;
  }
  .tbl__cell-name { min-width: 220px; }
  .tbl__cell-number {
    width: 88px;
    white-space: nowrap;
  }

  .fach-name {
    font-weight: 500;
    color: var(--text);
    line-height: 1.3;
  }
  /* Module-number is now its own cell — bigger, easier to scan, primary
   * lookup target since the user wanted asc/desc sort by number. */
  .fach-code {
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
    letter-spacing: 0.02em;
  }
  .text-dim { color: var(--text-dim); }

  .sem-badge {
    display: inline-block;
    font-size: 10px;
    font-weight: 600;
    padding: 2px 7px;
    border-radius: 4px;
    background: var(--surface-3);
    color: var(--text-mute);
    border: 1px solid var(--border-soft);
    letter-spacing: 0.04em;
  }
  .sem-badge--s1 {
    color: var(--sem-1);
    border-color: var(--sem-1-border);
  }
  .sem-badge--s2 {
    color: var(--sem-2);
    border-color: var(--sem-2-border);
  }

  .note-cell {
    font-weight: 600;
    font-size: 16px;
    letter-spacing: -0.01em;
  }
  .updated-cell {
    font-size: 12px;
    color: var(--text-mute);
  }

  /* Status pills — color + form (dot shape) per a11y rule. */
  .status-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 9px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    background: var(--surface-2);
    border: 1px solid var(--border-soft);
    color: var(--text-mute);
  }
  .status-pill__dot {
    width: 6px;
    height: 6px;
    border-radius: 999px;
    background: var(--text-dim);
  }
  .status-pill--has {
    color: var(--g-good);
    background: var(--accent-soft);
    border-color: var(--accent-border);
  }
  .status-pill--has .status-pill__dot { background: var(--g-good); }
  .status-pill--none {
    color: var(--text-dim);
    background: var(--surface-2);
    border-color: var(--border-soft);
  }
  .status-pill--none .status-pill__dot {
    background: transparent;
    border: 1px solid var(--text-dim);
    width: 6px;
    height: 6px;
    box-sizing: border-box;
  }
  .status-pill--fresh {
    color: var(--warning);
    background: var(--warning-soft-strong);
    border-color: var(--warning-border);
  }
  .status-pill--fresh .status-pill__dot { background: var(--warning); }

  /* ---------- Inline expansion ----------
   * Detail TR mounts conditionally via {#if isOpen}. Svelte keeps it in
   * the DOM until the child .pruef's out-transition completes, so the
   * close-slide actually plays before the row vanishes. Padding lives on
   * .pruef so it slides with the height; the TD itself has none. */
  .tbl__detail-row {
    background: var(--bg-elev);
  }
  .tbl__detail-cell {
    padding: 0;
    border: 0;
  }
  .pruef {
    padding: 14px 16px 18px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .pruef__title {
    font-size: 11px;
    letter-spacing: 0.10em;
    text-transform: uppercase;
    color: var(--text-dim);
    font-weight: 600;
  }
  .pruef__hint { color: var(--text-dim); font-size: 12px; }
  .pruef__error {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    color: var(--danger);
    font-size: 12px;
  }
  .pruef__retry {
    padding: 4px 10px;
    border-radius: var(--r-sm);
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text);
    font-size: 12px;
  }
  .pruef-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .pruef-row {
    display: grid;
    grid-template-columns: 50px 1fr auto auto;
    gap: 14px;
    align-items: center;
    padding: 8px 12px;
    background: var(--surface);
    border: 1px solid var(--border-soft);
    border-radius: var(--r-md);
  }
  /* Pending state on the trigger row — pre-loading pruefungen between
   * click and mount. Background change tells the user "I heard you,
   * opening in a beat" so the 100-300ms fetch wait doesn't feel like a
   * dead click. NO pseudo-element / position:relative on the TR — those
   * cause inconsistent table-cell layout across browsers. The pulsing
   * dot lives inside the trailing TD where positioning is well-defined. */
  .tbl tbody tr.tbl__row.is-pending {
    background: var(--surface-2);
  }
  .pruef-typ {
    display: inline-block;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.06em;
    padding: 3px 7px;
    border-radius: 4px;
    background: var(--surface-3);
    color: var(--text-mute);
    text-align: center;
  }
  .pruef-typ--zp {
    color: var(--warning);
    background: var(--warning-soft-strong);
  }
  .pruef-typ--lb {
    color: var(--accent);
    background: var(--accent-soft);
  }
  .pruef-row__label { font-size: 13px; color: var(--text); }
  .pruef-row__weight {
    font-size: 11px;
    color: var(--text-dim);
    letter-spacing: 0.02em;
  }
  .pruef-row__note {
    font-size: 14px;
    font-weight: 700;
    min-width: 44px;
    text-align: right;
    /* Bei Wert-Änderung enthält die Zelle prev → curr in einer Zeile.
     * inline-flex hält die Elemente baseline-aligned ohne Wrap. */
    display: inline-flex;
    align-items: baseline;
    gap: 5px;
    justify-content: flex-end;
  }
  .pruef-row__prev {
    font-size: 12px;
    font-weight: 600;
    /* Durchgestrichen ohne aggressive Strikethrough-Linie — der Pfeil
     * liefert die Vorher-Bedeutung; das durchstrichene "alt"-Gefühl kommt
     * über reduzierte Opacity statt Linie, das passt besser zur WISSen-
     * Linear-Lane (kein dekoratives Strikethrough). */
    opacity: 0.55;
  }
  .pruef-row__arrow {
    font-size: 11px;
    color: var(--text-dim);
    font-weight: 500;
  }

  /* ---------- Grade color tokens ---------- */
  .g-excellent { color: var(--g-excellent); }
  .g-good      { color: var(--g-good); }
  .g-ok        { color: var(--g-ok); }
  .g-fail      { color: var(--g-fail); }
  .g-none      { color: var(--text-dim); }

  /* ---------- Reduced motion ----------
   * Slide transition duration is forced to 0 in JS via prefersReducedMotion;
   * here we just kill any ambient row hover transitions so taps feel instant
   * for users who opt out of animation. */
  @media (prefers-reduced-motion: reduce) {
    .tbl__row { transition: none; }
  }

  /* ---------- Compact/mobile ---------- */
  @media (max-width: 600px) {
    .tbl thead th,
    .tbl td { padding: 10px 12px; }
    .tbl__cell-name { min-width: 0; }
    .updated-cell { display: none; }
    /* Collapse the Updated column itself so table-layout: fixed reclaims
     * the 120px and we don't trigger horizontal scroll on phones. The
     * cells' content is already display:none above. */
    .col-updated { width: 0; }
  }

  /* ---------- Touch-friendly tap targets ---------- */
  @media (pointer: coarse) {
    .tbl__sort-btn { min-height: 44px; }
  }
</style>
