<script lang="ts">
  /* "Aktuell"-Hero-Card on the desktop dashboard — shows the in-session
   * lesson (currentEvent). Idle state when no lesson is running right now.
   *
   * The next-today event lives in its own NextCard next to this one, so
   * NowCard intentionally does NOT fall back to it. That way the two cards
   * stay semantically distinct: Aktuell = jetzt, Nächste = gleich.
   */
  import FloorPlan from '#lib/floorplans/FloorPlan.svelte';
  import type { StundenplanRow } from '#lib/api/types.js';

  interface Props {
    currentEvent: StundenplanRow | null;
    /* Used purely to pick the right idle copy (don't render here). */
    hasNextToday: boolean;
    nextEvent: StundenplanRow | null;
    remainingCopy: string;
    dayDone: boolean;
    fmtDateShort: (d: Date) => string;
    combineDateTime: (datumIso: string, hhmm: string) => Date;
    isOnline: (raum: string | null | undefined) => boolean;
  }

  let {
    currentEvent,
    hasNextToday,
    nextEvent,
    remainingCopy,
    dayDone,
    fmtDateShort,
    combineDateTime,
    isOnline,
  }: Props = $props();

  /* Idle title varies with context:
   *  - lesson coming today (NextCard fills the gap): "Pause"
   *  - day's events all past:                         "Tagesende erreicht"
   *  - nothing today at all:                          "Heute keine Lektionen"
   */
  const idleTitle = $derived(
    hasNextToday ? 'Pause' : dayDone ? 'Tagesende erreicht' : 'Heute keine Lektionen',
  );
</script>

<article
  class="now-card"
  class:now-card--active={!!currentEvent}
  class:now-card--idle={!currentEvent}
  aria-label={currentEvent ? 'Aktuelle Lektion' : 'Keine aktuelle Lektion'}
>
  <div class="now-card__label">Aktuell</div>

  {#if currentEvent}
    <div class="now-card__time mono">
      <span>{currentEvent.zeit_von} - {currentEvent.zeit_bis}</span>
      <span class="now-card__remain">{remainingCopy}</span>
    </div>
    <div class="now-card__title">
      {currentEvent.veranstaltung || '—'}
    </div>
    <div class="now-card__meta">
      <span class="now-card__meta-item">
        <svg class="now-card__meta-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z" />
          <circle cx="12" cy="10" r="3" />
        </svg>
        <span class="mono">{currentEvent.raum || '—'}</span>
      </span>
      {#if currentEvent.dozent}
        <span class="now-card__meta-item">
          <svg class="now-card__meta-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
          </svg>
          <span>{currentEvent.dozent}</span>
        </span>
      {/if}
      {#if currentEvent.klasse}
        <span class="now-card__meta-item now-card__meta-item--dim mono">
          {currentEvent.klasse}
        </span>
      {/if}
    </div>
    {#if !isOnline(currentEvent.raum)}
      <div class="now-card__floor">
        <FloorPlan raum={currentEvent.raum} mode="inline" showLabel={false} />
      </div>
    {/if}
  {:else}
    <div class="now-card__time mono">
      <span>—</span>
    </div>
    <div class="now-card__title">{idleTitle}</div>
    <div class="now-card__meta">
      {#if !hasNextToday && nextEvent}
        <span class="now-card__meta-item now-card__meta-item--dim">
          Nächste Lektion: {fmtDateShort(combineDateTime(nextEvent.datum_iso, nextEvent.zeit_von))} um <span class="mono">{nextEvent.zeit_von}</span>
        </span>
      {:else if !hasNextToday && !dayDone}
        <span class="now-card__meta-item now-card__meta-item--dim">
          Schönes Wochenende.
        </span>
      {/if}
    </div>
  {/if}
</article>

<style>
  .mono {
    font-family: var(--font-mono);
    font-feature-settings: 'tnum' 1, 'zero' 1;
  }

  /* Aktuell hero card. Same compact dimensions as the sibling LessonCards
   * (they sit in a 3-up row). Active state is signalled by an accent
   * border + a tonal accent-soft background tint — no top-stripe accent,
   * impeccable bans the side-stripe family. */
  .now-card {
    position: relative;
    background: var(--surface);
    border: 1px solid var(--border-soft);
    border-radius: var(--r-lg);
    padding: 16px 18px;
    box-shadow: var(--shadow-sm);
    transition: border-color var(--t) var(--ease), background-color var(--t) var(--ease);
    height: 100%;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .now-card--active {
    border-color: var(--accent);
    background: var(--accent-soft);
  }

  .now-card__label {
    font-size: 11px;
    letter-spacing: 0.10em;
    text-transform: uppercase;
    color: var(--text-dim);
    font-weight: 600;
    margin-bottom: 10px;
  }

  .now-card__time {
    font-size: 22px;
    font-weight: 600;
    color: var(--accent);
    letter-spacing: -0.01em;
    margin-bottom: 6px;
    display: flex;
    align-items: baseline;
    gap: 12px;
    flex-wrap: wrap;
  }
  .now-card__remain {
    font-family: var(--font-sans);
    font-size: 12px;
    font-weight: 500;
    color: var(--text-dim);
    letter-spacing: 0.02em;
  }

  .now-card__title {
    font-size: 15px;
    font-weight: 600;
    letter-spacing: -0.005em;
    margin-bottom: 8px;
    color: var(--text);
    line-height: 1.3;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  .now-card__meta {
    display: flex;
    gap: 18px;
    flex-wrap: wrap;
    font-size: 13px;
    color: var(--text-mute);
  }
  .now-card__meta-item {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .now-card__meta-icon {
    color: var(--text-dim);
    flex: none;
  }
  .now-card__meta-item--dim {
    color: var(--text-dim);
    font-size: 11px;
    letter-spacing: 0.04em;
  }

  /* Embedded Floor-Plan inside the Now-card. Grows to fill leftover card
   * height (flex:1) but caps at the FloorPlan's natural width-driven
   * aspect — the inner stage uses width:100%; aspect-ratio so it sizes
   * to the column width, and we centre it vertically when there's slack. */
  .now-card__floor {
    margin-top: 14px;
    border-radius: var(--r-md);
    flex: 1 1 0;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }
  .now-card__floor :global(.floorplan) {
    width: 100%;
  }

  .now-card--idle .now-card__time {
    color: var(--text-mute);
    font-size: 18px;
  }
  .now-card--idle .now-card__title {
    color: var(--text-mute);
    font-weight: 500;
  }

  /* ---------- Responsive ---------- */
  @media (max-width: 640px) {
    .now-card {
      padding: 16px;
    }
    .now-card__time {
      font-size: 18px;
    }
    .now-card__title {
      font-size: 16px;
    }
  }

  /* ---------- Reduced motion ---------- */
  @media (prefers-reduced-motion: reduce) {
    .now-card { transition: none; }
  }
</style>
