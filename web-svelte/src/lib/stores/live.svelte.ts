// =============================================================
// Global live state — populated by a single SSE connection in +layout.svelte.
// Topbar reads { kind, label, lastrun }; LogPeek reads { entries }.
// Single connection, single source of truth, single subscriber.
// =============================================================

import type { ApiStatus, LogEntry, StatusKind } from '$lib/api/types';

const MAX_LOGS = 200;

class LiveState {
  kind = $state<StatusKind>('idle');
  label = $state<string>('Bereit');
  lastrun = $state<string>('—');
  phase = $state<string | null>(null);
  raw = $state<ApiStatus | null>(null);
  entries = $state<LogEntry[]>([]);
  connection = $state<'connecting' | 'open' | 'closed' | 'reconnecting'>('closed');

  applyStatus(s: ApiStatus): void {
    this.raw = s;
    this.phase = s.currentPhase ?? null;
    if (s.lastError) {
      this.kind = 'error';
      this.label = 'Fehler';
    } else if (s.running) {
      this.kind = 'running';
      this.label = s.currentPhase
        ? `Abfrage: ${this.formatPhase(s.currentPhase)}`
        : 'Abfrage läuft';
    } else {
      this.kind = 'idle';
      this.label = 'Bereit';
    }
    this.lastrun = s.lastRun ? this.formatRelative(new Date(s.lastRun)) : 'noch nie';
  }

  pushLog(entry: LogEntry): void {
    // Append, cap at MAX_LOGS (drop oldest).
    const next = this.entries.length >= MAX_LOGS
      ? this.entries.slice(this.entries.length - MAX_LOGS + 1)
      : this.entries.slice();
    next.push(entry);
    this.entries = next;
  }

  clearLogs(): void {
    this.entries = [];
  }

  private formatPhase(p: string): string {
    // 'stundenplan' wird seit dem Parallel-Fetch-Refactor nicht mehr vom
    // Scraper emittiert — Noten + Stundenplan laufen zusammen unter 'noten'.
    // Label entsprechend zusammengefasst. Defensive Einträge für längst
    // unbenutzte Phasen ('note', 'modulnote', 'pruefung', 'detail') bleiben
    // als Forward-Compat-Fallback bestehen.
    const map: Record<string, string> = {
      login: 'Login',
      note: 'Noten',
      noten: 'Noten + Stundenplan',
      modulnote: 'Modulnoten',
      modulnoten: 'Modulnoten',
      pruefung: 'Prüfungen',
      pruefungen: 'Prüfungen',
      noten_details: 'Modul-Details',
      absenzen_details: 'Absenzen-Details',
      detail: 'Details',
      saving: 'Speichern',
      finalize: 'Abschluss',
      cleanup: 'Cleanup',
      init: 'Initialisierung'
    };
    if (map[p]) return map[p];
    // Fallback: capitalize first letter so "irgendwas" → "Irgendwas"
    return p.charAt(0).toUpperCase() + p.slice(1);
  }

  private formatRelative(d: Date): string {
    const diffMs = Date.now() - d.getTime();
    const sec = Math.round(diffMs / 1000);
    if (sec < 60) return `vor ${sec}s`;
    const min = Math.round(sec / 60);
    if (min < 60) return `vor ${min} min`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `vor ${hr} h`;
    const days = Math.round(hr / 24);
    return `vor ${days} Tg`;
  }
}

export const live = new LiveState();
