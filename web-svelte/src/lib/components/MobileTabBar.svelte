<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { base } from '$app/paths';
  import { peek } from '$lib/stores/peek.svelte';
  import { getRouteId, type RouteId } from '$lib/stores/route.svelte';
  import { logout } from '$lib/auth';

  interface TabItem {
    id: RouteId | 'more';
    label: string;
    route?: string;
  }

  const tabs: TabItem[] = [
    { id: 'now',         label: 'Aktuell', route: '/' },
    { id: 'stundenplan', label: 'Plan',  route: '/stundenplan' },
    { id: 'noten',       label: 'Noten', route: '/noten' },
    { id: 'stats',       label: 'Stats', route: '/stats' },
    { id: 'more',        label: 'Mehr' },
  ];

  // Active id: derive from route. The 'more' tab is active when on
  // settings/push/telegram (overflow surfaces) OR when the sheet is open.
  let routeId = $derived<RouteId>(getRouteId(page.url.pathname));
  let sheetOpen = $state<boolean>(false);

  const overflowRoutes: RouteId[] = ['absenzen', 'settings', 'push', 'telegram'];
  let moreActive = $derived(sheetOpen || overflowRoutes.includes(routeId));

  function isTabActive(tab: TabItem): boolean {
    if (tab.id === 'more') return moreActive;
    return routeId === tab.id;
  }

  function navigate(route: string): void {
    sheetOpen = false;
    void goto(`${base}${route}`);
  }

  function onTab(tab: TabItem): void {
    if (tab.id === 'more') {
      sheetOpen = !sheetOpen;
      return;
    }
    if (tab.route) navigate(tab.route);
  }

  // Sheet drag-to-dismiss: simple touch threshold.
  let dragStartY = $state<number | null>(null);
  let dragDelta = $state<number>(0);

  function onSheetTouchStart(e: TouchEvent): void {
    dragStartY = e.touches[0]?.clientY ?? null;
    dragDelta = 0;
  }
  function onSheetTouchMove(e: TouchEvent): void {
    if (dragStartY === null) return;
    const y = e.touches[0]?.clientY ?? dragStartY;
    const d = y - dragStartY;
    dragDelta = d > 0 ? d : 0;
  }
  function onSheetTouchEnd(): void {
    if (dragDelta > 80) sheetOpen = false;
    dragStartY = null;
    dragDelta = 0;
  }

  // Esc closes the sheet.
  $effect(() => {
    if (!sheetOpen) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.stopPropagation();
        sheetOpen = false;
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  function onLogout(): void {
    sheetOpen = false;
    void logout(base, goto);
  }

  function onLogsToggle(): void {
    sheetOpen = false;
    peek.toggle();
  }
</script>

<nav class="mobile-tabbar" aria-label="Mobile-Navigation">
  {#each tabs as tab (tab.id)}
    <button
      type="button"
      class="tab"
      class:is-active={isTabActive(tab)}
      onclick={() => onTab(tab)}
      aria-current={isTabActive(tab) && tab.id !== 'more' ? 'page' : undefined}
      aria-expanded={tab.id === 'more' ? sheetOpen : undefined}
    >
      <span class="tab__icon" aria-hidden="true">
        {#if tab.id === 'now'}
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>
        {:else if tab.id === 'stundenplan'}
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="17" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="8" y1="4" x2="8" y2="2"/><line x1="16" y1="4" x2="16" y2="2"/></svg>
        {:else if tab.id === 'noten'}
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h12a4 4 0 0 1 4 4v12H8a4 4 0 0 1-4-4V4z"/><line x1="8" y1="9" x2="16" y2="9"/><line x1="8" y1="13" x2="14" y2="13"/></svg>
        {:else if tab.id === 'stats'}
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="20" x2="4" y2="10"/><line x1="10" y1="20" x2="10" y2="4"/><line x1="16" y1="20" x2="16" y2="14"/><line x1="22" y1="20" x2="22" y2="8"/></svg>
        {:else if tab.id === 'more'}
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>
        {/if}
      </span>
      <span class="tab__label">{tab.label}</span>
    </button>
  {/each}
</nav>

{#if sheetOpen}
  <!-- Backdrop -->
  <button
    type="button"
    class="sheet__backdrop"
    aria-label="Menü schließen"
    onclick={() => (sheetOpen = false)}
  ></button>

  <!-- Sheet -->
  <div
    class="sheet"
    role="dialog"
    aria-label="Mehr"
    aria-modal="true"
    tabindex="-1"
    style:transform={dragDelta > 0 ? `translateY(${dragDelta}px)` : undefined}
    ontouchstart={onSheetTouchStart}
    ontouchmove={onSheetTouchMove}
    ontouchend={onSheetTouchEnd}
    ontouchcancel={onSheetTouchEnd}
  >
    <div class="sheet__handle" aria-hidden="true"></div>
    <div class="sheet__title">Mehr</div>
    <div class="sheet__list">
      <button
        type="button"
        class="sheet__item"
        class:is-active={routeId === 'absenzen'}
        onclick={() => navigate('/absenzen')}
      >
        <span class="sheet__icon">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="17" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="8" y1="4" x2="8" y2="2"/><line x1="16" y1="4" x2="16" y2="2"/><line x1="9.5" y1="14.5" x2="14.5" y2="18.5"/><line x1="14.5" y1="14.5" x2="9.5" y2="18.5"/></svg>
        </span>
        <span class="sheet__label">Absenzen</span>
        <span class="sheet__chev" aria-hidden="true">›</span>
      </button>

      <div class="sheet__divider" aria-hidden="true"></div>

      <button
        type="button"
        class="sheet__item"
        class:is-active={routeId === 'settings'}
        onclick={() => navigate('/settings')}
      >
        <span class="sheet__icon">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        </span>
        <span class="sheet__label">Einstellungen</span>
        <span class="sheet__chev" aria-hidden="true">›</span>
      </button>

      <button
        type="button"
        class="sheet__item"
        class:is-active={routeId === 'push'}
        onclick={() => navigate('/push')}
      >
        <span class="sheet__icon">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a1.85 1.85 0 0 1-3.4 0"/></svg>
        </span>
        <span class="sheet__label">Push</span>
        <span class="sheet__chev" aria-hidden="true">›</span>
      </button>

      <button
        type="button"
        class="sheet__item"
        class:is-active={routeId === 'telegram'}
        onclick={() => navigate('/telegram')}
      >
        <span class="sheet__icon">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4 20-7Z"/><path d="M22 2 11 13"/></svg>
        </span>
        <span class="sheet__label">Telegram</span>
        <span class="sheet__chev" aria-hidden="true">›</span>
      </button>

      <div class="sheet__divider" aria-hidden="true"></div>

      <button type="button" class="sheet__item" onclick={onLogsToggle}>
        <span class="sheet__icon">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
        </span>
        <span class="sheet__label">Logs {peek.open ? 'schließen' : 'öffnen'}</span>
        <span class="sheet__chev" aria-hidden="true">›</span>
      </button>

      <a class="sheet__item" href="/mobile/" data-sveltekit-reload onclick={() => (sheetOpen = false)}>
        <span class="sheet__icon">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2" width="12" height="20" rx="2.5"/><line x1="11" y1="18" x2="13" y2="18"/></svg>
        </span>
        <span class="sheet__label">Mobile</span>
        <span class="sheet__chev" aria-hidden="true">›</span>
      </a>

      <div class="sheet__divider" aria-hidden="true"></div>

      <button type="button" class="sheet__item sheet__item--danger" onclick={onLogout}>
        <span class="sheet__icon">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
        </span>
        <span class="sheet__label">Abmelden</span>
        <span class="sheet__chev" aria-hidden="true">›</span>
      </button>
    </div>
  </div>
{/if}

<style>
  /* ============================================================
     Bottom Tab Bar
     ============================================================ */
  .mobile-tabbar {
    display: none;
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 40;
    height: calc(var(--tabbar-h, 56px) + env(safe-area-inset-bottom));
    padding-bottom: env(safe-area-inset-bottom);
    background: var(--bg-elev);
    box-shadow: 0 -1px 0 var(--border);
    align-items: stretch;
    justify-content: space-around;
  }

  @media (max-width: 720px) {
    .mobile-tabbar { display: flex; }
  }

  .tab {
    flex: 1 1 0;
    min-width: 44px;
    min-height: 44px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    padding: 6px 4px;
    color: var(--text-mute);
    background: transparent;
    border: none;
    transition:
      color var(--t-fast) var(--ease),
      background var(--t-fast) var(--ease);
  }
  .tab:active { background: var(--surface-2); }

  .tab__icon {
    display: grid;
    place-items: center;
    width: 36px;
    height: 28px;
    border-radius: 999px;
    transition:
      background var(--t) var(--ease),
      color var(--t) var(--ease);
  }
  .tab__label {
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.01em;
  }
  .tab.is-active { color: var(--accent); }
  .tab.is-active .tab__icon {
    background: var(--accent-soft);
    color: var(--accent);
  }

  /* ============================================================
     Mehr-Sheet
     ============================================================ */
  .sheet__backdrop {
    position: fixed;
    inset: 0;
    z-index: 50;
    background: rgba(0, 0, 0, 0.5);
    border: none;
    cursor: pointer;
    animation: sheetFade 160ms var(--ease);
  }

  .sheet {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 51;
    max-height: 60vh;
    background: var(--surface);
    border-top: 1px solid var(--border);
    border-radius: 16px 16px 0 0;
    box-shadow: var(--shadow-lg);
    padding: 8px 0 calc(12px + env(safe-area-inset-bottom));
    display: flex;
    flex-direction: column;
    animation: sheetUp 220ms var(--ease);
    overflow: hidden;
    touch-action: pan-y;
  }

  .sheet__handle {
    width: 40px;
    height: 4px;
    background: var(--border);
    border-radius: 999px;
    margin: 6px auto 8px;
    flex-shrink: 0;
  }
  .sheet__title {
    padding: 4px 20px 8px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-dim);
  }
  .sheet__list {
    overflow-y: auto;
    flex: 1;
    padding: 4px 8px 8px;
  }

  .sheet__item {
    display: flex;
    align-items: center;
    gap: 14px;
    width: 100%;
    min-height: 48px;
    padding: 10px 14px;
    border-radius: var(--r-md);
    background: transparent;
    border: none;
    color: var(--text);
    font-size: 14px;
    font-weight: 500;
    text-align: left;
    text-decoration: none;
    transition:
      background var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease);
  }
  .sheet__item:active { background: var(--surface-2); }
  .sheet__item.is-active {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .sheet__item--danger { color: var(--danger); }
  .sheet__item--danger:active { background: rgba(255, 107, 107, 0.08); }

  .sheet__icon {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    flex-shrink: 0;
    color: currentColor;
  }
  .sheet__label { flex: 1; }
  .sheet__chev {
    color: var(--text-dim);
    font-size: 18px;
    line-height: 1;
  }

  .sheet__divider {
    height: 1px;
    background: var(--border-soft);
    margin: 6px 14px;
  }

  @keyframes sheetUp {
    from { transform: translateY(100%); }
    to   { transform: translateY(0); }
  }
  @keyframes sheetFade {
    from { opacity: 0; }
    to   { opacity: 1; }
  }

  @media (prefers-reduced-motion: reduce) {
    .sheet,
    .sheet__backdrop {
      animation: none;
    }
    .tab__icon { transition: none; }
  }
</style>
