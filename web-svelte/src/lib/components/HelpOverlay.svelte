<script lang="ts">
  interface HelpProps {
    open?: boolean;
  }

  let { open = $bindable(false) }: HelpProps = $props();

  interface Shortcut {
    keys: string[];
    label: string;
  }

  const shortcuts: Shortcut[] = [
    { keys: ['g', 'j'], label: 'Jetzt' },
    { keys: ['g', 's'], label: 'Stundenplan' },
    { keys: ['g', 'n'], label: 'Noten' },
    { keys: ['g', 'a'], label: 'Auswertung' },
    { keys: ['g', 'e'], label: 'Einstellungen' },
    { keys: ['g', 'p'], label: 'Push' },
    { keys: ['g', 't'], label: 'Telegram' },
    { keys: ['/'],     label: 'Suche fokussieren' },
    { keys: ['r'],     label: 'Abfrage starten' },
    { keys: ['⌘', 'K'], label: 'Befehle' },
    { keys: ['⌘', 'L'], label: 'Logs umschalten' },
    { keys: ['⌘', '↵'], label: 'Settings speichern' },
    { keys: ['?'],     label: 'Diese Übersicht' },
    { keys: ['Esc'],   label: 'Schließen' },
  ];

  function close(): void {
    open = false;
  }

  function onKeydown(e: KeyboardEvent): void {
    if (open && e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }

  function onBackdrop(e: MouseEvent): void {
    if (e.target === e.currentTarget) close();
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
  <div
    class="overlay"
    role="dialog"
    aria-modal="true"
    aria-labelledby="help-title"
    tabindex="-1"
    onclick={onBackdrop}
    onkeydown={onKeydown}
  >
    <div class="help-panel" role="presentation">
      <div class="help-panel__head">
        <h3 id="help-title">Tastatur</h3>
        <button class="close" type="button" aria-label="Schließen" onclick={close}>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      <dl class="help-panel__body">
        {#each shortcuts as s (s.label)}
          <dt>
            {#each s.keys as k (k)}
              <span class="kbd">{k}</span>
            {/each}
          </dt>
          <dd>{s.label}</dd>
        {/each}
      </dl>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 80;
    display: grid;
    place-items: center;
    padding: 20px;
    background: rgba(5, 8, 14, 0.65);
    animation: fadeOverlay 180ms var(--ease);
  }

  .help-panel {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-xl);
    width: min(560px, 100%);
    box-shadow: var(--shadow-lg);
    overflow: hidden;
    animation: pop 180ms var(--ease);
  }

  .help-panel__head {
    padding: 14px 18px;
    border-bottom: 1px solid var(--border-soft);
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .help-panel__head h3 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text-mute);
  }

  .close {
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
  .close:hover {
    background: var(--surface-2);
    color: var(--text);
  }

  .help-panel__body {
    padding: 14px 18px 18px;
    margin: 0;
    display: grid;
    grid-template-columns: minmax(120px, max-content) 1fr;
    gap: 10px 24px;
    align-items: center;
  }
  .help-panel__body dt {
    display: inline-flex;
    gap: 4px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text);
    letter-spacing: 0.04em;
    align-items: center;
  }
  .help-panel__body dd {
    margin: 0;
    font-size: 12px;
    color: var(--text-mute);
  }

  .kbd {
    font-family: var(--font-mono);
    font-size: 10px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 1px 5px;
    color: var(--text);
    letter-spacing: 0.04em;
  }

  @media (prefers-reduced-motion: reduce) {
    .overlay,
    .help-panel { animation: none; }
  }
</style>
