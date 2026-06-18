<script lang="ts">
  /* /stundenplan — day-grouped event list with ambient floor strip.
   *
   * Layout: 200px FloorPlan strip (auto-mirrors selected event's room) →
   * day-grouped event list with sticky day headers → expand-in-place
   * detail rows. Today's day-section auto-scrolls into view on mount.
   *
   * Highlighting:
   *   - past events: opacity 0.55
   *   - current event (now in [von, bis)): accent-soft background + leading
   *     filled accent dot. NO side-stripe border.
   *   - fresh events (isFresh=1): warning-tinted background + leading warning
   *     dot. Combines with current.
   *
   * Selection: clicking an event toggles its detail and pins the floor strip
   * to that event's room. Default = current ?? next ?? first event.
   * Esc collapses any open detail.
   *
   * The single-event row with its detail dropdown is encapsulated in
   * PlanEvent.svelte to keep this orchestrator file reasonable.
   */
  import { onMount, onDestroy } from 'svelte';
  import { page } from '$app/state';

  import { isOnlineRoom } from '$lib/floorplans/helpers';
  import { getStundenplan, markSeen } from '$lib/api/endpoints';
  import { isApiHttpError } from '$lib/api/client';
  import { pushToast } from '$lib/stores/toast.svelte';
  import type { StundenplanRow } from '$lib/api/types';

  import PlanEvent from './PlanEvent.svelte';

  // ---------- State ----------

  let plan = $state<StundenplanRow[] | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let fetchedAt = $state<string | null>(null);

  /** Currently expanded event id (null = nothing expanded). */
  let expandedId = $state<number | null>(null);
  /** Pinned-by-click event id; falls back to default selection when null. */
  let pinnedId = $state<number | null>(null);

  /** Live "now" for current/past determination. Refreshed every minute. */
  let now = $state(new Date());
  let nowTimer: ReturnType<typeof setInterval> | null = null;

  // ---------- Date helpers ----------

  /* Combine Stundenplan datum_iso (YYYY-MM-DD) + zeit (HH:MM) into a real
   * Date in local time. The DB stores naive local dates; building a
   * Date('YYYY-MM-DDTHH:MM') yields local-time semantics on every browser
   * that supports HTML5 datetime parsing. */
  function combineDateTime(datumIso: string, zeit: string): Date {
    return new Date(`${datumIso}T${zeit}`);
  }

  /* Stable YYYY-MM-DD key derived from datum_iso. The API already gives us
   * this exact form so we just normalise defensively. */
  function dayKey(datumIso: string): string {
    return datumIso.slice(0, 10);
  }

  function todayKey(): string {
    const d = now;
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function isToday(key: string): boolean {
    return key === todayKey();
  }

  const dayLabelFmt = new Intl.DateTimeFormat('de-CH', {
    weekday: 'long',
    day: 'numeric',
    month: 'long'
  });

  function formatDayLabel(key: string): string {
    // Anchor to local noon so DST shifts don't push the date back a day.
    const [y, m, d] = key.split('-').map(Number);
    if (!y || !m || !d) return key;
    return dayLabelFmt.format(new Date(y, m - 1, d, 12, 0, 0));
  }

  function formatLastFetched(iso: string | null): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `Stand ${hh}:${mm}`;
  }

  // ---------- Derivations ----------

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

  /* Stable per-plan structure: sort + group + pre-compute time-invariant
   * fields (start/end Dates, isFresh, isOnline). This block re-runs only
   * when `plan` identity changes — NOT on every now-tick. The 30s `now`
   * refresh used to invalidate this whole pipeline; now it only flips
   * the two boolean flags below. */
  type StableEvent = Omit<EventState, 'isPast' | 'isCurrent'>;

  const stableGrouped = $derived.by<Array<[string, StableEvent[]]>>(() => {
    if (!plan) return [];
    const sorted = plan.slice().sort((a, b) => {
      const da = a.datum_iso.localeCompare(b.datum_iso);
      if (da !== 0) return da;
      return a.zeit_von.localeCompare(b.zeit_von);
    });
    const map = new Map<string, StableEvent[]>();
    for (const row of sorted) {
      const start = combineDateTime(row.datum_iso, row.zeit_von);
      const end = combineDateTime(row.datum_iso, row.zeit_bis);
      const ev: StableEvent = {
        row,
        start,
        end,
        startMs: start.getTime(),
        endMs: end.getTime(),
        isFresh: row.isFresh === 1,
        isOnline: isOnlineRoom(row.raum)
      };
      const key = dayKey(row.datum_iso);
      const bucket = map.get(key);
      if (bucket) bucket.push(ev);
      else map.set(key, [ev]);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  });

  /* Per-tick layer: only re-derives the two time-dependent flags. The
   * outer day shape and per-event identity are reused, so list keys stay
   * stable and Svelte does minimal DOM diffing on the now-tick. */
  const groupedByDay = $derived.by<Array<[string, EventState[]]>>(() => {
    const t = now.getTime();
    return stableGrouped.map(([key, evs]) => [
      key,
      evs.map((ev) => ({
        ...ev,
        isPast: ev.endMs <= t,
        isCurrent: ev.startMs <= t && t < ev.endMs
      }))
    ]);
  });

  const totalCount = $derived.by(() => {
    let n = 0;
    for (const [, evs] of stableGrouped) n += evs.length;
    return n;
  });
  const dayCount = $derived(stableGrouped.length);

  // ---------- Data fetching ----------

  /* AbortController: bricht in-flight GET /api/stundenplan ab wenn die
   * Route geleavt wird oder fetchPlan() während eines laufenden Fetches
   * neu aufgerufen wird (z.B. nach Scrape-Event). Aborts werfen DOMException
   * 'AbortError', den wir per signal.aborted-Check absorbieren. */
  let activeController: AbortController | null = null;

  async function fetchPlan(opts: { silent?: boolean } = {}): Promise<void> {
    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;
    const { signal } = controller;

    if (!opts.silent) {
      loading = true;
    }
    error = null;
    try {
      const res = await getStundenplan({}, { signal });
      if (signal.aborted) return;
      plan = res.rows;
      fetchedAt = res.fetchedAt;
    } catch (e: unknown) {
      if (signal.aborted) return;
      // Keep stale data if a refetch fails so the user keeps a working view.
      let msg = 'Stundenplan konnte nicht geladen werden';
      if (isApiHttpError(e)) {
        const body = e.body;
        if (body && typeof body === 'object' && typeof body.error === 'string') {
          msg = body.error;
        } else {
          msg = `HTTP ${e.status}`;
        }
      } else if (e instanceof Error && e.message) {
        msg = e.message;
      }
      error = msg;
    } finally {
      if (!signal.aborted) loading = false;
    }
  }

  /* Mark fresh-flagged stundenplan rows as seen, server-side. We fire and
   * forget — the UI doesn't need to react synchronously, and toast noise on
   * a background "seen" call would be wrong. */
  async function markFreshAsSeen(): Promise<void> {
    if (!plan) return;
    const ids = plan.filter((r) => r.isFresh === 1).map((r) => r.id);
    if (ids.length === 0) return;
    try {
      await markSeen('stundenplan', ids);
    } catch {
      // Silent: stale fresh-flag is a low-impact failure mode.
    }
  }

  function handleScrapeEvent(): void {
    void fetchPlan({ silent: true });
  }

  // ---------- UI handlers ----------

  function toggleEvent(ev: EventState): void {
    if (expandedId === ev.row.id) {
      // Second click on the same event collapses but keeps the strip pinned
      // so the floor view doesn't surprise-jump back to default.
      expandedId = null;
    } else {
      expandedId = ev.row.id;
      pinnedId = ev.row.id;
    }
  }

  function onWindowKey(e: KeyboardEvent): void {
    if (e.key === 'Escape' && expandedId !== null) {
      // Don't fight the global Esc handlers (palette/peek). Only collapse
      // when nothing else is open — the global handler in +layout already
      // returns early for those cases, so by the time this fires we're safe.
      expandedId = null;
    }
  }

  // ---------- Lifecycle ----------

  $effect(() => {
    void fetchPlan();
  });

  /* No auto-scroll-to-today on initial load: today is always the first
   * day-group in the list, so the user sees it right after the page
   * header. */

  /* Deep-link from the dashboard's "Letzte Änderung" feed: ?focus=<id>.
   * Three-phase sequence so the user's eye follows the action:
   *   1. Scroll the row into view (smooth, ~500ms)
   *   2. Wait for the scroll to settle, then expand the dropdown (280ms reveal)
   *   3. Once expanded, two yellow pulses so the user sees which row was hit.
   * Runs once per data-load via didApplyFocus. */
  let didApplyFocus = $state(false);
  $effect(() => {
    if (didApplyFocus) return;
    if (loading || !plan || plan.length === 0) return;
    const focusRaw = page.url.searchParams.get('focus');
    if (!focusRaw) return;
    const focusId = Number(focusRaw);
    if (!Number.isFinite(focusId)) return;
    const target = plan.find((p) => p.id === focusId);
    if (!target) return;
    didApplyFocus = true;

    requestAnimationFrame(() => {
      const sel = `[data-event-id="${CSS.escape(String(focusId))}"]`;
      const node = document.querySelector(sel);
      if (!(node instanceof HTMLElement)) return;

      // Phase 1: scroll only.
      node.scrollIntoView({ behavior: 'smooth', block: 'center' });

      // Phase 2 + 3: wait for the smooth-scroll to land, then open the
      // dropdown and trigger the flash. 600ms covers most viewport
      // distances on a desktop monitor without feeling sluggish.
      setTimeout(() => {
        expandedId = focusId;
        requestAnimationFrame(() => {
          node.classList.add('is-flash');
          setTimeout(() => node.classList.remove('is-flash'), 2500);
        });
      }, 600);
    });
  });

  /* Clear "fresh" flags after the user has actually seen the page. We wait
   * a beat so the visual highlight registers before it disappears. */
  $effect(() => {
    if (!loading && plan && plan.length > 0) {
      const t = setTimeout(() => void markFreshAsSeen(), 1500);
      return () => clearTimeout(t);
    }
  });

  /* Pause the now-tick when the tab is hidden. Saves a re-derivation of
   * groupedByDay every 30s in background tabs, and snaps `now` back up
   * to date the moment the user comes back. */
  function startNowTimer(): void {
    if (nowTimer) return;
    nowTimer = setInterval(() => {
      now = new Date();
    }, 30_000);
  }
  function stopNowTimer(): void {
    if (!nowTimer) return;
    clearInterval(nowTimer);
    nowTimer = null;
  }
  function onVisibility(): void {
    if (document.visibilityState === 'visible') {
      now = new Date();
      startNowTimer();
    } else {
      stopNowTimer();
    }
  }

  onMount(() => {
    if (document.visibilityState === 'visible') startNowTimer();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('wissen:scrape', handleScrapeEvent);
    window.addEventListener('keydown', onWindowKey);
  });

  onDestroy(() => {
    stopNowTimer();
    activeController?.abort();
    activeController = null;
    if (typeof window !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('wissen:scrape', handleScrapeEvent);
      window.removeEventListener('keydown', onWindowKey);
    }
  });

  function onRefreshClick(): void {
    void fetchPlan().then(() => {
      if (!error) pushToast('success', 'Stundenplan aktualisiert.');
    });
  }
</script>

<svelte:head><title>Stundenplan · WISSen</title></svelte:head>

<section class="plan-route">
  <header class="plan-head">
    <div class="plan-head__title">
      <h1>Stundenplan</h1>
      <span class="plan-head__sub mono" aria-live="polite">
        {#if loading && !plan}
          Lädt …
        {:else if error}
          Fehler
        {:else if totalCount === 0}
          0 Termine
        {:else}
          {totalCount} {totalCount === 1 ? 'Termin' : 'Termine'} · {dayCount}
          {dayCount === 1 ? 'Tag' : 'Tage'}{#if fetchedAt} · {formatLastFetched(fetchedAt)}{/if}
        {/if}
      </span>
    </div>
    <button
      type="button"
      class="btn btn--ghost"
      onclick={onRefreshClick}
      aria-label="Stundenplan neu laden"
      disabled={loading}
    >
      <span class="btn__icon" aria-hidden="true">↻</span>
      <span>Aktualisieren</span>
    </button>
  </header>

  {#if loading && !plan}
    <ul class="plan-skeleton" aria-busy="true" aria-label="Stundenplan wird geladen">
      {#each [0, 1, 2, 3] as i (i)}
        <li class="skel-row">
          <div class="skel-row__time"></div>
          <div class="skel-row__body">
            <div class="skel-row__title"></div>
            <div class="skel-row__meta"></div>
          </div>
        </li>
      {/each}
    </ul>
  {:else if error && !plan}
    <div class="plan-error" role="alert">
      <div class="plan-error__title">Stundenplan konnte nicht geladen werden.</div>
      <div class="plan-error__msg mono">{error}</div>
      <button type="button" class="btn btn--primary" onclick={onRefreshClick}>
        Nochmal versuchen
      </button>
    </div>
  {:else if totalCount === 0}
    <div class="plan-empty">
      <div class="plan-empty__title">Keine Lektionen geplant.</div>
      <p class="plan-empty__hint">
        Klick auf <span class="kbd">Abfragen</span> oben rechts, um den Plan zu aktualisieren.
      </p>
    </div>
  {:else}
    {#each groupedByDay as [key, events] (key)}
      {@const today = isToday(key)}
      <section
        class="plan-day"
        class:plan-day--today={today}
        aria-labelledby="plan-day-{key}"
      >
        <header class="plan-day__head">
          <span id="plan-day-{key}" class="plan-day__label" class:plan-day__label--today={today}>
            {formatDayLabel(key)}
          </span>
          {#if today}
            <span class="badge badge--today" aria-label="Heute">Heute</span>
          {/if}
          <span class="plan-day__count mono">
            {events.length} {events.length === 1 ? 'Termin' : 'Termine'}
          </span>
        </header>

        <ul class="plan-day__list">
          {#each events as ev (ev.row.id)}
            <PlanEvent {ev} open={expandedId === ev.row.id} onToggle={toggleEvent} />
          {/each}
        </ul>
      </section>
    {/each}
  {/if}
</section>

<style>
  /* ---------- Layout ---------- */

  .plan-route {
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  .plan-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin-top: 4px;
  }

  .plan-head__title {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  .plan-head h1 {
    margin: 0;
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.01em;
    color: var(--text);
    line-height: 1.2;
  }

  .plan-head__sub {
    color: var(--text-mute);
    font-size: 12px;
    font-feature-settings: 'tnum' 1, 'zero' 1;
    letter-spacing: 0.02em;
  }

  /* ---------- Buttons ---------- */

  .btn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    border-radius: var(--r-md);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.04em;
    border: 1px solid transparent;
    transition:
      background var(--t) var(--ease),
      transform var(--t-fast) var(--ease),
      border-color var(--t) var(--ease);
    user-select: none;
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn:not(:disabled):active {
    transform: scale(0.97);
  }

  .btn--primary {
    background: var(--accent);
    color: var(--accent-ink);
  }

  .btn--ghost {
    background: var(--surface-2);
    color: var(--text);
    border-color: var(--border);
  }

  /* Hover-Guard: only apply hover styles on hover-capable pointers so we
   * don't flash sticky :hover state on touch. */
  @media (hover: hover) and (pointer: fine) {
    .btn--primary:hover:not(:disabled) {
      background: var(--accent);
      transform: translateY(-1px);
      box-shadow: var(--shadow-sm);
    }
    .btn--ghost:hover:not(:disabled) {
      background: var(--surface-3);
    }
  }

  .btn__icon {
    display: inline-block;
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1;
  }

  /* ---------- Day section ---------- */

  .plan-day {
    display: flex;
    flex-direction: column;
    /* No gap — the list owns the inter-event spacing. */
  }
  .plan-day + .plan-day {
    margin-top: 8px;
  }

  .plan-day__head {
    /* Sticky inside the .main scroll container. Topbar is outside the
     * scroller, so top: 0 places this header right under it visually. */
    position: sticky;
    top: 0;
    z-index: 5;
    display: flex;
    align-items: baseline;
    gap: 12px;
    padding: 10px 4px 8px;
    background: var(--bg);
    /* Solid surface impl so we don't fall back to backdrop-blur (banned
     * outside the topbar). The bottom hairline acts as the layer-cue. */
    box-shadow: 0 1px 0 var(--border-soft);
  }

  .plan-day__label {
    font-size: 14px;
    font-weight: 600;
    letter-spacing: -0.005em;
    color: var(--text);
    text-transform: capitalize;
  }
  .plan-day__label--today {
    color: var(--accent);
  }

  .plan-day__count {
    margin-left: auto;
    font-size: 11px;
    color: var(--text-dim);
    letter-spacing: 0.04em;
  }

  .badge {
    display: inline-flex;
    align-items: center;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    line-height: 1.4;
  }
  .badge--today {
    background: var(--accent-soft);
    color: var(--accent);
    border: 1px solid var(--accent-border);
  }

  .plan-day__list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  .mono {
    font-family: var(--font-mono);
    font-feature-settings: 'tnum' 1, 'zero' 1;
  }

  /* ---------- Empty / Error / Loading ---------- */

  .plan-empty {
    padding: 36px 20px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    text-align: center;
    box-shadow: var(--shadow-md);
  }
  .plan-empty__title {
    font-size: 16px;
    font-weight: 600;
    color: var(--text);
    margin-bottom: 6px;
  }
  .plan-empty__hint {
    margin: 0;
    color: var(--text-mute);
    font-size: 13px;
  }

  .kbd {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 4px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text);
  }

  .plan-error {
    padding: 24px 20px;
    background: var(--surface);
    border: 1px solid var(--danger-border);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-md);
    display: flex;
    flex-direction: column;
    gap: 10px;
    align-items: flex-start;
  }
  .plan-error__title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text);
  }
  .plan-error__msg {
    color: var(--danger);
    font-size: 12px;
  }

  .plan-skeleton {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    padding: 8px;
  }
  .skel-row {
    display: grid;
    grid-template-columns: 100px 1fr;
    gap: 16px;
    padding: 12px 8px;
    border-bottom: 1px solid var(--border-soft);
  }
  .skel-row:last-child { border-bottom: none; }

  .skel-row__time,
  .skel-row__title,
  .skel-row__meta {
    background: linear-gradient(
      90deg,
      var(--surface-2) 0%,
      var(--surface-3) 50%,
      var(--surface-2) 100%
    );
    background-size: 200% 100%;
    border-radius: var(--r-sm);
    animation: planSkeleton 1.4s var(--ease) infinite;
  }
  .skel-row__time { height: 14px; width: 90px; }
  .skel-row__body { display: flex; flex-direction: column; gap: 8px; }
  .skel-row__title { height: 14px; width: 60%; }
  .skel-row__meta  { height: 12px; width: 40%; }

  @keyframes planSkeleton {
    0%   { background-position: 100% 0; }
    100% { background-position: -100% 0; }
  }

  /* ---------- Reduced motion ---------- */

  @media (prefers-reduced-motion: reduce) {
    .skel-row__time,
    .skel-row__title,
    .skel-row__meta {
      animation: none;
    }
    .btn:not(:disabled):active {
      transform: none;
    }
    .btn--primary:hover:not(:disabled) {
      transform: none;
    }
  }
</style>
