<script lang="ts">
  /* "Nächste Lektion" tile on the home route.
   *
   * Click expands the tile inline to show full details + floor-plan, instead
   * of navigating away. The user wanted to glance at the next room without
   * losing their place on the Now page.
   *
   * Only rendered while in-session (currentEvent exists) — when there is no
   * current event, the next-today event already IS the cardEvent above, so a
   * tile would just duplicate it.
   */
  import type { StundenplanRow } from '#lib/api/types.js';
  import FloorPlan from '#lib/floorplans/FloorPlan.svelte';
  import { FLOOR_LABELS, normalizeRoom, roomToFloor } from '#lib/floorplans/helpers.js';

  interface Props {
    nextTile: StundenplanRow | null;
    isOnline: (raum: string | null | undefined) => boolean;
  }

  let { nextTile, isOnline }: Props = $props();

  let open = $state(false);

  /* Stable id so aria-controls hooks the exact panel for screen readers. */
  const panelId = $derived(
    nextTile ? `next-tile-panel-${nextTile.id}` : 'next-tile-panel',
  );

  /* Floor caption (e.g. "4. OG · 4.03") rendered ABOVE the plan instead of
   * underneath it — user prefers the geographic anchor before the visual. */
  const floorKey = $derived(nextTile ? roomToFloor(nextTile.raum) : null);
  const roomNorm = $derived(nextTile ? normalizeRoom(nextTile.raum) : '');
  const floorLabel = $derived(floorKey ? FLOOR_LABELS[floorKey] : '');

  function toggle(): void {
    open = !open;
  }
</script>

{#if nextTile}
  <div class="tile-shell" class:tile-shell--open={open}>
    <button
      type="button"
      class="tile tile--btn"
      onclick={toggle}
      aria-expanded={open}
      aria-controls={panelId}
      aria-label={`Nächste Lektion: ${nextTile.zeit_von} bis ${nextTile.zeit_bis} ${nextTile.veranstaltung ?? ''}`}
    >
      <div class="tile__header">
        <div class="tile__label">Nächste Lektion</div>
        <span class="tile__chev" aria-hidden="true">{open ? '▾' : '▸'}</span>
      </div>
      <div class="tile__row">
        <span class="tile__value mono">
          {nextTile.zeit_von}–{nextTile.zeit_bis}
        </span>
        {#if nextTile.raum}
          <span class="tile__sub mono" class:tile__sub--online={isOnline(nextTile.raum)}>
            {nextTile.raum}
          </span>
        {/if}
      </div>
      {#if nextTile.veranstaltung}
        <div class="tile__name">{nextTile.veranstaltung}</div>
      {/if}
    </button>

    {#if open}
      <div id={panelId} class="tile__panel">
        <dl class="tile__dl">
          {#if nextTile.raum}
            <dt>Raum</dt>
            <dd class="mono">{nextTile.raum}</dd>
          {/if}
          <dt>Zeit</dt>
          <dd class="mono">{nextTile.zeit_von}–{nextTile.zeit_bis}</dd>
          {#if nextTile.dozent}
            <dt>Dozent</dt>
            <dd>{nextTile.dozent}</dd>
          {/if}
          {#if nextTile.klasse}
            <dt>Klasse</dt>
            <dd>{nextTile.klasse}</dd>
          {/if}
        </dl>
        {#if nextTile.raum && !isOnline(nextTile.raum) && floorKey}
          <div class="tile__floor">
            <div class="tile__floor-caption">
              <span class="tile__floor-tag">{floorLabel}</span>
              <span class="tile__floor-room mono">{roomNorm}</span>
            </div>
            <FloorPlan raum={nextTile.raum} mode="inline" showLabel={false} />
          </div>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .mono {
    font-family: var(--font-mono);
    font-feature-settings: 'tnum' 1, 'zero' 1;
  }

  .tile-shell {
    width: 100%;
    background: var(--surface);
    border: 1px solid var(--border-soft);
    border-radius: var(--r-md);
    box-shadow: var(--shadow-sm);
    transition: border-color var(--t-fast) var(--ease);
    flex: 1 1 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .tile-shell--open {
    border-color: var(--border);
  }

  .tile {
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 100%;
    text-align: left;
    background: transparent;
    border: 0;
    padding: 18px 18px;
    transition: background var(--t-fast) var(--ease);
    color: inherit;
    font: inherit;
    cursor: pointer;
    justify-content: center;
    flex: 1 1 0;
    min-height: 0;
  }

  @media (hover: hover) and (pointer: fine) {
    .tile--btn:hover { background: var(--surface-2); }
  }
  .tile--btn:active { transform: scale(0.99); }
  .tile--btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .tile__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .tile__chev {
    color: var(--text-dim);
    font-size: 11px;
    transition: transform var(--t-fast) var(--ease);
  }
  .tile-shell--open .tile__chev { transform: rotate(0deg); }

  .tile__label {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.10em;
    text-transform: uppercase;
    color: var(--text-mute);
  }

  .tile__row {
    display: flex;
    align-items: baseline;
    gap: 12px;
  }

  .tile__value {
    font-size: 22px;
    font-weight: 600;
    color: var(--text);
    letter-spacing: -0.01em;
  }

  .tile__sub {
    font-size: 12px;
    color: var(--text-mute);
    padding: 2px 8px;
    background: var(--surface-2);
    border: 1px solid var(--border-soft);
    border-radius: var(--r-sm);
  }
  .tile__sub--online {
    background: transparent;
    border-color: var(--accent-border);
    color: var(--accent);
  }

  .tile__name {
    font-size: 13px;
    color: var(--text-mute);
    line-height: 1.35;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  /* ---------- Expanded panel ---------- */

  .tile__panel {
    border-top: 1px solid var(--border-soft);
    padding: 14px 18px 16px;
    display: grid;
    grid-template-columns: 1fr;
    gap: 12px;
    animation: panelIn 200ms var(--ease);
  }
  @media (min-width: 720px) {
    .tile__panel {
      grid-template-columns: minmax(180px, 1fr) minmax(200px, 1.4fr);
      gap: 16px;
      align-items: start;
    }
  }
  @keyframes panelIn {
    from { opacity: 0; transform: translateY(-4px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @media (prefers-reduced-motion: reduce) {
    .tile__panel { animation: none; }
    .tile--btn:active { transform: none; }
    .tile__chev { transition: none; }
  }

  .tile__dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 6px 14px;
    margin: 0;
    font-size: 13px;
  }
  .tile__dl dt {
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: 10.5px;
    align-self: center;
  }
  .tile__dl dd {
    margin: 0;
    color: var(--text);
  }

  .tile__floor {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .tile__floor-caption {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    align-self: flex-start;
    padding: 4px 10px;
    background: var(--surface-2);
    border: 1px solid var(--border-soft);
    border-radius: 999px;
    font-size: 11px;
  }
  .tile__floor-tag {
    color: var(--accent);
    font-weight: 600;
    letter-spacing: 0.04em;
  }
  .tile__floor-room {
    color: var(--text);
    font-weight: 600;
  }
  .tile__floor :global(.floorplan) {
    margin: 0;
  }
</style>
