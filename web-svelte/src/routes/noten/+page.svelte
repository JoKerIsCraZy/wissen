<script lang="ts">
  /**
   * /noten — Grades surface (Agent C3).
   *
   * Renders a dense, sortable module table with combinable filter chips and
   * inline Pruefungen expansion. Replaces the "hero metric" pattern with
   * three compact tiles per critique.
   *
   * The page itself stays a thin orchestrator: it owns all $state, runs
   * data fetching, and derives `filtered` + `sorted` lists. Presentation
   * is split into NotenTiles, NotenFilters, and NotenTable.
   */
  import { onMount, onDestroy } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { getNoten, getPruefungen, markSeen } from '#lib/api/endpoints.js';
  import type { PruefungRow } from '#lib/api/types.js';

  import NotenTiles from './NotenTiles.svelte';
  import NotenFilters from './NotenFilters.svelte';
  import NotenTable from './NotenTable.svelte';
  import { fmtRelative, indexRows, rowKey, type IndexedRow, type SortKey } from './helpers';

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------

  let modules = $state<IndexedRow[] | null>(null);
  let totalCount = $state<number>(0);
  let avgServer = $state<number | null>(null);
  let lastFetchedAt = $state<string | null>(null);

  let loading = $state(true);
  let error = $state<string | null>(null);

  // ------------------------------------------------------------------
  // URL-state: filters + sort werden in page.url.searchParams gespiegelt,
  // damit Reload + Sharing den exakten Filter-Stand wiederherstellt.
  // Initialwerte werden einmalig aus der URL gelesen, danach hält ein
  // $effect die URL via goto(..., { replace: true, reset: false }) im Sync.
  // ------------------------------------------------------------------
  const VALID_SORT_KEYS: ReadonlySet<SortKey> = new Set([
    'number', 'name', 'semester', 'note', 'status', 'updated',
  ]);
  function readInitialSort(): SortKey {
    const raw = page.url.searchParams.get('sortBy');
    return raw && VALID_SORT_KEYS.has(raw as SortKey) ? (raw as SortKey) : 'updated';
  }
  function readInitialSemester(): Set<'S1' | 'S2'> {
    const raw = page.url.searchParams.get('sem') ?? '';
    const out = new Set<'S1' | 'S2'>();
    for (const part of raw.split(',')) {
      if (part === 'S1' || part === 'S2') out.add(part);
    }
    return out;
  }

  // Search + filters — two separate inputs so the user can target either
  // the module number ("122") or the module name ("Abläufe...") on its own.
  let queryNumber = $state(page.url.searchParams.get('q') ?? '');
  let queryName = $state('');
  let activeSemester = $state<Set<'S1' | 'S2'>>(readInitialSemester());
  let activeNoteState = $state<Set<'has' | 'none'>>(new Set());

  // Sorting
  let sortBy = $state<SortKey>(readInitialSort());
  let sortDir = $state<'asc' | 'desc'>('desc');

  // Inline expansion
  let openId = $state<string | null>(null);
  let pruefungenCache = $state<Map<string, PruefungRow[]>>(new Map());
  let pruefungenLoading = $state<Set<string>>(new Set());
  let pruefungenError = $state<Map<string, string>>(new Map());

  // DOM refs — bindable through to NotenFilters so '/' shortcut focuses search.
  let searchInputEl = $state<HTMLInputElement | null>(null);

  // ------------------------------------------------------------------
  // Data fetching
  // ------------------------------------------------------------------

  /* AbortController: bricht in-flight GET /api/noten ab, wenn die Route
   * verlassen oder fetchNoten() während eines noch laufenden Fetches
   * erneut gerufen wird. Aborts werfen DOMException 'AbortError' — den
   * fangen wir hier explizit ab, damit eine geleavte Seite keinen
   * Error-Banner stehen lässt. */
  let activeController: AbortController | null = null;

  async function fetchNoten(): Promise<void> {
    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;
    const { signal } = controller;

    loading = true;
    error = null;
    try {
      const res = await getNoten({}, { signal });
      if (signal.aborted) return;
      modules = indexRows(res.rows);
      totalCount = res.count;
      avgServer = res.avg;
      lastFetchedAt = res.fetchedAt;
    } catch (e) {
      if (signal.aborted) return;
      const msg = e instanceof Error ? e.message : 'Unbekannter Fehler';
      error = msg;
      modules = null;
    } finally {
      if (!signal.aborted) loading = false;
    }
  }

  async function loadPruefungenFor(kuerzelId: string): Promise<void> {
    if (pruefungenCache.has(kuerzelId)) return;
    pruefungenLoading = new Set(pruefungenLoading).add(kuerzelId);
    try {
      const res = await getPruefungen(kuerzelId);
      pruefungenCache = new Map(pruefungenCache).set(kuerzelId, res.rows);
      // Only rebuild the error map if there was actually an error to clear
      // for this id — otherwise we trigger a no-op invalidation downstream.
      if (pruefungenError.has(kuerzelId)) {
        const errs = new Map(pruefungenError);
        errs.delete(kuerzelId);
        pruefungenError = errs;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Fehler beim Laden';
      pruefungenError = new Map(pruefungenError).set(kuerzelId, msg);
    } finally {
      const next = new Set(pruefungenLoading);
      next.delete(kuerzelId);
      pruefungenLoading = next;
    }
  }

  /* "Pending" id while we pre-load pruefungen for a row the user just
   * clicked. The trigger row shows a subtle visual cue during the wait,
   * but the detail row only mounts once data is ready — that way the
   * slide-in animation knows the final height up front and renders one
   * smooth reveal instead of a scoped jump after the fetch lands. */
  let pendingOpenId = $state<string | null>(null);

  async function toggleRow(r: IndexedRow): Promise<void> {
    const id = rowKey(r);
    if (openId === id) {
      openId = null;
      return;
    }
    // Cached → instant open. Uncached → wait for fetch first so the slide
    // animates straight to the eventual content height.
    if (!pruefungenCache.has(id) && !pruefungenError.has(id)) {
      pendingOpenId = id;
      try {
        await loadPruefungenFor(id);
      } finally {
        // If the user clicked another row while we were loading, abandon
        // this open. activeId already represents the user's latest intent.
        if (pendingOpenId !== id) return;
        pendingOpenId = null;
      }
    }
    // Mark seen — best-effort, fire-and-forget. Wir setzen isFresh hier
    // bewusst NICHT optimistic auf 0: der Server hält nach IS_FRESH_SQL
    // die "frisch"-Markierung noch 24h nach dem ersten Sehen aufrecht
    // (Grace-Period), damit der User innerhalb des Tages zurückkommt und
    // die Markierung wiederfindet. Optimistic-Clear würde diese Semantik
    // brechen und die Markierung schon beim ersten Aufklappen löschen.
    // Der nächste Refetch (Scrape-Done-Event oder Page-Reload) liefert den
    // konsistenten Server-Stand — change_seen_at ist gesetzt, isFresh
    // bleibt 1 für die nächsten 24h.
    if (r.isFresh && r.kuerzel_id) {
      void markSeen('noten', [r.kuerzel_id]).catch(() => {
        // Silent — next scrape reconciles.
      });
    }
    openId = id;
  }

  // ------------------------------------------------------------------
  // Filter + sort derivations
  // ------------------------------------------------------------------

  /* Filter derivation reads pre-computed lower-cased haystacks on each
   * indexed row (`_codeLc`, `_nameLc`) so the per-keystroke filter pass
   * doesn't redo `.toLowerCase()` and string concat per row. When no
   * filter is active we short-circuit to the source list directly,
   * avoiding the `.filter()` allocation entirely. */
  const filtered = $derived.by((): IndexedRow[] => {
    const list = modules;
    if (!list) return [];
    const qNum = queryNumber.trim().toLowerCase();
    const qName = queryName.trim().toLowerCase();
    const semSize = activeSemester.size;
    const noteSize = activeNoteState.size;
    // Hot path: no filters → return source identity, sort step skips the spread
    // copy when nothing changes between renders.
    if (!qNum && !qName && !semSize && !noteSize) return list;
    return list.filter((m) => {
      if (qNum && !m._codeLc.includes(qNum)) return false;
      if (qName && !m._nameLc.includes(qName)) return false;
      if (semSize) {
        const sem = m.semester as 'S1' | 'S2';
        if (!activeSemester.has(sem)) return false;
      }
      if (noteSize) {
        const has = m.note != null;
        if (has && !activeNoteState.has('has')) return false;
        if (!has && !activeNoteState.has('none')) return false;
      }
      return true;
    });
  });

  /* Locale-aware natural collator for code/name strings. Constructed once at
   * module scope so we don't pay the per-derive setup cost (~5-15μs per call). */
  const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });
  const collatorCompare = collator.compare;

  function sortValue(r: IndexedRow, key: SortKey): string | number | null {
    switch (key) {
      case 'number':
        // Trailing module-number ("122", "ENG-N3"). Empty codes sort last
        // ascending — using a high-codepoint sentinel keeps them at the
        // bottom regardless of direction toggling natural-numeric collation.
        return r._codeLc || '￿';
      case 'name':
        return r._nameSortLc;
      case 'semester':
        return r.semester || '';
      case 'note':
        return r.note;
      case 'status':
        // Stable ordering: fresh > has-note > no-note
        if (r.isFresh) return 0;
        if (r.note != null) return 1;
        return 2;
      case 'updated':
        // Numeric epoch ms — avoids string compare per pair.
        return r._fetchedAtMs || null;
      default:
        return null;
    }
  }

  const sorted = $derived.by((): IndexedRow[] => {
    // `filtered` returns the source array directly when no filter is active,
    // so we always copy here before sorting to avoid mutating the source.
    const out = filtered.slice();
    const mult = sortDir === 'desc' ? -1 : 1;
    out.sort((a, b) => {
      const av = sortValue(a, sortBy);
      const bv = sortValue(b, sortBy);
      const aMissing = av == null || av === '';
      const bMissing = bv == null || bv === '';
      if (aMissing && bMissing) return 0;
      if (aMissing) return 1;
      if (bMissing) return -1;
      if (typeof av === 'string' && typeof bv === 'string') {
        return collatorCompare(av, bv) * mult;
      }
      if (typeof av === 'number' && typeof bv === 'number') {
        if (av < bv) return -1 * mult;
        if (av > bv) return 1 * mult;
        return 0;
      }
      return 0;
    });
    return out;
  });

  // ------------------------------------------------------------------
  // Tile data
  // ------------------------------------------------------------------

  const overallAvg = $derived.by((): { value: number | null; gradedCount: number } => {
    const list = modules;
    if (!list) return { value: avgServer, gradedCount: 0 };
    const graded = list.filter((m) => m.note != null);
    if (avgServer != null) return { value: avgServer, gradedCount: graded.length };
    if (!graded.length) return { value: null, gradedCount: 0 };
    const sum = graded.reduce((acc, m) => acc + Number(m.note), 0);
    return { value: sum / graded.length, gradedCount: graded.length };
  });

  const lastChanged = $derived.by((): IndexedRow | null => {
    const list = modules;
    if (!list || !list.length) return null;
    const fresh = list.filter((m) => m.isFresh && m.note != null);
    const pool = fresh.length ? fresh : list.filter((m) => m.note != null);
    if (!pool.length) return null;
    // Single-pass max instead of slice+sort — O(n) vs O(n log n), and
    // re-uses the pre-parsed `_fetchedAtMs` instead of re-parsing per pair.
    let best = pool[0];
    for (let i = 1; i < pool.length; i++) {
      if (pool[i]._fetchedAtMs > best._fetchedAtMs) best = pool[i];
    }
    return best;
  });

  /** Quick-View anchors. Only present when there's something noteworthy. */
  const quickFilters = $derived.by((): Array<{ key: string; label: string; count: number; apply: () => void }> => {
    const list = modules;
    if (!list) return [];
    const out: Array<{ key: string; label: string; count: number; apply: () => void }> = [];
    const freshCount = list.filter((m) => m.isFresh).length;
    const ohneNoteCount = list.filter((m) => m.note == null).length;
    if (freshCount > 0) {
      out.push({
        key: 'fresh',
        label: `${freshCount} frisch`,
        count: freshCount,
        apply: () => {
          // No "fresh" filter chip exists; sort by status to surface them.
          activeSemester = new Set();
          activeNoteState = new Set();
          queryNumber = '';
          queryName = '';
          sortBy = 'status';
          sortDir = 'asc';
        },
      });
    }
    if (ohneNoteCount > 0 && ohneNoteCount < list.length) {
      out.push({
        key: 'ohne',
        label: `${ohneNoteCount} ohne Note`,
        count: ohneNoteCount,
        apply: () => {
          activeNoteState = new Set(['none']);
          activeSemester = new Set();
          queryNumber = '';
          queryName = '';
          sortBy = 'name';
          sortDir = 'asc';
        },
      });
    }
    return out;
  });

  // ------------------------------------------------------------------
  // Sort + filter handlers
  // ------------------------------------------------------------------

  function clearFilters(): void {
    activeSemester = new Set();
    activeNoteState = new Set();
    queryNumber = '';
    queryName = '';
  }

  function setSort(key: SortKey): void {
    if (sortBy === key) {
      sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      sortBy = key;
      sortDir = key === 'note' || key === 'updated' ? 'desc' : 'asc';
    }
  }

  function focusSearchHandler(): void {
    // Layout fires this when '/' is pressed. Layout itself also calls
    // querySelector('input[type="search"]'), so this is belt-and-braces.
    requestAnimationFrame(() => searchInputEl?.focus());
  }

  function onScrapeEvent(): void {
    void fetchNoten();
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  onMount(() => {
    void fetchNoten();
    window.addEventListener('wissen:scrape', onScrapeEvent);
    window.addEventListener('wissen:focus-search', focusSearchHandler);
  });

  /* Deep-link from the dashboard's "Letzte Änderung" feed: ?focus=<code-or-id>.
   * Three-phase sequence: scroll row into view → wait for scroll → expand
   * row + flash yellow pulse. The dashboard sends kuerzel_code first (with
   * kuerzel_id fallback), so accept either match here. */
  let didApplyFocus = $state(false);
  $effect(() => {
    if (didApplyFocus) return;
    if (loading || !modules || modules.length === 0) return;
    const focus = page.url.searchParams.get('focus');
    if (!focus) return;
    const target = modules.find(
      (m) => m.kuerzel_id === focus || m.kuerzel_code === focus,
    );
    if (!target) return;
    const id = rowKey(target);
    didApplyFocus = true;

    requestAnimationFrame(() => {
      const sel = `[data-row-id="${CSS.escape(id)}"]`;
      const node = document.querySelector(sel);
      if (!(node instanceof HTMLElement)) return;

      // Phase 1: scroll only.
      node.scrollIntoView({ behavior: 'smooth', block: 'center' });

      // Phase 2 + 3: after the smooth-scroll settles, expand the row and
      // start the yellow flash. toggleRow loads pruefungen async but the
      // row itself opens immediately.
      setTimeout(() => {
        void toggleRow(target);
        requestAnimationFrame(() => {
          node.classList.add('is-flash');
          setTimeout(() => node.classList.remove('is-flash'), 2500);
        });
      }, 600);
    });
  });

  /* URL-state sync: queryNumber + activeSemester + sortBy in die
   * searchParams spiegeln. replace statt push, damit der Back-Button
   * nicht durch jede Filter-Änderung tickt; reset: false damit das
   * Input nicht den Fokus verliert während getippt wird. Default-Werte
   * werden als leere Param aus der URL entfernt — sauberer Share-Link. */
  let initialUrlSyncDone = false;
  $effect(() => {
    /* Read state to register dependencies. */
    const q = queryNumber;
    const sems = activeSemester;
    const sort = sortBy;
    /* Skip the very first effect run so we don't immediately replaceState
     * with default values on mount — only do it after the user actually
     * changes something. */
    if (!initialUrlSyncDone) {
      initialUrlSyncDone = true;
      return;
    }
    const params = new URLSearchParams(page.url.search);
    if (q.trim()) params.set('q', q);
    else params.delete('q');
    const semCsv = [...sems].sort().join(',');
    if (semCsv) params.set('sem', semCsv);
    else params.delete('sem');
    if (sort !== 'updated') params.set('sortBy', sort);
    else params.delete('sortBy');
    const next = params.toString();
    const current = page.url.searchParams.toString();
    if (next === current) return;
    const url = next ? `${page.url.pathname}?${next}` : page.url.pathname;
    void goto(url, { replace: true, reset: false });
  });

  onDestroy(() => {
    activeController?.abort();
    activeController = null;
    if (typeof window === 'undefined') return;
    window.removeEventListener('wissen:scrape', onScrapeEvent);
    window.removeEventListener('wissen:focus-search', focusSearchHandler);
  });
</script>

<svelte:head>
  <title>Noten · WISSen</title>
</svelte:head>

<section class="noten-route">
  <header class="route__head">
    <h1 class="route__title">Noten</h1>
    <span class="route__subtitle mono">
      {#if loading && !modules}
        Lade…
      {:else if modules}
        {sorted.length} angezeigt · {totalCount} insgesamt
        {#if lastFetchedAt}
          · zuletzt {fmtRelative(lastFetchedAt)}
        {/if}
      {:else if error}
        Fehler
      {/if}
    </span>
  </header>

  {#if error}
    <div class="banner banner--error" role="alert">
      <span class="banner__title">Fehler beim Laden</span>
      <span class="banner__msg mono">{error}</span>
      <button type="button" class="banner__btn" onclick={fetchNoten}>Erneut versuchen</button>
    </div>
  {/if}

  <NotenTiles {modules} {overallAvg} {lastChanged} {quickFilters} />

  <div class="card">
    <NotenFilters
      bind:queryNumber
      bind:queryName
      bind:activeSemester
      bind:activeNoteState
      bind:searchInputEl
      onClear={clearFilters}
    />

    <NotenTable
      {loading}
      {modules}
      {sorted}
      {sortBy}
      {sortDir}
      {openId}
      {pendingOpenId}
      {pruefungenCache}
      {pruefungenLoading}
      {pruefungenError}
      {setSort}
      {toggleRow}
      {loadPruefungenFor}
    />
  </div>
</section>

<style>
  .noten-route {
    display: flex;
    flex-direction: column;
    gap: 18px;
  }

  /* ---------- Header ---------- */
  .route__head {
    display: flex;
    align-items: baseline;
    gap: 14px;
    margin-bottom: 4px;
  }
  .route__title {
    margin: 0;
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.01em;
    color: var(--text);
  }
  .route__subtitle {
    font-size: 12px;
    color: var(--text-dim);
    letter-spacing: 0.02em;
  }
  .mono {
    font-family: var(--font-mono);
    font-feature-settings: 'tnum' 1, 'zero' 1;
  }

  /* ---------- Error banner ---------- */
  .banner {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    padding: 10px 14px;
    border-radius: var(--r-md);
    border: 1px solid var(--border);
    background: var(--surface);
  }
  .banner--error {
    border-color: var(--danger-border);
    background: var(--danger-soft);
  }
  .banner__title { font-weight: 600; color: var(--text); }
  .banner__msg { color: var(--text-mute); font-size: 12px; }
  .banner__btn {
    margin-left: auto;
    padding: 6px 12px;
    border-radius: var(--r-md);
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    font-size: 12px;
    transition: background var(--t-fast) var(--ease);
  }
  @media (hover: hover) and (pointer: fine) {
    .banner__btn:hover { background: var(--surface-3); }
  }

  /* ---------- Card wrapper around filters + table ---------- */
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-md);
    overflow: hidden;
  }

  /* ---------- Reduced motion ---------- */
  @media (prefers-reduced-motion: reduce) {
    .banner__btn { transition: none; }
  }
</style>
