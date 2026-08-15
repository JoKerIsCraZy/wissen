<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { base } from '$app/paths';
  import { peek } from '$lib/stores/peek.svelte';
  import { getRouteId, type RouteId } from '$lib/stores/route.svelte';
  import { logout } from '$lib/auth';

  interface NavItem {
    id: RouteId;
    label: string;
    route: string;
    shortcut: string;
  }

  const navItems: NavItem[] = [
    { id: 'now',         label: 'Aktuell',      route: '/',             shortcut: 'g j' },
    { id: 'stundenplan', label: 'Stundenplan',  route: '/stundenplan',  shortcut: 'g s' },
    { id: 'noten',       label: 'Noten',        route: '/noten',        shortcut: 'g n' },
    { id: 'absenzen',    label: 'Absenzen',     route: '/absenzen',     shortcut: 'g b' },
    { id: 'stats',       label: 'Statistik',    route: '/stats',        shortcut: 'g a' },
    { id: 'settings',    label: 'Einstellungen', route: '/settings',    shortcut: 'g e' },
    { id: 'push',        label: 'Push',         route: '/push',         shortcut: 'g p' },
    { id: 'telegram',    label: 'Telegram',     route: '/telegram',     shortcut: 'g t' },
  ];

  let activeId = $derived<RouteId>(getRouteId(page.url.pathname));

  function navigate(route: string): void {
    void goto(`${base}${route}`);
  }

  function onLogout(): void {
    void logout(base, goto);
  }
</script>

