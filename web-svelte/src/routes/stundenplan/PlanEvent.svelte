<script lang="ts">
  /* Single event row in /stundenplan, with its expand-in-place detail panel.
   * Extracted from +page.svelte during the routes split.
   *
   * The parent owns `expandedId` (only one row open at a time) so we receive
   * `open` as a prop and call `onToggle` when the row is clicked. The parent
   * decides whether to expand this row or collapse the previously open one.
   */
  import { onMount } from 'svelte';
  import { slide } from 'svelte/transition';
  import { expoOut } from 'svelte/easing';

  import FloorPlan from '#lib/floorplans/FloorPlan.svelte';
  import type { StundenplanRow } from '#lib/api/types.js';

  type EventState = {
    row: StundenplanRow;
    start: Date;
    end: Date;
    startMs: number;
    endMs: number;
    isPast: boolean;
    isCurrent: boolean;
    isFresh: boolean;
    isOnline: boolean;
  };

  interface Props {
    ev: EventState;
    open: boolean;
    onToggle: (ev: EventState) => void;
  }

  let { ev, open, onToggle }: Props = $props();

  /* Honour prefers-reduced-motion for the slide transition: Svelte's slide
   * doesn't auto-disable when the user has reduced-motion set, so we
   * collapse the duration to 0 and skip the easing tail. Live-binds via
   * matchMedia change events so toggling the OS setting takes effect
   * without a reload. */
  let prefersReducedMotion = $state(false);
  const slideDuration = $derived(prefersReducedMotion ? 0 : 320);

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

  function onRowKey(e: KeyboardEvent): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onToggle(ev);
    }
  }
</script>

<li
  class="plan-event"
  class:plan-event--past={ev.isPast && !ev.isCurrent}
  class:plan-event--current={ev.isCurrent}
  class:plan-event--fresh={ev.isFresh}
  class:plan-event--open={open}
  data-event-id={ev.row.id}
