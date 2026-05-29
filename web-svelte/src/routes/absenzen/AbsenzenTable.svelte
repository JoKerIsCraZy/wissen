<script lang="ts">
  /* Sortierbare Modul-Tabelle für /absenzen mit Inline-Expansion (Tagesliste).
   * Rein präsentational — Sort + Open + Load werden als Callbacks übergeben,
   * der Parent hält die Source of Truth. Klick auf eine Zeile klappt die
   * Tagesliste inline auf (slide + prefers-reduced-motion-Gate, KEIN Modal),
   * mit Termin / Ist / Soll / % / Status-Pill pro Lektion.
   */
  import { onMount } from 'svelte';
  import { slide } from 'svelte/transition';
  import { expoOut, cubicOut } from 'svelte/easing';

  import type { AbsenzLektionRow } from '$lib/api/types';
  import {
    statusLabel,
    attendanceClass,
    fmtPct,
    fmtLektionen,
    fmtRelative,
    rowKey,
    type IndexedAbsenzRow,
    type SortKey,
  } from './helpers';

  interface Props {
    loading: boolean;
    modules: IndexedAbsenzRow[] | null;
    sorted: IndexedAbsenzRow[];
    sortBy: SortKey;
    sortDir: 'asc' | 'desc';
    openId: string | null;
    /** Zeile, deren Tagesliste gerade vor-lädt (zwischen Klick und Mount). */
    pendingOpenId: string | null;
    lektionenCache: Map<string, AbsenzLektionRow[]>;
    lektionenLoading: Set<string>;
    lektionenError: Map<string, string>;
    setSort: (key: SortKey) => void;
    toggleRow: (r: IndexedAbsenzRow) => Promise<void> | void;
    loadLektionenFor: (code: string) => Promise<void> | void;
  }

  let {
    loading,
    modules,
    sorted,
    sortBy,
    sortDir,
    openId,
    pendingOpenId,
    lektionenCache,
    lektionenLoading,
    lektionenError,
    setSort,
    toggleRow,
    loadLektionenFor,
  }: Props = $props();

  /* prefers-reduced-motion fürs Row-Reveal — Svelte-Transitions deaktivieren
   * sich nicht automatisch, also kollabieren wir die Dauer auf 0. Reaktiv via
   * matchMedia-Change-Listener, falls das OS die Einstellung mitten in der
   * Session umschaltet. */
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

  function onRowKey(e: KeyboardEvent, r: IndexedAbsenzRow): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      void toggleRow(r);
    } else if (e.key === 'Escape' && openId === rowKey(r)) {
      e.preventDefault();
      void toggleRow(r);
    }
  }

  function typBadge(typ: string | null): string {
    if (!typ) return '';
    return /berbetrieb|ÜK|UEK|ÜK/i.test(typ) ? 'ÜK' : 'Modul';
  }
</script>

