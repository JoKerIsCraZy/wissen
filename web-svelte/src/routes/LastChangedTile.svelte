<script lang="ts">
  /* "Letzte Änderung" tile on the home route.
   *
   * Click expands the tile inline to show ALL recent fresh items —
   * fresh-flagged grades AND fresh-flagged Stundenplan rows (Zimmerwechsel).
   * The header reflects the single most-recent change.
   *
   * Empty state: tile is disabled and shows "Nichts neu".
   */
  import type { NotenRow, StundenplanRow } from '#lib/api/types.js';

  type Change =
    | { kind: 'noten'; row: NotenRow; ts: number }
    | { kind: 'plan'; row: StundenplanRow; ts: number };

  interface Props {
    freshNoten: NotenRow[];
    freshLessons: StundenplanRow[];
    now: Date;
    fmtRelativePast: (iso: string, ref: Date) => string;
    gradeColor: (note: number | null | undefined) => string;
    onSelectNote: (row: NotenRow) => void;
    onSelectLesson: (row: StundenplanRow) => void;
  }

  let {
    freshNoten,
    freshLessons,
    now,
    fmtRelativePast,
    gradeColor,
    onSelectNote,
    onSelectLesson,
  }: Props = $props();

  /* Merge + sort all fresh items by fetched_at desc. Items without a valid
   * fetched_at are dropped — they'd otherwise sort to "now" and pollute the
   * top of the list. */
  const changes = $derived.by<Change[]>(() => {
    const out: Change[] = [];
    for (const n of freshNoten) {
      if (n.isFresh !== 1) continue;
      const ts = n.fetched_at ? new Date(n.fetched_at).getTime() : NaN;
      if (Number.isFinite(ts)) out.push({ kind: 'noten', row: n, ts });
    }
    for (const l of freshLessons) {
      if (l.isFresh !== 1) continue;
      const ts = l.fetched_at ? new Date(l.fetched_at).getTime() : NaN;
      if (Number.isFinite(ts)) out.push({ kind: 'plan', row: l, ts });
    }
    return out.sort((a, b) => b.ts - a.ts);
  });

  const top = $derived(changes[0] ?? null);
  const hasMore = $derived(changes.length > 1);

  let open = $state(false);
  function toggle(): void {
    if (changes.length === 0) return;
    open = !open;
  }

  /** Modul-Noten werden mit 2 Kommastellen gerendert (Tocco's note_raw
   *  liefert "5.500" mit drei Stellen — zu viel; reine Modul-Schnitte
   *  können aber 2 distinkte Decimals haben wie 4.85). Wenn `note` null
   *  ist (z.B. seltene Sonder-Strings wie "best."), fall back auf
   *  note_raw verbatim. */
  function fmtNote(n: number | null, raw?: string | null): string {
    if (n != null) return n.toFixed(2);
    if (raw && raw.trim()) return raw;
    return '—';
  }
  function topGradeText(c: Change): string {
    if (c.kind !== 'noten') return '';
    return fmtNote(c.row.note, c.row.note_raw);
  }

  function topGradeColor(c: Change): string {
    if (c.kind !== 'noten') return 'var(--text)';
    return gradeColor(c.row.note);
  }

  /** True wenn die Note tatsächlich von einem anderen Wert auf den jetzigen
   *  geändert wurde (nicht erstmalig erfasst und auch nicht gleich-geblieben). */
  function noteHasDiff(r: NotenRow): boolean {
    return r.prev_note != null && r.note != null && r.prev_note !== r.note;
  }
</script>