<aside class="rail" aria-label="Hauptnavigation">
  <div class="rail__brand">
    <div class="rail__mark" aria-hidden="true">
      <img
        class="rail__mark-img"
        src={`${base}/assets/logo.webp`}
        alt=""
        width="40"
        height="40"
        decoding="async"
      />
    </div>
    <div class="rail__brand-name">WISS<span>en</span></div>
  </div>

  <nav class="rail__nav">
    {#each navItems as item, i (item.id)}
      {#if i === 5}
        <div class="rail__divider" aria-hidden="true"></div>
      {/if}
      <button
        type="button"
        class="rail__item"
        class:is-active={activeId === item.id}
        onclick={() => navigate(item.route)}
        aria-current={activeId === item.id ? 'page' : undefined}
      >
        <span class="rail__icon">
          {#if item.id === 'now'}
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>
          {:else if item.id === 'stundenplan'}
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="17" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="8" y1="4" x2="8" y2="2"/><line x1="16" y1="4" x2="16" y2="2"/></svg>
          {:else if item.id === 'noten'}
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4h12a4 4 0 0 1 4 4v12H8a4 4 0 0 1-4-4V4z"/><line x1="8" y1="9" x2="16" y2="9"/><line x1="8" y1="13" x2="14" y2="13"/></svg>
          {:else if item.id === 'absenzen'}
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="17" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="8" y1="4" x2="8" y2="2"/><line x1="16" y1="4" x2="16" y2="2"/><line x1="9.5" y1="14.5" x2="14.5" y2="18.5"/><line x1="14.5" y1="14.5" x2="9.5" y2="18.5"/></svg>
          {:else if item.id === 'stats'}
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="4" y1="20" x2="4" y2="10"/><line x1="10" y1="20" x2="10" y2="4"/><line x1="16" y1="20" x2="16" y2="14"/><line x1="22" y1="20" x2="22" y2="8"/></svg>
          {:else if item.id === 'settings'}
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          {:else if item.id === 'push'}
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a1.85 1.85 0 0 1-3.4 0"/></svg>
          {:else if item.id === 'telegram'}
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4 20-7Z"/><path d="M22 2 11 13"/></svg>
          {/if}
        </span>
        <span class="rail__label">{item.label}</span>
        <span class="rail__kbd">{item.shortcut}</span>
      </button>
    {/each}
  </nav>

  <div class="rail__bottom">
    <button
      type="button"
      class="rail__item"
      class:is-active={peek.open}
      onclick={() => peek.toggle()}
      title="Logs öffnen (Cmd+L)"
    >
      <span class="rail__icon">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
      </span>
      <span class="rail__label">Logs</span>
      <span class="rail__kbd">⌘L</span>
    </button>
    <button
      type="button"
      class="rail__item"
      onclick={() => { window.location.href = '/mobile/'; }}
      title="Mobile-Ansicht"
    >
      <span class="rail__icon">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="2" width="14" height="20" rx="2.5"/><line x1="10" y1="18" x2="14" y2="18"/></svg>
      </span>
      <span class="rail__label">Mobile</span>
    </button>
    <button
      type="button"
      class="rail__item"
      onclick={onLogout}
      title="Abmelden"
    >
      <span class="rail__icon">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
      </span>
      <span class="rail__label">Abmelden</span>
    </button>
  </div>
</aside>

<style>
  .rail {
    position: relative;
    z-index: 25;
    background: var(--bg);
    border-right: 1px solid var(--border-soft);
    display: flex;
    flex-direction: column;
    width: var(--rail-w);
    overflow: hidden;
    height: 100vh;
  }

  .rail__brand {
    display: flex;
    align-items: center;
    gap: 12px;
    height: 64px;
    padding: 0 16px;
    border-bottom: 1px solid var(--border-soft);
    flex-shrink: 0;
  }
  .rail__mark {
    width: 40px;
    height: 40px;
    flex-shrink: 0;
    border-radius: 9px;
    overflow: hidden;
    /* Solid background fallback if the PNG is being fetched / has alpha
     * holes, so the brand mark never flashes the page background. */
    background: var(--surface-2);
  }
  .rail__mark-img {
    width: 100%;
    height: 100%;
    display: block;
    object-fit: cover;
    /* Source PNG has a transparent margin around the squircle. Scaling
     * up + clipping via the parent's overflow:hidden makes the actual
     * logo fill the 40×40 box edge-to-edge. */
    transform: scale(1.4);
  }
  .rail__brand-name {
    font-weight: 600;
    font-size: 15px;
    letter-spacing: -0.01em;
    white-space: nowrap;
    color: var(--text);
  }
  .rail__brand-name :global(span) {
    color: inherit;
    font-weight: inherit;
  }

  .rail__nav {
    flex: 1;
    padding: 12px 8px;
    overflow-y: auto;
    overflow-x: hidden;
    scrollbar-width: thin;
    scrollbar-color: var(--border) transparent;
  }
  .rail__nav::-webkit-scrollbar { width: 6px; }
  .rail__nav::-webkit-scrollbar-thumb { background: var(--border); border-radius: 999px; }

  .rail__bottom {
    padding: 8px;
    border-top: 1px solid var(--border-soft);
    flex-shrink: 0;
  }

  /* CSS-Grid statt Flex: ICON | LABEL | KBD-Reserve mit fixen
   * Spalten-Tracks. Jeder Punkt — egal ob er einen Shortcut hat oder
   * nicht — reserviert die rechte Spalte. Damit landen Labels und
   * Icons aller Items (Top-Nav UND Bottom-Sektion) garantiert im
   * gleichen X-Raster, statt dass kbd-lose Items ihre Label-Box
   * über die Shortcut-Spalte ausdehnen lassen. */
  .rail__item {
    position: relative;
    display: grid;
    grid-template-columns: 16px 1fr 24px;
    column-gap: 12px;
    align-items: center;
    width: 100%;
    height: 36px;
    padding: 0 12px;
    border-radius: var(--r-md);
    color: var(--text-mute);
    font-size: 13px;
    font-weight: 500;
    white-space: nowrap;
    text-align: left;
    transition:
      background var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease);
    text-decoration: none;
  }
  .rail__item + .rail__item { margin-top: 2px; }
  @media (hover: hover) and (pointer: fine) {
    .rail__item:hover { background: var(--surface-2); color: var(--text); text-decoration: none; }
  }
  .rail__item.is-active {
    background: var(--accent-soft);
    color: var(--accent);
  }

  .rail__icon {
    width: 16px;
    height: 16px;
    display: grid;
    place-items: center;
    color: currentColor;
  }
  .rail__label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .rail__kbd {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-dim);
    letter-spacing: 0.04em;
    justify-self: end;
  }

  .rail__divider {
    height: 1px;
    background: var(--border-soft);
    margin: 8px 4px;
  }

  /* Mobile: rail is replaced by the bottom MobileTabBar. */
  @media (max-width: 720px) {
    .rail { display: none; }
  }
</style>
