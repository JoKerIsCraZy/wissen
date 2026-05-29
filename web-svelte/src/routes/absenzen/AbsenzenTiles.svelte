<script lang="ts">
  /* Drei kompakte Stat-Kacheln oben auf /absenzen:
   *   1. Ø-Anwesenheit
   *   2. Module unter Minimum
   *   3. Abwesenheiten gesamt
   * Rein präsentational — bekommt die (server-)Stats + Modul-Liste als Props.
   */
  import type { AbsenzenStats } from '$lib/api/types';
  import { attendanceClass, fmtPct, type IndexedAbsenzRow } from './helpers';

  type QuickFilter = { key: string; label: string; count: number; apply: () => void };

  interface Props {
    modules: IndexedAbsenzRow[] | null;
    stats: AbsenzenStats | null;
    quickFilters: QuickFilter[];
  }

  let { modules, stats, quickFilters }: Props = $props();

  // Ø-Minimum über alle Module mit Wert — Referenz fürs Band der Ø-Kachel.
  const avgMin = $derived.by<number | null>(() => {
    if (!modules) return null;
    const vals = modules
      .map((m) => m.minimal_pct)
      .filter((v): v is number => v != null && Number.isFinite(Number(v)));
    if (!vals.length) return null;
    return vals.reduce((s, v) => s + Number(v), 0) / vals.length;
  });

  const avgPct = $derived(stats?.avgAnwesenheit ?? null);
  const unterMin = $derived(stats?.unterMinimum ?? 0);
  const abwesend = $derived(stats?.abwesendGesamt ?? 0);
</script>

<div class="tiles">
  <!-- Kachel 1: Ø-Anwesenheit -->
  <div class="tile" aria-label="Durchschnittliche Anwesenheit">
    <div class="tile__label">Ø-Anwesenheit</div>
    <div class="tile__row">
      <span class="tile__value mono {attendanceClass(avgPct, avgMin)}">
        {avgPct != null ? fmtPct(avgPct) : '—'}
      </span>
      <span class="tile__sub mono">
        {#if modules}
          über {modules.length} Module
        {:else}
          —
        {/if}
      </span>
    </div>
    {#if avgMin != null}
      <div class="tile__name">Ø-Minimum {fmtPct(avgMin)}</div>
    {/if}
  </div>

  <!-- Kachel 2: Module unter Minimum -->
  <div class="tile" aria-label="Module unter Minimum">
    <div class="tile__label">Unter Minimum</div>
    <div class="tile__row">
      <span class="tile__value mono" class:is-warn={unterMin > 0} class:is-good={unterMin === 0}>
        {unterMin}
      </span>
      <span class="tile__sub mono">
        {unterMin === 1 ? 'Modul' : 'Module'}
      </span>
    </div>
    <div class="tile__name">
      {#if unterMin === 0}
        alle über der Anforderung
      {:else}
        Anwesenheit unter Soll
      {/if}
    </div>
  </div>

  <!-- Kachel 3: Abwesenheiten gesamt ODER Quick-View, wenn vorhanden -->
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
    <div class="tile" aria-label="Abwesenheiten gesamt">
      <div class="tile__label">Abwesenheiten</div>
      <div class="tile__row">
        <span class="tile__value mono" class:is-warn={abwesend > 0} class:is-good={abwesend === 0}>
          {abwesend % 1 === 0 ? abwesend : abwesend.toFixed(2)}
        </span>
        <span class="tile__sub mono">Lektionen gesamt</span>
      </div>
      <div class="tile__name">
        {abwesend === 0 ? 'lückenlose Anwesenheit' : 'Soll minus besucht'}
      </div>
    </div>
  {/if}
</div>

<style>
  .mono {
    font-family: var(--font-mono);
    font-feature-settings: 'tnum' 1, 'zero' 1;
  }

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
  .tile__value {
    font-size: 22px;
    font-weight: 600;
    letter-spacing: -0.01em;
    line-height: 1.1;
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
    color: var(--text);
  }
  .tile__sub {
    font-size: 12px;
    color: var(--text-dim);
  }
  .tile__name {
    font-size: 13px;
    color: var(--text-mute);
    margin-top: 4px;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tile--quick { padding-bottom: 12px; }
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
    color: var(--warning);
  }
  .quick-link__label { font-size: 13px; color: var(--text); }
  .quick-link__chev { color: var(--text-dim); font-size: 14px; }

  /* ---------- Anwesenheits-Band-Tokens ---------- */
  .a-good { color: var(--g-excellent); }
  .a-ok   { color: var(--g-good); }
  .a-fail { color: var(--g-fail); }
  .a-none { color: var(--text-dim); }

  /* Semantische Ton-Helfer für Zahl-Kacheln (Risiko vs. alles gut). */
  .is-warn { color: var(--warning); }
  .is-good { color: var(--g-excellent); }

  @media (pointer: coarse) {
    .quick-link { min-height: 44px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .quick-link { transition: none; }
  }
</style>
