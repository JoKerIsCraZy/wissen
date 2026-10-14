<script lang="ts">
  /* Compact "Nächste Lektion" panel for the dashboard side-rail.
   *
   * No floor-plan here (the dominant Aktuell hero on the left already shows
   * a plan). This panel is information-dense: label, time, lesson, room
   * chip, optional dozent. One-glance read.
   */
  import type { StundenplanRow } from '#lib/api/types.js';

  interface Props {
    nextEventToday: StundenplanRow | null;
    nextEvent: StundenplanRow | null;
    startsInCopy: string;
    fmtDateShort: (d: Date) => string;
    combineDateTime: (datumIso: string, hhmm: string) => Date;
    isOnline: (raum: string | null | undefined) => boolean;
  }

  let {
    nextEventToday,
    nextEvent,
    startsInCopy,
    fmtDateShort,
    combineDateTime,
    isOnline,
  }: Props = $props();
</script>

<section
  class="next-panel"
  class:next-panel--idle={!nextEventToday}
  aria-labelledby="next-panel-label"
>
  <header class="next-panel__head">
    <span id="next-panel-label" class="next-panel__label">Nächste Lektion</span>
    {#if nextEventToday}
      <span class="next-panel__hint mono">{startsInCopy}</span>
    {/if}
  </header>

  {#if nextEventToday}
    <div class="next-panel__time mono">
      {nextEventToday.zeit_von}–{nextEventToday.zeit_bis}
    </div>
    <div class="next-panel__title">
      {nextEventToday.veranstaltung || '—'}
    </div>
    <div class="next-panel__meta">
      <span
        class="next-panel__room mono"
        class:next-panel__room--online={isOnline(nextEventToday.raum)}
      >
        {nextEventToday.raum || '—'}
      </span>
      {#if nextEventToday.dozent}
        <span class="next-panel__dozent">{nextEventToday.dozent}</span>
      {/if}
      {#if nextEventToday.klasse}
        <span class="next-panel__klasse mono">{nextEventToday.klasse}</span>
      {/if}
    </div>
  {:else}
    <div class="next-panel__title next-panel__title--idle">
      Heute keine weitere Lektion
    </div>
    {#if nextEvent}
      <div class="next-panel__meta">
        <span class="next-panel__hint">
          {fmtDateShort(combineDateTime(nextEvent.datum_iso, nextEvent.zeit_von))}
          um <span class="mono">{nextEvent.zeit_von}</span>
        </span>
      </div>
    {/if}
  {/if}
</section>

<style>
  .mono {
    font-family: var(--font-mono);
    font-feature-settings: 'tnum' 1, 'zero' 1;
  }

  .next-panel {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 14px 0 16px;
    border-bottom: 1px solid var(--border-soft);
  }
  .next-panel:first-child {
    padding-top: 0;
  }

  .next-panel__head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 2px;
  }
  .next-panel__label {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.10em;
    text-transform: uppercase;
    color: var(--text-dim);
  }
  .next-panel__hint {
    font-size: 11px;
    color: var(--accent);
    letter-spacing: 0.02em;
  }

  .next-panel__time {
    font-size: 24px;
    font-weight: 600;
    color: var(--accent);
    letter-spacing: -0.01em;
    line-height: 1.05;
  }
  .next-panel__title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text);
    line-height: 1.35;
  }
  .next-panel__title--idle {
    color: var(--text-mute);
    font-weight: 500;
  }

  .next-panel__meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin-top: 4px;
    font-size: 12px;
    color: var(--text-mute);
  }
  .next-panel__room {
    padding: 2px 8px;
    background: var(--surface-2);
    border: 1px solid var(--border-soft);
    border-radius: var(--r-sm);
    color: var(--text);
    font-size: 11px;
    letter-spacing: 0.04em;
  }
  .next-panel__room--online {
    background: transparent;
    border-color: var(--accent-border);
    color: var(--accent);
    font-style: italic;
  }
  .next-panel__dozent {
    color: var(--text-mute);
  }
  .next-panel__klasse {
    color: var(--text-dim);
    font-size: 11px;
    letter-spacing: 0.04em;
  }
</style>
