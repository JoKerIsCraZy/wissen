<script lang="ts">
  /**
   * /stats — Statistik-Übersicht.
   *
   * Quellen:
   *   - GET /api/stats   -> StatsResponse (counts, avg, nextEvent, ...)
   *   - GET /api/noten   -> NotenResponse (Detaildaten für Histogramm, sparkline,
   *                         Schnitt nach Semester)
   *
   * Die Stats-API liefert keine Zeitreihe für eine Sparkline; statt eine zu
   * faken, leiten wir sie aus den `fetched_at`-Timestamps der Noten ab. Wenn
   * weniger als zwei verschiedene Tage existieren, blenden wir die Sparkline
   * aus und zeigen stattdessen "n/a".
   */

  import { onMount, onDestroy } from 'svelte';
  import { getStats, getNoten } from '$lib/api/endpoints';
  import { pushToast } from '$lib/stores/toast.svelte';
  import type {
    StatsResponse,
    NotenResponse,
    NotenRow
  } from '$lib/api/types';

  let stats = $state<StatsResponse | null>(null);
  let noten = $state<NotenResponse | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);

  /* AbortController: bricht in-flight GET /api/stats + /api/noten ab,
   * wenn die Route geleavt oder load() während eines laufenden Fetches
   * erneut gerufen wird (Scrape-Event). */
  let activeController: AbortController | null = null;

  /**
   * Lädt Stats + Noten parallel.
   * @param opts.silent unterdrückt das Loading-Flicker (für event-triggered
   *  Refetch nach Scrape — die Daten sind schon sichtbar und sollen nicht
   *  durch einen Skeleton-Flash ersetzt werden).
   */
  async function load(opts: { silent?: boolean } = {}): Promise<void> {
    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;
    const { signal } = controller;

    if (!opts.silent) loading = true;
    error = null;
    try {
      const [s, n] = await Promise.all([
        getStats({ signal }),
        getNoten({}, { signal }),
      ]);
      if (signal.aborted) return;
      stats = s;
      noten = n;
    } catch (e) {
      if (signal.aborted) return;
      const msg = e instanceof Error ? e.message : 'Unbekannter Fehler';
      error = msg;
      pushToast('error', `Stats laden fehlgeschlagen: ${msg}`);
    } finally {
      if (!signal.aborted && !opts.silent) loading = false;
    }
  }

  onMount(() => {
    void load();
  });

  onDestroy(() => {
    activeController?.abort();
    activeController = null;
  });

  /* React to the global scrape trigger: when the user fires 'r' or clicks
   * the topbar Scrape button, re-pull our data once it lands. Mirrors the
   * pattern from /+page.svelte — wait 1.5s for the scrape commit to settle,
   * then silent refetch (no loading-flicker since data is already visible). */
  $effect(() => {
    function onScrape(): void {
      window.setTimeout(() => {
        void load({ silent: true });
      }, 1500);
    }
    window.addEventListener('wissen:scrape', onScrape);
    return () => window.removeEventListener('wissen:scrape', onScrape);
  });

  // ----- Derived metrics -----
  const totalModules = $derived(stats?.notenCount ?? 0);
  const withGrade = $derived(stats?.notenWithGradeCount ?? 0);
  const withoutGrade = $derived(Math.max(0, totalModules - withGrade));
  const avg = $derived(stats?.avgNote ?? null);

  /**
   * Histogram: 21 Buckets von 4.0 bis 6.0 in 0.1er Schritten.
   * Nur benotete Module (note != null) zaehlen.
   */
  const buckets = $derived.by<number[]>(() => {
    const arr = new Array<number>(21).fill(0);
    if (!noten) return arr;
    for (const row of noten.rows) {
      if (row.note == null) continue;
      const idx = Math.round((row.note - 4.0) * 10);
      if (idx >= 0 && idx < 21) arr[idx]++;
    }
    return arr;
  });

  const maxBucket = $derived(Math.max(1, ...buckets));

  /**
   * Sparkline: leitet einen rollierenden Durchschnitt aus den
   * fetched_at-Tagen der Noten ab. Wenn die Datenbasis zu duenn ist,
   * geben wir null zurueck und blenden die Sparkline aus.
   */
  interface SparkPoint {
    label: string;
    value: number;
  }

  const sparkPoints = $derived.by<SparkPoint[] | null>(() => {
    if (!noten) return null;
    const dayBuckets = new Map<string, number[]>();
    for (const row of noten.rows) {
      if (row.note == null) continue;
      const day = (row.fetched_at || '').slice(0, 10);
      if (!day) continue;
      const list = dayBuckets.get(day) ?? [];
      list.push(row.note);
      dayBuckets.set(day, list);
    }
    if (dayBuckets.size < 2) return null;
    const sortedDays = [...dayBuckets.keys()].sort();
    // Letzte 28 Tage
    const days = sortedDays.slice(-28);
    return days.map((d) => {
      const list = dayBuckets.get(d)!;
      const sum = list.reduce((a, b) => a + b, 0);
      return { label: d, value: sum / list.length };
    });
  });

  /** Trend: erster vs letzter Sparkline-Punkt. */
  const trend = $derived.by<number | null>(() => {
    if (!sparkPoints || sparkPoints.length < 2) return null;
    const first = sparkPoints[0].value;
    const last = sparkPoints[sparkPoints.length - 1].value;
    return last - first;
  });

  // ----- Sparkline SVG geometry -----
  const SPARK_W = 220;
  const SPARK_H = 48;
  const SPARK_PAD = 4;

  interface SparkPath {
    line: string;
    fill: string;
  }

  const sparkPath = $derived.by<SparkPath | null>(() => {
    const pts = sparkPoints;
    if (!pts || pts.length < 2) return null;
    // Single-pass min/max — avoids `Math.min(...arr)` spread cost.
    let min = pts[0].value;
    let max = min;
    for (let i = 1; i < pts.length; i++) {
      const v = pts[i].value;
      if (v < min) min = v;
      else if (v > max) max = v;
    }
    const range = max - min || 1;
    const innerW = SPARK_W - SPARK_PAD * 2;
    const innerH = SPARK_H - SPARK_PAD * 2;
    const denom = pts.length - 1;
    // Build line in a single pass; track first/last x for the fill closure.
    let line = '';
    let firstX = 0;
    let lastX = 0;
    for (let i = 0; i < pts.length; i++) {
      const x = SPARK_PAD + (i / denom) * innerW;
      const t = (pts[i].value - min) / range;
      const y = SPARK_PAD + (1 - t) * innerH;
      line += (i === 0 ? 'M' : 'L') + x.toFixed(2) + ',' + y.toFixed(2) + ' ';
      if (i === 0) firstX = x;
      lastX = x;
    }
    const baseY = (SPARK_H - SPARK_PAD).toFixed(2);
    const fill = line + `L${lastX.toFixed(2)},${baseY} L${firstX.toFixed(2)},${baseY} Z`;
    return { line: line.trim(), fill: fill.trim() };
  });

  /** CSS-Klasse fuer Note-Badge (passt zu --g-* Tokens). */
  function gradeClass(note: number | null): string {
    if (note == null) return '';
    if (note >= 5.0) return 'g-excellent';
    if (note >= 4.5) return 'g-good';
    if (note >= 4.0) return 'g-ok';
    return 'g-fail';
  }

  /** Histogram-Bucket -> Farb-Klasse (Band). */
  function bucketClass(idx: number): string {
    // idx 0..3   -> 4.0..4.3 -> fail unter 4.0 ist nicht im Bucket, aber wir
    // faerben die unteren Eintraege als ok/fail-Band (laut DESIGN: <4.0 fail).
    // 4.0-4.4 -> ok, 4.5-4.9 -> good, 5.0+ -> excellent.
    if (idx <= 4) return 'is-ok';
    if (idx <= 9) return 'is-good';
    return 'is-excellent';
  }

  function bucketLabel(idx: number): string {
    return (4.0 + idx / 10).toFixed(1);
  }

  /** Schnitt pro Semester sortieren (S1, S2, ...). */
  const semesterEntries = $derived.by<Array<[string, number]>>(() => {
    if (!stats?.avgBySemester) return [];
    return Object.entries(stats.avgBySemester).sort((a, b) =>
      a[0].localeCompare(b[0])
    );
  });
  /** Pre-joined "S1+S2+..." for the route subtitle (memoized). */
  const semesterKeysJoined = $derived(
    semesterEntries.map((e) => e[0]).join('+'),
  );
  /** Pre-joined "S1: 5.20 · S2: 4.80" for the headline col (memoized). */
  const semesterAvgsJoined = $derived(
    semesterEntries.map(([sem, val]) => `${sem}: ${val.toFixed(2)}`).join(' · '),
  );

  /* ---------- Modul Statistik: extended derivations ---------- */

  /**
   * Single noten-derived aggregate. All per-module statistics share one sort
   * pass over `gradedRows`, instead of triggering 4 separate `[...rows].sort()`
   * allocations on every recompute.
   */
  interface ModuleAggregate {
    gradedRows: NotenRow[];
    sortedDesc: NotenRow[];      // best -> worst
    medianNote: number | null;
    bestModule: NotenRow | null;
    worstModule: NotenRow | null;
    noteRange: number | null;
    topModules: NotenRow[];
    flopModules: NotenRow[];
  }
  const moduleAgg = $derived.by<ModuleAggregate>(() => {
    const empty: ModuleAggregate = {
      gradedRows: [],
      sortedDesc: [],
      medianNote: null,
      bestModule: null,
      worstModule: null,
      noteRange: null,
      topModules: [],
      flopModules: [],
    };
    if (!noten) return empty;
    const graded = noten.rows.filter((r) => r.note != null);
    if (!graded.length) return empty;

    // Single sort: best -> worst. Top/flop/best/worst/median all reuse this.
    const sortedDesc = graded.slice().sort(
      (a, b) => (b.note as number) - (a.note as number),
    );
    const n = sortedDesc.length;
    const best = sortedDesc[0];
    const worst = sortedDesc[n - 1];

    // Median from sorted notes — no extra sort.
    let median: number;
    if (n % 2 === 0) {
      // sortedDesc[n/2 - 1] and sortedDesc[n/2] straddle the middle (descending).
      median = ((sortedDesc[n / 2 - 1].note as number) +
                (sortedDesc[n / 2].note as number)) / 2;
    } else {
      median = sortedDesc[Math.floor(n / 2)].note as number;
    }

    // Top 5 = first 5 of sortedDesc; flop 5 = last 5 reversed (worst-first).
    const topModules = sortedDesc.slice(0, 5);
    const flopModules: NotenRow[] = [];
    for (let i = n - 1; i >= Math.max(0, n - 5); i--) flopModules.push(sortedDesc[i]);

    return {
      gradedRows: graded,
      sortedDesc,
      medianNote: median,
      bestModule: best,
      worstModule: worst,
      noteRange: (best.note as number) - (worst.note as number),
      topModules,
      flopModules,
    };
  });

  // Cheap aliases so template bindings stay readable.
  const gradedRows  = $derived<NotenRow[]>(moduleAgg.gradedRows);
  const medianNote  = $derived<number | null>(moduleAgg.medianNote);
  const bestModule  = $derived<NotenRow | null>(moduleAgg.bestModule);
  const worstModule = $derived<NotenRow | null>(moduleAgg.worstModule);
  const noteRange   = $derived<number | null>(moduleAgg.noteRange);
  const topModules  = $derived<NotenRow[]>(moduleAgg.topModules);
  const flopModules = $derived<NotenRow[]>(moduleAgg.flopModules);

  /** Per-Semester: count, avg, best, worst. */
  interface SemesterStat {
    semester: string;
    count: number;
    countGraded: number;
    avg: number | null;
    best: number | null;
    worst: number | null;
  }
  const semesterStats = $derived.by<SemesterStat[]>(() => {
    if (!noten) return [];
    // Single-pass aggregation: count, gradedCount, sum, best, worst per semester.
    interface Acc {
      count: number;
      gradedCount: number;
      sum: number;
      best: number;
      worst: number;
    }
    const acc = new Map<string, Acc>();
    for (const r of noten.rows) {
      const sem = r.semester || '–';
      let a = acc.get(sem);
      if (!a) {
        a = { count: 0, gradedCount: 0, sum: 0, best: -Infinity, worst: Infinity };
        acc.set(sem, a);
      }
      a.count++;
      if (r.note != null) {
        const n = r.note;
        a.gradedCount++;
        a.sum += n;
        if (n > a.best) a.best = n;
        if (n < a.worst) a.worst = n;
      }
    }
    const out: SemesterStat[] = [];
    for (const [sem, a] of acc) {
      out.push({
        semester: sem,
        count: a.count,
        countGraded: a.gradedCount,
        avg: a.gradedCount ? a.sum / a.gradedCount : null,
        best: a.gradedCount ? a.best : null,
        worst: a.gradedCount ? a.worst : null,
      });
    }
    return out.sort((a, b) => a.semester.localeCompare(b.semester));
  });

  /** Module-name resolution that mirrors helpers.moduleName from /noten. */
  function modName(r: NotenRow): string {
    return r.fach_name || r.fach_code || r.kuerzel_full || '—';
  }
  /** Trailing module-number ("122") — mirrors helpers.moduleCode. */
  function modCode(r: NotenRow): string {
    if (!r.kuerzel_code) return r.fach_code || '';
    const parts = String(r.kuerzel_code).split('-');
    if (!parts.length) return r.fach_code || '';
    const last = parts[parts.length - 1];
    if (/^N\d+$/i.test(last) && parts.length >= 2) {
      return parts[parts.length - 2] + '-' + last;
    }
    return last;
  }

  /** ISO-Datum -> "Mo, 12.05" (Wochentag + DD.MM). */
  function formatEventDate(iso: string): string {
    if (!iso) return '';
    const d = new Date(iso + 'T00:00:00');
    if (Number.isNaN(d.getTime())) return iso;
    const wd = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'][d.getDay()];
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    return `${wd}, ${dd}.${mm}`;
  }

  /* ---------- QV-Rechner (BiVo 2021, ABU dispensiert) ---------------
   *
   * Verbindliche Gewichtung laut Verordnung / Notenausweis:
   *   IPA                      40 %
   *   Informatikkompetenzen    30 %   (= BK, alle Modulnoten außer M+E)
   *   Mathe + Englisch         10 %
   *   ABU                      20 %   (dispensiert → fällt weg)
   *
   * Ohne ABU summieren sich die drei Bereiche auf 80 %. Damit die
   * Gesamtnote wieder auf der 1–6-Skala landet, dividieren wir durch
   * 0.8 — das ist kein Wahlschritt, sondern zwingend.
   *
   *   IPA   = (2·A + B + C) / 4          [A=Prozess/Resultat,
   *                                       B=Doku, C=Präsentation]
   *   BK    = Ø der Informatik-Modulnoten direkt aus Tocco
   *           (3-stellige Modulnummer; Mathe + Englisch ausgeschlossen)
   *   ME    = Ø der Mathe- und Englisch-Modulnoten
   *
   *   Gesamt = (IPA·0.4 + BK·0.3 + ME·0.1) / 0.8
   *
   * Effektiver Anteil nach der Division: IPA 50 %, BK 37.5 %, ME 12.5 %.
   * Diese Zahlen sind keine zweite Gewichtung, nur das Ergebnis der
   * Normalisierung — sie zeigen, wie stark jeder Bereich am Ende
   * tatsächlich durchschlägt.
   *
   * Notenquelle: `row.note` ist die geparste Tocco-Modulnote
   * (parseNote macht nur Komma→Punkt + parseFloat, keine Berechnung).
   * Das ist die Note wie sie im Tocco steht — KEIN backend-berechneter
   * Schnitt aus ZP/LB.
   *
   * Bestanden:
   *   - IPA ≥ 4.0
   *   - Gesamt ≥ 4.0
   *
   * Alle Zwischen- und Endwerte werden auf 0.1 gerundet (CH-Konvention).
   */

  /* IPA-Teilnoten — nullable damit der User leeren kann ohne Auto-Clamp.
   * Defaults sitzen auf 4.5 als plausibler Mittelwert. */
  let noteA = $state<number | null>(4.5);
  let noteB = $state<number | null>(4.5);
  let noteC = $state<number | null>(4.5);

  /* Sichere Zahl-Lese-Funktionen — leeres Feld / NaN = null. */
  function num(v: number | null): number {
    return v != null && Number.isFinite(v) ? v : 0;
  }
  function valid(v: number | null): v is number {
    return v != null && Number.isFinite(v);
  }
  function round1(n: number): number {
    return Math.round(n * 10) / 10;
  }

  /* Modul-Filter für die zwei Schnitte:
   *
   *   isMathEnglishModule(row)
   *     Matched Mathe + Englisch über `fach_name` (Mathematik /
   *     Englisch) — unabhängig vom Niveau-Suffix oder Semester. So
   *     fängt der Filter Mathematik-N1, Mathematik-N2, Englisch-N1
   *     etc. einheitlich ab.
   *
   *   isInformatikModule(row)
   *     Alles, was Berufsfach ist: 3-stellige Modulnummer im
   *     kuerzel_code (z.B. "122", "M122", "BMI-AP-122"). Lookbehind/
   *     -ahead schützt vor falsch gematchten Jahreszahlen ("2024").
   *     Mathe + Englisch werden zusätzlich explizit ausgeschlossen,
   *     falls ein ICT-Modul jemals ein Niveau-Suffix bekommt.
   *
   * Modul ohne Note → in beiden Filtern raus.
   * Module die WEDER M+E noch Informatik sind (z.B. ABU, falls
   * jemand mit ABU drinsitzt) fallen aus beiden Schnitten raus. */
  function isMathEnglishModule(row: NotenRow): boolean {
    const name = (row.fach_name || '').toLowerCase();
    return name.includes('mathematik') || name.includes('englisch');
  }
  function isInformatikModule(row: NotenRow): boolean {
    if (isMathEnglishModule(row)) return false;
    const code = row.kuerzel_code || '';
    if (!code) return false;
    if (/-N\d+$/i.test(code)) return false;
    return /(?<!\d)\d{3}(?!\d)/.test(code);
  }

  interface AvgData {
    rows: NotenRow[];
    count: number;
    avg: number | null;       // exakter Schnitt
    rounded: number | null;   // auf 0.1 gerundet (für die Formel)
  }
  function buildAvg(rows: NotenRow[]): AvgData {
    if (rows.length === 0) return { rows: [], count: 0, avg: null, rounded: null };
    let sum = 0;
    for (const r of rows) sum += r.note as number;
    const a = sum / rows.length;
    return { rows, count: rows.length, avg: a, rounded: round1(a) };
  }

  const bk = $derived.by<AvgData>(() => {
    if (!noten) return { rows: [], count: 0, avg: null, rounded: null };
    return buildAvg(noten.rows.filter((r) => isInformatikModule(r) && r.note != null));
  });

  const me = $derived.by<AvgData>(() => {
    if (!noten) return { rows: [], count: 0, avg: null, rounded: null };
    return buildAvg(noten.rows.filter((r) => isMathEnglishModule(r) && r.note != null));
  });

  /* IPA = (2·A + B + C) / 4, gerundet 0.1. Berechnet sobald A/B/C valid. */
  const ipaInputsValid = $derived<boolean>(
    valid(noteA) && valid(noteB) && valid(noteC),
  );
  const ipaExact = $derived<number | null>(
    ipaInputsValid ? (2 * num(noteA) + num(noteB) + num(noteC)) / 4 : null,
  );
  const ipaRounded = $derived<number | null>(
    ipaExact != null ? round1(ipaExact) : null,
  );

  /* Gesamtnote nur wenn IPA-Inputs UND beide Schnitte da sind.
   *
   *   Gesamt = (IPA·0.4 + BK·0.3 + ME·0.1) / 0.8
   *
   * Beide Schnitte sind bereits auf 0.1 gerundet, IPA ebenso. Das
   * entspricht der CH-Konvention (zwischenrunden vor Endformel). */
  const allQvValid = $derived<boolean>(
    ipaInputsValid && bk.rounded != null && me.rounded != null,
  );
  const gesamtExact = $derived<number | null>(
    allQvValid
      ? ((ipaRounded as number) * 0.4
         + (bk.rounded as number) * 0.3
         + (me.rounded as number) * 0.1) / 0.8
      : null,
  );
  const gesamtRounded = $derived<number | null>(
    gesamtExact != null ? round1(gesamtExact) : null,
  );

  const passQV = $derived<boolean>(
    allQvValid && (ipaRounded as number) >= 4 && (gesamtRounded as number) >= 4,
  );

  /** Range check für IPA-Inputs (1.0–6.0). */
  function inRange(v: number | null): boolean {
    return v == null || (v >= 1 && v <= 6);
  }
  const aInvalid = $derived<boolean>(!inRange(noteA));
  const bInvalid = $derived<boolean>(!inRange(noteB));
  const cInvalid = $derived<boolean>(!inRange(noteC));

  /* "Was-wäre-wenn"-Szenarien: drei feste IPA-Werte gegen die aktuellen
   * BK- und ME-Schnitte. Read-only Display unter dem Result.
   * Braucht beide Schnitte (sonst ergibt das ÷ 0.8 keine sinnvolle Note). */
  interface WhatIfScenario {
    ipa: number;
    gesamt: number;
    passed: boolean;
  }
  const whatIfScenarios = $derived.by<WhatIfScenario[]>(() => {
    if (bk.rounded == null || me.rounded == null) return [];
    return [5.0, 5.5, 6.0].map((ipa) => {
      const ges = round1(
        (ipa * 0.4 + (bk.rounded as number) * 0.3 + (me.rounded as number) * 0.1) / 0.8,
      );
      return { ipa, gesamt: ges, passed: ipa >= 4 && ges >= 4 };
    });
  });

  /* Modul-Listen-Toggles persistiert pro Box. */
  let bkListOpen = $state(false);
  let meListOpen = $state(false);
