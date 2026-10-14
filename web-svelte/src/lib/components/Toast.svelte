<script lang="ts">
  import { toast, type ToastKind } from '#lib/stores/toast.svelte.js';

  function glyph(kind: ToastKind): string {
    if (kind === 'success') return '✓';
    if (kind === 'warn') return '⚠';
    if (kind === 'error') return '✕';
    return '●';
  }

  function ariaRole(kind: ToastKind): 'status' | 'alert' {
    return kind === 'error' ? 'alert' : 'status';
  }
</script>

<div class="toasts" aria-live="polite" aria-atomic="true">
  {#each toast.items as t (t.id)}
    <div
      class="toast toast--{t.kind}"
      role={ariaRole(t.kind)}
    >
      <span class="toast__icon" aria-hidden="true">{glyph(t.kind)}</span>
      <div class="toast__text">
        {#if t.title}
          <div class="toast__title">{t.title}</div>
        {/if}
        <div class="toast__msg">{t.msg}</div>
      </div>
      <button
        type="button"
        class="toast__close"
        aria-label="Schließen"
        onclick={() => toast.dismiss(t.id)}
      >
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    right: 20px;
    bottom: 20px;
    z-index: 60;
    display: flex;
    flex-direction: column;
    gap: 10px;
    pointer-events: none;
  }
  .toast {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    padding: 10px 14px;
    color: var(--text);
    font-size: 13px;
    min-width: 240px;
    max-width: 360px;
    box-shadow: var(--shadow-md);
    pointer-events: auto;
    display: flex;
    align-items: flex-start;
    gap: 10px;
    animation: toastIn 220ms var(--ease);
  }
  .toast__icon {
    flex-shrink: 0;
    width: 18px;
    height: 18px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    font-size: 11px;
    font-weight: 700;
  }
  .toast__text { flex: 1; min-width: 0; }
  .toast__title {
    font-weight: 600;
    line-height: 1.3;
  }
  .toast__msg {
    color: var(--text-mute);
    font-size: 12px;
    margin-top: 2px;
  }

  .toast__close {
    flex-shrink: 0;
    width: 22px;
    height: 22px;
    border-radius: var(--r-sm);
    display: grid;
    place-items: center;
    color: var(--text-dim);
    transition:
      background var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease);
  }
  @media (hover: hover) and (pointer: fine) {
    .toast__close:hover {
      background: var(--surface-2);
      color: var(--text);
    }
  }

  .toast--info .toast__icon {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .toast--success {
    background: rgba(76, 201, 160, 0.10);
    border-color: rgba(76, 201, 160, 0.35);
  }
  .toast--success .toast__icon {
    background: var(--success);
    color: var(--accent-ink);
  }
  .toast--warn {
    background: rgba(255, 169, 77, 0.10);
    border-color: rgba(255, 169, 77, 0.35);
  }
  .toast--warn .toast__icon {
    background: var(--warning);
    color: var(--accent-ink);
  }
  .toast--error {
    background: rgba(255, 107, 107, 0.10);
    border-color: rgba(255, 107, 107, 0.35);
  }
  .toast--error .toast__icon {
    background: var(--danger);
    color: var(--text);
  }

  @media (prefers-reduced-motion: reduce) {
    .toast { animation: none; }
  }
</style>
