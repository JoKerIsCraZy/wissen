<script lang="ts">
  /* Generic lesson hero-card used in the dashboard's 3-up row.
   *
   * Renders any single lesson (or an empty/idle slot) with the standard
   * shape: label, time, title, room/dozent meta, floor-plan. Used for the
   * "Nächste Lektion" and "Danach" slots — the live "Aktuell" slot has
   * its own NowCard with the active-bar accent.
   */
  import FloorPlan from '#lib/floorplans/FloorPlan.svelte';
  import type { StundenplanRow } from '#lib/api/types.js';

  interface Props {
    lesson: StundenplanRow | null;
    label: string;
    hint?: string;
    emptyTitle?: string;
    /** Optional date pill ("Mo, 12.05.") rendered next to the time when the
     * lesson isn't today. Lets the same card-shape be reused for the
     * "next-three-across-the-week" fallback when today has no lessons. */
    dateLabel?: string;
    isOnline: (raum: string | null | undefined) => boolean;
  }

  let {
    lesson,
    label,
    hint = '',
    emptyTitle = 'Keine weitere Lektion',
    dateLabel = '',
    isOnline,
  }: Props = $props();
</script>

<article
  class="lesson-card"
  class:lesson-card--idle={!lesson}
  aria-label={lesson ? `${label}: ${lesson.veranstaltung ?? ''}` : `${label}: nichts`}
>
  <header class="lesson-card__head">
    <span class="lesson-card__label">{label}</span>
    {#if lesson && hint}
      <span class="lesson-card__hint mono">{hint}</span>
    {/if}
  </header>

  {#if lesson}
    <div class="lesson-card__time-row">
      <span class="lesson-card__time mono">
        {lesson.zeit_von}–{lesson.zeit_bis}
      </span>
      {#if dateLabel}
        <span class="lesson-card__date mono">{dateLabel}</span>
      {/if}
    </div>
    <div class="lesson-card__title">
      {lesson.veranstaltung || '—'}
    </div>
    <div class="lesson-card__meta">
      <span
        class="lesson-card__room mono"
        class:lesson-card__room--online={isOnline(lesson.raum)}
      >
        {lesson.raum || '—'}
      </span>
      {#if lesson.dozent}
        <span class="lesson-card__dozent">{lesson.dozent}</span>
      {/if}
      {#if lesson.klasse}
        <span class="lesson-card__klasse mono">{lesson.klasse}</span>
      {/if}
    </div>
    {#if !isOnline(lesson.raum)}
      <div class="lesson-card__floor">
        <FloorPlan raum={lesson.raum} mode="inline" showLabel={false} />
      </div>
    {/if}
  {:else}
    <div class="lesson-card__title lesson-card__title--idle">{emptyTitle}</div>
  {/if}
</article>

<style>
  .mono {
    font-family: var(--font-mono);
    font-feature-settings: 'tnum' 1, 'zero' 1;
  }

  .lesson-card {
    position: relative;
    background: var(--surface);
    border: 1px solid var(--border-soft);
    border-radius: var(--r-lg);
    padding: 16px 18px;
    box-shadow: var(--shadow-sm);
    transition: border-color var(--t) var(--ease);
    height: 100%;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .lesson-card__head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 10px;
  }
  .lesson-card__label {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.10em;
    text-transform: uppercase;
    color: var(--text-dim);
  }
  .lesson-card__hint {
    font-size: 11px;
    color: var(--accent);
    letter-spacing: 0.02em;
  }

  /* Time + optional date pill share a baseline-aligned row so the date
   * sits next to the big time without dropping below it. */
  .lesson-card__time-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 4px;
  }
  .lesson-card__time {
    font-size: 22px;
    font-weight: 600;
    color: var(--text);
    letter-spacing: -0.01em;
    line-height: 1.05;
  }
  .lesson-card__date {
    font-size: 11px;
    font-weight: 600;
    color: var(--accent);
    background: var(--accent-soft);
    border: 1px solid var(--accent-border);
    border-radius: 999px;
    padding: 2px 8px;
    letter-spacing: 0.04em;
    white-space: nowrap;
  }
  .lesson-card__title {
    font-size: 15px;
    font-weight: 600;
    color: var(--text);
    line-height: 1.3;
    margin-bottom: 8px;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .lesson-card__title--idle {
    color: var(--text-mute);
    font-weight: 500;
  }

  .lesson-card__meta {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    font-size: 12px;
    color: var(--text-mute);
    margin-bottom: 12px;
  }
  .lesson-card__room {
    padding: 2px 8px;
    background: var(--surface-2);
    border: 1px solid var(--border-soft);
    border-radius: var(--r-sm);
    color: var(--text);
    font-size: 11px;
    letter-spacing: 0.04em;
  }
  .lesson-card__room--online {
    background: transparent;
    border-color: var(--accent-border);
    color: var(--accent);
    font-style: italic;
  }
  .lesson-card__dozent { color: var(--text-mute); }
  .lesson-card__klasse {
    color: var(--text-dim);
    font-size: 11px;
    letter-spacing: 0.04em;
  }

  /* Floor-plan grows to fill leftover card height; centred when slack. */
  .lesson-card__floor {
    border-radius: var(--r-md);
    flex: 1 1 0;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }
  .lesson-card__floor :global(.floorplan) {
    width: 100%;
  }
</style>
