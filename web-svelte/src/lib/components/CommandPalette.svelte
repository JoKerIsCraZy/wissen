<script lang="ts">
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import { peek } from '$lib/stores/peek.svelte';

  interface PaletteProps {
    open?: boolean;
    onHelpOpen?: () => void;
  }

  let { open = $bindable(false), onHelpOpen }: PaletteProps = $props();

  interface PaletteItem {
    id: string;
    label: string;
    icon: string;
    hint?: string;
    action: () => void;
  }

  const items: PaletteItem[] = [
    { id: 'r-now',         label: 'Jetzt öffnen',         icon: '⊙', hint: 'g j', action: () => { void goto(`${base}/`); } },
    { id: 'r-stundenplan', label: 'Stundenplan öffnen',  icon: '☷', hint: 'g s', action: () => { void goto(`${base}/stundenplan`); } },
    { id: 'r-noten',       label: 'Noten öffnen',        icon: '◎', hint: 'g n', action: () => { void goto(`${base}/noten`); } },
    { id: 'r-absenzen',    label: 'Absenzen öffnen',     icon: '⦸', hint: 'g b', action: () => { void goto(`${base}/absenzen`); } },
    { id: 'r-stats',       label: 'Auswertung öffnen',   icon: '⌘', hint: 'g a', action: () => { void goto(`${base}/stats`); } },
    { id: 'r-settings',    label: 'Einstellungen öffnen', icon: '⚙', hint: 'g e', action: () => { void goto(`${base}/settings`); } },
    { id: 'r-push',        label: 'Push öffnen',         icon: '⤴', hint: 'g p', action: () => { void goto(`${base}/push`); } },
    { id: 'r-telegram',    label: 'Telegram öffnen',     icon: '⏚', hint: 'g t', action: () => { void goto(`${base}/telegram`); } },
    { id: 'a-scrape',      label: 'Scrape jetzt starten', icon: '►', hint: 'r', action: () => { window.dispatchEvent(new CustomEvent('wissen:scrape')); } },
    { id: 'a-logs',        label: 'Logs umschalten',     icon: '☰', hint: '⌘L', action: () => { peek.toggle(); } },
    { id: 'a-help',        label: 'Tastatur-Hilfe',      icon: '?', hint: '?', action: () => { if (onHelpOpen) onHelpOpen(); } },
    { id: 'a-logout',      label: 'Abmelden',            icon: '⏻',           action: () => { void goto(`${base}/login`); } },
  ];

  let query = $state('');
  let activeIndex = $state(0);
  let inputEl: HTMLInputElement | undefined = $state();

  const filtered = $derived(
    !query.trim()
      ? items
      : items.filter((it) => it.label.toLowerCase().includes(query.toLowerCase()))
  );

  $effect(() => {
    if (open) {
      query = '';
      activeIndex = 0;
      // Focus the input on next tick.
      queueMicrotask(() => inputEl?.focus());
    }
  });

  // Reset active index when filter changes.
  $effect(() => {
    void filtered;
    if (activeIndex >= filtered.length) activeIndex = 0;
  });

  function close(): void {
    open = false;
  }

  function pick(item: PaletteItem): void {
    item.action();
    close();
  }

  function onKeydown(e: KeyboardEvent): void {
    if (!open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, filtered.length - 1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const it = filtered[activeIndex];
      if (it) pick(it);
      return;
    }
  }

  function onBackdrop(e: MouseEvent): void {
    if (e.target === e.currentTarget) close();
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
  <!-- Backdrop click closes the palette. Keyboard close is handled by the
       window-level Escape handler in onKeydown above, so the matching
       onkeydown on this element would be redundant. -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="overlay"
    role="dialog"
    aria-modal="true"
    aria-label="Befehle"
    tabindex="-1"
    onclick={onBackdrop}
  >
    <div class="palette" role="presentation">
      <input
        bind:this={inputEl}
        bind:value={query}
        class="palette__input"
        type="text"
        placeholder="Tippe einen Befehl oder Route..."
        autocomplete="off"
        aria-label="Befehl suchen"
      />
      <div class="palette__list" role="listbox">
        {#each filtered as item, i (item.id)}
          <button
            type="button"
            class="palette__row"
            class:is-active={i === activeIndex}
            onclick={() => pick(item)}
            onmousemove={() => (activeIndex = i)}
            role="option"
            aria-selected={i === activeIndex}
          >
            <span class="palette__row__icon mono">{item.icon}</span>
            <span class="palette__row__title">{item.label}</span>
            <span class="palette__row__hint">{item.hint ?? '↵'}</span>
          </button>
        {/each}
        {#if filtered.length === 0}
          <div class="palette__empty">Keine Treffer.</div>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 80;
    display: grid;
    place-items: start center;
    padding: 80px 20px 20px;
    background: rgba(5, 8, 14, 0.65);
    animation: fadeOverlay 180ms var(--ease);
  }

  .palette {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-xl);
    width: min(540px, 100%);
    max-height: 60vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: var(--shadow-lg);
    animation: pop 160ms var(--ease);
  }
  .palette__input {
    background: transparent;
    border: 0;
    border-bottom: 1px solid var(--border-soft);
    padding: 14px 18px;
    font-size: 14px;
    color: var(--text);
    outline: 0;
  }
  .palette__input::placeholder { color: var(--text-dim); }

  .palette__list {
    flex: 1;
    overflow-y: auto;
    padding: 6px;
  }
  .palette__row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 12px;
    border-radius: var(--r-md);
    font-size: 13px;
    color: var(--text);
    cursor: pointer;
    width: 100%;
    text-align: left;
    background: transparent;
    border: 0;
    transition:
      background var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease);
  }
  .palette__row.is-active {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .palette__row__icon {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    color: currentColor;
    display: grid;
    place-items: center;
  }
  .palette__row__title {
    flex: 1;
  }
  .palette__row__hint {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-dim);
    letter-spacing: 0.04em;
  }

  .palette__empty {
    padding: 14px;
    color: var(--text-dim);
    font-size: 13px;
    text-align: center;
  }

  @media (prefers-reduced-motion: reduce) {
    .overlay,
    .palette { animation: none; }
  }
</style>
