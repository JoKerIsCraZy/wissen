<script lang="ts">
  import { tick } from 'svelte';
  import { peek } from '#lib/stores/peek.svelte.js';
  import { live } from '#lib/stores/live.svelte.js';

  function formatTs(iso: string): string {
    try {
      const d = new Date(iso);
      return d.toLocaleTimeString('de-CH', { hour12: false });
    } catch {
      return iso;
    }
  }

  // Show newest at the bottom, like a real terminal log.
  const lines = $derived(live.entries);

  // Auto-scroll behaviour: ride the bottom edge as new lines arrive, but
  // back off the moment the user scrolls up to read history. Treat
  // "within 24px of bottom" as pinned so a single missed pixel doesn't
  // unstick the follow.
  let bodyEl = $state<HTMLDivElement | null>(null);
  let pinnedToBottom = $state(true);

  function onBodyScroll(): void {
    if (!bodyEl) return;
    const distanceFromBottom =
      bodyEl.scrollHeight - bodyEl.clientHeight - bodyEl.scrollTop;
    pinnedToBottom = distanceFromBottom < 24;
  }

  function scrollToBottom(): void {
    if (!bodyEl) return;
    bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  // New line landed → if user was at the bottom, ride it down.
  // Reading `lines.length` registers the dependency on the entry array.
  $effect(() => {
    const _ = lines.length;
    void _;
    if (!peek.open || !bodyEl || !pinnedToBottom) return;
    void tick().then(scrollToBottom);
  });

  // Panel just opened → snap to bottom and reset pin state, regardless
  // of where the user was last time. Opening the panel implies "show me
  // what's happening now".
  $effect(() => {
    if (!peek.open || !bodyEl) return;
    pinnedToBottom = true;
    void tick().then(scrollToBottom);
  });
</script>

<aside
  class="peek"
  class:is-open={peek.open}
  aria-label="Live Logs"
  aria-hidden={!peek.open}
>
  <div class="peek__head">
    <span class="peek__title">
      <span class="peek__led" class:peek__led--off={live.connection !== 'open'} aria-hidden="true"></span>
      Live-Log
      <span class="peek__count mono">{lines.length}</span>
    </span>
    <button
      class="peek__close"
      type="button"
      onclick={() => peek.hide()}
      aria-label="Logs schließen"
    >
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    </button>
  </div>
  <div class="peek__body" bind:this={bodyEl} onscroll={onBodyScroll}>
    {#if lines.length === 0}
      <div class="peek__empty">
        {#if live.connection === 'open'}
          Noch keine Log-Einträge.
        {:else if live.connection === 'reconnecting'}
          Verbindung wird wiederhergestellt …
        {:else if live.connection === 'connecting'}
          Verbinde mit Server …
        {:else}
          Keine Verbindung.
        {/if}
      </div>
    {:else}
      {#each lines as line, i (i)}
        <div class="log-row lv-{line.level}">
          <span class="log-row__ts">{formatTs(line.ts)}</span>
          <span class="log-row__lv">{line.level}</span>
          <span class="log-row__msg">{line.message}</span>
        </div>
      {/each}
    {/if}
  </div>
</aside>

<style>
  .peek {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: var(--peek-w);
    background: var(--surface);
    border-left: 1px solid var(--border);
    z-index: 30;
    display: flex;
    flex-direction: column;
    transform: translateX(100%);
    transition: transform var(--t-slow) var(--ease);
    box-shadow: var(--shadow-lg);
  }
  .peek.is-open { transform: translateX(0); }

  .peek__head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 14px 16px;
    border-bottom: 1px solid var(--border-soft);
    flex-shrink: 0;
  }
  .peek__title {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.02em;
  }
  .peek__led {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--success);
    box-shadow: 0 0 0 0 rgba(76, 201, 160, 0.6);
    animation: pulseGreen 2.4s var(--ease) infinite;
  }
  .peek__count {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-dim);
    padding: 2px 7px;
    background: var(--surface-2);
    border-radius: 999px;
    border: 1px solid var(--border-soft);
  }
  .peek__close {
    margin-left: auto;
    width: 28px;
    height: 28px;
    border-radius: var(--r-md);
    display: grid;
    place-items: center;
    color: var(--text-mute);
    transition:
      background var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease);
  }
  .peek__close:hover {
    background: var(--surface-2);
    color: var(--text);
  }

  .peek__body {
    flex: 1;
    overflow-y: auto;
    padding: 8px 12px;
    font-family: var(--font-mono);
    font-feature-settings: "tnum" 1;
    font-size: 12px;
    line-height: 1.55;
    background: var(--bg-deep);
  }
  .log-row {
    display: grid;
    grid-template-columns: 56px 50px 1fr;
    gap: 8px;
    padding: 3px 0;
    color: var(--text-mute);
  }
  .log-row__ts { color: var(--text-dim); }
  .log-row__lv {
    text-transform: uppercase;
    font-size: 10px;
    letter-spacing: 0.08em;
    padding-top: 2px;
  }
  .log-row__msg {
    color: var(--text);
    word-break: break-word;
  }
  .log-row.lv-info     .log-row__lv { color: var(--accent); }
  .log-row.lv-warn     .log-row__lv { color: var(--warning); }
  .log-row.lv-error    .log-row__lv { color: var(--danger); }
  .log-row.lv-progress .log-row__lv { color: var(--success); }
  .log-row.lv-debug    .log-row__lv { color: var(--text-dim); }

  .peek__led--off {
    background: var(--text-dim) !important;
    box-shadow: none !important;
    animation: none !important;
  }
  .peek__empty {
    padding: 18px 14px;
    color: var(--text-dim);
    font-size: 12px;
    text-align: center;
    font-style: italic;
  }

  @media (prefers-reduced-motion: reduce) {
    .peek {
      transition: opacity var(--t) var(--ease);
    }
    .peek__led {
      animation: none;
      opacity: 0.7;
    }
  }

  @media (max-width: 720px) {
    .peek {
      width: calc(100vw - 24px);
      max-width: 100vw;
    }
  }
</style>