</script>

<svelte:head>
  <title>Statistik · WISSen</title>
</svelte:head>

<div class="route__head">
  <h1 class="route__title">Statistik</h1>
  <span class="route__subtitle mono">
    {#if loading}
      laedt...
    {:else if totalModules > 0}
      {totalModules} Module {#if semesterEntries.length}· {semesterKeysJoined}{/if}
    {:else}
      keine Daten
    {/if}
  </span>
</div>

{#if error && !stats}
  <div class="empty-state">
    <p>Fehler beim Laden der Statistik.</p>
    <button class="btn-primary" type="button" onclick={() => void load()}>Erneut versuchen</button>
  </div>
{:else}
  <!-- Headline stats — flat columns with hairline dividers, not tile chrome -->
  <dl class="headline">
    <div class="headline__col">
      <dt class="headline__label">Module</dt>
      <dd class="headline__value mono">{totalModules}</dd>
      <dd class="headline__sub">
        {#if semesterEntries.length}
          {semesterAvgsJoined}
        {:else}
          &nbsp;
        {/if}
      </dd>
    </div>
    <div class="headline__col">
      <dt class="headline__label">Mit Note</dt>
      <dd class="headline__value mono g-good">{withGrade}</dd>
      <dd class="headline__sub">
        {#if totalModules > 0}
          {Math.round((withGrade / totalModules) * 100)}% benotet
        {:else}
          &nbsp;
        {/if}
      </dd>
    </div>
    <div class="headline__col">
      <dt class="headline__label">Ohne Note</dt>
      <dd class="headline__value mono">{withoutGrade}</dd>
      <dd class="headline__sub">
        {#if stats?.changedRecent}
          {stats.changedRecent} kuerzlich geaendert
        {:else}
          ausstehend
        {/if}
      </dd>
    </div>
    <div class="headline__col">
      <dt class="headline__label">Schnitt</dt>
      <dd class="headline__value mono {gradeClass(avg)}">
        {avg != null ? avg.toFixed(2) : '–'}
      </dd>
      <dd class="headline__sub">
        {#if avg != null}
          ueber {withGrade} Module
        {:else}
          &nbsp;
        {/if}
      </dd>
    </div>
  </dl>

  <!-- Sparkline (volle Breite — Naechster Termin entfernt per User-Wunsch) -->
  <div class="card">
    <div class="card__head">
      <h2 class="card__title">Schnitt-Verlauf</h2>
      <span class="card__hint mono">letzte {sparkPoints?.length ?? 0} Tage</span>
    </div>
    <div class="spark-wrap">
      {#if sparkPath && sparkPoints && sparkPoints.length >= 2}
        {@const sparkFirst = sparkPoints[0].value}
        {@const sparkLast = sparkPoints[sparkPoints.length - 1].value}
        {@const sparkMin = sparkPoints.reduce((m, p) => (p.value < m ? p.value : m), sparkPoints[0].value)}
        {@const sparkMax = sparkPoints.reduce((m, p) => (p.value > m ? p.value : m), sparkPoints[0].value)}
        {@const sparkTrend = trend ?? 0}
        <svg
          viewBox="0 0 {SPARK_W} {SPARK_H}"
          preserveAspectRatio="none"
          class="spark-svg"
          role="img"
          aria-label={`Schnitt-Verlauf, ${sparkPoints.length} Tage, Trend ${sparkTrend >= 0 ? '+' : ''}${sparkTrend.toFixed(2)}, von ${sparkFirst.toFixed(2)} auf ${sparkLast.toFixed(2)}`}
        >
          <desc>Minimum {sparkMin.toFixed(2)}, Maximum {sparkMax.toFixed(2)}.</desc>
          <path d={sparkPath.fill} class="spark-fill" />
          <path d={sparkPath.line} class="spark-line" />
        </svg>
        {#if trend != null}
          <span class="spark-trend mono {trend >= 0 ? 'g-excellent' : 'g-fail'}">
            {trend >= 0 ? '+' : ''}{trend.toFixed(2)}
          </span>
        {/if}
      {:else}
        <p class="muted mono">Zu wenige Datenpunkte fuer Trend.</p>
      {/if}
    </div>
  </div>

  <!-- Modul Statistik — Verteilung + Kennzahlen + Top/Flop + pro Semester -->
  <div class="card">
    <div class="card__head">
      <h2 class="card__title">Modul Statistik</h2>
      <span class="card__hint mono">{withGrade} benotet · {totalModules} total</span>
    </div>

    <!-- Kennzahlen — inline rows with hairline dividers (different visual rhythm than headline) -->
    <section class="modstat__section">
      <h3 class="modstat__shead">
        <span>Kennzahlen</span>
      </h3>
      <dl class="kennzahlen">
        <div class="kennzahlen__row">
          <dt class="kennzahlen__label">Median</dt>
          <dd class="kennzahlen__value mono {gradeClass(medianNote)}">
            {medianNote != null ? medianNote.toFixed(2) : '–'}
          </dd>
          <dd class="kennzahlen__sub"></dd>
        </div>
        <div class="kennzahlen__row">
          <dt class="kennzahlen__label">Beste</dt>
          <dd class="kennzahlen__value mono {gradeClass(bestModule?.note ?? null)}">
            {bestModule?.note != null ? bestModule.note.toFixed(2) : '–'}
          </dd>
          <dd class="kennzahlen__sub">{bestModule ? modName(bestModule) : ''}</dd>
        </div>
        <div class="kennzahlen__row">
          <dt class="kennzahlen__label">Schlechteste</dt>
          <dd class="kennzahlen__value mono {gradeClass(worstModule?.note ?? null)}">
            {worstModule?.note != null ? worstModule.note.toFixed(2) : '–'}
          </dd>
          <dd class="kennzahlen__sub">{worstModule ? modName(worstModule) : ''}</dd>
        </div>
        <div class="kennzahlen__row">
          <dt class="kennzahlen__label">Spannweite</dt>
          <dd class="kennzahlen__value mono">
            {noteRange != null ? noteRange.toFixed(2) : '–'}
          </dd>
          <dd class="kennzahlen__sub">Best − Schlecht</dd>
        </div>
      </dl>
    </section>

    <!-- Notenverteilung (Histogramm) -->
    <section class="modstat__section">
      <h3 class="modstat__shead">
        <span>Notenverteilung</span>
        <span class="mono">0.1er Buckets · 4.0–6.0</span>
      </h3>
      <div class="histogram" role="list" aria-label="Notenverteilung">
        {#each buckets as count, i (i)}
          <div
            class="histo-bar {bucketClass(i)} {count > 0 ? 'has-val' : 'is-empty'}"
            style="height: {count > 0 ? (count / maxBucket) * 100 : 0}%"
            role="listitem"
            aria-label="{bucketLabel(i)}: {count} {count === 1 ? 'Modul' : 'Module'}"
            title="{bucketLabel(i)}: {count} {count === 1 ? 'Modul' : 'Module'}"
          >
            {#if count > 0}
              <span class="histo-bar__count mono" aria-hidden="true">{count}</span>
            {/if}
          </div>
        {/each}
      </div>
      <div class="histo-axis">
        {#each buckets as _, i (i)}
          <span class="mono">{bucketLabel(i)}</span>
        {/each}
      </div>
    </section>

    <!-- Top 5 + Flop 5 Module side-by-side -->
    {#if topModules.length > 0}
      <section class="modstat__section">
        <h3 class="modstat__shead">
          <span>Top &amp; Flop</span>
        </h3>
        <div class="modstat__top-flop">
          <div class="modstat__list">
            <div class="modstat__list-title">Top {topModules.length}</div>
            {#each topModules as r (r.kuerzel_id || r.id)}
              <div class="modstat__list-row">
                <span class="modstat__list-num mono">{modCode(r) || '—'}</span>
                <span class="modstat__list-name">{modName(r)}</span>
                <span class="modstat__list-grade mono {gradeClass(r.note)}">
                  {(r.note as number).toFixed(2)}
                </span>
              </div>
            {/each}
          </div>
          <div class="modstat__list">
            <div class="modstat__list-title">Flop {flopModules.length}</div>
            {#each flopModules as r (r.kuerzel_id || r.id)}
              <div class="modstat__list-row">
                <span class="modstat__list-num mono">{modCode(r) || '—'}</span>
                <span class="modstat__list-name">{modName(r)}</span>
                <span class="modstat__list-grade mono {gradeClass(r.note)}">
                  {(r.note as number).toFixed(2)}
                </span>
              </div>
            {/each}
          </div>
        </div>
      </section>
    {/if}

    <!-- Per-Semester Breakdown -->
    {#if semesterStats.length > 0}
      <section class="modstat__section">
        <h3 class="modstat__shead">
          <span>Pro Semester</span>
        </h3>
        <div class="modstat__sem-grid">
          {#each semesterStats as s (s.semester)}
            <div class="modstat__sem">
              <div class="modstat__sem-label">{s.semester}</div>
              <div class="modstat__sem-row">
                <span class="modstat__sem-stat">
                  <span class="modstat__sem-stat-label">Schnitt</span>
                  <span class="modstat__sem-stat-value mono {gradeClass(s.avg)}">
                    {s.avg != null ? s.avg.toFixed(2) : '–'}
                  </span>
                </span>
                <span class="modstat__sem-stat">
                  <span class="modstat__sem-stat-label">Module</span>
                  <span class="modstat__sem-stat-value mono">{s.count}</span>
                </span>
                <span class="modstat__sem-stat">
                  <span class="modstat__sem-stat-label">Benotet</span>
                  <span class="modstat__sem-stat-value mono">{s.countGraded}</span>
                </span>
                <span class="modstat__sem-stat">
                  <span class="modstat__sem-stat-label">Beste</span>
                  <span class="modstat__sem-stat-value mono {gradeClass(s.best)}">
                    {s.best != null ? s.best.toFixed(2) : '–'}
                  </span>
                </span>
                <span class="modstat__sem-stat">
                  <span class="modstat__sem-stat-label">Schlecht</span>
                  <span class="modstat__sem-stat-value mono {gradeClass(s.worst)}">
                    {s.worst != null ? s.worst.toFixed(2) : '–'}
                  </span>
                </span>
              </div>
            </div>
          {/each}
        </div>
      </section>
    {/if}
  </div>

  <!-- QV-Rechner — BiVo 2021, ABU dispensiert (IPA + BK + M+E → Gesamtnote) -->
  <div class="card">
    <div class="card__head">
      <h2 class="card__title">QV-Rechner</h2>
      <span class="card__hint mono">IPA + BK + M+E · ABU dispensiert</span>
    </div>

    <p class="ipa__intro">
      Schätzt deine QV-Gesamtnote aus den drei IPA-Teilnoten, dem
      Schnitt deiner Informatik-Module (BK) und dem Schnitt aus Mathe
      und Englisch (M+E). Die Modulnoten kommen direkt aus Tocco.
    </p>

    <div class="ipa__formula mono">
      IPA = (2·A + B + C) / 4 &nbsp;·&nbsp;
      Gesamt = (IPA·0.4 + BK·0.3 + ME·0.1) / 0.8
    </div>

    <div class="ipa__inputs ipa__inputs--qv">
      <label class="ipa__field" class:ipa__field--invalid={aInvalid}>
        <span class="ipa__label" id="qv-lbl-a">A · Prozess / Resultat</span>
        <input
          id="qv-in-a"
          type="number"
          step="0.1"
          min="1"
          max="6"
          inputmode="decimal"
          class="mono"
          bind:value={noteA}
          aria-labelledby="qv-lbl-a"
          aria-describedby="qv-w-a{aInvalid ? ' qv-err-a' : ''}"
          aria-invalid={aInvalid}
        />
        <span class="ipa__weight" id="qv-w-a">2×</span>
        {#if aInvalid}
          <span class="ipa__err mono" id="qv-err-a">1.0–6.0</span>
        {/if}
      </label>
      <label class="ipa__field" class:ipa__field--invalid={bInvalid}>
        <span class="ipa__label" id="qv-lbl-b">B · Dokumentation</span>
        <input
          id="qv-in-b"
          type="number"
          step="0.1"
          min="1"
          max="6"
          inputmode="decimal"
          class="mono"
          bind:value={noteB}
          aria-labelledby="qv-lbl-b"
          aria-describedby="qv-w-b{bInvalid ? ' qv-err-b' : ''}"
          aria-invalid={bInvalid}
        />
        <span class="ipa__weight" id="qv-w-b">1×</span>
        {#if bInvalid}
          <span class="ipa__err mono" id="qv-err-b">1.0–6.0</span>
        {/if}
      </label>
      <label class="ipa__field" class:ipa__field--invalid={cInvalid}>
        <span class="ipa__label" id="qv-lbl-c">C · Präsentation / Gespräch</span>
        <input
          id="qv-in-c"
          type="number"
          step="0.1"
          min="1"
          max="6"
          inputmode="decimal"
          class="mono"
          bind:value={noteC}
          aria-labelledby="qv-lbl-c"
          aria-describedby="qv-w-c{cInvalid ? ' qv-err-c' : ''}"
          aria-invalid={cInvalid}
        />
        <span class="ipa__weight" id="qv-w-c">1×</span>
        {#if cInvalid}
          <span class="ipa__err mono" id="qv-err-c">1.0–6.0</span>
        {/if}
      </label>
    </div>

    <!-- Zwei Schnitt-Boxen nebeneinander: BK (Informatikkompetenzen)
         und M+E (Mathe + Englisch). Beide live aus den Modulnoten in
         Tocco gebildet, jeweils mit aufklappbarer Modul-Liste als
         Datentransparenz. -->
    <div class="avg-grid">
      <div class="bk">
        <div class="bk__main">
          <div class="bk__label">Informatikkompetenzen</div>
          <div class="bk__value mono {gradeClass(bk.rounded)}">
            {bk.rounded != null ? bk.rounded.toFixed(1) : '–'}
          </div>
          <div class="bk__exact mono">
            {#if bk.count === 0}
              noch keine Informatik-Module benotet
            {:else}
              exakt {(bk.avg as number).toFixed(2)} · {bk.count} {bk.count === 1 ? 'Modul' : 'Module'} · 30 %
            {/if}
          </div>
        </div>
        {#if bk.count > 0}
          <details class="bk__details" bind:open={bkListOpen}>
            <summary class="bk__summary mono">Module zeigen</summary>
            <ul class="bk__list">
              {#each bk.rows as r (r.kuerzel_id || r.id)}
                <li class="bk__item">
                  <span class="bk__item-code mono">{modCode(r) || '—'}</span>
                  <span class="bk__item-name">{modName(r)}</span>
                  <span class="bk__item-grade mono {gradeClass(r.note)}">
                    {(r.note as number).toFixed(2)}
                  </span>
                </li>
              {/each}
            </ul>
          </details>
        {/if}
      </div>

      <div class="bk">
        <div class="bk__main">
          <div class="bk__label">Mathe + Englisch</div>
          <div class="bk__value mono {gradeClass(me.rounded)}">
            {me.rounded != null ? me.rounded.toFixed(1) : '–'}
          </div>
          <div class="bk__exact mono">
            {#if me.count === 0}
              noch keine Mathe-/Englisch-Module benotet
            {:else}
              exakt {(me.avg as number).toFixed(2)} · {me.count} {me.count === 1 ? 'Modul' : 'Module'} · 10 %
            {/if}
          </div>
        </div>
        {#if me.count > 0}
          <details class="bk__details" bind:open={meListOpen}>
            <summary class="bk__summary mono">Module zeigen</summary>
            <ul class="bk__list">
              {#each me.rows as r (r.kuerzel_id || r.id)}
                <li class="bk__item">
                  <span class="bk__item-code mono">{modCode(r) || '—'}</span>
                  <span class="bk__item-name">{modName(r)}</span>
                  <span class="bk__item-grade mono {gradeClass(r.note)}">
                    {(r.note as number).toFixed(2)}
                  </span>
                </li>
              {/each}
            </ul>
          </details>
        {/if}
      </div>
    </div>

    <div class="ipa__result">
      <div class="ipa__result-main">
        <div class="ipa__result-label">QV-Gesamtnote</div>
        <div class="ipa__result-value mono {gradeClass(gesamtRounded)}">
          {gesamtRounded != null ? gesamtRounded.toFixed(1) : '–'}
        </div>
        <div class="ipa__result-exact mono">
          {#if !ipaInputsValid}
            A · B · C ausfüllen
          {:else if bk.rounded == null && me.rounded == null}
            IPA {(ipaRounded as number).toFixed(1)} · BK fehlt · M+E fehlt
          {:else if bk.rounded == null}
            IPA {(ipaRounded as number).toFixed(1)} · BK fehlt · M+E {(me.rounded as number).toFixed(1)}
          {:else if me.rounded == null}
            IPA {(ipaRounded as number).toFixed(1)} · BK {bk.rounded.toFixed(1)} · M+E fehlt
          {:else}
            IPA {(ipaRounded as number).toFixed(1)} · BK {bk.rounded.toFixed(1)} · M+E {(me.rounded as number).toFixed(1)} · exakt {(gesamtExact as number).toFixed(2)}
          {/if}
        </div>
      </div>
      {#if allQvValid}
        <div class="ipa__pass" class:ipa__pass--ok={passQV} class:ipa__pass--fail={!passQV}>
          {#if passQV}
            ✓ Bestanden
          {:else if (ipaRounded ?? 0) < 4}
            ✗ IPA &lt; 4
          {:else}
            ✗ Gesamtnote &lt; 4
          {/if}
        </div>
      {/if}
      {#if whatIfScenarios.length > 0}
        <div class="whatif">
          <div class="whatif__label">Was-wäre-wenn</div>
          <div class="whatif__row">
            {#each whatIfScenarios as sc (sc.ipa)}
              <div
                class="whatif__btn"
                class:whatif__btn--ok={sc.passed}
                class:whatif__btn--fail={!sc.passed}
                aria-label="Bei IPA {sc.ipa.toFixed(1)} ergibt sich Gesamtnote {sc.gesamt.toFixed(1)} — {sc.passed ? 'bestanden' : 'nicht bestanden'}"
              >
                <span class="whatif__ipa mono">IPA {sc.ipa.toFixed(1)}</span>
                <span class="whatif__arrow" aria-hidden="true">→</span>
                <span class="whatif__gesamt mono {gradeClass(sc.gesamt)}">
                  {sc.gesamt.toFixed(1)}
                </span>
              </div>
            {/each}
          </div>
        </div>
      {/if}
    </div>

    <p class="ipa__note">
      Bestanden = IPA ≥ 4.0 · Gesamtnote ≥ 4.0 (auf 0.1 gerundet).
      BK-Schnitt aus allen Informatik-Modulnoten direkt aus Tocco
      (dreistellige Modulnummer). M+E-Schnitt aus den Mathe- und
      Englisch-Modulen (alle Niveaus). Verordnung: IPA 40 %,
      Informatikkompetenzen 30 %, Mathe+Englisch 10 %, ABU 20 %
      (bei dir dispensiert, fällt weg). Ohne ABU summieren sich die
      drei Bereiche auf 80 %, deshalb die Division durch 0.8 — das
      schiebt die Gesamtnote zurück auf die 1–6-Skala. Effektiv
      schlägt damit IPA 50 %, BK 37.5 %, M+E 12.5 % auf die Endnote
      durch. Quelle: ICT-Berufsbildung, BiVo 2021 (QV ohne ABU).
    </p>
  </div>
{/if}

<style>
  .route__head {
    display: flex;
    align-items: baseline;
    gap: 14px;
    margin-bottom: 22px;
  }
  .route__title {
    font-size: 22px;
    font-weight: 700;
    margin: 0;
    color: var(--text);
    letter-spacing: -0.01em;
  }
  .route__subtitle {
    color: var(--text-mute);
    font-size: 12px;
  }

  /* ---- Headline stats: flat columns separated by hairlines, no card chrome ---- */
  .headline {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 0;
    margin: 0 0 24px;
    padding: 4px 0 20px;
    border-bottom: 1px solid var(--border-soft);
  }
  .headline__col {
    padding: 0 18px;
    border-left: 1px solid var(--border-soft);
    min-width: 0;
  }
  .headline__col:first-child {
    padding-left: 0;
    border-left: 0;
  }
  .headline__col:last-child {
    padding-right: 0;
  }
  @media (max-width: 900px) {
    .headline { grid-template-columns: repeat(2, 1fr); row-gap: 18px; }
    .headline__col:nth-child(3) { padding-left: 18px; border-left: 1px solid var(--border-soft); }
    .headline__col:nth-child(odd) { padding-left: 0; border-left: 0; }
  }
  @media (max-width: 480px) {
    .headline__col { padding: 0 14px; }
    .headline__col:nth-child(odd) { padding-left: 0; }
    .headline__col:nth-child(even) { padding-right: 0; }
  }
  .headline__label {
    font-size: 10px;
    letter-spacing: 0.10em;
    text-transform: uppercase;
    color: var(--text-dim);
    font-weight: 600;
    margin: 0;
  }
  .headline__value {
    font-size: 30px;
    font-weight: 600;
    letter-spacing: -0.015em;
    margin: 4px 0 0;
    color: var(--text);
    line-height: 1.05;
  }
  .headline__sub {
    font-size: 11px;
    color: var(--text-dim);
    margin: 6px 0 0;
    font-family: var(--font-mono);
    letter-spacing: 0.02em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Grade colors (mirror tokens) */
  :global(.g-excellent) { color: var(--g-excellent); }
  :global(.g-good)      { color: var(--g-good); }
  :global(.g-ok)        { color: var(--g-ok); }
  :global(.g-fail)      { color: var(--g-fail); }

  /* ---- Card ---- */
  .card {
    background: var(--surface);
    border: 1px solid var(--border-soft);
    border-radius: var(--r-lg);
    padding: 16px 18px;
    margin-bottom: 20px;
    box-shadow: var(--shadow-sm);
  }
  .card__head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
  }
  .card__title {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
    letter-spacing: 0.02em;
  }
  .card__hint {
    font-size: 11px;
    color: var(--text-dim);
  }

  /* ---- Two-col row (sparkline + next event) ---- */
  .spark-wrap {
    display: flex;
    align-items: center;
    gap: 14px;
    min-height: 56px;
  }
  .spark-svg {
    flex: 1;
    height: 48px;
    width: 100%;
    overflow: visible;
  }
  .spark-line {
    fill: none;
    stroke: var(--accent);
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .spark-fill {
    fill: var(--accent-soft);
    stroke: none;
  }
  .spark-trend {
    font-size: 13px;
    font-weight: 600;
    flex-shrink: 0;
  }

  /* ---- Modul Statistik sub-sections ---- */
  .modstat__section {
    padding: 14px 0 16px;
    border-top: 1px solid var(--border-soft);
  }
  .modstat__section:first-of-type {
    border-top: 0;
    padding-top: 0;
  }
  .modstat__section:last-of-type {
    padding-bottom: 0;
  }
  .modstat__shead {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    margin: 0 0 10px;
    font-size: 11px;
    line-height: 1.2;
    font-weight: 600;
    letter-spacing: 0.10em;
    text-transform: uppercase;
    color: var(--text-dim);
  }
  .modstat__shead .mono {
    text-transform: none;
    letter-spacing: 0.02em;
    font-size: 11px;
    font-weight: 400;
  }

  /* Kennzahlen — inline rows with hairlines (no tile chrome, distinct from headline) */
  .kennzahlen {
    display: flex;
    flex-direction: column;
    margin: 0;
  }
  .kennzahlen__row {
    display: grid;
    grid-template-columns: 130px auto 1fr;
    align-items: baseline;
    gap: 16px;
    padding: 10px 2px;
    border-top: 1px solid var(--border-soft);
  }
  .kennzahlen__row:first-child {
    border-top: 0;
    padding-top: 2px;
  }
  .kennzahlen__row:last-child {
    padding-bottom: 2px;
  }
  .kennzahlen__label {
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-dim);
    font-weight: 600;
    margin: 0;
  }
  .kennzahlen__value {
    font-size: 20px;
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--text);
    margin: 0;
    text-align: right;
    min-width: 60px;
  }
  .kennzahlen__sub {
    font-size: 12px;
    color: var(--text-mute);
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  @media (max-width: 480px) {
    .kennzahlen__row {
      grid-template-columns: 1fr auto;
      grid-template-areas: "label value" "sub sub";
      row-gap: 2px;
    }
    .kennzahlen__label { grid-area: label; }
    .kennzahlen__value { grid-area: value; }
    .kennzahlen__sub   { grid-area: sub; }
    .kennzahlen__sub:empty { display: none; }
  }

  /* Top / Flop lists side-by-side */
  .modstat__top-flop {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }
  @media (max-width: 700px) {
    .modstat__top-flop { grid-template-columns: 1fr; }
  }
  .modstat__list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .modstat__list-title {
    font-size: 11px;
    color: var(--text-mute);
    letter-spacing: 0.04em;
    margin-bottom: 4px;
    font-weight: 600;
  }
  .modstat__list-row {
    display: grid;
    grid-template-columns: 60px 1fr auto;
    align-items: center;
    gap: 10px;
    padding: 6px 8px;
    border-radius: var(--r-sm);
    background: var(--bg-elev);
    border: 1px solid var(--border-soft);
    font-size: 12.5px;
  }
  .modstat__list-num {
    color: var(--text-dim);
    font-size: 11px;
    letter-spacing: 0.02em;
  }
  .modstat__list-name {
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .modstat__list-grade {
    font-weight: 600;
    font-size: 13px;
  }

  /* Pro-Semester rows */
  .modstat__sem-grid {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .modstat__sem {
    background: var(--bg-elev);
    border: 1px solid var(--border-soft);
    border-radius: var(--r-md);
    padding: 10px 14px;
  }
  .modstat__sem-label {
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-mute);
    font-weight: 600;
    margin-bottom: 6px;
  }
  .modstat__sem-row {
    display: flex;
    flex-wrap: wrap;
    gap: 14px 22px;
  }
  .modstat__sem-stat {
    display: inline-flex;
    flex-direction: column;
    gap: 1px;
  }
  .modstat__sem-stat-label {
    font-size: 9.5px;
    color: var(--text-dim);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .modstat__sem-stat-value {
    font-size: 14px;
    font-weight: 600;
    color: var(--text);
  }

  /* ---- IPA-Rechner ---- */
  .ipa__intro {
    margin: 0 0 12px;
    color: var(--text-mute);
    font-size: 13px;
    line-height: 1.5;
  }
  .ipa__formula {
    padding: 10px 12px;
    background: var(--bg-elev);
    border: 1px solid var(--border-soft);
    border-radius: var(--r-sm);
    font-size: 12px;
    color: var(--text-mute);
    margin-bottom: 16px;
    line-height: 1.5;
  }

  .ipa__inputs {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 10px;
    margin-bottom: 16px;
  }
  /* QV-Variante: 3 Inputs (A/B/C) — Desktop drei-spaltig, schmal
   * gestapelt unter 700px (Touch-tauglich, keine gequetschten Labels). */
  .ipa__inputs--qv {
    grid-template-columns: repeat(3, 1fr);
  }
  @media (max-width: 700px) {
    .ipa__inputs { grid-template-columns: repeat(2, 1fr); }
    .ipa__inputs--qv { grid-template-columns: 1fr; }
  }
  .ipa__field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    background: var(--bg-elev);
    border: 1px solid var(--border-soft);
    border-radius: var(--r-md);
    padding: 10px 12px;
    transition: border-color var(--t-fast) var(--ease);
  }
  .ipa__field:focus-within {
    border-color: var(--accent-border);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
  .ipa__field--invalid {
    border-color: var(--danger-border);
    background: var(--danger-soft);
  }
  .ipa__field--invalid:focus-within {
    border-color: var(--danger-border);
    box-shadow: 0 0 0 3px var(--danger-soft);
  }
  .ipa__label {
    font-size: 10.5px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-dim);
    font-weight: 600;
  }
  .ipa__field input {
    background: transparent;
    border: 0;
    font-size: 22px;
    font-weight: 600;
    color: var(--text);
    width: 100%;
    /* Touch-target safe: ~44px tall once combined with field padding */
    min-height: 44px;
    padding: 4px 0;
    appearance: textfield;
    -moz-appearance: textfield;
  }
  .ipa__field input:focus { outline: 0; }
  .ipa__field input:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: var(--r-sm);
  }
  .ipa__field--invalid input:focus-visible {
    outline-color: var(--danger);
  }
  .ipa__field input::-webkit-inner-spin-button,
  .ipa__field input::-webkit-outer-spin-button {
    appearance: none;
    margin: 0;
  }
  .ipa__weight {
    font-size: 10px;
    color: var(--accent);
    letter-spacing: 0.04em;
    font-family: var(--font-mono);
  }
  .ipa__err {
    font-size: 10px;
    color: var(--danger);
    letter-spacing: 0.04em;
    margin-top: 2px;
  }

  .ipa__result {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 14px 16px;
    background: var(--bg-elev);
    border: 1px solid var(--border-soft);
    border-radius: var(--r-md);
    margin-bottom: 16px;
  }
  .ipa__result-label {
    font-size: 11px;
    letter-spacing: 0.10em;
    text-transform: uppercase;
    color: var(--text-dim);
    font-weight: 600;
  }
  .ipa__result-value {
    font-size: 36px;
    font-weight: 600;
    letter-spacing: -0.02em;
    line-height: 1;
    margin-top: 4px;
  }
  .ipa__result-exact {
    font-size: 11px;
    color: var(--text-dim);
    margin-top: 2px;
    letter-spacing: 0.02em;
  }
  .ipa__pass {
    font-size: 13px;
    font-weight: 600;
    padding: 8px 14px;
    border-radius: 999px;
    border: 1px solid;
    letter-spacing: 0.02em;
    white-space: nowrap;
  }
  .ipa__pass--ok {
    color: var(--g-excellent);
    background: var(--g-excellent-soft);
    border-color: var(--success-border);
  }
  .ipa__pass--fail {
    color: var(--g-fail);
    background: var(--g-fail-soft);
    border-color: var(--danger-border);
  }

  /* ---- Zwei Schnitt-Boxen nebeneinander (BK + M+E) ----
   * Auf Desktop side-by-side, auf schmalen Screens stacked. Beide Boxen
   * teilen das `.bk`-Styling, das Grid steuert nur die Außenanordnung. */
  .avg-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    margin-bottom: 16px;
  }
  @media (max-width: 700px) {
    .avg-grid { grid-template-columns: 1fr; }
  }

  /* ---- BK-Schnitt-Box ----
   * Neutrale Surface-Box mit aufklappbarer Modul-Liste. Sitzt zwischen
   * IPA-Inputs und Result, signalisiert die Datenquelle der Gesamtformel. */
  .bk {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px 16px;
    background: var(--bg-elev);
    border: 1px solid var(--border-soft);
    border-radius: var(--r-md);
    margin-bottom: 16px;
  }
  /* Innerhalb des avg-grid übernimmt das Grid das Bottom-Spacing. */
  .avg-grid .bk { margin-bottom: 0; }
  .bk__main {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .bk__label {
    font-size: 11px;
    letter-spacing: 0.10em;
    text-transform: uppercase;
    color: var(--text-dim);
    font-weight: 600;
  }
  .bk__value {
    font-size: 32px;
    font-weight: 600;
    letter-spacing: -0.02em;
    line-height: 1;
    margin-top: 4px;
    color: var(--text);
  }
  .bk__exact {
    font-size: 11px;
    color: var(--text-dim);
    margin-top: 2px;
    letter-spacing: 0.02em;
  }
  .bk__details {
    margin-top: 2px;
  }
  .bk__summary {
    list-style: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px 5px 8px;
    border-radius: 999px;
    border: 1px solid var(--border-soft);
    background: var(--surface-2);
    color: var(--text-mute);
    font-size: 11px;
    letter-spacing: 0.04em;
    cursor: pointer;
    user-select: none;
    transition: color var(--t-fast) var(--ease),
                border-color var(--t-fast) var(--ease),
                background var(--t-fast) var(--ease);
  }
  .bk__summary::-webkit-details-marker { display: none; }
  .bk__summary::marker { content: ''; }
  .bk__summary::before {
    content: '▸';
    font-size: 10px;
    line-height: 1;
    color: var(--text-dim);
    transition: transform var(--t-fast) var(--ease);
  }
  .bk__details[open] .bk__summary::before { transform: rotate(90deg); }
  @media (hover: hover) and (pointer: fine) {
    .bk__summary:hover {
      background: var(--surface-3);
      color: var(--text);
      border-color: var(--border);
    }
  }
  .bk__list {
    list-style: none;
    margin: 10px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .bk__item {
    display: grid;
    grid-template-columns: 64px 1fr auto;
    align-items: center;
    gap: 12px;
    padding: 6px 10px;
    border-radius: var(--r-sm);
    background: var(--surface);
    border: 1px solid var(--border-soft);
    font-size: 13px;
  }
  .bk__item-code {
    color: var(--text-dim);
    font-size: 11px;
    letter-spacing: 0.02em;
  }
  .bk__item-name {
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .bk__item-grade {
    font-weight: 600;
    font-size: 13px;
  }

  /* ---- "Was-wäre-wenn"-Pillen ----
   * Drei statische Chips unter dem Result. Bei festem BK-Schnitt zeigt
   * jede Pille die Gesamtnote für eine Standard-IPA (5.0 / 5.5 / 6.0).
   * Pass/Fail farblich gewichtet (success-soft vs. danger-soft) — der
   * Pfeil + die Notenwerte tragen auch ohne Farbe Bedeutung. */
  .whatif {
    flex-basis: 100%;
    margin-top: 4px;
    padding-top: 12px;
    border-top: 1px dashed var(--border-soft);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .whatif__label {
    font-size: 10px;
    letter-spacing: 0.10em;
    text-transform: uppercase;
    color: var(--text-dim);
    font-weight: 600;
  }
  .whatif__row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .whatif__btn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 7px 12px;
    border-radius: 999px;
    border: 1px solid transparent;
    font-size: 13px;
    letter-spacing: 0.01em;
    white-space: nowrap;
  }
  .whatif__btn--ok {
    background: var(--g-excellent-soft, var(--success-soft));
    border-color: var(--success-border);
    color: var(--text);
  }
  .whatif__btn--fail {
    background: var(--g-fail-soft, var(--danger-soft));
    border-color: var(--danger-border);
    color: var(--text);
  }
  .whatif__ipa {
    color: var(--text-mute);
    font-size: 12px;
  }
  .whatif__arrow {
    color: var(--text-dim);
    font-size: 12px;
  }
  .whatif__gesamt {
    font-weight: 700;
    font-size: 14px;
  }

  .ipa__note {
    margin: 0;
    font-size: 11px;
    color: var(--text-dim);
    line-height: 1.5;
  }

  /* ---- Histogram ---- */
  .histogram {
    display: grid;
    grid-template-columns: repeat(21, 1fr);
    gap: 3px;
    align-items: end;
    height: 160px;
    padding: 18px 4px 4px;
  }
  .histo-bar {
    position: relative;
    background: var(--surface-3);
    border-radius: 2px 2px 0 0;
    transition: opacity var(--t-fast) var(--ease);
  }
  .histo-bar.is-empty { visibility: hidden; }
  .histo-bar.has-val.is-ok        { background: var(--g-ok); }
  .histo-bar.has-val.is-good      { background: var(--g-good); }
  .histo-bar.has-val.is-excellent { background: var(--g-excellent); }
  @media (hover: hover) and (pointer: fine) {
    .histo-bar:hover { opacity: 0.85; }
  }
  .histo-bar__count {
    position: absolute;
    top: -16px;
    left: 50%;
    transform: translateX(-50%);
    font-size: 10px;
    color: var(--text-mute);
  }
  .histo-axis {
    display: grid;
    grid-template-columns: repeat(21, 1fr);
    gap: 3px;
    padding: 6px 4px 4px;
    font-size: 9.5px;
    color: var(--text-dim);
    text-align: center;
  }
  .histo-axis span:nth-child(odd) { visibility: hidden; }

  /* On narrow screens 21 bars become illegible — tighten gaps and show
     only the major-tick labels (4.0 / 4.5 / 5.0 / 5.5 / 6.0). */
  @media (max-width: 480px) {
    .histogram { gap: 1px; padding: 18px 2px 4px; }
    .histo-axis { gap: 1px; padding: 6px 2px 4px; font-size: 9px; }
    /* Reset desktop hide-odd rule, then hide everything except every 5th. */
    .histo-axis span:nth-child(odd) { visibility: visible; }
    .histo-axis span { visibility: hidden; }
    .histo-axis span:nth-child(5n + 1) { visibility: visible; }
  }

  /* ---- Empty / muted ---- */
  .empty-state {
    background: var(--surface);
    border: 1px solid var(--border-soft);
    border-radius: var(--r-md);
    padding: 24px;
    text-align: center;
    color: var(--text-mute);
  }
  .empty-state p { margin: 0 0 12px; }
  .muted { color: var(--text-dim); margin: 0; font-size: 12px; }

  .btn-primary {
    background: var(--accent);
    color: var(--accent-ink);
    border-radius: var(--r-md);
    padding: 10px 16px;
    min-height: 44px;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.04em;
    transition: transform var(--t-fast) var(--ease), background var(--t-fast) var(--ease);
  }
  @media (hover: hover) and (pointer: fine) {
    .btn-primary:hover {
      transform: translateY(-1px);
      background: var(--accent-hover);
    }
  }
  .btn-primary:active { transform: scale(0.97); }

  @media (prefers-reduced-motion: reduce) {
    .btn-primary,
    .histo-bar,
    .ipa__field {
      transition: none;
    }
    .btn-primary:hover,
    .btn-primary:active {
      transform: none;
    }
  }
</style>
