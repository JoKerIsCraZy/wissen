<script lang="ts">
  /**
   * /absenzen — Anwesenheits-/Absenz-Tracking (vierte Daten-Achse).
   *
   * Klon der /noten-Struktur: dichte, sortierbare Modul-Tabelle mit
   * kombinierbaren Filter-Chips und Inline-Tagesliste-Expansion. Stats-
   * Kacheln oben (Ø-Anwesenheit · Module unter Minimum · Abwesenheiten).
   *
   * Die Seite bleibt ein dünner Orchestrator: sie hält alle $state, fetcht
   * die Daten und leitet `filtered` + `sorted` ab. Präsentation ist auf
   * AbsenzenTiles, AbsenzenFilters und AbsenzenTable aufgeteilt.
   */
  import { onMount, onDestroy } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { getAbsenzen, getAbsenzenLektionen, markSeen } from '$lib/api/endpoints';
  import type { AbsenzLektionRow, AbsenzenStats } from '$lib/api/types';

  import AbsenzenTiles from './AbsenzenTiles.svelte';
  import AbsenzenFilters from './AbsenzenFilters.svelte';
  import AbsenzenTable from './AbsenzenTable.svelte';
  import { fmtRelative, indexRows, rowKey, type IndexedAbsenzRow, type SortKey } from './helpers';

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------

  let modules = $state<IndexedAbsenzRow[] | null>(null);
  let totalCount = $state<number>(0);
  let serverStats = $state<AbsenzenStats | null>(null);
  let lastFetchedAt = $state<string | null>(null);

  let loading = $state(true);
  let error = $state<string | null>(null);

  // ------------------------------------------------------------------
  // URL-state: filters + sort werden in page.url.searchParams gespiegelt,
  // damit Reload + Sharing den exakten Filter-Stand wiederherstellt.
  // ------------------------------------------------------------------
  const VALID_SORT_KEYS: ReadonlySet<SortKey> = new Set([
    'code', 'name', 'typ', 'anwesenheit', 'soll', 'updated',
  ]);
  function readInitialSort(): SortKey {
    const raw = page.url.searchParams.get('sortBy');
    return raw && VALID_SORT_KEYS.has(raw as SortKey) ? (raw as SortKey) : 'anwesenheit';
  }
  function readInitialTyp(): Set<'modul' | 'uek'> {
    const raw = page.url.searchParams.get('typ') ?? '';
    const out = new Set<'modul' | 'uek'>();
    for (const part of raw.split(',')) {
      if (part === 'modul' || part === 'uek') out.add(part);
    }
    return out;
  }

  // Search + filters — zwei getrennte Inputs (Code-Nr. + Bezeichnung).
  let queryNumber = $state(page.url.searchParams.get('q') ?? '');
  let queryName = $state('');
  let activeTyp = $state<Set<'modul' | 'uek'>>(readInitialTyp());
  let onlyUnterMin = $state(page.url.searchParams.get('min') === '1');

  // Sorting
  let sortBy = $state<SortKey>(readInitialSort());
  let sortDir = $state<'asc' | 'desc'>('asc');

  // Inline expansion
  let openId = $state<string | null>(null);
  let lektionenCache = $state<Map<string, AbsenzLektionRow[]>>(new Map());
  let lektionenLoading = $state<Set<string>>(new Set());
  let lektionenError = $state<Map<string, string>>(new Map());

  // DOM refs — durchgereicht an AbsenzenFilters, damit '/' die Suche fokussiert.
  let searchInputEl = $state<HTMLInputElement | null>(null);

  // ------------------------------------------------------------------
  // Data fetching
  // ------------------------------------------------------------------

  /* AbortController: bricht in-flight GET /api/absenzen ab, wenn die Route
   * verlassen oder fetchAbsenzen() während eines noch laufenden Fetches
   * erneut gerufen wird. Aborts werfen DOMException 'AbortError' — den
   * fangen wir hier explizit ab. */
  let activeController: AbortController | null = null;

  async function fetchAbsenzen(): Promise<void> {
    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;
    const { signal } = controller;

    loading = true;
    error = null;
    try {
      const res = await getAbsenzen({ signal });
      if (signal.aborted) return;
      modules = indexRows(res.rows);
      totalCount = res.count;
      serverStats = res.stats;
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

  async function loadLektionenFor(code: string): Promise<void> {
    if (lektionenCache.has(code)) return;
    lektionenLoading = new Set(lektionenLoading).add(code);
    try {
      const res = await getAbsenzenLektionen(code);
      lektionenCache = new Map(lektionenCache).set(code, res.rows);
      if (lektionenError.has(code)) {
        const errs = new Map(lektionenError);
        errs.delete(code);
        lektionenError = errs;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Fehler beim Laden';
      lektionenError = new Map(lektionenError).set(code, msg);
    } finally {
      const next = new Set(lektionenLoading);
      next.delete(code);
      lektionenLoading = next;
    }
  }

  /* "Pending" id während wir die Tagesliste für eine eben geklickte Zeile
   * vor-laden. Die Trigger-Zeile zeigt einen dezenten Cue während der Wartezeit,
   * aber die Detail-Zeile mountet erst wenn Daten da sind — so kennt die
   * Slide-Animation die finale Höhe und rendert einen sauberen Reveal. */
  let pendingOpenId = $state<string | null>(null);

  async function toggleRow(r: IndexedAbsenzRow): Promise<void> {
    const id = rowKey(r);
    if (openId === id) {
      openId = null;
      return;
    }
    if (!lektionenCache.has(id) && !lektionenError.has(id)) {
      pendingOpenId = id;
      try {
        await loadLektionenFor(id);
      } finally {
        if (pendingOpenId !== id) return;
        pendingOpenId = null;
      }
    }
    // Mark seen — best-effort, fire-and-forget. isFresh wird hier bewusst
    // NICHT optimistic auf 0 gesetzt: der Server hält die frisch-Markierung
    // per IS_FRESH_SQL noch 24h aufrecht (Grace-Period). Der nächste Refetch
    // liefert den konsistenten Server-Stand. Join-Key ist der kuerzel_code.
    if (r.isFresh && r.kuerzel_code) {
      void markSeen('absenzen', [r.kuerzel_code]).catch(() => {
        // Silent — nächster Scrape reconciliert.
      });
    }
    openId = id;
  }

  // ------------------------------------------------------------------
  // Filter + sort derivations
  // ------------------------------------------------------------------

  function matchesTyp(m: IndexedAbsenzRow): boolean {
    const typ = (m.typ ?? '').toLowerCase();
    const isUek = /berbetrieb|ük|uek/.test(typ);
    if (activeTyp.has('uek') && isUek) return true;
    if (activeTyp.has('modul') && !isUek) return true;
    return false;
  }

  const filtered = $derived.by((): IndexedAbsenzRow[] => {
    const list = modules;
    if (!list) return [];
    const qNum = queryNumber.trim().toLowerCase();
    const qName = queryName.trim().toLowerCase();
    const typSize = activeTyp.size;
    // Hot path: keine Filter → Source-Identität (Sort-Step kopiert dann).
    if (!qNum && !qName && !typSize && !onlyUnterMin) return list;
    return list.filter((m) => {
      if (qNum && !m._codeLc.includes(qNum)) return false;
      if (qName && !m._nameLc.includes(qName)) return false;
      if (typSize && !matchesTyp(m)) return false;
      if (onlyUnterMin && !m._unterMin) return false;
      return true;
    });
  });

  const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });
  const collatorCompare = collator.compare;

  function sortValue(r: IndexedAbsenzRow, key: SortKey): string | number | null {
    switch (key) {
      case 'code':
        return r._codeLc || '￿';
      case 'name':
        return r._nameSortLc;
      case 'typ':
        return (r.typ ?? '').toLowerCase();
      case 'anwesenheit':
        return r.anwesenheit_pct;
      case 'soll':
        return r.soll;
      case 'updated':
        return r._fetchedAtMs || null;
      default:
        return null;
    }
  }

  const sorted = $derived.by((): IndexedAbsenzRow[] => {
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

  /** Quick-View-Anker. Nur vorhanden wenn etwas erwähnenswert ist. */
  const quickFilters = $derived.by((): Array<{ key: string; label: string; count: number; apply: () => void }> => {
    const list = modules;
    if (!list) return [];
    const out: Array<{ key: string; label: string; count: number; apply: () => void }> = [];
    const unterMinCount = list.filter((m) => m._unterMin).length;
    const freshCount = list.filter((m) => m.isFresh).length;
    if (unterMinCount > 0) {
      out.push({
        key: 'unter-min',
        label: `${unterMinCount} unter Minimum`,
        count: unterMinCount,
        apply: () => {
          activeTyp = new Set();
          queryNumber = '';
          queryName = '';
          onlyUnterMin = true;
          sortBy = 'anwesenheit';
          sortDir = 'asc';
        },
      });
    }
    if (freshCount > 0) {
      out.push({
        key: 'fresh',
        label: `${freshCount} neu`,
        count: freshCount,
        apply: () => {
          activeTyp = new Set();
          queryNumber = '';
          queryName = '';
          onlyUnterMin = false;
          sortBy = 'updated';
          sortDir = 'desc';
        },
      });
    }
    return out;
  });

  // ------------------------------------------------------------------
  // Sort + filter handlers
  // ------------------------------------------------------------------

  function clearFilters(): void {
    activeTyp = new Set();
    queryNumber = '';
    queryName = '';
    onlyUnterMin = false;
  }

  function setSort(key: SortKey): void {
    if (sortBy === key) {
      sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      sortBy = key;
      // Anwesenheit + Soll + Updated default absteigend; Text aufsteigend.
      sortDir = key === 'anwesenheit' || key === 'soll' || key === 'updated' ? 'desc' : 'asc';
    }
  }

  function focusSearchHandler(): void {
    requestAnimationFrame(() => searchInputEl?.focus());
  }

  function onScrapeEvent(): void {
    void fetchAbsenzen();
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  onMount(() => {
    void fetchAbsenzen();
    window.addEventListener('wissen:scrape', onScrapeEvent);
    window.addEventListener('wissen:focus-search', focusSearchHandler);
  });

  /* Deep-link aus Push/Dashboard: ?focus=<kuerzel_code> oder ?code=<…>.
   * Drei-Phasen: Zeile in den View scrollen → warten → Zeile aufklappen
   * + gelben Flash. */
  let didApplyFocus = $state(false);
  $effect(() => {
    if (didApplyFocus) return;
    if (loading || !modules || modules.length === 0) return;
    const focus = page.url.searchParams.get('focus') ?? page.url.searchParams.get('code');
    if (!focus) return;
    const target = modules.find((m) => m.kuerzel_code === focus);
    if (!target) return;
    const id = rowKey(target);
    didApplyFocus = true;

    requestAnimationFrame(() => {
      const sel = `[data-row-id="${CSS.escape(id)}"]`;
      const node = document.querySelector(sel);
      if (!(node instanceof HTMLElement)) return;

      node.scrollIntoView({ behavior: 'smooth', block: 'center' });

      setTimeout(() => {
        void toggleRow(target);
        requestAnimationFrame(() => {
          node.classList.add('is-flash');
          setTimeout(() => node.classList.remove('is-flash'), 2500);
        });
      }, 600);
    });
  });

  /* URL-state sync: queryNumber + activeTyp + onlyUnterMin + sortBy in die
   * searchParams spiegeln. replaceState statt push, damit der Back-Button
   * nicht durch jede Filter-Änderung tickt; noScroll+keepFocus damit das
   * Input den Fokus behält. */
  let initialUrlSyncDone = false;
  $effect(() => {
    /* State lesen, um Dependencies zu registrieren. */
    const q = queryNumber;
    const typs = activeTyp;
    const min = onlyUnterMin;
    const sort = sortBy;
    if (!initialUrlSyncDone) {
      initialUrlSyncDone = true;
      return;
    }
    const params = new URLSearchParams(page.url.searchParams);
    if (q.trim()) params.set('q', q);
    else params.delete('q');
    const typCsv = [...typs].sort().join(',');
    if (typCsv) params.set('typ', typCsv);
    else params.delete('typ');
    if (min) params.set('min', '1');
    else params.delete('min');
    if (sort !== 'anwesenheit') params.set('sortBy', sort);
    else params.delete('sortBy');
    const next = params.toString();
    const current = page.url.searchParams.toString();
    if (next === current) return;
    const url = next ? `${page.url.pathname}?${next}` : page.url.pathname;
    void goto(url, { replaceState: true, noScroll: true, keepFocus: true });
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
  <title>Absenzen · WISSen</title>
</svelte:head>

<section class="absenzen-route">
  <header class="route__head">
    <h1 class="route__title">Absenzen</h1>
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
      <button type="button" class="banner__btn" onclick={fetchAbsenzen}>Erneut versuchen</button>
    </div>
  {/if}

  <AbsenzenTiles {modules} stats={serverStats} {quickFilters} />

  <div class="card">
    <AbsenzenFilters
      bind:queryNumber
      bind:queryName
      bind:activeTyp
      bind:onlyUnterMin
      bind:searchInputEl
      onClear={clearFilters}
    />

    <AbsenzenTable
      {loading}
      {modules}
      {sorted}
      {sortBy}
      {sortDir}
      {openId}
      {pendingOpenId}
      {lektionenCache}
      {lektionenLoading}
      {lektionenError}
      {setSort}
      {toggleRow}
      {loadLektionenFor}
    />
  </div>
</section>

<style>
  .absenzen-route {
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