<div class="tbl-wrap">
  <table class="tbl">
    <colgroup>
      <col style="width: 96px" />
      <col />
      <col style="width: 70px" />
      <col class="col-anw" style="width: 110px" />
      <col style="width: 150px" />
      <col class="col-updated" style="width: 120px" />
    </colgroup>
    <thead>
      <tr>
        <th scope="col" class={sortClass('code')} aria-sort={sortAria('code')}>
          <button type="button" class="tbl__sort-btn" onclick={() => setSort('code')}>
            Code <span class="sort-arrow" aria-hidden="true"></span>
          </button>
        </th>
        <th scope="col" class={sortClass('name')} aria-sort={sortAria('name')}>
          <button type="button" class="tbl__sort-btn" onclick={() => setSort('name')}>
            Modul <span class="sort-arrow" aria-hidden="true"></span>
          </button>
        </th>
        <th scope="col" class={sortClass('typ')} aria-sort={sortAria('typ')}>
          <button type="button" class="tbl__sort-btn" onclick={() => setSort('typ')}>
            Typ <span class="sort-arrow" aria-hidden="true"></span>
          </button>
        </th>
        <th scope="col" class="tbl__right {sortClass('anwesenheit')}" aria-sort={sortAria('anwesenheit')}>
          <button type="button" class="tbl__sort-btn tbl__sort-btn--right" onclick={() => setSort('anwesenheit')}>
            Anwesend <span class="sort-arrow" aria-hidden="true"></span>
          </button>
        </th>
        <th scope="col" class="tbl__right {sortClass('soll')}" aria-sort={sortAria('soll')}>
          <button type="button" class="tbl__sort-btn tbl__sort-btn--right" onclick={() => setSort('soll')}>
            Ist/Soll <span class="sort-arrow" aria-hidden="true"></span>
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
          {@const anwCls = attendanceClass(r.anwesenheit_pct, r.minimal_pct)}
          <tr
            class="tbl__row"
            class:is-fresh={r.isFresh === 1}
            class:is-expanded={isOpen}
            class:is-pending={pendingOpenId === id}
            class:is-unter-min={r._unterMin}
            tabindex="0"
            role="button"
            aria-expanded={isOpen}
            aria-controls={isOpen ? `lekt-${id}` : undefined}
            aria-label={`Tagesliste ${isOpen ? 'schliessen' : 'oeffnen'}: ${r._name}`}
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
              {#if r.typ}
                <span class="typ-badge mono">{typBadge(r.typ)}</span>
              {:else}
                <span class="text-dim">—</span>
              {/if}
            </td>
            <td class="tbl__right">
              <span class="anw-cell mono {anwCls}">{fmtPct(r.anwesenheit_pct)}</span>
              {#if r.minimal_pct != null}
                <span class="anw-min mono">min {fmtPct(r.minimal_pct)}</span>
              {/if}
            </td>
            <td class="tbl__right">
              <span class="soll-cell mono">
                {fmtLektionen(r.besucht)}<span class="soll-sep">/</span>{fmtLektionen(r.soll)}
              </span>
            </td>
            <td class="tbl__right">
              <span class="updated-cell mono">{fmtRelative(r.fetched_at)}</span>
            </td>
          </tr>
          {#if isOpen}
            <tr class="tbl__detail-row" id={`lekt-${id}`}>
              <td colspan="6" class="tbl__detail-cell">
                <div
                  class="lekt"
                  role="region"
                  aria-live="polite"
                  aria-label={`Tagesliste für ${r._name}`}
                  in:slide={{ duration: slideDuration, easing: expoOut }}
                  out:slide={{ duration: slideOutDuration, easing: cubicOut }}
                >
                  <div class="lekt__title">Tagesliste</div>
                  {#if lektionenLoading.has(id)}
                    <div class="lekt__hint mono">Lade Tagesliste…</div>
                  {:else if lektionenError.has(id)}
                    <div class="lekt__error">
                      {lektionenError.get(id)}
                      <button
                        type="button"
                        class="lekt__retry"
                        onclick={(e) => {
                          e.stopPropagation();
                          void loadLektionenFor(id);
                        }}
                      >
                        Erneut
                      </button>
                    </div>
                  {:else if (lektionenCache.get(id) ?? []).length === 0}
                    <div class="lekt__hint">Keine Lektionen erfasst.</div>
                  {:else}
                    <div class="lekt-list">
                      {#each lektionenCache.get(id) ?? [] as l (l.id)}
                        {@const st = statusLabel(l.status)}
                        {@const lAnw = attendanceClass(l.anwesenheit_pct, r.minimal_pct)}
                        <div class="lekt-row">
                          <span class="lekt-row__termin">
                            {l.termin_raw || l.termin_iso || '—'}
                          </span>
                          <span class="lekt-row__lekt mono">
                            {fmtLektionen(l.lektionen_ist)}<span class="soll-sep">/</span>{fmtLektionen(l.lektionen_soll)}
                          </span>
                          <span class="lekt-row__pct mono {lAnw}">{fmtPct(l.anwesenheit_pct)}</span>
                          <span class="status-pill status-pill--{st.tone}">
                            <span class="status-pill__dot" aria-hidden="true"></span>
                            {st.text}
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
  .tbl-wrap { overflow-x: auto; }
  .tbl {
    width: 100%;
    border-collapse: collapse;
    font-size: 13.5px;
    table-layout: fixed;
  }
  .tbl thead th {
    text-align: left;
    padding: 0;
    border-bottom: 1px solid var(--border-soft);
    background: var(--surface-header);
  }
  .tbl thead th.tbl__right { text-align: right; }

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
  .tbl__sort-btn--right { justify-content: flex-end; }
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
  .tbl thead th.is-asc .sort-arrow::after { content: '↑'; color: var(--accent); }
  .tbl thead th.is-desc .sort-arrow::after { content: '↓'; color: var(--accent); }

  .tbl tbody tr.tbl__row {
    border-bottom: 1px solid var(--border-soft);
    cursor: pointer;
    transition: background var(--t-fast) var(--ease);
  }
  .tbl tbody tr.tbl__row.is-fresh { background: var(--warning-soft); }
  @media (hover: hover) and (pointer: fine) {
    .tbl tbody tr.tbl__row:hover { background: var(--surface-2); }
    .tbl tbody tr.tbl__row.is-fresh:hover { background: var(--warning-soft-strong); }
  }
  .tbl tbody tr.tbl__row.is-expanded { background: var(--surface-2); }

  /* Deep-link flash: zwei Pulse auf der fokussierten Zeile + ihrer Detail-
   * Zeile. `:global`, weil .is-flash zur Laufzeit per JS gesetzt wird.
   * Animiert background-color direkt auf dem TR (keine ::before-Overlays —
   * Table-Row-Pseudo-Elemente rendern browserübergreifend inkonsistent und
   * verschieben echte <td>s). */
  .tbl tbody tr.tbl__row:global(.is-flash),
  .tbl tbody tr.tbl__row:global(.is-flash) + tr.tbl__detail-row {
    animation: absenz-row-flash 2400ms ease-out;
  }
  @keyframes absenz-row-flash {
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
  /* Module unter Minimum: dezenter linker Danger-Akzent — Risiko zeigt sich
   * auch ohne die Anwesenheits-Zelle zu lesen. Form + Farbe (a11y). */
  .tbl tbody tr.tbl__row.is-unter-min td:first-child {
    box-shadow: inset 2px 0 0 var(--danger);
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
  .tbl__cell-number { width: 96px; white-space: nowrap; }

  .fach-name {
    font-weight: 500;
    color: var(--text);
    line-height: 1.3;
  }
  .fach-code {
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
    letter-spacing: 0.02em;
  }
  .text-dim { color: var(--text-dim); }

  .typ-badge {
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

  .anw-cell {
    font-weight: 600;
    font-size: 16px;
    letter-spacing: -0.01em;
  }
  .anw-min {
    display: block;
    font-size: 10px;
    color: var(--text-dim);
    margin-top: 1px;
  }
  .soll-cell {
    font-size: 13px;
    color: var(--text-mute);
    font-weight: 500;
  }
  .soll-sep { color: var(--text-dim); margin: 0 1px; }
  .updated-cell {
    font-size: 12px;
    color: var(--text-mute);
  }

  /* ---------- Status pills (Wort + Punkt + Farbe — a11y) ---------- */
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
    white-space: nowrap;
  }
  .status-pill__dot {
    width: 6px;
    height: 6px;
    border-radius: 999px;
    background: var(--text-dim);
  }
  /* teilgenommen → has (gut/grün) */
  .status-pill--has {
    color: var(--g-excellent);
    background: var(--g-excellent-soft);
    border-color: var(--g-excellent);
  }
  .status-pill--has .status-pill__dot { background: var(--g-excellent); }
  /* offen → neutral (gedämpft, hohler Ring) */
  .status-pill--neutral {
    color: var(--text-dim);
    background: var(--surface-2);
    border-color: var(--border-soft);
  }
  .status-pill--neutral .status-pill__dot {
    background: transparent;
    border: 1px solid var(--text-dim);
    box-sizing: border-box;
  }
  /* abwesend_entschuldigt → warning (orange) */
  .status-pill--warning {
    color: var(--warning);
    background: var(--warning-soft-strong);
    border-color: var(--warning-border);
  }
  .status-pill--warning .status-pill__dot { background: var(--warning); }
  /* abwesend_unentschuldigt → danger (rot) */
  .status-pill--danger {
    color: var(--danger);
    background: var(--danger-soft-strong);
    border-color: var(--danger-border);
  }
  .status-pill--danger .status-pill__dot { background: var(--danger); }

  /* ---------- Inline expansion (Tagesliste) ---------- */
  .tbl__detail-row { background: var(--bg-elev); }
  .tbl__detail-cell {
    padding: 0;
    border: 0;
  }
  .lekt {
    padding: 14px 16px 18px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .lekt__title {
    font-size: 11px;
    letter-spacing: 0.10em;
    text-transform: uppercase;
    color: var(--text-dim);
    font-weight: 600;
  }
  .lekt__hint { color: var(--text-dim); font-size: 12px; }
  .lekt__error {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    color: var(--danger);
    font-size: 12px;
  }
  .lekt__retry {
    padding: 4px 10px;
    border-radius: var(--r-sm);
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text);
    font-size: 12px;
  }
  .lekt-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .lekt-row {
    display: grid;
    grid-template-columns: 1fr auto 64px 140px;
    gap: 14px;
    align-items: center;
    padding: 8px 12px;
    background: var(--surface);
    border: 1px solid var(--border-soft);
    border-radius: var(--r-md);
  }
  .tbl tbody tr.tbl__row.is-pending { background: var(--surface-2); }
  .lekt-row__termin {
    font-size: 13px;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .lekt-row__lekt {
    font-size: 12px;
    color: var(--text-mute);
    text-align: right;
  }
  .lekt-row__pct {
    font-size: 13px;
    font-weight: 700;
    text-align: right;
  }

  /* ---------- Anwesenheits-Band-Tokens ---------- */
  .a-good { color: var(--g-excellent); }
  .a-ok   { color: var(--g-good); }
  .a-fail { color: var(--g-fail); }
  .a-none { color: var(--text-dim); }

  /* ---------- Reduced motion ---------- */
  @media (prefers-reduced-motion: reduce) {
    .tbl__row { transition: none; }
  }

  /* ---------- Compact/mobile ---------- */
  @media (max-width: 640px) {
    .lekt-row {
      grid-template-columns: 1fr auto;
      gap: 6px 12px;
    }
    .lekt-row__pct { grid-column: 2; text-align: right; }
    .status-pill { justify-self: start; }
  }
  @media (max-width: 600px) {
    .tbl thead th,
    .tbl td { padding: 10px 12px; }
    .tbl__cell-name { min-width: 0; }
    .updated-cell { display: none; }
    .col-updated { width: 0; }
    .anw-min { display: none; }
  }

  /* ---------- Touch-friendly tap targets ---------- */
  @media (pointer: coarse) {
    .tbl__sort-btn { min-height: 44px; }
  }
</style>