>
  <button
    type="button"
    class="plan-event__row"
    onclick={() => onToggle(ev)}
    onkeydown={onRowKey}
    aria-expanded={open}
    aria-controls={`plan-detail-${ev.row.id}`}
  >
    <span class="plan-event__dot" aria-hidden="true">
      {#if ev.isCurrent}
        <span class="dot dot--accent"></span>
      {:else if ev.isFresh}
        <span class="dot dot--warning"></span>
      {/if}
    </span>

    <span class="plan-event__time mono">
      <span class="plan-event__time-range">
        {ev.row.zeit_von}–{ev.row.zeit_bis}
      </span>
      {#if ev.isCurrent}
        <small class="plan-event__time-hint">läuft jetzt</small>
      {/if}
    </span>

    <span class="plan-event__body">
      <span class="plan-event__title" title={ev.row.veranstaltung || ''}>{ev.row.veranstaltung || '—'}</span>
      <span class="plan-event__meta">
        {#if ev.isOnline}
          <span class="chip chip--online" title={ev.row.raum}>Online</span>
        {:else if ev.row.raum}
          <span class="chip chip--room mono">{ev.row.raum}</span>
        {/if}
        {#if ev.row.dozent}
          <span class="plan-event__dozent">{ev.row.dozent}</span>
        {/if}
        {#if ev.row.klasse}
          <span class="plan-event__klasse mono">{ev.row.klasse}</span>
        {/if}
      </span>
    </span>

    <span class="plan-event__chev" aria-hidden="true">›</span>
  </button>

  {#if open}
    <div
      class="plan-event__detail"
      id={`plan-detail-${ev.row.id}`}
      role="region"
      aria-label="Termin-Details"
      transition:slide={{ duration: slideDuration, easing: expoOut }}
    >
      <dl class="plan-event__detail-grid">
        <div class="plan-event__detail-row">
          <dt>Raum</dt>
          <dd class="mono">
            {ev.isOnline ? `${ev.row.raum || 'Online'}` : (ev.row.raum || '—')}
          </dd>
        </div>
        <div class="plan-event__detail-row">
          <dt>Zeit</dt>
          <dd class="mono">{ev.row.zeit_von}–{ev.row.zeit_bis}</dd>
        </div>
        {#if ev.row.dozent}
          <div class="plan-event__detail-row">
            <dt>Dozent</dt>
            <dd>{ev.row.dozent}</dd>
          </div>
        {/if}
        {#if ev.row.klasse}
          <div class="plan-event__detail-row">
            <dt>Klasse</dt>
            <dd class="mono">{ev.row.klasse}</dd>
          </div>
        {/if}
      </dl>
      {#if !ev.isOnline}
        <aside class="plan-event__floor">
          <FloorPlan raum={ev.row.raum} mode="inline" showLabel={false} />
        </aside>
      {/if}
    </div>
  {/if}
</li>

<style>
  .mono {
    font-family: var(--font-mono);
    font-feature-settings: 'tnum' 1, 'zero' 1;
  }

  /* ---------- Event card ----------
   *
   * State background sits on the LI itself so it extends through the entire
   * expanded card (trigger row + detail panel + floor-plan) without any
   * internal hairline. Trigger and detail render transparent above it.
   *
   * Custom ease curve (Emil's strong ease-out-expo) for the expand reveal —
   * the default --ease is good for hover/state, but the dropdown deserves
   * a punchier, more intentional motion. */

  .plan-event {
    position: relative;
    border-bottom: 1px solid var(--border-soft);
    transition: background 200ms var(--ease-expo);
  }
  .plan-event:last-child {
    border-bottom: none;
  }

  .plan-event__row {
    display: grid;
    grid-template-columns: 16px 110px 1fr auto;
    gap: 14px;
    width: 100%;
    padding: 12px 14px;
    background: transparent;
    border: none;
    color: inherit;
    text-align: left;
    cursor: pointer;
    align-items: start;
    border-radius: var(--r-md);
    transition: background var(--t-fast) var(--ease);
  }
  .plan-event__row:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
    border-radius: var(--r-md);
  }

  /* Past events: dim the entire card. */
  .plan-event--past {
    opacity: 0.55;
  }

  /* State backgrounds on the LI — extend through the whole card when open. */
  .plan-event--current {
    background: var(--accent-soft);
  }
  .plan-event--fresh:not(.plan-event--current) {
    background: var(--warning-soft);
  }

  /* Open + neutral: subtle elevation lift. */
  .plan-event--open:not(.plan-event--current):not(.plan-event--fresh) {
    background: var(--surface-2);
  }
  /* Open + current: deeper accent fill so the unified card reads brighter. */
  .plan-event--open.plan-event--current {
    background: var(--accent-soft-strong);
  }
  /* Open + fresh: deeper warning fill. */
  .plan-event--open.plan-event--fresh:not(.plan-event--current) {
    background: var(--warning-soft-strong);
  }

  /* Hover-Guard: only apply hover styles on hover-capable pointers. */
  @media (hover: hover) and (pointer: fine) {
    .plan-event:not(.plan-event--open):not(.plan-event--current):not(.plan-event--fresh):hover {
      background: var(--surface-2);
    }
    .plan-event--past:not(.plan-event--open):hover { opacity: 0.8; }
    .plan-event--current:not(.plan-event--open):hover {
      background: var(--accent-soft-strong);
    }
    .plan-event--fresh:not(.plan-event--current):not(.plan-event--open):hover {
      background: var(--warning-soft-strong);
    }
  }

  /* Deep-link flash: two yellow pulses on the WHOLE card (trigger + detail
   * + floor-plan) when the user arrives from the dashboard's Letzte-
   * Änderung feed. Implemented as a transparent ::after overlay animated
   * only on opacity — the LI's static state bg (current/fresh/open) stays
   * put underneath, and the GPU compositor handles the pulse. */
  .plan-event:global(.is-flash)::after {
    content: '';
    position: absolute;
    inset: 0;
    background: var(--warning-flash);
    pointer-events: none;
    opacity: 0;
    animation: plan-event-flash 2400ms ease-out;
  }
  @keyframes plan-event-flash {
    0%   { opacity: 0; }
    15%  { opacity: 1; }
    35%  { opacity: 0; }
    55%  { opacity: 1; }
    100% { opacity: 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .plan-event:global(.is-flash)::after { animation: none; opacity: 0; }
  }

  /* ---------- Dot column ---------- */

  .plan-event__dot {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    margin-top: 4px;
  }

  .dot {
    position: relative;
    width: 7px;
    height: 7px;
    border-radius: 999px;
    display: inline-block;
  }
  .dot--accent {
    background: var(--accent);
    box-shadow:
      0 0 0 2px var(--accent-soft-strong),
      0 0 8px var(--accent-flash);
  }
  /* GPU-only halo: a sibling ring that scales + fades. Identical visual to
   * the old infinite box-shadow keyframes, but compositor-bound. */
  .dot--accent::after {
    content: '';
    position: absolute;
    inset: -2px;
    border-radius: 999px;
    background: var(--accent);
    opacity: 0.55;
    transform: scale(1);
    animation: planDotPulse 1.6s var(--ease) infinite;
    pointer-events: none;
  }
  .dot--warning {
    background: var(--warning);
    box-shadow: 0 0 0 2px var(--warning-soft-strong);
  }

  @keyframes planDotPulse {
    0%   { transform: scale(1);    opacity: 0.55; }
    70%  { transform: scale(2.6);  opacity: 0;    }
    100% { transform: scale(2.6);  opacity: 0;    }
  }

  /* ---------- Time column ---------- */

  .plan-event__time {
    display: flex;
    flex-direction: column;
    gap: 2px;
    color: var(--text);
    font-size: 13px;
    line-height: 1.3;
    letter-spacing: 0.01em;
    font-feature-settings: 'tnum' 1, 'zero' 1;
  }

  .plan-event__time-range {
    white-space: nowrap;
  }

  .plan-event__time-hint {
    color: var(--accent);
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    font-weight: 700;
  }

  /* ---------- Body column ---------- */

  .plan-event__body {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .plan-event__title {
    font-size: 14px;
    font-weight: 500;
    color: var(--text);
    letter-spacing: -0.005em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .plan-event__meta {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 12px;
    align-items: center;
    font-size: 12px;
    color: var(--text-mute);
    line-height: 1.3;
  }
  .plan-event__dozent {
    color: var(--text-mute);
  }
  .plan-event__klasse {
    color: var(--text-dim);
    font-size: 11px;
    letter-spacing: 0.04em;
  }

  /* ---------- Chips ---------- */

  .chip {
    display: inline-flex;
    align-items: center;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    line-height: 1.4;
    letter-spacing: 0.02em;
    background: var(--surface-2);
    color: var(--text-mute);
    border: 1px solid var(--border);
  }
  .chip--room {
    color: var(--text);
    font-feature-settings: 'tnum' 1, 'zero' 1;
  }
  .chip--online {
    background: var(--surface-3);
    color: var(--text-dim);
    font-style: italic;
    letter-spacing: 0.04em;
  }

  /* ---------- Chevron ---------- */

  .plan-event__chev {
    align-self: center;
    font-family: var(--font-mono);
    font-size: 14px;
    color: var(--text-dim);
    /* Match the detail panel's ease curve so the chevron rotation feels
     * synced with the reveal — no double-tempo. */
    transition: transform 240ms var(--ease-expo),
                color var(--t-fast) var(--ease);
    line-height: 1;
  }
  .plan-event--open .plan-event__chev {
    transform: rotate(90deg);
    color: var(--accent);
  }

  /* ---------- Detail panel ----------
   * Two columns: dl-info on the left (flush with the time column above),
   * Floor-Plan on the right at ~280-320px. Mobile collapses to one column.
   *
   * Transparent bg + no border-top → the LI's state background flows
   * through the whole card seamlessly. The card reads as one piece. */

  .plan-event__detail {
    padding: 4px 14px 16px 14px;
    background: transparent;
    color: var(--text-mute);
    display: grid;
    grid-template-columns: 1fr minmax(320px, 440px);
    column-gap: 32px;
    align-items: start;
    /* Reveal motion lives on the Svelte slide transition above (height +
     * padding interpolation with expoOut easing). expoOut gives the strong
     * ease-out tail that the impeccable + Emil playbooks call for, without
     * the bounce/elastic feel they ban.
     *
     * Hint the compositor that height/transform will animate in (Svelte
     * slide tweens height + padding). Scoped to this element only — the
     * panel always lives inside an open card, so the cost of an extra
     * promotion layer is paid only when something is actually expanded,
     * not on every row in the list. */
    overflow: hidden;
    will-change: height, padding;
    contain: layout paint;
  }
  @media (prefers-reduced-motion: reduce) {
    .plan-event__chev { transition: color var(--t-fast) var(--ease); }
  }

  /* Desktop layout: <dl> grid with label column + values. */
  .plan-event__detail-grid {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0;
  }
  .plan-event__detail-row {
    display: grid;
    grid-template-columns: 110px 1fr;
    gap: 12px;
    padding: 4px 0;
  }
  .plan-event__detail-row dt {
    color: var(--text-dim);
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    font-weight: 600;
    margin: 0;
  }
  .plan-event__detail-row dd {
    margin: 0;
    color: var(--text);
    font-size: 13px;
  }

  .plan-event__floor { max-width: 100%; }

  /* ---------- Responsive ---------- */

  @media (max-width: 720px) {
    .plan-event__row {
      grid-template-columns: 16px 92px 1fr auto;
      gap: 10px;
      padding: 10px 8px;
      /* WCAG 2.5.5: ensure the row stays a 44px touch target on mobile
       * even with tighter padding. */
      min-height: 44px;
    }

    /* Collapse the 2-column dropdown to single column on mobile —
     * Floor-Plan first (full width), info dl below. */
    .plan-event__detail {
      grid-template-columns: 1fr;
      padding: 10px;
      gap: 10px;
    }
    .plan-event__detail-row {
      grid-template-columns: 92px 1fr;
    }
    .plan-event__floor {
      max-width: 100%;
      /* On mobile, show the Floor-Plan first (visual context), info below. */
      order: -1;
    }
  }

  /* ---------- Reduced motion ---------- */

  @media (prefers-reduced-motion: reduce) {
    .plan-event__detail {
      animation: none;
    }
    .dot--accent::after {
      animation: none;
      opacity: 0;
    }
  }
</style>
