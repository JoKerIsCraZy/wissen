<script lang="ts">
  /* Suche (Code + Name) + Filter-Chips für /absenzen.
   * Spiegelt NotenFilters: zwei getrennte Query-Bindings (Code-Nr. + Name),
   * dazu Typ-Chips (Modul / ÜK) und ein „Unter Minimum“-Chip. Der
   * `searchInputEl`-Ref zeigt auf das NAME-Input — Ziel des globalen
   * '/'-Shortcuts.
   */
  interface Props {
    queryNumber: string;
    queryName: string;
    activeTyp: Set<'modul' | 'uek'>;
    onlyUnterMin: boolean;
    searchInputEl: HTMLInputElement | null;
    onClear: () => void;
  }

  let {
    queryNumber = $bindable(),
    queryName = $bindable(),
    activeTyp = $bindable(),
    onlyUnterMin = $bindable(),
    searchInputEl = $bindable(),
    onClear,
  }: Props = $props();

  function toggleTyp(t: 'modul' | 'uek'): void {
    const next = new Set(activeTyp);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    activeTyp = next;
  }

  function toggleUnterMin(): void {
    onlyUnterMin = !onlyUnterMin;
  }

  function onNumberKey(e: KeyboardEvent): void {
    if (e.key === 'Escape' && queryNumber) {
      e.preventDefault();
      queryNumber = '';
    }
  }
  function onNameKey(e: KeyboardEvent): void {
    if (e.key === 'Escape' && queryName) {
      e.preventDefault();
      queryName = '';
    }
  }
</script>

<div class="toolbar">
  <!-- Modul-Code-Filter: kurzes, mono Input. -->
  <div class="search search--number">
    <span class="search__lbl mono" aria-hidden="true">#</span>
    <input
      bind:value={queryNumber}
      onkeydown={onNumberKey}
      type="search"
      placeholder="Code"
      aria-label="Nach Modul-Code filtern"
      class="mono"
    />
  </div>

  <!-- Modul-Name-Filter: breites Input, '/'-Shortcut-Ziel. -->
  <div class="search search--name">
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
    <input
      bind:this={searchInputEl}
      bind:value={queryName}
      onkeydown={onNameKey}
      type="search"
      placeholder="Modul suchen..."
      aria-label="Nach Modul-Bezeichnung filtern"
      data-search
    />
    <span class="search__kbd" aria-hidden="true">/</span>
  </div>

  <div class="chips" role="group" aria-label="Filter">
    <button
      type="button"
      class="chip"
      class:is-active={activeTyp.has('modul')}
      aria-pressed={activeTyp.has('modul')}
      onclick={() => toggleTyp('modul')}
    >
      <span class="chip__dot" aria-hidden="true"></span>Modul
    </button>
    <button
      type="button"
      class="chip"
      class:is-active={activeTyp.has('uek')}
      aria-pressed={activeTyp.has('uek')}
      onclick={() => toggleTyp('uek')}
    >
      <span class="chip__dot" aria-hidden="true"></span>ÜK
    </button>
    <button
      type="button"
      class="chip chip--warn"
      class:is-active={onlyUnterMin}
      aria-pressed={onlyUnterMin}
      onclick={toggleUnterMin}
    >
      <span class="chip__dot" aria-hidden="true"></span>Unter Minimum
    </button>
    {#if activeTyp.size + (onlyUnterMin ? 1 : 0) + (queryNumber ? 1 : 0) + (queryName ? 1 : 0) > 0}
      <button type="button" class="chip chip--clear" onclick={onClear}>
        Zurücksetzen
      </button>
    {/if}
  </div>
</div>

<style>
  .mono {
    font-family: var(--font-mono);
    font-feature-settings: 'tnum' 1, 'zero' 1;
  }

  .toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border-soft);
  }

  .search {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    color: var(--text-mute);
    transition:
      border-color var(--t-fast) var(--ease),
      background var(--t-fast) var(--ease);
  }
  .search--number {
    min-width: 120px;
    flex: 0 0 auto;
  }
  .search--number .search__lbl {
    color: var(--text-dim);
    font-size: 13px;
    font-weight: 600;
  }
  .search--name {
    min-width: 220px;
    flex: 1;
    max-width: 380px;
  }
  .search:focus-within {
    border-color: var(--accent-border);
    background: var(--surface);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
  .search input {
    background: transparent;
    border: 0;
    outline: 0;
    color: var(--text);
    width: 100%;
    font-size: 13px;
  }
  .search input:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .search input::placeholder { color: var(--text-dim); }
  .search input::-webkit-search-cancel-button { display: none; }
  .search__kbd {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-dim);
    background: var(--surface-2);
    padding: 2px 5px;
    border-radius: 3px;
    border: 1px solid var(--border-soft);
    letter-spacing: 0.04em;
  }

  /* ---------- Chips (multi-select, combinable) ---------- */
  .chips {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 11px;
    border-radius: 999px;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    color: var(--text-mute);
    font-size: 12px;
    font-weight: 500;
    letter-spacing: 0.02em;
    transition:
      background var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease),
      border-color var(--t-fast) var(--ease);
  }
  @media (hover: hover) and (pointer: fine) {
    .chip:hover {
      color: var(--text);
      border-color: var(--border-strong, #3a4152);
    }
  }
  .chip__dot {
    width: 6px;
    height: 6px;
    border-radius: 999px;
    background: transparent;
    border: 1px solid currentColor;
    opacity: 0.55;
    transition:
      background-color var(--t-fast) var(--ease),
      border-color var(--t-fast) var(--ease),
      opacity var(--t-fast) var(--ease);
  }
  .chip.is-active {
    background: var(--accent-soft);
    color: var(--accent);
    border-color: var(--accent-border);
  }
  .chip.is-active .chip__dot {
    background: var(--accent);
    border-color: var(--accent);
    opacity: 1;
  }
  /* „Unter Minimum“ ist ein Warn-Filter — aktiv in Warn-Ton statt Accent,
   * damit die semantische Bedeutung (Risiko) auch farblich trägt. */
  .chip--warn.is-active {
    background: var(--warning-soft-strong);
    color: var(--warning);
    border-color: var(--warning-border);
  }
  .chip--warn.is-active .chip__dot {
    background: var(--warning);
    border-color: var(--warning);
    opacity: 1;
  }
  .chip--clear {
    background: transparent;
    border-color: var(--border-soft);
    color: var(--text-dim);
  }
  @media (hover: hover) and (pointer: fine) {
    .chip--clear:hover {
      color: var(--text);
      background: var(--surface-2);
    }
  }

  @media (pointer: coarse) {
    .chip { min-height: 44px; }
  }

  @media (prefers-reduced-motion: reduce) {
    .chip { transition: none; }
    .search { transition: none; }
  }
</style>