<div class="tile-shell" class:tile-shell--open={open && changes.length > 0}>
  <button
    type="button"
    class="tile tile--btn"
    onclick={toggle}
    disabled={changes.length === 0}
    aria-expanded={open}
    aria-controls="last-changed-panel"
    aria-label={top
      ? top.kind === 'noten'
        ? `Letzte Änderung: ${top.row.fach_name} ${top.row.note_raw ?? ''}`
        : `Zimmerwechsel: ${top.row.veranstaltung} → ${top.row.raum}`
      : 'Keine kürzliche Änderung'}
  >
    <div class="tile__header">
      <div class="tile__label">
        Letzte Änderung
        {#if changes.length > 1}
          <span class="tile__count mono">{changes.length}</span>
        {/if}
      </div>
      {#if changes.length > 0}
        <span class="tile__chev" aria-hidden="true">{open ? '▾' : '▸'}</span>
      {/if}
    </div>

    {#if top}
      {#if top.kind === 'noten'}
        <div class="tile__row">
          <span class="tile__value mono" style:color={topGradeColor(top)}>
            {#if noteHasDiff(top.row)}
              <span class="tile__value-prev mono"
                    style:color={gradeColor(top.row.prev_note)}
                    title="Vorheriger Wert">
                {fmtNote(top.row.prev_note)}
              </span>
              <span class="tile__value-arrow" aria-hidden="true">→</span>
            {/if}{topGradeText(top)}
          </span>
          <span class="tile__sub mono">
            {fmtRelativePast(top.row.fetched_at, now)}
          </span>
        </div>
        <div class="tile__name">{top.row.fach_name}</div>
      {:else}
        <div class="tile__row">
          <span class="tile__kind">Zimmerwechsel</span>
          <span class="tile__sub mono">
            {fmtRelativePast(top.row.fetched_at, now)}
          </span>
        </div>
        <div class="tile__name">
          {top.row.veranstaltung} · {top.row.raum || '—'}
        </div>
      {/if}
    {:else}
      <div class="tile__row">
        <span class="tile__value mono tile__value--empty">—</span>
        <span class="tile__sub">Nichts neu</span>
      </div>
      <div class="tile__name tile__name--dim">Keine frischen Änderungen.</div>
    {/if}
  </button>

  {#if open && changes.length > 0}
    <ul id="last-changed-panel" class="changes" role="list">
      {#each changes as c, i (c.kind + '-' + c.row.id)}
        {#if i > 0 || hasMore}
          <li class="changes__item">
            {#if c.kind === 'noten'}
              <button
                type="button"
                class="changes__btn"
                onclick={() => onSelectNote(c.row)}
              >
                <span
                  class="changes__grade mono"
                  style:color={gradeColor(c.row.note)}
                >
                  {#if noteHasDiff(c.row)}
                    <span class="changes__grade-prev mono"
                          style:color={gradeColor(c.row.prev_note)}
                          title="Vorheriger Wert">
                      {fmtNote(c.row.prev_note)}
                    </span>
                    <span class="changes__grade-arrow" aria-hidden="true">→</span>
                  {/if}{fmtNote(c.row.note, c.row.note_raw)}
                </span>
                <span class="changes__body">
                  <span class="changes__title">{c.row.fach_name}</span>
                  <span class="changes__sub mono">
                    {fmtRelativePast(c.row.fetched_at, now)}
                  </span>
                </span>
              </button>
            {:else}
              <button
                type="button"
                class="changes__btn"
                onclick={() => onSelectLesson(c.row)}
              >
                <span class="changes__icon" aria-hidden="true">⇄</span>
                <span class="changes__body">
                  <span class="changes__title">
                    {c.row.veranstaltung} → {c.row.raum || '—'}
                  </span>
                  <span class="changes__sub mono">
                    {fmtRelativePast(c.row.fetched_at, now)}
                  </span>
                </span>
              </button>
            {/if}
          </li>
        {/if}
      {/each}
    </ul>
  {/if}
</div>

<style>
  .mono {
    font-family: var(--font-mono);
    font-feature-settings: 'tnum' 1, 'zero' 1;
  }

  .tile-shell {
    width: 100%;
    background: var(--surface);
    border: 1px solid var(--border-soft);
    border-radius: var(--r-md);
    box-shadow: var(--shadow-sm);
    transition: border-color var(--t-fast) var(--ease);
    flex: 1 1 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .tile-shell--open { border-color: var(--border); }

  .tile {
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 100%;
    text-align: left;
    background: transparent;
    border: 0;
    padding: 18px 18px;
    transition: background var(--t-fast) var(--ease);
    color: inherit;
    font: inherit;
    cursor: pointer;
    justify-content: center;
    flex: 1 1 0;
    min-height: 0;
  }

  @media (hover: hover) and (pointer: fine) {
    .tile--btn:not(:disabled):hover { background: var(--surface-2); }
  }
  .tile--btn:not(:disabled):active { transform: scale(0.99); }
  .tile--btn:disabled { cursor: default; opacity: 0.65; }
  .tile--btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .tile__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .tile__chev { color: var(--text-dim); font-size: 11px; }

  .tile__label {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.10em;
    text-transform: uppercase;
    color: var(--text-mute);
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .tile__count {
    color: var(--accent);
    background: var(--accent-soft);
    border-radius: 999px;
    padding: 1px 7px;
    font-size: 10px;
    letter-spacing: 0.02em;
  }

  .tile__row {
    display: flex;
    align-items: baseline;
    gap: 12px;
  }
  .tile__value {
    font-size: 22px;
    font-weight: 600;
    letter-spacing: -0.01em;
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
  }
  /* Vorheriger Wert klein + halb-transparent — der Pfeil trägt die "vorher"-
   * Bedeutung, das durchstrichene "alt"-Gefühl kommt über opacity + Größe. */
  .tile__value-prev {
    font-size: 14px;
    font-weight: 500;
    opacity: 0.55;
  }
  .tile__value-arrow {
    font-size: 13px;
    color: var(--text-dim);
    font-weight: 500;
  }
  .tile__value--empty { color: var(--text-dim); }
  .tile__kind {
    font-size: 13px;
    font-weight: 600;
    color: var(--warning);
    letter-spacing: 0.02em;
  }
  .tile__sub { font-size: 12px; color: var(--text-mute); }
  .tile__name {
    font-size: 13px;
    color: var(--text-mute);
    line-height: 1.35;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .tile__name--dim { color: var(--text-dim); }

  /* ---------- Expanded list ---------- */

  .changes {
    list-style: none;
    margin: 0;
    padding: 0;
    border-top: 1px solid var(--border-soft);
    animation: changesIn 200ms var(--ease);
  }
  @keyframes changesIn {
    from { opacity: 0; transform: translateY(-4px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @media (prefers-reduced-motion: reduce) {
    .changes { animation: none; }
    .tile--btn:not(:disabled):active { transform: none; }
  }

  .changes__item + .changes__item .changes__btn {
    border-top: 1px solid var(--border-soft);
  }
  .changes__btn {
    display: grid;
    grid-template-columns: 44px 1fr;
    align-items: center;
    gap: 12px;
    width: 100%;
    padding: 10px 16px;
    background: transparent;
    border: 0;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    transition: background var(--t-fast) var(--ease);
  }
  @media (hover: hover) and (pointer: fine) {
    .changes__btn:hover { background: var(--surface-2); }
  }
  .changes__btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .changes__grade {
    font-size: 18px;
    font-weight: 700;
    text-align: center;
    display: inline-flex;
    align-items: baseline;
    justify-content: center;
    gap: 4px;
  }
  .changes__grade-prev {
    font-size: 12px;
    font-weight: 600;
    opacity: 0.55;
  }
  .changes__grade-arrow {
    font-size: 11px;
    color: var(--text-dim);
    font-weight: 500;
  }
  .changes__icon {
    color: var(--warning);
    font-size: 16px;
    text-align: center;
  }
  .changes__body {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .changes__title {
    font-size: 13px;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .changes__sub { font-size: 11px; color: var(--text-mute); }
</style>
