<script lang="ts">
  /* Three compact tiles at the top of /noten:
   *   1. Schnitt insgesamt
   *   2. Letzte Änderung
   *   3. Quick-View (or all-clear status placeholder)
   * Pure presentational — receives derived data + apply handlers as props.
   */
  import { gradeClass, fmtGrade, fmtRelative, type IndexedRow } from './helpers';

  type QuickFilter = { key: string; label: string; count: number; apply: () => void };

  interface Props {
    modules: IndexedRow[] | null;
    overallAvg: { value: number | null; gradedCount: number };
    lastChanged: IndexedRow | null;
    quickFilters: QuickFilter[];
  }

  let { modules, overallAvg, lastChanged, quickFilters }: Props = $props();

  function isBkModule(row: IndexedRow): boolean {
    const code = row.kuerzel_code || '';
    if (!code || /-N\d+$/i.test(code)) return false;
    return /(?<!\d)\d{3}(?!\d)/.test(code);
  }

  const bkAvg = $derived.by<number | null>(() => {
    if (!modules) return null;
    const list = modules.filter((r) => isBkModule(r) && r.note != null);
    if (!list.length) return null;
    return list.reduce((s, r) => s + (r.note as number), 0) / list.length;
  });
</script>

<div class="tiles">
  <!-- Tile 1: Schnitt insgesamt -->
  <div class="tile" aria-label="Schnitt insgesamt">
    <div class="tile__label">Schnitt insgesamt</div>
    <div class="tile__row">
      <span class="tile__value mono {gradeClass(overallAvg.value)}">
        {overallAvg.value != null ? overallAvg.value.toFixed(2) : '—'}
      </span>
      <span class="tile__sub mono">
        {#if modules}
          von {modules.length} Modulen
        {:else}
          —
        {/if}
      </span>
    </div>
    {#if overallAvg.gradedCount > 0 && modules}
      <div class="tile__name">{overallAvg.gradedCount} benotet</div>
    {/if}
    {#if bkAvg != null}
      <div class="tile__bk">
        <span class="tile__bk-label">BK</span>
        <span class="tile__bk-value mono {gradeClass(bkAvg)}">{bkAvg.toFixed(2)}</span>
      </div>
    {/if}
  </div>

  <!-- Tile 2: Letzte Änderung -->
  <div class="tile" aria-label="Letzte Änderung">
    <div class="tile__label">Letzte Änderung</div>
    {#if lastChanged}
      {@const hasDiff = lastChanged.prev_note != null
        && lastChanged.note != null
        && lastChanged.prev_note !== lastChanged.note}
      <div class="tile__row">
        <span class="tile__value mono {gradeClass(lastChanged.note)}">
          {#if hasDiff}
            <!-- Vorgänger klein + halb-transparent, dann Pfeil, dann
                 aktueller Wert in voller Größe + Farbklasse. -->
            <span class="tile__value-prev mono {gradeClass(lastChanged.prev_note)}"
                  title="Vorheriger Wert">
              {lastChanged.prev_note != null ? lastChanged.prev_note.toFixed(2) : '—'}
            </span>
            <span class="tile__value-arrow" aria-hidden="true">→</span>
          {/if}{fmtGrade(lastChanged.note)}
        </span>
        <span class="tile__sub mono">{fmtRelative(lastChanged.fetched_at)}</span>
      </div>
      <!-- Modulnummer + Modulname konsistent zur Letzte-Änderung-Liste
           unten. _code ist das Trailing-Segment aus kuerzel_code (z.B. "319"). -->
      <div class="tile__name">
        {lastChanged._code ? lastChanged._code + ' - ' : ''}{lastChanged._name}
      </div>
    {:else}
      <div class="tile__row">
        <span class="tile__value mono g-none">—</span>
        <span class="tile__sub mono">noch keine</span>
      </div>
    {/if}
  </div>

  <!-- Tile 3: Schnelle Filter — only if notable -->
  {#if quickFilters.length > 0}
    <div class="tile tile--quick" aria-label="Schnelle Filter">
      <div class="tile__label">Quick-View</div>
      <div class="quick-list">
        {#each quickFilters as qf (qf.key)}
          <button type="button" class="quick-link" onclick={qf.apply}>
            <span class="quick-link__count mono">{qf.count}</span>
            <span class="quick-link__label">{qf.label}</span>
            <span class="quick-link__chev mono" aria-hidden="true">›</span>
          </button>
        {/each}
      </div>
    </div>
  {:else}
    <!-- All-clear placeholder — keeps grid alignment when nothing notable. -->
    <div class="tile tile--empty" aria-label="Status">
      <div class="tile__label">Status</div>
      <div class="tile__row">
        <span class="tile__value mono g-excellent" aria-hidden="true">●</span>
        <span class="tile__sub">alles aktuell</span>
      </div>
    </div>
  {/if}
</div>

<style>
  .mono {
    font-family: var(--font-mono);
    font-feature-settings: 'tnum' 1, 'zero' 1;
  }

  /* ---------- Tiles (no hero metric) ---------- */
  .tiles {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 12px;
  }
  @media (max-width: 720px) { .tiles { grid-template-columns: 1fr; } }

  .tile {
    background: var(--surface);
    border: 1px solid var(--border-soft);
    border-radius: var(--r-md);
    padding: 14px 16px;
    box-shadow: var(--shadow-sm);
  }
  .tile__label {
    font-size: 10px;
    letter-spacing: 0.10em;
    text-transform: uppercase;
    color: var(--text-dim);
    font-weight: 600;
    margin-bottom: 8px;
  }
  .tile__row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
  }
  /* 22px not 72px — explicit, compact, readable. */
  .tile__value {
    font-size: 22px;
    font-weight: 600;
    letter-spacing: -0.01em;
    line-height: 1.1;
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
  }
  /* Vorheriger Wert klein + halb-transparent für die "Letzte Änderung"-
   * Tile, wenn die Note sich tatsächlich geändert hat. Pfeil dezent dazwischen. */
  .tile__value-prev {
    font-size: 14px;
    font-weight: 500;
    opacity: 0.55;
  }
  .tile__value-arrow {
    font-size: 13px;
    color: var(--text-dim);
    font-weight: 500;
  }
  .tile__sub {
    font-size: 12px;
    color: var(--text-dim);
  }
  .tile__name {
    font-size: 13px;
    color: var(--text);
    margin-top: 4px;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tile__bk {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--border-soft);
  }
  .tile__bk-label {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.10em;
    text-transform: uppercase;
    color: var(--text-dim);
  }
  .tile__bk-value {
    font-size: 16px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }

  .tile--quick { padding-bottom: 12px; }
  .tile--empty .tile__value { font-size: 18px; }

  .quick-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: -2px;
  }
  .quick-link {
    display: grid;
    grid-template-columns: 32px 1fr 12px;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    margin: 0 -8px;
    border-radius: var(--r-sm);
    text-align: left;
    color: var(--text);
    transition: background var(--t-fast) var(--ease);
  }
  @media (hover: hover) and (pointer: fine) {
    .quick-link:hover { background: var(--surface-2); }
  }
  .quick-link__count {
    font-size: 14px;
    font-weight: 700;
    color: var(--accent);
  }
  .quick-link__label { font-size: 13px; color: var(--text); }
  .quick-link__chev { color: var(--text-dim); font-size: 14px; }

  /* ---------- Grade color tokens ---------- */
  .g-excellent { color: var(--g-excellent); }
  .g-good      { color: var(--g-good); }
  .g-ok        { color: var(--g-ok); }
  .g-fail      { color: var(--g-fail); }
  .g-none      { color: var(--text-dim); }

  /* ---------- Touch-friendly tap targets ----------
   * Quick-Links sit inside a tile and need to clear the 44px target-size
   * threshold on coarse pointers. Fine pointers stay compact at 30px. */
  @media (pointer: coarse) {
    .quick-link { min-height: 44px; }
  }

  /* ---------- Reduced motion ---------- */
  @media (prefers-reduced-motion: reduce) {
    .quick-link { transition: none; }
  }
</style>
