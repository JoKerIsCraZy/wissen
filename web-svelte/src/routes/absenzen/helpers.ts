/* Shared helpers for the /absenzen route + its sub-components.
 * Spiegelt die /noten-Struktur (helpers.ts) verbatim, angepasst auf die
 * Absenzen-Felder. Die reine Status-/Band-Logik (`statusLabel`,
 * `attendanceClass`, `isUnterMinimum`) lebt in der seiteneffektfreien
 * Datei `absenz-status.js`, damit sie unabhängig vom Svelte-Compiler
 * test- und im Mobile spiegelbar ist; hier nur re-exportiert.
 */
import type { AbsenzModulRow } from '$lib/api/types';
import {
  statusLabel,
  attendanceClass,
  isUnterMinimum,
} from './absenz-status.js';

export { statusLabel, attendanceClass, isUnterMinimum };

export type SortKey = 'code' | 'name' | 'typ' | 'anwesenheit' | 'soll' | 'updated';

/** Anwesenheit als Prozent-String formatieren (oder „—“). */
export function fmtPct(pct: number | null | undefined): string {
  if (pct == null) return '—';
  const n = Number(pct);
  if (!Number.isFinite(n)) return '—';
  // Ganzzahlig wenn ohne Nachkomma, sonst eine Stelle — wie das WISS-Badge.
  return (Number.isInteger(n) ? String(n) : n.toFixed(1)) + '%';
}

/** Lektionen-Wert (soll/ist) formatieren — ganzzahlig (z.B. „4“ statt „4.00“),
 *  eine Nachkommastelle nur bei echten Halb-Lektionen. Spiegelt fmtPct. */
export function fmtLektionen(v: number | null | undefined): string {
  if (v == null) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
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

/** Anzeige-Bezeichnung mit Fallback-Kette. */
export function modulName(r: AbsenzModulRow): string {
  return r.bezeichnung || r.kuerzel_code || '—';
}

/**
 * Trailing-Segment des kuerzel_code als kompakter Code (z.B. „106“ aus
 * „UIFZ-2524-020-S1-UEK-106“). N-Level bleibt zusammengehalten („ENG-N3“).
 */
export function modulCode(r: AbsenzModulRow): string {
  if (!r.kuerzel_code) return '';
  const parts = String(r.kuerzel_code).split('-');
  if (!parts.length) return r.kuerzel_code;
  const last = parts[parts.length - 1];
  if (/^N\d+$/i.test(last) && parts.length >= 2) {
    return parts[parts.length - 2] + '-' + last;
  }
  return last;
}

/** Join-Key fürs Detail + /seen + /dismiss: der kuerzel_code (Text). */
export function rowKey(r: AbsenzModulRow): string {
  return r.kuerzel_code || String(r.id);
}

/**
 * Modul-Zeile mit vorberechneten Such-Haystacks + geparstem fetched_at.
 * Einmalig berechnet wenn `rows` gesetzt wird, damit die Filter/Sort-
 * Derivations das nicht pro Tastendruck pro Zeile wiederholen.
 */
export interface IndexedAbsenzRow extends AbsenzModulRow {
  /** Trailing-Modulcode, Original-Case (z.B. „106“, „ENG-N3“). */
  _code: string;
  /** Lower-cased Trailing-Modulcode für Filter-`.includes()`. */
  _codeLc: string;
  /** Aufgelöster Anzeige-Name (Fallback-Kette wie `modulName`). */
  _name: string;
  /** Lower-cased „bezeichnung + kuerzel_code“ Haystack. */
  _nameLc: string;
  /** Lower-cased Anzeige-Name fürs Sortieren. */
  _nameSortLc: string;
  /** Geparstes fetched_at als Epoch-ms (0 wenn fehlend/ungültig). */
  _fetchedAtMs: number;
  /** Vorberechnet: liegt das Modul unter seiner Minimal-Anwesenheit? */
  _unterMin: boolean;
}

/** Roh-Zeilen mit vorberechneten Lower-cased Haystacks dekorieren. */
export function indexRows(rows: AbsenzModulRow[]): IndexedAbsenzRow[] {
  return rows.map((r) => {
    const code = modulCode(r);
    const name = modulName(r);
    const nameSort = (r.bezeichnung || r.kuerzel_code || '').toLowerCase();
    const hay = [r.bezeichnung, r.kuerzel_code, r.typ].filter(Boolean).join(' ');
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
      _unterMin: isUnterMinimum(r.anwesenheit_pct, r.minimal_pct),
    };
  });
}
