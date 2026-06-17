<script lang="ts">
  /* /v2/  —  Now route (default).
   *
   * The most-current view of the user's day. Three layers, top to bottom:
   *
   *   1. Floor strip (200px, ambient) — always visible, pulses on the current
   *      event's room when there is one. Empty/online states are handled by
   *      the FloorPlan component itself.
   *   2. Current-event card + two living tiles
   *      - Card highlights with an accent top-bar when in-session, dims to
   *        idle copy ("Als Nächstes heute" / "Keine Lektion heute") otherwise.
   *      - Tiles: "Letzte Änderung" (fresh-flagged Note) and "Nächste Lektion"
   *        (next event). Both clickable, route to /noten resp. /stundenplan.
   *      - "Nächste Prüfung" was dropped on purpose — exam data isn't
   *        queryable from the current API surface.
   *   3. "Heute danach" — remaining events of the same calendar day.
   *
   * Live-tick: re-evaluates `now` every 30s so derived state stays accurate
   * without a refetch. Real data refresh happens on the global scrape
   * trigger ('wissen:scrape' window event).
   *
   * The current-event card and the Letzte-Änderung tile are extracted into
   * NowCard.svelte and LastChangedTile.svelte respectively so this file can
   * stay an orchestrator under the line cap.
   */
  import { getStatus, getStundenplan, getNoten, dismissChanges } from '$lib/api/endpoints';
  import { pushToast } from '$lib/stores/toast.svelte';
  import { isApiHttpError } from '$lib/api/client';
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import type {
    ApiStatus,
    StundenplanRow,
    NotenRow,
  } from '$lib/api/types';

  import NowCard from './NowCard.svelte';
  import LessonCard from './LessonCard.svelte';

  // ---------- State ----------

  let status = $state<ApiStatus | null>(null);
  let plan = $state<StundenplanRow[] | null>(null);
  let noten = $state<NotenRow[] | null>(null);
  /* Aggregated grade stats from /api/noten — drives the Notenschnitt strip
   * at the top of the dashboard. */
  let notenAvg = $state<number | null>(null);
  let notenBySemester = $state<Record<string, number>>({});
  let notenCount = $state<number>(0);
  /* Per-section loading flags so each panel can resolve independently
   * statt das ganze UI hinter einem Promise.all-Block zu verzögern.
   * `loading` bleibt ein abgeleitetes Flag (true bis ALLE drei aufgelöst
   * sind) damit der Skeleton-Pfad weiter funktioniert. */
  let loadingStatus = $state(true);
  let loadingPlan = $state(true);
  let loadingNoten = $state(true);
  const loading = $derived(loadingStatus || loadingPlan || loadingNoten);
  let error = $state<string | null>(null);

  /* `now` is a $state we tick manually so $derived values recompute. */
  let now = $state(new Date());

  // ---------- Data fetching ----------

  function handleFetchError(e: unknown): void {
    if (isApiHttpError(e)) {
      error = e.message;
    } else if (e instanceof Error) {
      error = e.message;
    } else {
      error = 'Unbekannter Fehler beim Laden.';
    }
  }

  /* AbortController: abort in-flight fetches wenn die Route geleavt oder
   * vor Abschluss neu geladen wird. Verhindert Memory-Leaks + race-
   * conditions, wo eine alte Antwort State aus einer abgelaufenen
   * Session überschreibt. */
  let activeController: AbortController | null = null;

  /* Drei unabhängige Fetches statt Promise.all: jeder Bereich (Status,
   * Stundenplan, Noten) resolved für sich und rendert sobald seine Daten
   * da sind. Das vermeidet, dass z.B. ein langsamer /api/noten den Floor-
   * plan und die Aktuell-Card künstlich blockiert. */
  function fetchAll(): void {
    // Cancel pending fetches from a previous call before starting fresh.
    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;
    const { signal } = controller;

    error = null;
    loadingStatus = true;
    loadingPlan = true;
    loadingNoten = true;

    void getStatus({ signal })
      .then((s) => {
        status = s;
      })
      .catch((e) => {
        if (signal.aborted) return;
        handleFetchError(e);
      })
      .finally(() => {
        if (signal.aborted) return;
        loadingStatus = false;
      });

    void getStundenplan({}, { signal })
      .then((p) => {
        plan = p.rows;
      })
      .catch((e) => {
        if (signal.aborted) return;
        handleFetchError(e);
      })
      .finally(() => {
        if (signal.aborted) return;
        loadingPlan = false;
      });

    void getNoten({}, { signal })
      .then((n) => {
        noten = n.rows;
        notenAvg = n.avg ?? null;
        notenBySemester = n.bySemester ?? {};
        notenCount = n.count ?? n.rows.length;
      })
      .catch((e) => {
        if (signal.aborted) return;
        handleFetchError(e);
      })
      .finally(() => {
        if (signal.aborted) return;
        loadingNoten = false;
      });
  }

  $effect(() => {
    fetchAll();
    return () => {
      activeController?.abort();
      activeController = null;
    };
  });

  // "Alle gelesen"-Aktion: dismisst ALLE aktuell-frischen Einträge
  // (Noten + Stundenplan-Zimmerwechsel) hart per change_pending=0, nicht
  // nur via change_seen_at. Danach refetch damit die freshChanges-Liste
  // sofort leer ist. Optimistic-Clear lassen wir absichtlich weg —
  // der Server hat die Wahrheit, kleine Verzögerung beim Refetch ist OK.
  // Custom Confirm-Dialog: kein window.confirm (sieht system-mäßig aus,
  // bricht den WISSen-Look). Modal sitzt im Markup unten.
  let confirmOpen = $state(false);
  let confirmMsg = $state('');
  let confirmResolve: ((ok: boolean) => void) | null = null;
  /* A11y: Focus-Trap-Bookkeeping. Wir merken uns das vorher fokussierte
   * Element vor dem Öffnen, damit beim Schliessen der Fokus genau dorthin
   * zurückwandert (z.B. zum "Alle gelesen"-Button) — Screen-Reader und
   * Tastatur-Nutzer behalten so ihren Kontext. */
  let confirmPrevFocus: HTMLElement | null = null;
  function askConfirm(message: string): Promise<boolean> {
    confirmMsg = message;
    /* Snapshot des aktuellen Fokus VOR dem Öffnen — Browser verschiebt den
     * Fokus durch das @attach-focus auf den Danger-Button, danach wäre
     * document.activeElement der Modal-Button selbst. */
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    confirmPrevFocus = active instanceof HTMLElement ? active : null;
    confirmOpen = true;
    return new Promise<boolean>((resolve) => {
      confirmResolve = resolve;
    });
  }
  function closeConfirm(ok: boolean): void {
    confirmOpen = false;
    if (confirmResolve) {
      confirmResolve(ok);
      confirmResolve = null;
    }
    /* Restore-Focus: zurück zum Trigger. Microtask, damit der Modal-Knoten
     * erst aus dem DOM raus ist bevor wir fokussieren — sonst kann Svelte
     * den Fokus während des Teardowns wieder einfangen. */
    const target = confirmPrevFocus;
    confirmPrevFocus = null;
    if (target && typeof queueMicrotask === 'function') {
      queueMicrotask(() => {
        try { target.focus(); } catch { /* element gone */ }
      });
    }
  }

  /* Focus-Trap im Confirm-Dialog. Tab/Shift+Tab cyclet zwischen den beiden
   * Buttons (Abbrechen + Entfernen) — verhindert, dass der Fokus auf
   * Hintergrund-UI hinter dem Modal entkommt. Greift nur, solange das
   * Modal offen ist; .confirm-overlay ruft uns per onkeydown auf. */
  function trapConfirmFocus(e: KeyboardEvent): void {
    if (e.key !== 'Tab') return;
    const overlay = e.currentTarget as HTMLElement | null;
    if (!overlay) return;
    const focusable = overlay.querySelectorAll<HTMLElement>(
      'button:not([disabled])',
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey) {
      if (active === first || !overlay.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (active === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  let dismissBusy = $state(false);
  async function dismissAllChanges(): Promise<void> {
    if (dismissBusy) return;
    if (freshChanges.length === 0) return;
    const count = freshChanges.length;
    // Bestätigung vor destruktiver Bulk-Aktion. Einzel-X (dismissOne) hat
    // KEIN confirm — einzelne Items sind harmlos zu entfernen.
    const confirmed = await askConfirm(
      `${count} Änderung${count === 1 ? '' : 'en'} als gelesen markieren und aus der Liste entfernen?`
    );
    if (!confirmed) return;
    dismissBusy = true;
    try {
      const r = await dismissChanges({ all: true });
      const total = (r.dismissed?.noten ?? 0) + (r.dismissed?.stundenplan ?? 0);
      // fetchAll() ist jetzt fire-and-forget (drei unabhängige Fetches);
      // kein await mehr — Toast direkt anzeigen, Daten kommen reaktiv nach.
      fetchAll();
      pushToast('success', `${total} Änderung${total === 1 ? '' : 'en'} als gelesen markiert.`, { title: 'Letzte Änderung' });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Fehler beim Entfernen';
      pushToast('error', msg, { title: 'Letzte Änderung' });
    } finally {
      dismissBusy = false;
    }
  }

  // Per-Item-Dismiss: einzelner Eintrag wird per X-Button entfernt. Optimistic
  // patch (lokaler State sofort updaten) + API-Call + final fetchAll als
  // Reconciliation. So fühlt sich der X-Klick instant an, auch bei langsamer
  // Verbindung.
  let dismissingIds = $state(new Set<string>());
  async function dismissOne(c: { kind: 'noten' | 'plan'; row: { id: number; kuerzel_id?: string } }): Promise<void> {
    const key = c.kind + '-' + c.row.id;
    if (dismissingIds.has(key)) return;
    const next = new Set(dismissingIds);
    next.add(key);
    dismissingIds = next;
    try {
      if (c.kind === 'noten') {
        await dismissChanges({ kind: 'noten', ids: [c.row.kuerzel_id ?? ''] });
        // Optimistic: Note aus lokaler Liste raus (isFresh:0 → fällt aus
        // freshChanges raus, weil das derived nur isFresh==1 berücksichtigt).
        if (noten) {
          noten = noten.map((n) =>
            n.kuerzel_id === c.row.kuerzel_id ? { ...n, isFresh: 0 as const } : n
          );
        }
        pushToast('success', 'Note als gelesen markiert.', { title: 'Letzte Änderung' });
      } else {
        await dismissChanges({ kind: 'stundenplan', ids: [c.row.id] });
        if (plan) {
          plan = plan.map((p) =>
            p.id === c.row.id ? { ...p, isFresh: 0 as const } : p
          );
        }
        pushToast('success', 'Zimmerwechsel als gelesen markiert.', { title: 'Letzte Änderung' });
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Fehler beim Entfernen';
      pushToast('error', msg, { title: 'Letzte Änderung' });
      // Bei Fehler refetch um inkonsistenten optimistischen State zu fixen
      void fetchAll();
    } finally {
      const after = new Set(dismissingIds);
      after.delete(key);
      dismissingIds = after;
    }
  }

  /* Live tick: re-evaluate "now" every 30s so the current/next event stays
   * accurate as time passes. No refetch — that's the global scrape's job.
   *
   * Idle-cost: pause the interval while the tab is hidden (browsers already
   * throttle setInterval in background tabs to ~1Hz, but skipping the tick
   * entirely avoids the cost of re-running every $derived that depends on
   * `now` — currentEvent, nextEvent, upcomingToday, freshChanges, …). On
   * visibilitychange we tick once immediately so the UI is fresh. */
  $effect(() => {
    let id: number | null = null;
    function start(): void {
      if (id !== null) return;
      id = window.setInterval(() => {
        now = new Date();
      }, 30_000);
    }
    function stop(): void {
      if (id === null) return;
      window.clearInterval(id);
      id = null;
    }
    function onVisibility(): void {
      if (document.visibilityState === 'visible') {
        now = new Date();
        start();
      } else {
        stop();
      }
    }
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  });

  /* React to the global scrape trigger: when the user fires 'r' or clicks the
   * topbar Scrape button, re-pull our data once it lands. We listen for the
   * shell's 'wissen:scrape' notice and refetch a couple of seconds later. */
  $effect(() => {
    function onScrape(): void {
      window.setTimeout(() => {
        void fetchAll();
      }, 1500);
    }
    window.addEventListener('wissen:scrape', onScrape);
    return () => window.removeEventListener('wissen:scrape', onScrape);
  });

  // ---------- Helpers ----------

  /* Combine a YYYY-MM-DD date with HH:MM time into a local Date.
   * Server timezone is the user's school timezone (Europe/Zurich) and
   * Stundenplan rows are stored in that local convention, so naive parsing
   * matches what's displayed on the page. */
  function combineDateTime(datumIso: string, hhmm: string): Date {
    const [hStr, mStr] = hhmm.split(':');
    const h = Number(hStr) || 0;
    const m = Number(mStr) || 0;
    const [yy, mm, dd] = datumIso.split('-').map((p) => Number(p));
    return new Date(yy, (mm || 1) - 1, dd || 1, h, m, 0, 0);
  }

  function isSameDay(a: Date, b: Date): boolean {
    return (
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate()
    );
  }

  function fmtTimeShort(d: Date): string {
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }

  const WEEKDAYS_DE = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'] as const;
  function fmtDateShort(d: Date): string {
    const wd = WEEKDAYS_DE[d.getDay()];
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    return `${wd}, ${dd}.${mm}.`;
  }

  /* "vor 12 min", "vor 3h", "vor 2 Tg", "vor 3 Wo", "vor 4 Mt", "vor 1 J".
   * Buckets escalate so a note from 6 weeks ago doesn't read as "vor 42 Tg". */
  function fmtRelativePast(iso: string, ref: Date): string {
    const t = new Date(iso);
    if (Number.isNaN(t.getTime())) return '';
    const diffMs = ref.getTime() - t.getTime();
    if (diffMs < 0) return 'gerade eben';
    const minutes = Math.floor(diffMs / 60_000);
    if (minutes < 1) return 'gerade eben';
    if (minutes < 60) return `vor ${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `vor ${hours}h`;
    const days = Math.floor(hours / 24);
    if (days < 14) return `vor ${days} Tg`;
    const weeks = Math.floor(days / 7);
    if (weeks < 9) return `vor ${weeks} Wo`;
    const months = Math.floor(days / 30);
    if (months < 12) return `vor ${months} Mt`;
    const years = Math.floor(days / 365);
    return `vor ${years} J`;
  }

  /* BK-Filter: 3-stellige Modulnummer, ohne Niveau-Suffixe (-Nx = Englisch,
   * Mathe usw.). Mirrors isBkModule aus stats/+page.svelte. */
  function isBkModule(row: NotenRow): boolean {
    const code = row.kuerzel_code || '';
    if (!code) return false;
    if (/-N\d+$/i.test(code)) return false;
    return /(?<!\d)\d{3}(?!\d)/.test(code);
  }

  const bkAvg = $derived.by<number | null>(() => {
    if (!noten || noten.length === 0) return null;
    const list = noten.filter((r) => isBkModule(r) && r.note != null);
    if (list.length === 0) return null;
    let sum = 0;
    for (const r of list) sum += r.note as number;
    return sum / list.length;
  });

  const bkCount = $derived.by<number>(() => {
    if (!noten) return 0;
    return noten.filter((r) => isBkModule(r) && r.note != null).length;
  });

  /* Note → grade-color CSS variable. Mirrors the band in the Noten route. */
  function gradeColor(note: number | null | undefined): string {
    if (note == null) return 'var(--text-mute)';
    if (note >= 5.0) return 'var(--g-excellent)';
    if (note >= 4.5) return 'var(--g-good)';
    if (note >= 4.0) return 'var(--g-ok)';
    return 'var(--g-fail)';
  }

  function isOnline(raum: string | null | undefined): boolean {
    return !!raum && /online/i.test(raum);
  }

  // ---------- Derived ----------

  /* All events sorted ascending by start datetime, with start/end timestamps
   * cached once so the per-tick loops below don't re-parse date strings.
   * This derived only re-runs when `plan` changes (NOT every 30s tick). */
  type PlanEntry = { row: StundenplanRow; start: number; end: number };
  const planEntries = $derived.by<PlanEntry[] | null>(() => {
    if (!plan) return null;
    const out: PlanEntry[] = plan.map((row) => ({
      row,
      start: combineDateTime(row.datum_iso, row.zeit_von).getTime(),
      end: combineDateTime(row.datum_iso, row.zeit_bis).getTime(),
    }));
    out.sort((a, b) => a.start - b.start);
    return out;
  });

  /* Single-pass derive: walk the sorted plan once and bucket all the
   * "where are we now" answers in one go. Re-runs on `now` tick or when
   * `plan` changes. Avoids 4× iteration of the same array per tick. */
  type NowSnapshot = {
    current: StundenplanRow | null;
    next: StundenplanRow | null;
    nextToday: StundenplanRow | null;
    upcomingToday: StundenplanRow[];
    dayDone: boolean;
  };
  const nowSnapshot = $derived.by<NowSnapshot>(() => {
    if (!planEntries) {
      return { current: null, next: null, nextToday: null, upcomingToday: [], dayDone: false };
    }
    const t = now.getTime();
    let current: StundenplanRow | null = null;
    let next: StundenplanRow | null = null;
    let nextToday: StundenplanRow | null = null;
    const upcomingToday: StundenplanRow[] = [];
    let hadTodayEvent = false;
    for (const e of planEntries) {
      const start = e.start;
      const isToday = isSameDay(new Date(start), now);
      if (isToday) hadTodayEvent = true;
      if (start <= t && t < e.end) {
        if (current === null) current = e.row;
        continue;
      }
      if (start > t) {
        if (next === null) next = e.row;
        if (isToday) {
          if (nextToday === null) nextToday = e.row;
          upcomingToday.push(e.row);
        }
      }
    }
    const dayDone = !current && !nextToday && hadTodayEvent;
    return { current, next, nextToday, upcomingToday, dayDone };
  });

  const currentEvent = $derived(nowSnapshot.current);
  const nextEvent = $derived(nowSnapshot.next);
  const nextEventToday = $derived(nowSnapshot.nextToday);

  /* Third hero slot: the "danach" lesson — second upcoming today (after
   * nextEventToday). Null if there's no third lesson today. */
  const lessonAfterNext = $derived<StundenplanRow | null>(
    nowSnapshot.upcomingToday.length > 1 ? nowSnapshot.upcomingToday[1] : null,
  );

  /* "Mehr heute" overflow list: events 3+ today (excluding nextToday and
   * lessonAfterNext which already have hero slots). */
  const todayOverflow = $derived<StundenplanRow[]>(
    nowSnapshot.upcomingToday.length > 2 ? nowSnapshot.upcomingToday.slice(2) : [],
  );

  /* The next three actual lessons starting from `now`, but ONLY from the
   * first future day that actually has lessons. Powers the empty-day
   * fallback: when there are no lessons today, show the upcoming day's
   * lessons as a coherent block instead of pulling random later lessons
   * into slot 3 (which would visually suggest a contiguous schedule when
   * there's actually a multi-day gap). */
  const upcomingAcrossWeek = $derived.by<StundenplanRow[]>(() => {
    if (!planEntries) return [];
    const t = now.getTime();
    const out: StundenplanRow[] = [];
    let targetDay: Date | null = null;
    for (const e of planEntries) {
      if (e.start <= t) continue;
      const eDay = new Date(e.start);
      if (!targetDay) {
        targetDay = eDay;
      } else if (!isSameDay(eDay, targetDay)) {
        break;
      }
      out.push(e.row);
      if (out.length === 3) break;
    }
    return out;
  });

  /* Switch: only fall back to "next three across the week" when today has
   * absolutely no remaining lessons (no current, no upcoming today). If
   * even one lesson is left today, the regular Aktuell/Nächste/Danach
   * arrangement stays — that's the dense in-day rhythm we want by default. */
  const showAcrossWeek = $derived(
    !currentEvent && nowSnapshot.upcomingToday.length === 0 && upcomingAcrossWeek.length > 0,
  );

  /* Date pill text for the across-week cards: omitted when the lesson is
   * actually today so the pill never shows redundant info. */
  function dateLabelFor(ev: StundenplanRow | null): string {
    if (!ev) return '';
    const d = combineDateTime(ev.datum_iso, ev.zeit_von);
    if (isSameDay(d, now)) return '';
    return fmtDateShort(d);
  }

  /* "in 12 Min", "in 3h 20m", "in 2 Tg", "in 3 Wo", "in 4 Mt", "in 1 J".
   * Buckets escalate so a lesson 6 days out doesn't read as "in 142h 30m".
   * Keeps the h+m precision under 24h since that's the "today/tomorrow"
   * range where exact minutes still matter. */
  function startsInMinutes(ev: StundenplanRow | null): string {
    if (!ev) return '';
    const start = combineDateTime(ev.datum_iso, ev.zeit_von).getTime();
    const inMin = Math.round((start - now.getTime()) / 60_000);
    if (inMin <= 0) return 'jetzt';
    if (inMin < 60) return `in ${inMin} Min`;
    const totalH = Math.floor(inMin / 60);
    if (totalH < 24) {
      const m = inMin - totalH * 60;
      return m === 0 ? `in ${totalH}h` : `in ${totalH}h ${m}m`;
    }
    const days = Math.floor(totalH / 24);
    if (days < 14) return `in ${days} Tg`;
    const weeks = Math.floor(days / 7);
    if (weeks < 9) return `in ${weeks} Wo`;
    const months = Math.floor(days / 30);
    if (months < 12) return `in ${months} Mt`;
    const years = Math.floor(days / 365);
    return `in ${years} J`;
  }


  /* Merged fresh-changes feed: notes + Stundenplan rows (Zimmerwechsel),
   * sorted desc by fetched_at. Dropped items without a valid fetched_at
   * so they don't sort to "now" and pollute the top of the list.
   *
   * Single-pass build over `noten` + `plan` directly (no intermediate
   * filtered arrays). Only re-runs when those source arrays change — the
   * 30s `now` tick does NOT invalidate this. */
  type FreshChange =
    | { kind: 'noten'; row: NotenRow; ts: number }
    | { kind: 'plan'; row: StundenplanRow; ts: number };
  const freshChanges = $derived.by<FreshChange[]>(() => {
    const out: FreshChange[] = [];
    if (noten) {
      for (const n of noten) {
        if (n.isFresh !== 1) continue;
        const ts = n.fetched_at ? new Date(n.fetched_at).getTime() : NaN;
        if (Number.isFinite(ts)) out.push({ kind: 'noten', row: n, ts });
      }
    }
    if (plan) {
      for (const l of plan) {
        if (l.isFresh !== 1) continue;
        const ts = l.fetched_at ? new Date(l.fetched_at).getTime() : NaN;
        if (Number.isFinite(ts)) out.push({ kind: 'plan', row: l, ts });
      }
    }
    return out.sort((a, b) => b.ts - a.ts);
  });

  /* "Remaining minutes" copy for the current event. */
  const remainingCopy = $derived.by(() => {
    if (!currentEvent) return '';
    const end = combineDateTime(
      currentEvent.datum_iso,
      currentEvent.zeit_bis,
    ).getTime();
    const left = Math.round((end - now.getTime()) / 60_000);
    if (left <= 0) return 'gleich vorbei';
    if (left === 1) return 'noch 1 Min';
    return `noch ${left} Min`;
  });

  /* Subtitle: live time + date. */
  const subtitle = $derived(`${fmtTimeShort(now)} · ${fmtDateShort(now)}`);

  /* Pre-sorted semester chip list. Re-runs only when notenBySemester
   * changes, not on every {#each} pass — Object.entries + sort otherwise
   * allocates a fresh array on each render. */
  const semesterChips = $derived<Array<readonly [string, number | null | undefined]>>(
    Object.entries(notenBySemester).sort(([a], [b]) => a.localeCompare(b)),
  );

  /* Last graded module — newest note_recorded_at among rows that have a note.
   * Powers the inline "Letzte Note" chip on the grades strip. Sorts by
   * note_recorded_at (from noten_history — only written on a real grade
   * insert/change), NOT fetched_at: fetched_at is rewritten for every row on
   * every scrape, so as a "newest" key it would be effectively random.
   * fetched_at stays a fallback in case history is missing. Skip rows with
   * invalid timestamps so they don't sort to the top via NaN comparison. */
  const lastAddedNote = $derived.by<NotenRow | null>(() => {
    if (!noten || noten.length === 0) return null;
    let best: NotenRow | null = null;
    let bestTs = -Infinity;
    for (const n of noten) {
      if (n.note == null) continue;
      const stamp = n.note_recorded_at ?? n.fetched_at;
      const ts = stamp ? new Date(stamp).getTime() : NaN;
      if (!Number.isFinite(ts)) continue;
      if (ts > bestTs) {
        bestTs = ts;
        best = n;
      }
    }
    return best;
  });

  /* Module-number for the "Letzte Note" chip — last "-" segment of
   * kuerzel_code with N-level safe-guard ("ENG-N3" stays joined), matching
   * the same logic the /noten table uses so both surfaces show the same
   * label for the same module. */
  function shortModuleCode(row: NotenRow): string {
    if (!row.kuerzel_code) return row.fach_code || '';
    const parts = String(row.kuerzel_code).split('-');
    if (!parts.length) return row.fach_code || '';
    const last = parts[parts.length - 1];
    if (/^N\d+$/i.test(last) && parts.length >= 2) {
      return parts[parts.length - 2] + '-' + last;
    }
    return last;
  }

  /* Modul-Anzeigename mit ausgeschriebenem Semester für Niveau-/Sprachmodule
   * (Englisch, Mathematik … — nicht-numerische Modul-Nr wie ENG-N3, MAT). Diese
   * wiederholen sich über mehrere Semester mit identischem fach_name; das
   * Semester im Namen macht sie unterscheidbar. Numerische Module (z.B. 254)
   * sind pro Semester eindeutig und bleiben unverändert. */
  function moduleNameWithSemester(row: NotenRow): string {
    const name = row.fach_name || row.fach_code || row.kuerzel_full || '—';
    const code = shortModuleCode(row);
    if (row.semester && /[A-Za-z]/.test(code)) {
      const m = String(row.semester).match(/(\d+)/);
      if (m) return `${name} · Semester ${m[1]}`;
    }
    return name;
  }

  /* Card "headline". Three states: aktuell läuft / heute kommt noch / heute fertig. */
  const cardLabel = $derived(
    currentEvent
      ? 'Aktuell'
      : nextEventToday
        ? 'Nächste Lektion'
        : 'Heute keine Lektion mehr',
  );

  /* Did we ever load any data? Used for the "fresh install" empty state. */
  const everScraped = $derived(
    !!status && (status.lastRun !== null || (plan?.length ?? 0) > 0 || (noten?.length ?? 0) > 0),
  );

  /* "Tagesende": no current, no next-today, but the day HAD events that ended.
   * Computed inside `nowSnapshot` for free; this alias keeps the template tidy. */
  const dayDone = $derived(nowSnapshot.dayDone);

  // ---------- Navigation ----------

  /* Open a specific module page or scroll the plan to a lesson. The
   * Letzte-Änderung dropdown calls these when an item is tapped. */
  function openNote(row: NotenRow): void {
    /* Module deep-link by code — the noten page already handles ?focus= */
    const code = row.kuerzel_code || row.kuerzel_id;
    if (code) {
      void goto(`${base}/noten?focus=${encodeURIComponent(String(code))}`);
    } else {
      void goto(`${base}/noten`);
    }
  }
  function openLesson(row: StundenplanRow): void {
    void goto(`${base}/stundenplan?focus=${encodeURIComponent(String(row.id))}`);
  }
  function goToPlanFocus(id: number): void {
    void goto(`${base}/stundenplan?focus=${encodeURIComponent(String(id))}`);
  }
</script>

<svelte:head><title>Aktuell · WISSen</title></svelte:head>

<section class="now-route" aria-labelledby="now-title">
  <header class="route-head">
    <h1 class="route-head__title" id="now-title">Jetzt</h1>
    <span class="route-head__subtitle mono">{subtitle}</span>
  </header>

  <!-- 1. Floor strip (always visible, ambient) -->

  {#if loading && !plan && !noten}
    <!-- Skeleton mirrors the 3-up hero row. -->
    <div class="hero-row" aria-hidden="true">
      {#each [0, 1, 2] as i (i)}
        <div class="now-card skeleton">
          <div class="skel-line skel-line--label"></div>
          <div class="skel-line skel-line--time"></div>
          <div class="skel-line skel-line--title"></div>
          <div class="skel-line skel-line--meta"></div>
        </div>
      {/each}
    </div>
  {:else if error}
    <!-- Error fallback -->
    <div class="now-card now-card--error">
      <div class="now-card__label">Fehler</div>
      <div class="now-card__title">Daten konnten nicht geladen werden.</div>
      <div class="now-card__error-msg">{error}</div>
      <button class="btn btn--primary" type="button" onclick={fetchAll}>
        Erneut versuchen
      </button>
    </div>
  {:else if !everScraped}
    <!-- Fresh install: no scrape has ever run -->
    <div class="now-card now-card--idle">
      <div class="now-card__label">Noch keine Daten</div>
      <div class="now-card__title">
        Klick oben rechts auf <kbd class="kbd">Abfragen</kbd> oder drücke
        <kbd class="kbd">r</kbd>, um zu starten.
      </div>
    </div>
  {:else}
    <!-- PC dashboard layout: a Notenschnitt-strip across the top, then
         a dominant Aktuell-hero on the left with the big floor-plan and
         a vertical info-rail on the right (Nächste Lektion, Heute noch,
         Letzte Änderung). Responsive: 65/35 split on wide screens, 1fr
         stack on laptop-narrow widths. -->

    <!-- Notenschnitt strip — first thing the user sees, glance-readable
         across all monitor widths. Per-semester chips on the right. -->
    {#if notenCount > 0}
      <header class="grades-strip" aria-label="Notenschnitt">
        <div class="grades-strip__main">
          <div class="grades-strip__primary">
            <span class="grades-strip__label">Notenschnitt</span>
            <span
              class="grades-strip__value mono"
              style:color={gradeColor(notenAvg)}
            >
              {notenAvg != null ? notenAvg.toFixed(2) : '—'}
            </span>
            <span class="grades-strip__count mono">
              {notenCount} Module
            </span>
          </div>
          {#if bkCount > 0}
            <div class="grades-strip__bk" aria-label="BK-Schnitt {bkAvg != null ? bkAvg.toFixed(2) : '—'}">
              <span class="grades-strip__bk-label">BK</span>
              <span
                class="grades-strip__bk-value mono"
                style:color={gradeColor(bkAvg)}
              >
                {bkAvg != null ? bkAvg.toFixed(2) : '—'}
              </span>
            </div>
          {/if}
        </div>

        {#if lastAddedNote}
          <button
            type="button"
            class="grades-strip__last"
            onclick={() => openNote(lastAddedNote)}
            aria-label="Zur letzten Note: {shortModuleCode(lastAddedNote)} {moduleNameWithSemester(lastAddedNote)}"
          >
            <span class="grades-strip__last-label">Letzte Note</span>
            <span class="grades-strip__last-code mono">
              {shortModuleCode(lastAddedNote)}
            </span>
            <span class="grades-strip__last-name">
              {moduleNameWithSemester(lastAddedNote)}
            </span>
            <span
              class="grades-strip__last-grade mono"
              style:color={gradeColor(lastAddedNote.note)}
            >
              {lastAddedNote.note != null
                ? lastAddedNote.note.toFixed(2)
                : (lastAddedNote.note_raw || '—')}
            </span>
            <span class="grades-strip__last-when mono">
              {fmtRelativePast(lastAddedNote.note_recorded_at ?? lastAddedNote.fetched_at, now)}
            </span>
          </button>
        {/if}

        {#if semesterChips.length > 0}
          <div class="grades-strip__sems">
            {#each semesterChips as [sem, avg] (sem)}
              <span class="grades-strip__sem">
                <span class="grades-strip__sem-label">{sem}</span>
                <span
                  class="grades-strip__sem-value mono"
                  style:color={gradeColor(avg)}
                >
                  {avg != null ? avg.toFixed(2) : '—'}
                </span>
              </span>
            {/each}
          </div>
        {/if}
      </header>
    {/if}

    <!-- Top hero row: 3 lesson cards side-by-side.
         Default: Aktuell + Nächste heute + Danach heute.
         Empty-day fallback: the next three actual lessons from anywhere
         in the upcoming week, each labelled with a date pill so the day
         is obvious. Each card shows its own floor-plan, sized to the column. -->
    <div class="hero-row">
      {#if showAcrossWeek}
        {@const a = upcomingAcrossWeek[0] ?? null}
        {@const b = upcomingAcrossWeek[1] ?? null}
        {@const c = upcomingAcrossWeek[2] ?? null}
        {@const nextDayLabel = a ? dateLabelFor(a) : ''}
        {@const emptyAfter = nextDayLabel ? `Keine weitere Lektion am ${nextDayLabel}` : 'Keine weitere Lektion'}
        <LessonCard
          lesson={a}
          label="Als nächstes"
          hint={startsInMinutes(a)}
          dateLabel={dateLabelFor(a)}
          emptyTitle="Keine kommenden Lektionen"
          {isOnline}
        />
        <LessonCard
          lesson={b}
          label="Danach"
          hint={startsInMinutes(b)}
          dateLabel={dateLabelFor(b)}
          emptyTitle={emptyAfter}
          {isOnline}
        />
        <LessonCard
          lesson={c}
          label="Danach"
          hint={startsInMinutes(c)}
          dateLabel={dateLabelFor(c)}
          emptyTitle={emptyAfter}
          {isOnline}
        />
      {:else}
        <NowCard
          {currentEvent}
          hasNextToday={nextEventToday !== null}
          {nextEvent}
          {remainingCopy}
          {dayDone}
          {fmtDateShort}
          {combineDateTime}
          {isOnline}
        />
        <LessonCard
          lesson={nextEventToday}
          label="Nächste Lektion"
          hint={startsInMinutes(nextEventToday)}
          emptyTitle="Heute keine weitere Lektion"
          {isOnline}
        />
        <LessonCard
          lesson={lessonAfterNext}
          label="Danach"
          hint={startsInMinutes(lessonAfterNext)}
          emptyTitle="Keine dritte Lektion heute"
          {isOnline}
        />
      {/if}
    </div>

    <!-- Below: side-by-side info panels (overflow today + Letzte Änderung). -->
    <div class="info-row">
      {#if todayOverflow.length > 0}
        <section class="panel" aria-labelledby="more-today-title">
          <header class="panel__head">
            <span id="more-today-title" class="panel__label">Später heute</span>
            <span class="panel__count mono">{todayOverflow.length}</span>
          </header>
          <ul class="panel-list" role="list">
            {#each todayOverflow as ev (ev.id)}
              <li>
                <button
                  type="button"
                  class="panel-item"
                  onclick={() => goToPlanFocus(ev.id)}
                >
                  <span class="panel-item__time mono">
                    {ev.zeit_von}–{ev.zeit_bis}
                  </span>
                  <span class="panel-item__title">
                    {ev.veranstaltung || '—'}
                  </span>
                  <span
                    class="panel-item__room mono"
                    class:panel-item__room--online={isOnline(ev.raum)}
                  >
                    {ev.raum || '—'}
                  </span>
                </button>
              </li>
            {/each}
          </ul>
        </section>
      {/if}

      <section class="panel" aria-labelledby="changes-title">
        <header class="panel__head">
          <span id="changes-title" class="panel__label">Letzte Änderung</span>
          {#if freshChanges.length > 0}
            <span class="panel__count mono">{freshChanges.length}</span>
            <button
              type="button"
              class="panel__action"
              onclick={dismissAllChanges}
              disabled={dismissBusy}
              title="Alle als gelesen markieren und entfernen"
              aria-label="Alle Änderungen als gelesen markieren"
            >
              {dismissBusy ? '…' : 'Alle gelesen'}
            </button>
          {/if}
        </header>
        {#if freshChanges.length > 0}
          <ul class="panel-changes" role="list">
            {#each freshChanges as c (c.kind + '-' + c.row.id)}
              <li class="panel-changes__item">
                {#if c.kind === 'noten'}
                  {@const isChange = c.row.prev_note != null
                    && c.row.note != null
                    && c.row.prev_note !== c.row.note}
                  {@const modNum = shortModuleCode(c.row)}
                  <button
                    type="button"
                    class="panel-change"
                    onclick={() => openNote(c.row)}
                  >
                    {#if isChange}
                      <!-- Wert-Änderung: Stift-Icon + Modulnummer-Modulname:
                           prev → curr Diff im Title. Mirrors Zimmerwechsel
                           Pattern (icon-cell + Beschreibung im title). -->
                      <span class="panel-change__icon panel-change__icon--note-change" aria-hidden="true">✎</span>
                      <span class="panel-change__body">
                        <span class="panel-change__title">
                          {modNum ? modNum + ' - ' : ''}{moduleNameWithSemester(c.row)}: <span class="panel-change__diff mono">
                            <span style:color={gradeColor(c.row.prev_note)}>{c.row.prev_note != null ? c.row.prev_note.toFixed(2) : '—'}</span>
                            <span class="panel-change__arrow" aria-hidden="true">→</span>
                            <span style:color={gradeColor(c.row.note)}>{c.row.note != null ? c.row.note.toFixed(2) : '—'}</span>
                          </span>
                        </span>
                        <span class="panel-change__sub mono">
                          {fmtRelativePast(c.row.fetched_at, now)}
                        </span>
                      </span>
                    {:else}
                      <!-- Neue Note (vorher gab's keinen Wert): Plus-Icon
                           + Label "Neue Note Y.YY" im Title. -->
                      <span class="panel-change__icon panel-change__icon--note-new" aria-hidden="true">＋</span>
                      <span class="panel-change__body">
                        <span class="panel-change__title">
                          {modNum ? modNum + ' - ' : ''}{moduleNameWithSemester(c.row)}: <span class="panel-change__diff mono"
                            style:color={gradeColor(c.row.note)}>Neue Note {c.row.note != null ? c.row.note.toFixed(2) : (c.row.note_raw || '—')}</span>
                        </span>
                        <span class="panel-change__sub mono">
                          {fmtRelativePast(c.row.fetched_at, now)}
                        </span>
                      </span>
                    {/if}
                  </button>
                {:else}
                  <button
                    type="button"
                    class="panel-change"
                    onclick={() => openLesson(c.row)}
                  >
                    <span class="panel-change__icon" aria-hidden="true">⇄</span>
                    <span class="panel-change__body">
                      <span class="panel-change__title">
                        {c.row.veranstaltung} → {c.row.raum || '—'}
                      </span>
                      <span class="panel-change__sub mono">
                        {fmtRelativePast(c.row.fetched_at, now)}
                      </span>
                    </span>
                  </button>
                {/if}
                <!-- Per-Item-Dismiss: roter X rechts neben jedem Eintrag.
                     Sibling des panel-change Buttons, NICHT Kind, weil
                     verschachtelte Buttons ungültiges HTML sind. -->
                <button
                  type="button"
                  class="panel-change__dismiss"
                  onclick={() => dismissOne(c)}
                  disabled={dismissingIds.has(c.kind + '-' + c.row.id)}
                  title="Diesen Eintrag entfernen"
                  aria-label="Eintrag entfernen"
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none"
                       stroke="currentColor" stroke-width="2.4"
                       stroke-linecap="round" stroke-linejoin="round"
                       aria-hidden="true">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="panel-empty">Keine frischen Änderungen.</p>
        {/if}
      </section>
    </div>
  {/if}
</section>

<!-- Custom Confirm-Dialog für destruktive Aktionen ("Alle gelesen"). Statt
     des Browser-eigenen window.confirm — das looked OS-spezifisch und
     bricht den WISSen-Look. Eigenes Modal mit Backdrop, Esc-/Click-
     außen-Schließen und ghost-Buttons. -->
{#if confirmOpen}
  <div
    class="confirm-overlay"
    role="dialog"
    aria-modal="true"
    aria-labelledby="confirm-title"
    tabindex="-1"
    onclick={(e) => { if (e.target === e.currentTarget) closeConfirm(false); }}
    onkeydown={(e) => {
      if (e.key === 'Escape') { closeConfirm(false); return; }
      trapConfirmFocus(e);
    }}
  >
    <div class="confirm-card" role="document">
      <h3 id="confirm-title" class="confirm-card__title">Sicher?</h3>
      <p class="confirm-card__msg">{confirmMsg}</p>
      <div class="confirm-card__actions">
        <button
          type="button"
          class="confirm-card__btn confirm-card__btn--ghost"
          onclick={() => closeConfirm(false)}
        >
          Abbrechen
        </button>
        <button
          type="button"
          class="confirm-card__btn confirm-card__btn--danger"
          onclick={() => closeConfirm(true)}
          {@attach (el) => { queueMicrotask(() => el.focus()); }}
        >
          Entfernen
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .now-route {
    display: flex;
    flex-direction: column;
    gap: 18px;
    flex: 1;
    min-height: 0;
  }

  /* Header */
  .route-head {
    display: flex;
    align-items: baseline;
    gap: 14px;
    margin-bottom: 4px;
  }
  .route-head__title {
    margin: 0;
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.01em;
    color: var(--text);
    line-height: 1.2;
  }
  .route-head__subtitle {
    color: var(--text-dim);
    font-size: 13px;
    letter-spacing: 0.02em;
  }

  /* Notenschnitt strip — full-width hairline-divided header with the big
   * mono average on the left and per-semester chips on the right. */
  .grades-strip {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    padding: 12px 4px 14px;
    border-bottom: 1px solid var(--border-soft);
    flex-wrap: wrap;
  }
  .grades-strip__main {
    display: flex;
    align-items: center;
    gap: 20px;
  }
  .grades-strip__primary {
    display: flex;
    align-items: baseline;
    gap: 14px;
  }
  .grades-strip__label {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.10em;
    text-transform: uppercase;
    color: var(--text-dim);
  }
  .grades-strip__value {
    font-size: 32px;
    font-weight: 600;
    letter-spacing: -0.02em;
    line-height: 1;
    transition: color var(--t-normal, 300ms) ease;
  }
  .grades-strip__count {
    font-size: 12px;
    color: var(--text-mute);
    letter-spacing: 0.02em;
  }
  /* BK-Schnitt — sekundäre Grösse, vertikal gestapelt, kleiner als Hauptwert */
  .grades-strip__bk {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 1px;
    padding-left: 20px;
    border-left: 1px solid var(--border-soft);
  }
  .grades-strip__bk-label {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--text-dim);
    line-height: 1;
  }
  .grades-strip__bk-value {
    font-size: 22px;
    font-weight: 600;
    letter-spacing: -0.02em;
    line-height: 1;
    font-family: var(--font-mono);
    font-feature-settings: 'tnum' 1, 'zero' 1;
    transition: color var(--t-normal, 300ms) ease;
  }
  .grades-strip__sems {
    display: flex;
    align-items: baseline;
    gap: 18px;
    flex-wrap: wrap;
  }
  .grades-strip__sem {
    display: inline-flex;
    align-items: baseline;
    gap: 8px;
    font-size: 13px;
  }
  .grades-strip__sem-label {
    color: var(--text-dim);
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    font-weight: 600;
  }
  .grades-strip__sem-value {
    font-size: 16px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }

  /* "Letzte Note" inline chip — sits between the avg block and the
   * semester chips so a glance at the strip shows where the latest
   * change landed. Clickable; deep-links into /noten?focus=<code>. */
  .grades-strip__last {
    display: inline-flex;
    align-items: baseline;
    gap: 10px;
    padding: 6px 12px;
    background: var(--surface);
    border: 1px solid var(--border-soft);
    border-radius: 999px;
    font: inherit;
    color: inherit;
    cursor: pointer;
    transition:
      background var(--t-fast) var(--ease),
      border-color var(--t-fast) var(--ease);
    /* Clamp statt fixer 520px — auf 1024-1279px Viewports verhindert das
     * 40%-Mid einen 2-Reihen-Wrap der grades-strip, ohne auf >=1280px
     * zu schrumpfen (520px-Cap bleibt). 280px-Floor schützt schmale
     * Viewports vor zu enger Pille. */
    max-width: clamp(280px, 40%, 520px);
    min-width: 0;
  }
  @media (hover: hover) and (pointer: fine) {
    .grades-strip__last:hover {
      background: var(--surface-2);
      border-color: var(--border);
    }
  }
  .grades-strip__last:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .grades-strip__last-label {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.10em;
    text-transform: uppercase;
    color: var(--text-dim);
    flex-shrink: 0;
  }
  .grades-strip__last-code {
    font-size: 12px;
    color: var(--text);
    background: var(--surface-2);
    border: 1px solid var(--border-soft);
    border-radius: var(--r-sm);
    padding: 1px 7px;
    letter-spacing: 0.04em;
    flex-shrink: 0;
  }
  .grades-strip__last-name {
    font-size: 13px;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .grades-strip__last-grade {
    font-size: 16px;
    font-weight: 700;
    letter-spacing: -0.01em;
    flex-shrink: 0;
  }
  .grades-strip__last-when {
    font-size: 11px;
    color: var(--text-dim);
    letter-spacing: 0.02em;
    flex-shrink: 0;
  }

  /* Main dashboard split: Hero (Aktuell with floor-plan) + vertical info
   * rail. Asymmetric, dense, info-rich — that's the PC dashboard feel.
   *
   * Breakpoints:
   *  - ≥1280px (desktop):   65 / 35 split (hero dominant)
   *  - 1024-1279 (laptop):  60 / 40 split (still 2-col but tighter)
   *  - <1024 (small lap):   1-col stack (hero on top, rail below)
   */
  /* Top hero row: 3 lesson cards side-by-side. Each shows its own
   * floor-plan at proper size — min-height guarantees the floor-plans
   * have room to breathe regardless of how much content is in the panels
   * below. align-items:stretch makes all 3 cards the same height. */
  .hero-row {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 16px;
    align-items: stretch;
    min-height: 420px;
  }
  @media (max-width: 1279px) {
    .hero-row { gap: 12px; min-height: 380px; }
  }
  @media (max-width: 1023px) {
    .hero-row {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      min-height: auto;
    }
  }
  @media (max-width: 700px) {
    .hero-row { grid-template-columns: 1fr; }
  }

  /* Below the hero row: side-by-side info panels. auto-fit so when there
   * is only one panel (no Später-heute overflow) it claims the full row
   * instead of leaving an empty grid track on the right. */
  .info-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
    gap: 16px;
    align-items: start;
  }

  .panel {
    background: var(--surface);
    border: 1px solid var(--border-soft);
    border-radius: var(--r-lg);
    padding: 14px 16px 16px;
    box-shadow: var(--shadow-sm);
  }
  .panel__head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 10px;
  }
  .panel__label {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.10em;
    text-transform: uppercase;
    color: var(--text-dim);
  }
  .panel__count {
    font-size: 11px;
    color: var(--accent);
    background: var(--accent-soft);
    border-radius: 999px;
    padding: 1px 8px;
    letter-spacing: 0.02em;
  }
  /* "Alle gelesen"-Button — ghost style, sitzt rechts neben dem Count.
   * margin-left:auto schiebt ihn an den rechten Header-Rand (header ist
   * flex space-between, das Label links, alles andere rechts gruppiert). */
  .panel__action {
    margin-left: auto;
    background: transparent;
    border: 1px solid transparent;
    color: var(--text-mute);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    padding: 3px 8px;
    border-radius: var(--r-sm);
    cursor: pointer;
    transition:
      color var(--t-fast) var(--ease),
      background var(--t-fast) var(--ease),
      border-color var(--t-fast) var(--ease),
      transform var(--t-fast) var(--ease);
  }
  @media (hover: hover) and (pointer: fine) {
    .panel__action:hover:not(:disabled) {
      color: var(--text);
      background: var(--surface-2);
      border-color: var(--border);
    }
  }
  .panel__action:active:not(:disabled) {
    transform: scale(0.97);
  }
  .panel__action:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .panel__action:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .panel-empty {
    margin: 4px 0 0;
    color: var(--text-dim);
    font-size: 12px;
  }

  /* Später-heute list inside a panel. */
  .panel-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .panel-item {
    display: grid;
    grid-template-columns: max-content 1fr auto;
    align-items: center;
    gap: 12px;
    width: 100%;
    padding: 8px 10px;
    background: transparent;
    border: 0;
    /* --r-md (8px) statt --r-sm (6px). Auf High-DPI-Monitoren las sich
     * die enge 6px-Rundung als fast rechteckig; 8px ist sichtbar
     * abgerundet ohne den Linear/Raycast-Tool-Look zu verlieren.
     * Padding-X von 6 auf 10px erhöht damit der Inhalt nicht in den
     * neuen Radius reinläuft. */
    border-radius: var(--r-md);
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    transition: background var(--t-fast) var(--ease);
  }
  @media (hover: hover) and (pointer: fine) {
    .panel-item:hover { background: var(--surface-2); }
  }
  .panel-item:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -1px;
  }
  .panel-item__time {
    font-size: 12px;
    color: var(--text-mute);
    letter-spacing: 0.01em;
  }
  .panel-item__title {
    font-size: 13px;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .panel-item__room {
    font-size: 10.5px;
    color: var(--text-mute);
    background: var(--surface-2);
    border: 1px solid var(--border-soft);
    border-radius: var(--r-sm);
    padding: 2px 7px;
    letter-spacing: 0.04em;
    white-space: nowrap;
  }
  .panel-item__room--online {
    background: transparent;
    border-color: var(--accent-border);
    color: var(--accent);
    font-style: italic;
  }

  /* Letzte-Änderung change feed inside a panel. */
  .panel-changes {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  /* ============================================================
   * Confirm-Dialog für destruktive Aktionen
   * ============================================================ */
  .confirm-overlay {
    position: fixed;
    inset: 0;
    z-index: 90;
    display: grid;
    place-items: center;
    padding: 20px;
    background: rgba(5, 8, 14, 0.6);
    animation: confirmFade 180ms var(--ease);
  }
  @keyframes confirmFade {
    from { opacity: 0; }
    to   { opacity: 1; }
  }
  .confirm-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    padding: 20px 22px 18px;
    width: min(420px, 100%);
    box-shadow: var(--shadow-lg);
    animation: confirmPop 180ms var(--ease);
  }
  @keyframes confirmPop {
    from { opacity: 0; transform: scale(0.96) translateY(6px); }
    to   { opacity: 1; transform: scale(1) translateY(0); }
  }
  .confirm-card__title {
    margin: 0 0 8px;
    font-size: 15px;
    font-weight: 600;
    color: var(--text);
    letter-spacing: -0.005em;
  }
  .confirm-card__msg {
    margin: 0 0 18px;
    font-size: 13px;
    color: var(--text-mute);
    line-height: 1.5;
  }
  .confirm-card__actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
  .confirm-card__btn {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text);
    font-size: 13px;
    font-weight: 600;
    padding: 7px 14px;
    border-radius: var(--r-sm);
    cursor: pointer;
    transition:
      background var(--t-fast) var(--ease),
      border-color var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease),
      transform var(--t-fast) var(--ease);
  }
  .confirm-card__btn--ghost {
    color: var(--text-mute);
  }
  @media (hover: hover) and (pointer: fine) {
    .confirm-card__btn--ghost:hover {
      background: var(--surface-2);
      color: var(--text);
    }
  }
  /* Danger-Button — Token-driven statt hardcoded rgba(). Closest-fit:
   * 0.12 → --danger-soft (0.10), 0.45 → --danger-border-strong (0.45),
   * Hover 0.18 → --danger-soft-strong (0.18 exact). Visuell identisch
   * zur vorherigen Implementierung; Theming + Dark/Light konsistent. */
  .confirm-card__btn--danger {
    background: var(--danger-soft);
    border-color: var(--danger-border-strong);
    color: var(--danger);
  }
  @media (hover: hover) and (pointer: fine) {
    .confirm-card__btn--danger:hover {
      background: var(--danger-soft-strong);
      border-color: var(--danger);
    }
  }
  .confirm-card__btn:active {
    transform: scale(0.97);
  }
  .confirm-card__btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  @media (prefers-reduced-motion: reduce) {
    .confirm-overlay,
    .confirm-card { animation: none; }
  }

  /* Item-Row: panel-change Button (Hauptklick) + dismiss-X als Geschwister
   * INNERHALB einer gemeinsamen visuellen Box. Hover-Background sitzt am
   * <li> damit Klick-Bereich und X-Bereich denselben Highlight teilen.
   * Kein gap — Inner-Buttons grenzen direkt aneinander; border-radius
   * NUR am Outer, Inner-Buttons sind eckig damit nichts an den Rändern
   * absteht. */
  .panel-changes__item {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: stretch;
    gap: 0;
    /* Konsistent mit .panel-item — 8px statt 6px für sichtbare Rundung
     * im Linear/Raycast-Tool-Look. */
    border-radius: var(--r-md);
    overflow: hidden;
    transition: background var(--t-fast) var(--ease);
  }
  @media (hover: hover) and (pointer: fine) {
    .panel-changes__item:hover { background: var(--surface-2); }
  }
  /* Dismiss-X — dezent danger-tint, taucht auf wenn die Row gehovered wird,
   * mobile (touch) ist er permanent sichtbar (kein hover-state). */
  .panel-change__dismiss {
    display: grid;
    place-items: center;
    width: 32px;
    border: 0;
    background: transparent;
    color: var(--text-dim);
    /* Eckig — der border-radius lebt am Outer .panel-changes__item, damit
     * der X visuell IM gleichen Container sitzt wie die Row. */
    border-radius: 0;
    cursor: pointer;
    opacity: 0.4;
    transition:
      opacity var(--t-fast) var(--ease),
      background var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease),
      transform var(--t-fast) var(--ease);
  }
  @media (hover: hover) and (pointer: fine) {
    .panel-changes__item:hover .panel-change__dismiss { opacity: 1; }
    .panel-change__dismiss:hover {
      background: var(--danger-soft);
      color: var(--danger, #ff6b6b);
    }
  }
  /* Touch-Devices: X immer sichtbar, kein Hover-Reveal. */
  @media (hover: none) {
    .panel-change__dismiss { opacity: 0.7; }
  }
  .panel-change__dismiss:active:not(:disabled) {
    transform: scale(0.9);
    color: var(--danger, #ff6b6b);
  }
  .panel-change__dismiss:focus-visible {
    outline: 2px solid var(--danger, #ff6b6b);
    outline-offset: -1px;
    opacity: 1;
  }
  .panel-change__dismiss:disabled {
    opacity: 0.25;
    cursor: not-allowed;
  }
  .panel-change {
    display: grid;
    grid-template-columns: 36px 1fr;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 6px;
    background: transparent;
    border: 0;
    /* Border-Radius lebt am Outer (.panel-changes__item); Inner-Button
     * eckig damit kein Spalt zwischen Button und Dismiss-X entsteht. */
    border-radius: 0;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .panel-change:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -1px;
  }
  .panel-change__icon {
    text-align: center;
    color: var(--warning);
    font-size: 14px;
    flex-shrink: 0;
    width: 18px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  /* Stift-Icon für Note-Wert-Änderung — accent-blau statt warning-amber,
   * damit Note-Diff sich visuell von Zimmerwechsel (warning) abgrenzt. */
  .panel-change__icon--note-change {
    color: var(--accent);
    font-size: 15px;
  }
  /* Plus-Icon für eine erstmals erfasste Note — grade-excellent grün, weil
   * "neue Note" in der Regel ein positives Signal ist (Modul wurde
   * abgeschlossen / Tocco hat den Eintrag freigegeben). */
  .panel-change__icon--note-new {
    color: var(--grade-excellent, var(--accent));
    font-size: 16px;
    font-weight: 700;
  }
  /* Inline-Diff im Title-Text. Hält die prev → curr-Werte in einer Zeile
   * mit Mono-Font damit Tabular-Nums alignen. */
  .panel-change__diff {
    font-weight: 600;
    margin-left: 2px;
  }
  .panel-change__arrow {
    color: var(--text-dim);
    font-weight: 500;
    margin: 0 4px;
  }
  .panel-change__body {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .panel-change__title {
    font-size: 12.5px;
    color: var(--text);
    /* Wrap erlauben — lange "Modulnummer - Modulname: prev → curr"-Texte
     * würden auf schmalen Viewports und im aufgeklappten Letzte-Änderung-
     * Panel sonst abgeschnitten. overflow-wrap:anywhere reicht aus, um
     * auch extrem lange Modulnamen zu brechen, die nicht von alleine
     * umbrechen — word-break:break-word ist redundant. */
    line-height: 1.4;
    overflow-wrap: anywhere;
  }
  .panel-change__sub {
    font-size: 11px;
    color: var(--text-mute);
  }

  /* Skeleton + error/idle Now-card surface tokens — the real Now-card lives
   * in NowCard.svelte. These rules only style placeholders left in this file. */
  .now-card {
    position: relative;
    background: var(--surface);
    border: 1px solid var(--border-soft);
    border-radius: var(--r-lg);
    padding: 20px;
    box-shadow: var(--shadow-md);
  }
  .now-card__label {
    font-size: 11px;
    letter-spacing: 0.10em;
    text-transform: uppercase;
    color: var(--text-dim);
    font-weight: 600;
    margin-bottom: 10px;
  }
  .now-card__title {
    font-size: 18px;
    font-weight: 600;
    letter-spacing: -0.005em;
    margin-bottom: 8px;
    color: var(--text);
    line-height: 1.3;
  }
  .now-card--idle .now-card__title {
    color: var(--text-mute);
    font-weight: 500;
  }
  .now-card--error {
    border-color: var(--danger-border-strong);
  }
  .now-card--error .now-card__title {
    color: var(--text);
    font-weight: 600;
  }
  .now-card__error-msg {
    margin: 6px 0 14px;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-dim);
    word-break: break-word;
  }

  .mono {
    font-family: var(--font-mono);
    font-feature-settings: 'tnum' 1, 'zero' 1;
  }

  /* Buttons */
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 14px;
    border-radius: var(--r-md);
    font-family: var(--font-sans);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.04em;
    cursor: pointer;
    transition: transform var(--t-fast) var(--ease), background var(--t-fast) var(--ease);
  }
  .btn--primary {
    background: var(--accent);
    color: var(--accent-ink);
    border: 1px solid var(--accent);
    box-shadow: var(--shadow-sm);
  }
  @media (hover: hover) and (pointer: fine) {
    .btn--primary:hover {
      transform: translateY(-1px);
    }
  }
  .btn--primary:active {
    transform: scale(0.97);
  }
  .btn:focus-visible,
  .btn--primary:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  /* Inline kbd hint */
  .kbd {
    display: inline-flex;
    align-items: center;
    font-family: var(--font-mono);
    font-size: 11px;
    background: var(--accent-soft);
    border: 1px solid var(--accent-border);
    border-radius: 4px;
    padding: 1px 6px;
    color: var(--accent);
    letter-spacing: 0.04em;
  }

  /* Skeleton loading state */
  .skeleton {
    pointer-events: none;
  }
  .skel-line {
    height: 14px;
    border-radius: 4px;
    background: linear-gradient(
      90deg,
      var(--surface-2) 0%,
      var(--surface-3) 50%,
      var(--surface-2) 100%
    );
    background-size: 200% 100%;
    animation: skel-shimmer 1.2s linear infinite;
    margin-bottom: 10px;
  }
  .skel-line--label { width: 30%; height: 11px; margin-bottom: 14px; }
  .skel-line--time  { width: 55%; height: 22px; }
  .skel-line--title { width: 70%; height: 18px; }
  .skel-line--meta  { width: 45%; height: 13px; margin-bottom: 0; }

  @keyframes skel-shimmer {
    0%   { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }

  /* Reduced motion: skeletons go static, button hover lift drops, keep
   * pulse handled in tokens.css. */
  @media (prefers-reduced-motion: reduce) {
    .skel-line {
      animation: none;
      background: var(--surface-2);
    }
    .btn--primary:hover {
      transform: none;
    }
  }

  /* Narrow screens (small laptops in tab + sidebar): tighten paddings */
  @media (max-width: 640px) {
    .grades-strip { gap: 14px; padding: 8px 2px 12px; }
    .grades-strip__value { font-size: 26px; }
    .panel { padding: 12px 14px; }
  }

  /* Touch targets: ensure 44px minimum on coarse pointers (mobile/tablet). */
  @media (pointer: coarse) {
    .panel-item,
    .panel-change {
      min-height: 44px;
    }
    /* Dismiss-X — 32px Default ist auf Touch unter dem Apple/WCAG-Minimum
     * von 44px. Auf coarse-Pointern auf 44px erweitern, damit der Hit-
     * Target nicht der dünnste Punkt der Row ist. */
    .panel-change__dismiss {
      min-width: 44px;
    }
  }
</style>
