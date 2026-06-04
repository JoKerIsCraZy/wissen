/* Shared helpers for the /noten route + its sub-components.
 * Pulled out of +page.svelte during the split into NotenTiles /
 * NotenFilters / NotenTable so all three components agree on the
 * exact same formatting + status logic.
 */
import type { NotenRow } from '$lib/api/types';

export type SortKey = 'number' | 'name' | 'semester' | 'note' | 'status' | 'updated';

/** Color class by grade band — used for note text + tile values. */
export function gradeClass(note: number | null | undefined): string {
  if (note == null) return 'g-none';
  const n = Number(note);
  if (!Number.isFinite(n)) return 'g-none';
  if (n >= 5) return 'g-excellent';
  if (n >= 4.5) return 'g-good';
  if (n >= 4) return 'g-ok';
  return 'g-fail';
}

export function fmtGrade(note: number | null | undefined): string {
  if (note == null) return '—';
  const n = Number(note);
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(2);
}

export function fmtRelative(tsIso: string | null | undefined): string {
  if (!tsIso) return '—';
  // SQLite CURRENT_TIMESTAMP is a UTC string without 'Z'. Normalize so
  // Date parses it as UTC, not local time.
  const iso = /Z|[+-]\d{2}:?\d{2}$/.test(tsIso) ? tsIso : tsIso.replace(' ', 'T') + 'Z';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const diff = Date.now() - t;
  const s = Math.floor(diff / 1000);
  if (s < 0) {
    const abs = Math.abs(s);
    if (abs < 60) return `in ${abs}s`;
    if (abs < 3600) return `in ${Math.floor(abs / 60)}m`;
    if (abs < 86400) return `in ${Math.floor(abs / 3600)}h`;
    return `in ${Math.floor(abs / 86400)}d`;
  }
  if (s < 30) return 'gerade eben';
  if (s < 60) return `vor ${s}s`;
  if (s < 3600) return `vor ${Math.floor(s / 60)}m`;
  if (s < 86400) return `vor ${Math.floor(s / 3600)}h`;
  return `vor ${Math.floor(s / 86400)}d`;
}

export function moduleName(r: NotenRow): string {
  const name = r.fach_name || r.fach_code || r.kuerzel_full || '—';
  // Niveau-/Sprachmodule (Englisch "ENG-N3", Mathematik "MAT" …) wiederholen
  // sich über mehrere Semester mit identischem fach_name. Das ausgeschriebene
  // Semester macht sie im Modul-Namen unterscheidbar. Bedingung: die Modul-Nr
  // (moduleCode) enthält einen Buchstaben → Niveau-/Sprachmodul. Rein
  // numerische Module (z.B. "254") sind pro Semester eindeutig und bleiben
  // unverändert. Sort/Suche laufen über separate Keys (_nameSortLc/_nameLc),
  // sind also vom Anzeige-Suffix nicht betroffen.
  const code = moduleCode(r);
  if (r.semester && /[A-Za-z]/.test(code)) {
    const m = String(r.semester).match(/(\d+)/);
    if (m) return `${name} · Semester ${m[1]}`;
  }
  return name;
}

export function moduleCode(r: NotenRow): string {
  // Last segment of kuerzel_code, with N-level safe-guard ("ENG-N3" stays joined).
  if (!r.kuerzel_code) return r.fach_code || '';
  const parts = String(r.kuerzel_code).split('-');
  if (!parts.length) return r.fach_code || '';
  const last = parts[parts.length - 1];
  if (/^N\d+$/i.test(last) && parts.length >= 2) {
    return parts[parts.length - 2] + '-' + last;
  }
  return last;
}

export function statusLabel(r: NotenRow): { text: string; tone: 'fresh' | 'has' | 'none' } {
  if (r.isFresh) return { text: 'Frisch', tone: 'fresh' };
  if (r.note != null) return { text: 'Mit Note', tone: 'has' };
  return { text: 'Ohne Note', tone: 'none' };
}

export function rowKey(r: NotenRow): string {
  return r.kuerzel_id || String(r.id);
}

/**
 * Row decorated with pre-computed search haystacks + a parsed fetched_at
 * timestamp. Computed once when `modules` is set on the page so the
 * filter/sort derivations don't redo this work per keystroke per row.
 */
export interface IndexedRow extends NotenRow {
  /** Trailing module code, original case (e.g. "122", "ENG-N3"). */
  _code: string;
  /** Lower-cased trailing module code for filter `.includes()`. */
  _codeLc: string;
  /** Resolved display name (matches `moduleName` fallback chain). */
  _name: string;
  /** Lower-cased "fach_name + kuerzel_full + fach_code" haystack. */
  _nameLc: string;
  /** Lower-cased display name for sorting. */
  _nameSortLc: string;
  /** Parsed fetched_at as epoch ms (0 if missing/invalid). */
  _fetchedAtMs: number;
}

/** Decorate raw rows with pre-computed lower-cased haystacks. */
export function indexRows(rows: NotenRow[]): IndexedRow[] {
  return rows.map((r) => {
    const code = moduleCode(r);
    const name = moduleName(r);
    // Sort key uses the same fallback chain but keeps empty (not "—") for
    // missing rows so the sort step's "missing" branch keeps them last.
    const nameSort = (r.fach_name || r.fach_code || r.kuerzel_full || '').toLowerCase();
    const hay = [r.fach_name, r.kuerzel_full, r.fach_code]
      .filter(Boolean)
      .join(' ');
    let ms = 0;
    if (r.fetched_at) {
      const iso = /Z|[+-]\d{2}:?\d{2}$/.test(r.fetched_at)
        ? r.fetched_at
        : r.fetched_at.replace(' ', 'T') + 'Z';
      const t = Date.parse(iso);
      if (!Number.isNaN(t)) ms = t;
    }
    return {
      ...r,
      _code: code,
      _codeLc: code.toLowerCase(),
      _name: name,
      _nameLc: hay.toLowerCase(),
      _nameSortLc: nameSort,
      _fetchedAtMs: ms,
    };
  });
}
