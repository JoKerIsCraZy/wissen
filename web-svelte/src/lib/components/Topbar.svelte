<script module lang="ts">
  // StatusKind lebt in $lib/api/types (geteiltes .ts-Modul). Hier nur als
  // Komfort-Re-Export, damit bestehende Konsumenten weiter funktionieren —
  // ein `import type` aus einer .svelte-Datei schlägt sonst mit TS2614 fehl.
  export type { StatusKind } from '$lib/api/types';
</script>

<script lang="ts">
  import type { StatusKind } from '$lib/api/types';

  interface TopbarProps {
    status?: StatusKind;
    statusLabel?: string;
    lastrun?: string;
    onScrape?: () => void;
    onPalette?: () => void;
  }

  let {
    status = 'idle',
    statusLabel = 'Bereit',
    lastrun = 'vor 12 min',
    onScrape,
    onPalette,
  }: TopbarProps = $props();

  function handleScrape(): void {
    if (onScrape) onScrape();
  }
  function handlePalette(): void {
    if (onPalette) onPalette();
  }
</script>

<header class="topbar">
  <div
    class="status-pill"
    class:status-pill--idle={status === 'idle'}
    class:status-pill--running={status === 'running'}
    class:status-pill--error={status === 'error'}
    role="status"
    aria-live="polite"
  >
    <span class="status-pill__dot" aria-hidden="true"></span>
    {#if status === 'error'}
      <span class="status-pill__icon" aria-hidden="true">⚠</span>
    {/if}
    <span>{statusLabel}</span>
  </div>

  <div class="lastrun mono">
    <b>Letzter Lauf:</b>
    {lastrun}
  </div>

  <div class="topbar__spacer"></div>

  <button class="kbd-hint" type="button" onclick={handlePalette} title="Befehle (Cmd+K)">
    <kbd><span class="cmd-glyph">⌘</span>K</kbd>
    <span class="kbd-hint__label">Befehle</span>
  </button>

  <button class="btn btn--primary btn--sm scrape-btn" type="button" onclick={handleScrape} title="Jetzt abfragen (R)" aria-label="Abfragen">
    <svg class="scrape-btn__icon-play" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polygon points="6 4 20 12 6 20 6 4" />
    </svg>
    <svg class="scrape-btn__icon-refresh" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="23 4 23 10 17 10"/>
      <path d="M20.49 15A9 9 0 1 1 17.65 5.51L23 10"/>
    </svg>
    <span class="scrape-btn__label">Abfragen</span>
  </button>
</header>

<style>
  .topbar {
    position: sticky;
    top: 0;
    z-index: 20;
    height: var(--topbar-h);
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 20px;
    /* Solid fallback for browsers without backdrop-filter (Firefox <103, older
     * Android WebView). Without this they'd show a translucent panel that
     * lets the content underneath bleed through. */
    background: var(--bg-elev);
    border-bottom: 1px solid var(--border-soft);
    flex-shrink: 0;
  }
  @supports ((backdrop-filter: blur(8px)) or (-webkit-backdrop-filter: blur(8px))) {
    .topbar {
      background: rgba(15, 17, 21, 0.72);
      backdrop-filter: saturate(140%) blur(12px);
      -webkit-backdrop-filter: saturate(140%) blur(12px);
    }
  }

  .status-pill {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 4px 10px 4px 8px;
    border-radius: 999px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    font-size: 12px;
    font-weight: 600;
    color: var(--text-mute);
    letter-spacing: 0.02em;
    transition:
      background var(--t) var(--ease),
      border-color var(--t) var(--ease),
      color var(--t) var(--ease);
  }
  .status-pill__dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--text-dim);
  }
  .status-pill__icon { font-size: 10px; line-height: 1; }
  .status-pill--idle { color: var(--text-mute); }
  .status-pill--idle .status-pill__dot { background: var(--text-dim); }
  .status-pill--running {
    color: var(--accent);
    background: var(--accent-soft);
    border-color: var(--accent-border);
  }
  .status-pill--running .status-pill__dot {
    background: var(--accent);
    animation: pulse 1.6s var(--ease) infinite;
  }
  .status-pill--error {
    color: var(--danger);
    background: rgba(255, 107, 107, 0.08);
    border-color: rgba(255, 107, 107, 0.4);
  }
  .status-pill--error .status-pill__dot { background: var(--danger); }

  .lastrun {
    font-family: var(--font-mono);
    font-feature-settings: "tnum" 1, "zero" 1;
    font-size: 12px;
    color: var(--text-dim);
    letter-spacing: 0.01em;
  }
  .lastrun b {
    color: var(--text-mute);
    font-weight: 500;
  }

  .topbar__spacer { flex: 1; }

  .kbd-hint {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 8px;
    background: var(--surface-2);
    border: 1px solid var(--border-soft);
    border-radius: var(--r-sm);
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-dim);
    letter-spacing: 0.04em;
    cursor: pointer;
    transition:
      color var(--t-fast) var(--ease),
      border-color var(--t-fast) var(--ease);
  }
  @media (hover: hover) and (pointer: fine) {
    .kbd-hint:hover {
      color: var(--text-mute);
      border-color: var(--border);
    }
  }
  .kbd-hint kbd {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-family: inherit;
    font-size: 11px;
    line-height: 1;
    background: var(--bg);
    padding: 3px 6px;
    border-radius: 3px;
    border: 1px solid var(--border-soft);
    color: var(--text-mute);
  }
  .kbd-hint kbd .cmd-glyph {
    display: inline-block;
    transform: translateY(1px);
  }

  .btn {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 6px 12px;
    border-radius: var(--r-md);
    font-weight: 600;
    font-size: 13px;
    letter-spacing: 0.01em;
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--text);
    transition:
      transform var(--t-fast) var(--ease),
      background var(--t-fast) var(--ease),
      border-color var(--t-fast) var(--ease);
  }
  @media (hover: hover) and (pointer: fine) {
    .btn:hover {
      background: var(--surface-3);
      border-color: var(--border-strong);
    }
    .btn--primary:hover {
      background: var(--accent-hover);
      border-color: var(--accent-hover);
    }
  }
  .btn:active { transform: scale(0.97); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .btn--primary {
    background: var(--accent);
    color: var(--accent-ink);
    border-color: var(--accent);
  }

  .btn--sm {
    padding: 4px 9px;
    font-size: 12px;
  }

  /* Default desktop: refresh icon hidden, play+label shown */
  .scrape-btn__icon-refresh { display: none; }

  @media (prefers-reduced-motion: reduce) {
    .status-pill--running .status-pill__dot {
      animation: none;
      opacity: 0.7;
    }
  }

  /* ============================================================
     Mobile compaction
     - Hide Cmd+K hint chip entirely (keyboard shortcut isn't usable
       on touch devices)
     - Hide "Abfragen" label, show refresh icon only
     - Shrink lastrun font and add safe-area padding on top
     ============================================================ */
  @media (max-width: 720px) {
    .topbar {
      padding: 0 12px;
      padding-top: env(safe-area-inset-top);
      height: calc(var(--topbar-h) + env(safe-area-inset-top));
      gap: 8px;
    }
    .kbd-hint { display: none; }
    .lastrun {
      font-size: 11px;
      max-width: 50%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .lastrun b { display: none; }
    .scrape-btn {
      padding: 8px 10px;
      min-width: 40px;
      min-height: 36px;
    }
    .scrape-btn__label { display: none; }
    .scrape-btn__icon-play { display: none; }
    .scrape-btn__icon-refresh { display: inline-block; }
  }
</style>
