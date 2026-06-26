/* ============================================================
   WISSen — View: Statistik
   Hero KPIs (Module / Mit Note / Ohne Note / Schnitt) + Spark-Verlauf +
   Modul-Statistik (Kennzahlen, Histogramm, Top/Flop, pro Semester) +
   QV-Rechner (BiVo 2021 ohne ABU — IPA + BK-Schnitt → Gesamtnote).

   Portiert von web-svelte/src/routes/stats/+page.svelte — gleiche Ableitungen,
   nur das Rendering ist Vanilla-DOM statt Svelte. Markup-Klassen sind exakt
   mit web/mobile/css/stats.css (Agent B) gepairt.

   Depends on globals from mobile.js shell:
     - $, titleEl, main, apiFetch, loadingShell, skeletonShell, errorShell
     - gradeClass, modulNummerOf
   ============================================================ */
'use strict';

/* Modul-State überlebt SSE-/Tab-Re-Renders. Touched-Flags wurden mit dem
 * QV-Umbau leer — die drei IPA-Teilnoten haben keinen sinnvollen Auto-
 * Prefill aus dem Modul-Schnitt mehr (die kommen aus der Praxisarbeit
 * selbst). touched bleibt als reserviertes Objekt, um die State-Shape
 * stabil zu halten falls künftig wieder Prefills nötig werden. */
const statsState = {
  qv: { a: 4.5, b: 4.5, c: 4.5, ziel: 4.0 },
  touched: {},
};

/* Ziel-Presets für den Zielnoten-Rechner. 4.0 = Bestehensgrenze (Default),
 * darüber die üblichen Zwischenziele. Bewusst kein 6.0 — bei BK/M+E unter
 * Maximum ist 6.0 fast immer „impossible" und der Chip wäre toter Platz. */
const QV_ZIEL_PRESETS = [4.0, 4.5, 5.0, 5.5];

/* Sparkline-Geometrie (Pixel im SVG-Koordinatensystem — viewBox 220×48 wird
 * vom Browser auf die tatsächliche Pixelbreite gestreckt). */
const SPARK_W = 220;
const SPARK_H = 48;
const SPARK_PAD = 4;

/* QV-Defaults: bei erstem Render greift; bei Re-Render bleibt statsState
 * erhalten — der User behält seine eingegebenen Werte über SSE-Reloads. */
function ensureQvDefaults() {
  if (statsState.qv.a == null) statsState.qv.a = 4.5;
  if (statsState.qv.b == null) statsState.qv.b = 4.5;
  if (statsState.qv.c == null) statsState.qv.c = 4.5;
  if (statsState.qv.ziel == null) statsState.qv.ziel = 4.0;
}

async function renderStats() {
  titleEl.textContent = 'Statistik';
  skeletonShell('stats'); // unbekannte View → loadingShell-Fallback
  try {
    const [statsData, notenData, verlaufData] = await Promise.all([
      apiFetch('/api/stats'),
      apiFetch('/api/noten'),
      apiFetch('/api/noten/verlauf').catch(() => null),
    ]);
    drawStats(statsData, notenData, verlaufData);
  } catch (e) {
    if (e && e.silent) return;
    drawStatsEmpty(e && e.message);
  }
}

/* Wenn beide Endpoints leer ODER Fehler werfen: Empty-State + Retry-Button.
 * Inhaltliche Leere wird im Haupt-Renderer noch über notenCount===0 geprüft. */
function drawStatsEmpty(errMsg) {
  main.replaceChildren();
  const wrap = document.createElement('div');
  wrap.className = 'm-stats';
  const empty = document.createElement('div');
  empty.className = 'm-stats-empty';
  const p = document.createElement('p');
  p.textContent = errMsg
    ? 'Statistik konnte nicht geladen werden.'
    : 'Noch keine Daten vorhanden — starte eine Abfrage.';
  const btn = document.createElement('button');
  btn.className = 'm-btn m-btn--primary';
  btn.type = 'button';
  btn.id = 'statsRetryBtn';
  btn.textContent = 'Erneut versuchen';
  btn.addEventListener('click', () => { renderStats(); });
  empty.append(p, btn);
  wrap.append(empty);
  main.append(wrap);
}

function drawStats(stats, noten, verlauf) {
  ensureQvDefaults();
  main.replaceChildren();

  const totalModules = (stats && stats.notenCount) || 0;
  const withGrade = (stats && stats.notenWithGradeCount) || 0;
  const withoutGrade = Math.max(0, totalModules - withGrade);
  const avg = (stats && stats.avgNote != null) ? stats.avgNote : null;

  // Empty-State: gar keine Module gescraped → freundlicher Hinweis statt
  // halbleerer Hero mit 0-Werten überall.
  if (totalModules === 0) {
    drawStatsEmpty(null);
    return;
  }

  const wrap = document.createElement('div');
  wrap.className = 'm-stats';

  wrap.append(buildHero(totalModules, withGrade, withoutGrade, avg));
  wrap.append(buildSparkCard(verlauf));

  const rows = (noten && noten.rows) || [];
  wrap.append(buildModstatCard(rows, totalModules, withGrade));
  wrap.append(buildQvCard(rows));

  main.append(wrap);
}

/* ------------------------------------------------------------------ */
/* Hero — Noten-Muster (.m-hero): dominanter Schnitt + Meta-Spalte.     */
/* Gespiegelt am Noten- + Absenzen-Tab (Hierarchie durch Skala statt    */
/* vier gleichwertiger KPI-Boxen).                                      */
/* ------------------------------------------------------------------ */
function buildHero(totalModules, withGrade, withoutGrade, avg) {
  const hero = document.createElement('section');
  hero.className = 'm-hero';
  hero.setAttribute('aria-label', 'Schnitt-Übersicht');

  // Dominante Kennzahl: Gesamt-Schnitt, getönt via gradeClass.
  const left = document.createElement('div');
  const lab = document.createElement('div');
  lab.className = 'm-hero__label';
  lab.textContent = 'Schnitt';
  const val = document.createElement('div');
  val.className = 'm-hero__value ' + (avg != null ? gradeClass(avg) : '');
  val.textContent = avg != null ? avg.toFixed(2) : '–';
  left.append(lab, val);

  // Kompakte Meta-Spalte rechts: Module · benotet · ohne Note.
  const meta = document.createElement('div');
  meta.className = 'm-hero__meta';
  meta.append(
    statHeroMetaRow(totalModules, totalModules === 1 ? 'Modul' : 'Module'),
    statHeroMetaRow(withGrade, 'benotet'),
    statHeroMetaRow(withoutGrade, 'ohne Note'),
  );

  hero.append(left, meta);
  return hero;
}

/* Eine Meta-Zeile im Stats-Hero: fette Zahl + Label (kein innerHTML). */
function statHeroMetaRow(num, label) {
  const row = document.createElement('div');
  row.className = 'm-hero__metarow';
  const strong = document.createElement('strong');
  strong.textContent = String(num);
  row.append(strong, document.createTextNode(' ' + label));
  return row;
}

/* ------------------------------------------------------------------ */
/* Sparkline-Card — rendert die server-seitige Carry-forward-Serie aus */
/* GET /api/noten/verlauf (points[], ungeschnitten gezeichnet).        */
/* ------------------------------------------------------------------ */
function buildSparkCard(verlauf) {
  const card = document.createElement('article');
  card.className = 'm-card m-stats-card m-stats-spark-card';

  const head = document.createElement('div');
  head.className = 'm-stats-card__head';
  const title = document.createElement('h2');
  title.className = 'm-stats-card__title';
  title.textContent = 'Schnitt-Verlauf';
  const hint = document.createElement('span');
  hint.className = 'm-stats-card__hint mono';
  head.append(title, hint);
  card.append(head);

  const spark = document.createElement('div');
  spark.className = 'm-stats-spark';

  const geom = buildSparkGeom(verlauf);
  hint.textContent = 'letzte '
    + ((verlauf && Array.isArray(verlauf.points)) ? verlauf.points.length : 0)
    + ' Tage';

  if (geom) {
    const pts = geom.pts;
    const trend = pts[pts.length - 1].value - pts[0].value;
    const trendStr = (trend >= 0 ? '+' : '') + trend.toFixed(2);

    // Plot-Container: SVG-Linie + HTML-Overlay (Crosshair/Dot/Readout).
    const plot = document.createElement('div');
    plot.className = 'm-stats-spark__plot';
    plot.setAttribute('role', 'img');
    plot.setAttribute('tabindex', '0');
    plot.setAttribute(
      'aria-label',
      'Schnitt-Verlauf, ' + pts.length + ' Tage, Trend ' + trendStr
        + '. Wischen oder Pfeiltasten fuer einzelne Tageswerte.',
    );

    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'm-stats-spark__svg');
    svg.setAttribute('viewBox', '0 0 ' + SPARK_W + ' ' + SPARK_H);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');
    const desc = document.createElementNS(NS, 'desc');
    desc.textContent = 'Minimum ' + geom.min.toFixed(2) + ', Maximum ' + geom.max.toFixed(2) + '.';
    const fillEl = document.createElementNS(NS, 'path');
    fillEl.setAttribute('class', 'm-stats-spark__fill');
    fillEl.setAttribute('d', geom.fill);
    const lineEl = document.createElementNS(NS, 'path');
    lineEl.setAttribute('class', 'm-stats-spark__line');
    lineEl.setAttribute('d', geom.line);
    svg.append(desc, fillEl, lineEl);
    plot.append(svg);

    // Overlay bewusst als HTML (nicht im SVG): preserveAspectRatio="none"
    // streckt die x-Achse → ein SVG-Kreis wuerde zur Ellipse, ein HTML-Dot
    // bleibt rund. Positionen snappen ohne Transition; nur das Ein-/Ausblenden
    // faded (opacity, prefers-reduced-motion-sicher).
    const overlay = document.createElement('div');
    overlay.className = 'm-stats-spark__overlay';
    const cross = document.createElement('span');
    cross.className = 'm-stats-spark__cross';
    const dot = document.createElement('span');
    dot.className = 'm-stats-spark__dot';
    const readout = document.createElement('span');
    readout.className = 'm-stats-spark__readout';
    const rVal = document.createElement('span');
    rVal.className = 'm-stats-spark__readout-val mono';
    const rMeta = document.createElement('span');
    rMeta.className = 'm-stats-spark__readout-meta mono';
    readout.append(rVal, rMeta);
    overlay.append(cross, dot, readout);
    plot.append(overlay);

    // a11y: Punkt-Werte beim Scrubben ansagen.
    const live = document.createElement('span');
    live.className = 'm-visually-hidden';
    live.setAttribute('aria-live', 'polite');
    plot.append(live);

    let activeIdx = -1;
    function setActive(idx) {
      if (idx < 0) {
        plot.classList.remove('is-active');
        activeIdx = -1;
        live.textContent = '';
        return;
      }
      if (idx > pts.length - 1) idx = pts.length - 1;
      if (idx === activeIdx) return;
      activeIdx = idx;
      const p = pts[idx];
      const leftPct = (p.x / SPARK_W) * 100 + '%';
      cross.style.left = leftPct;
      dot.style.left = leftPct;
      dot.style.top = (p.y / SPARK_H) * 100 + '%';
      readout.style.left = leftPct;
      readout.style.setProperty('--rx', readoutShift(p.x));
      rVal.className = 'm-stats-spark__readout-val mono ' + mGradeClass(p.value);
      rVal.textContent = p.value.toFixed(1);
      const modLabel = p.count === 1 ? ' Modul' : ' Module';
      rMeta.textContent = fmtVerlaufDate(p.day) + ' · ' + p.count + modLabel;
      live.textContent = fmtVerlaufDate(p.day) + ': Schnitt ' + p.value.toFixed(1)
        + ', ' + p.count + modLabel;
      plot.classList.add('is-active');
    }
    function idxFromClientX(clientX) {
      const rect = plot.getBoundingClientRect();
      if (rect.width <= 0) return -1;
      let idx = Math.round(((clientX - rect.left) / rect.width) * (pts.length - 1));
      if (idx < 0) idx = 0;
      else if (idx > pts.length - 1) idx = pts.length - 1;
      return idx;
    }
    plot.addEventListener('pointermove', function (e) { setActive(idxFromClientX(e.clientX)); });
    plot.addEventListener('pointerdown', function (e) { setActive(idxFromClientX(e.clientX)); });
    plot.addEventListener('pointerleave', function () { setActive(-1); });
    plot.addEventListener('pointercancel', function () { setActive(-1); });
    plot.addEventListener('pointerup', function (e) { if (e.pointerType === 'touch') setActive(-1); });
    plot.addEventListener('blur', function () { setActive(-1); });
    plot.addEventListener('keydown', function (e) {
      let idx = activeIdx < 0 ? pts.length - 1 : activeIdx;
      if (e.key === 'ArrowLeft') idx = Math.max(0, idx - 1);
      else if (e.key === 'ArrowRight') idx = Math.min(pts.length - 1, idx + 1);
      else if (e.key === 'Home') idx = 0;
      else if (e.key === 'End') idx = pts.length - 1;
      else if (e.key === 'Escape') { setActive(-1); plot.blur(); return; }
      else return;
      e.preventDefault();
      setActive(idx);
    });

    spark.append(plot);

    const trendEl = document.createElement('span');
    trendEl.className = 'm-stats-spark__trend mono '
      + (trend >= 0 ? 'm-grade--excellent' : 'm-grade--fail');
    trendEl.textContent = trendStr;
    spark.append(trendEl);
  } else {
    const empty = document.createElement('p');
    empty.className = 'm-stats-spark__empty mono';
    empty.textContent = 'Zu wenige Datenpunkte für Trend.';
    spark.append(empty);
  }
  card.append(spark);
  return card;
}

/* Baut die volle Spark-Geometrie aus der server-seitigen Carry-forward-Serie
 * (verlauf.points): pro Punkt x/y im SVG-Koordinatenraum + day/value/count
 * fuer den Hover-Readout, plus Line- + Fill-Path. Die volle Serie wird
 * gezeichnet (kein Client-Slice). Mindestens 2 Punkte notwendig. */
function buildSparkGeom(verlauf) {
  const vp = verlauf && Array.isArray(verlauf.points) ? verlauf.points : null;
  if (!vp || vp.length < 2) return null;
  let min = vp[0].value;
  let max = min;
  for (let i = 1; i < vp.length; i += 1) {
    const v = vp[i].value;
    if (v < min) min = v;
    else if (v > max) max = v;
  }
  const range = max - min || 1;
  const innerW = SPARK_W - SPARK_PAD * 2;
  const innerH = SPARK_H - SPARK_PAD * 2;
  const denom = vp.length - 1;
  let line = '';
  const pts = [];
  for (let i = 0; i < vp.length; i += 1) {
    const x = SPARK_PAD + (i / denom) * innerW;
    const t = (vp[i].value - min) / range;
    const y = SPARK_PAD + (1 - t) * innerH;
    line += (i === 0 ? 'M' : 'L') + x.toFixed(2) + ',' + y.toFixed(2) + ' ';
    pts.push({ x: x, y: y, day: vp[i].day, value: vp[i].value, count: vp[i].count });
  }
  const baseY = (SPARK_H - SPARK_PAD).toFixed(2);
  const fill = line + 'L' + pts[pts.length - 1].x.toFixed(2) + ',' + baseY
    + ' L' + pts[0].x.toFixed(2) + ',' + baseY + ' Z';
  return { pts: pts, line: line.trim(), fill: fill.trim(), min: min, max: max };
}

/* SVG-Notenfarbklasse fuer den Readout-Wert (spiegelt die Desktop-gradeClass). */
function mGradeClass(v) {
  if (v == null) return '';
  if (v >= 5.0) return 'm-grade--excellent';
  if (v >= 4.5) return 'm-grade--good';
  if (v >= 4.0) return 'm-grade--ok';
  return 'm-grade--fail';
}

/* ISO `YYYY-MM-DD` -> `DD.MM.YYYY` (de). */
function fmtVerlaufDate(iso) {
  const p = String(iso).split('-');
  return p.length === 3 ? p[2] + '.' + p[1] + '.' + p[0] : iso;
}

/* Readout-Chip horizontal am Punkt verankern, an den Raendern kippen. */
function readoutShift(x) {
  if (x < SPARK_W * 0.18) return '0%';
  if (x > SPARK_W * 0.82) return '-100%';
  return '-50%';
}

/* ------------------------------------------------------------------ */
/* Modul-Statistik-Card: Kennzahlen + Histogramm + Top/Flop + Pro-Sem. */
/* ------------------------------------------------------------------ */
function buildModstatCard(rows, totalModules, withGrade) {
  const card = document.createElement('article');
  card.className = 'm-card m-stats-card m-stats-modstat-card';

  const head = document.createElement('div');
  head.className = 'm-stats-card__head';
  const title = document.createElement('h2');
  title.className = 'm-stats-card__title';
  title.textContent = 'Modul Statistik';
  const hint = document.createElement('span');
  hint.className = 'm-stats-card__hint mono';
  hint.textContent = withGrade + ' benotet · ' + totalModules + ' total';
  head.append(title, hint);
  card.append(head);

  const agg = computeModuleAggregate(rows);
  const buckets = computeHistogramBuckets(rows);
  let maxBucket = 1;
  for (let i = 0; i < buckets.length; i += 1) {
    if (buckets[i] > maxBucket) maxBucket = buckets[i];
  }
  const semStats = computeSemesterStats(rows);

  card.append(buildKpiSection(agg));
  card.append(buildHistoSection(buckets, maxBucket));
  if (agg.topModules.length > 0) {
    card.append(buildTopFlopSection(agg));
  }
  if (semStats.length > 0) {
    card.append(buildSemSection(semStats));
  }
  return card;
}

/* Single-Pass Aggregat über die benoteten Rows: sortedDesc liefert
 * Best/Worst/Median/Top/Flop ohne mehrfache Sort-Allocations. */
function computeModuleAggregate(rows) {
  const empty = {
    gradedRows: [], sortedDesc: [], medianNote: null,
    bestModule: null, worstModule: null, noteRange: null,
    topModules: [], flopModules: [],
  };
  if (!rows || !rows.length) return empty;
  const graded = rows.filter((r) => r.note != null);
  if (!graded.length) return empty;

  const sortedDesc = graded.slice().sort((a, b) => b.note - a.note);
  const n = sortedDesc.length;
  const best = sortedDesc[0];
  const worst = sortedDesc[n - 1];

  let median;
  if (n % 2 === 0) {
    median = (sortedDesc[n / 2 - 1].note + sortedDesc[n / 2].note) / 2;
  } else {
    median = sortedDesc[Math.floor(n / 2)].note;
  }

  const topModules = sortedDesc.slice(0, 5);
  const flopModules = [];
  for (let i = n - 1; i >= Math.max(0, n - 5); i -= 1) {
    flopModules.push(sortedDesc[i]);
  }

  return {
    gradedRows: graded,
    sortedDesc,
    medianNote: median,
    bestModule: best,
    worstModule: worst,
    noteRange: best.note - worst.note,
    topModules,
    flopModules,
  };
}

/* 21 Buckets von 4.0 bis 6.0 in 0.1er Schritten. Werte ausserhalb des
 * Bereichs werden ignoriert (z. B. < 4.0 ist im Bucket-System nicht
 * vorgesehen und würde nur das Histogramm-Layout zerstören). */
function computeHistogramBuckets(rows) {
  const arr = new Array(21).fill(0);
  if (!rows) return arr;
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (r.note == null) continue;
    const idx = Math.round((r.note - 4.0) * 10);
    if (idx >= 0 && idx < 21) arr[idx] += 1;
  }
  return arr;
}

function bucketClass(idx) {
  if (idx <= 4) return 'is-ok';
  if (idx <= 9) return 'is-good';
  return 'is-excellent';
}

function bucketLabel(idx) {
  return (4.0 + idx / 10).toFixed(1);
}

/* Modul-Code wie "122" oder "104-N1" (Modulnummer-Suffix-Pattern) — gleicher
 * Algorithmus wie in helpers.moduleCode auf Desktop. */
function modCode(r) {
  if (!r) return '';
  if (!r.kuerzel_code) return r.fach_code || '';
  const parts = String(r.kuerzel_code).split('-');
  if (!parts.length) return r.fach_code || '';
  const last = parts[parts.length - 1];
  if (/^N\d+$/i.test(last) && parts.length >= 2) {
    return parts[parts.length - 2] + '-' + last;
  }
  return last;
}

function modName(r) {
  if (!r) return '—';
  return r.fach_name || r.fach_code || r.kuerzel_full || '—';
}

function computeSemesterStats(rows) {
  if (!rows || !rows.length) return [];
  const acc = new Map();
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    const sem = r.semester || '–';
    let a = acc.get(sem);
    if (!a) {
      a = { count: 0, gradedCount: 0, sum: 0, best: -Infinity, worst: Infinity };
      acc.set(sem, a);
    }
    a.count += 1;
    if (r.note != null) {
      a.gradedCount += 1;
      a.sum += r.note;
      if (r.note > a.best) a.best = r.note;
      if (r.note < a.worst) a.worst = r.note;
    }
  }
  const out = [];
  acc.forEach((a, sem) => {
    out.push({
      semester: sem,
      count: a.count,
      countGraded: a.gradedCount,
      avg: a.gradedCount ? a.sum / a.gradedCount : null,
      best: a.gradedCount ? a.best : null,
      worst: a.gradedCount ? a.worst : null,
    });
  });
  out.sort((a, b) => a.semester.localeCompare(b.semester));
  return out;
}

function buildKpiSection(agg) {
  const sec = document.createElement('section');
  sec.className = 'm-stats-sec m-stats-sec--kpi';

  const head = document.createElement('h3');
  head.className = 'm-stats-sec__head';
  const span = document.createElement('span');
  span.textContent = 'Kennzahlen';
  head.append(span);
  sec.append(head);

  const dl = document.createElement('dl');
  dl.className = 'm-stats-kpi';

  dl.append(kpiRow(
    'Median',
    agg.medianNote != null ? agg.medianNote.toFixed(2) : '–',
    '',
    gradeClass(agg.medianNote),
  ));
  dl.append(kpiRow(
    'Beste',
    (agg.bestModule && agg.bestModule.note != null) ? agg.bestModule.note.toFixed(2) : '–',
    agg.bestModule ? modName(agg.bestModule) : '—',
    gradeClass(agg.bestModule ? agg.bestModule.note : null),
  ));
  dl.append(kpiRow(
    'Schlechteste',
    (agg.worstModule && agg.worstModule.note != null) ? agg.worstModule.note.toFixed(2) : '–',
    agg.worstModule ? modName(agg.worstModule) : '—',
    gradeClass(agg.worstModule ? agg.worstModule.note : null),
  ));
  dl.append(kpiRow(
    'Spannweite',
    agg.noteRange != null ? agg.noteRange.toFixed(2) : '–',
    'Best − Schlecht',
    '',
  ));

  sec.append(dl);
  return sec;
}

function kpiRow(labelText, valueText, subText, valueExtraClass) {
  const row = document.createElement('div');
  row.className = 'm-stats-kpi__row';
  const dt = document.createElement('dt');
  dt.className = 'm-stats-kpi__label';
  dt.textContent = labelText;
  const dd = document.createElement('dd');
  dd.className = 'm-stats-kpi__value mono' + (valueExtraClass ? ' ' + valueExtraClass : '');
  dd.textContent = valueText;
  const sub = document.createElement('dd');
  sub.className = 'm-stats-kpi__sub';
  sub.textContent = subText || '';
  row.append(dt, dd, sub);
  return row;
}

function buildHistoSection(buckets, maxBucket) {
  const sec = document.createElement('section');
  sec.className = 'm-stats-sec m-stats-sec--histo';

  const head = document.createElement('h3');
  head.className = 'm-stats-sec__head';
  const span1 = document.createElement('span');
  span1.textContent = 'Verteilung';
  const span2 = document.createElement('span');
  span2.className = 'm-stats-sec__hint mono';
  span2.textContent = '0.1er · 4.0–6.0';
  head.append(span1, span2);
  sec.append(head);

  const histo = document.createElement('div');
  histo.className = 'm-stats-histo';
  histo.setAttribute('role', 'list');
  histo.setAttribute('aria-label', 'Notenverteilung');

  for (let i = 0; i < buckets.length; i += 1) {
    const count = buckets[i];
    const bar = document.createElement('div');
    const stateCls = count > 0 ? 'has-val' : 'is-empty';
    bar.className = 'm-stats-histo__bar ' + bucketClass(i) + ' ' + stateCls;
    bar.style.height = (count > 0 ? (count / maxBucket) * 100 : 0) + '%';
    bar.setAttribute('role', 'listitem');
    const lbl = bucketLabel(i) + ': ' + count + ' ' + (count === 1 ? 'Modul' : 'Module');
    bar.setAttribute('aria-label', lbl);
    bar.title = lbl;
    if (count > 0) {
      const c = document.createElement('span');
      c.className = 'm-stats-histo__count mono';
      c.setAttribute('aria-hidden', 'true');
      c.textContent = String(count);
      bar.append(c);
    }
    histo.append(bar);
  }
  sec.append(histo);

  const axis = document.createElement('div');
  axis.className = 'm-stats-histo-axis';
  for (let i = 0; i < buckets.length; i += 1) {
    const sp = document.createElement('span');
    sp.className = 'mono';
    sp.textContent = bucketLabel(i);
    axis.append(sp);
  }
  sec.append(axis);
  return sec;
}

function buildTopFlopSection(agg) {
  const sec = document.createElement('section');
  sec.className = 'm-stats-sec m-stats-sec--toplist';

  const head = document.createElement('h3');
  head.className = 'm-stats-sec__head';
  const span = document.createElement('span');
  span.textContent = 'Top & Flop';
  head.append(span);
  sec.append(head);

  const grid = document.createElement('div');
  grid.className = 'm-stats-toplist';
  grid.append(topFlopCol('Top ' + agg.topModules.length, agg.topModules));
  grid.append(topFlopCol('Flop ' + agg.flopModules.length, agg.flopModules));
  sec.append(grid);
  return sec;
}

function topFlopCol(title, list) {
  const col = document.createElement('div');
  col.className = 'm-stats-toplist__col';
  const t = document.createElement('div');
  t.className = 'm-stats-toplist__title';
  t.textContent = title;
  col.append(t);
  for (let i = 0; i < list.length; i += 1) {
    const r = list[i];
    const row = document.createElement('div');
    row.className = 'm-stats-toplist__row';
    const num = document.createElement('span');
    num.className = 'm-stats-toplist__num mono';
    num.textContent = modCode(r) || '—';
    const name = document.createElement('span');
    name.className = 'm-stats-toplist__name';
    name.textContent = modName(r);
    const grade = document.createElement('span');
    grade.className = 'm-stats-toplist__grade mono ' + gradeClass(r.note);
    grade.textContent = r.note != null ? r.note.toFixed(2) : '–';
    row.append(num, name, grade);
    col.append(row);
  }
  return col;
}

function buildSemSection(semStats) {
  const sec = document.createElement('section');
  sec.className = 'm-stats-sec m-stats-sec--sem';

  const head = document.createElement('h3');
  head.className = 'm-stats-sec__head';
  const span = document.createElement('span');
  span.textContent = 'Pro Semester';
  head.append(span);
  sec.append(head);

  const grid = document.createElement('div');
  grid.className = 'm-stats-sem-grid';
  for (let i = 0; i < semStats.length; i += 1) {
    grid.append(buildSemBlock(semStats[i]));
  }
  sec.append(grid);
  return sec;
}

function buildSemBlock(s) {
  const block = document.createElement('div');
  block.className = 'm-stats-sem';

  const lab = document.createElement('div');
  lab.className = 'm-stats-sem__label';
  lab.textContent = s.semester;
  block.append(lab);

  const row = document.createElement('div');
  row.className = 'm-stats-sem__row';
  row.append(semStat('Schnitt', s.avg != null ? s.avg.toFixed(2) : '–', gradeClass(s.avg)));
  row.append(semStat('Module', String(s.count), ''));
  row.append(semStat('Benotet', String(s.countGraded), ''));
  row.append(semStat('Beste', s.best != null ? s.best.toFixed(2) : '–', gradeClass(s.best)));
  row.append(semStat('Schlecht', s.worst != null ? s.worst.toFixed(2) : '–', gradeClass(s.worst)));
  block.append(row);
  return block;
}

function semStat(labelText, valueText, valueExtraClass) {
  const wrap = document.createElement('span');
  wrap.className = 'm-stats-sem__stat';
  const lab = document.createElement('span');
  lab.className = 'm-stats-sem__stat-label';
  lab.textContent = labelText;
  const val = document.createElement('span');
  val.className = 'm-stats-sem__stat-value mono' + (valueExtraClass ? ' ' + valueExtraClass : '');
  val.textContent = valueText;
  wrap.append(lab, val);
  return wrap;
}

/* ------------------------------------------------------------------ */
/* QV-Rechner — BiVo 2021, ABU dispensiert.                           */
/*                                                                    */
/* Verbindliche Gewichtung laut Verordnung / Notenausweis:            */
/*   IPA                      40 %                                    */
/*   Informatikkompetenzen    30 %  (= BK, ohne Mathe + Englisch)     */
/*   Mathe + Englisch         10 %                                    */
/*   ABU                      20 %  (dispensiert → fällt weg)         */
/*                                                                    */
/* Ohne ABU summieren sich die drei Bereiche auf 80 %. Die Division   */
/* durch 0.8 schiebt die Gesamtnote zurück auf die 1–6-Skala — kein   */
/* Wahlschritt, sondern zwingend.                                     */
/*                                                                    */
/*   IPA   = (2·A + B + C) / 4         [A=Prozess/Resultat,           */
/*                                      B=Doku, C=Präsentation]       */
/*   BK    = Ø der Informatik-Modulnoten direkt aus Tocco             */
/*   ME    = Ø der Mathe- und Englisch-Module                         */
/*   Gesamt = (IPA·0.4 + BK·0.3 + ME·0.1) / 0.8                       */
/*                                                                    */
/* Effektiv: IPA 50 %, BK 37.5 %, ME 12.5 % — nur das Ergebnis der    */
/* Normalisierung, keine zweite Gewichtung.                           */
/*                                                                    */
/* Notenquelle ist row.note direkt aus Tocco (parseNote macht nur     */
/* String→Float, keine Berechnung). KEIN backend-berechneter Schnitt. */
/*                                                                    */
/* Bestanden: IPA ≥ 4.0 UND Gesamt ≥ 4.0. Alle Zwischen- und          */
/* Endwerte werden auf 0.1 gerundet (CH-Konvention).                  */
/* ------------------------------------------------------------------ */

/* Modul-Filter für die zwei Schnitte:
 *
 *   isMathEnglishModule(row)
 *     Matched Mathe + Englisch über fach_name (Mathematik / Englisch)
 *     — unabhängig vom Niveau-Suffix oder Semester. Fängt damit
 *     Mathematik-N1, Mathematik-N2, Englisch-N1 etc. einheitlich ab.
 *
 *   isInformatikModule(row)
 *     Berufsfach: 3-stellige Modulnummer im kuerzel_code (z.B.
 *     "122", "M122", "BMI-AP-122"). Lookbehind/-ahead schützt vor
 *     falsch gematchten Jahreszahlen ("2024"). Mathe + Englisch
 *     werden zusätzlich explizit ausgeschlossen, falls ein
 *     ICT-Modul jemals ein Niveau-Suffix bekommt.
 *
 * Modul ohne Note → in beiden Filtern raus.
 * Module die WEDER M+E noch Informatik sind (z.B. ABU, falls jemand
 * mit ABU drinsitzt) fallen aus beiden Schnitten raus. */
function isMathEnglishModule(row) {
  if (!row) return false;
  const name = (row.fach_name || '').toLowerCase();
  return name.indexOf('mathematik') !== -1 || name.indexOf('englisch') !== -1;
}
function isInformatikModule(row) {
  if (!row) return false;
  if (isMathEnglishModule(row)) return false;
  const code = row.kuerzel_code || '';
  if (!code) return false;
  if (/-N\d+$/i.test(code)) return false;
  return /(?<!\d)\d{3}(?!\d)/.test(code);
}

/* Liefert { rows, count, avg, rounded } für eine Schnitt-Berechnung.
 * predicate muss bereits den null-Note-Filter mitbringen. */
function computeAvg(rows, predicate) {
  const list = (rows || []).filter((r) => predicate(r) && r.note != null);
  if (list.length === 0) {
    return { rows: [], count: 0, avg: null, rounded: null };
  }
  let sum = 0;
  for (let i = 0; i < list.length; i += 1) sum += list[i].note;
  const avg = sum / list.length;
  const rounded = Math.round(avg * 10) / 10;
  return { rows: list, count: list.length, avg, rounded };
}

function buildQvCard(rows) {
  const card = document.createElement('article');
  card.className = 'm-card m-stats-card m-stats-ipa-card';

  const head = document.createElement('div');
  head.className = 'm-stats-card__head';
  const title = document.createElement('h2');
  title.className = 'm-stats-card__title';
  title.textContent = 'QV-Rechner';
  const hint = document.createElement('span');
  hint.className = 'm-stats-card__hint mono';
  hint.textContent = 'IPA + BK + M+E · ABU dispensiert';
  head.append(title, hint);
  card.append(head);

  const intro = document.createElement('p');
  intro.className = 'm-stats-ipa__intro';
  intro.textContent = 'Schätzt deine QV-Gesamtnote aus den drei '
    + 'IPA-Teilnoten, dem Schnitt deiner Informatik-Module (BK) und '
    + 'dem Schnitt aus Mathe und Englisch (M+E). Die Modulnoten '
    + 'kommen direkt aus Tocco.';
  card.append(intro);

  const formula = document.createElement('div');
  formula.className = 'm-stats-ipa__formula mono';
  formula.textContent = 'IPA = (2·A + B + C) / 4    ·    '
    + 'Gesamt = (IPA·0.4 + BK·0.3 + ME·0.1) / 0.8';
  card.append(formula);

  // IPA-Teilnoten — 3 Inputs (A 2x gewichtet, B, C).
  const inputs = document.createElement('div');
  inputs.className = 'm-stats-ipa__inputs';
  inputs.append(qvField('a', 'A · Prozess / Resultat', '2×'));
  inputs.append(qvField('b', 'B · Dokumentation', '1×'));
  inputs.append(qvField('c', 'C · Präsentation / Gespräch', '1×'));
  card.append(inputs);

  // Zwei Schnitt-Boxen nebeneinander (BK + M+E). Beide live aus den
  // geladenen Noten berechnet, Re-Render bei jeder SSE-Welle automatisch.
  const avgGrid = document.createElement('div');
  avgGrid.className = 'm-stats-ipa__avg-grid';
  const bkHost = document.createElement('div');
  bkHost.className = 'm-stats-ipa__bk-host';
  const meHost = document.createElement('div');
  meHost.className = 'm-stats-ipa__bk-host';
  avgGrid.append(bkHost, meHost);
  card.append(avgGrid);

  // Result-Container — live-Recompute zeichnet nur diesen Bereich neu
  // (Input-Felder behalten Focus + Cursor, keine "Tastatur klappt zu"-Bugs).
  const resultHost = document.createElement('div');
  resultHost.className = 'm-stats-ipa__result-host';
  card.append(resultHost);

  const note = document.createElement('p');
  note.className = 'm-stats-ipa__note';
  note.textContent = 'Bestanden = IPA ≥ 4.0 · Gesamtnote ≥ 4.0 (auf 0.1 '
    + 'gerundet). BK-Schnitt aus allen Informatik-Modulnoten direkt aus '
    + 'Tocco (dreistellige Modulnummer). M+E-Schnitt aus den Mathe- und '
    + 'Englisch-Modulen (alle Niveaus). Verordnung: IPA 40 %, '
    + 'Informatikkompetenzen 30 %, Mathe+Englisch 10 %, ABU 20 % (bei dir '
    + 'dispensiert, fällt weg). Ohne ABU summieren sich die drei Bereiche '
    + 'auf 80 %, deshalb die Division durch 0.8 — das schiebt die '
    + 'Gesamtnote zurück auf die 1–6-Skala. Effektiv schlägt damit IPA '
    + '50 %, BK 37.5 %, M+E 12.5 % auf die Endnote durch.';
  card.append(note);

  const bk = computeAvg(rows, isInformatikModule);
  const me = computeAvg(rows, isMathEnglishModule);

  // Initial-Render
  syncQvInputsFromState(inputs);
  bkHost.replaceChildren(buildAvgBox(bk, {
    label: 'Informatikkompetenzen',
    weight: '30 %',
    emptyMsg: 'noch keine Informatik-Module benotet',
  }));
  meHost.replaceChildren(buildAvgBox(me, {
    label: 'Mathe + Englisch',
    weight: '10 %',
    emptyMsg: 'noch keine Mathe-/Englisch-Module benotet',
  }));
  resultHost.replaceChildren(buildQvResult(bk, me));

  // Live-Recompute bei jedem Input (eigener Listener pro Feld, data-key
  // entscheidet welcher State-Slot geändert wird).
  inputs.querySelectorAll('input.m-stats-ipa__field-input').forEach((inp) => {
    inp.addEventListener('input', () => {
      const field = inp.closest('.m-stats-ipa__field');
      const key = field && field.dataset.key;
      if (!key) return;
      const v = inp.value.trim();
      const parsed = v === '' ? null : parseFloat(v);
      statsState.qv[key] = (parsed != null && Number.isFinite(parsed)) ? parsed : null;
      updateFieldValidity(field, statsState.qv[key]);
      resultHost.replaceChildren(buildQvResult(bk, me));
    });
  });

  return card;
}

function qvField(key, labelText, weightText) {
  const label = document.createElement('label');
  label.className = 'm-stats-ipa__field';
  label.dataset.key = key;

  const lbl = document.createElement('span');
  lbl.className = 'm-stats-ipa__field-label';
  lbl.textContent = labelText;

  const input = document.createElement('input');
  input.type = 'number';
  input.step = '0.1';
  input.min = '1';
  input.max = '6';
  input.inputMode = 'decimal';
  input.className = 'm-stats-ipa__field-input mono';
  input.setAttribute('aria-label', labelText);

  const weight = document.createElement('span');
  weight.className = 'm-stats-ipa__field-weight';
  weight.textContent = weightText;

  const err = document.createElement('span');
  err.className = 'm-stats-ipa__field-err mono';
  err.hidden = true;
  err.textContent = '1.0–6.0';

  label.append(lbl, input, weight, err);
  return label;
}

function syncQvInputsFromState(inputsRoot) {
  inputsRoot.querySelectorAll('.m-stats-ipa__field').forEach((field) => {
    const key = field.dataset.key;
    if (!key) return;
    const input = field.querySelector('input');
    const v = statsState.qv[key];
    if (input) input.value = v != null && Number.isFinite(v) ? String(v) : '';
    updateFieldValidity(field, v);
  });
}

function updateFieldValidity(field, value) {
  const input = field.querySelector('input');
  const err = field.querySelector('.m-stats-ipa__field-err');
  const invalid = value != null && (value < 1 || value > 6);
  field.classList.toggle('m-stats-ipa__field--invalid', invalid);
  if (input) input.setAttribute('aria-invalid', invalid ? 'true' : 'false');
  if (err) err.hidden = !invalid;
}

function buildAvgBox(data, opts) {
  const box = document.createElement('div');
  box.className = 'm-stats-ipa__bk';

  const main_ = document.createElement('div');
  main_.className = 'm-stats-ipa__bk-main';

  const lab = document.createElement('div');
  lab.className = 'm-stats-ipa__bk-label';
  lab.textContent = opts.label;

  const val = document.createElement('div');
  val.className = 'm-stats-ipa__bk-value mono '
    + gradeClass(data.rounded);
  val.textContent = data.rounded != null ? data.rounded.toFixed(1) : '–';

  const exact = document.createElement('div');
  exact.className = 'm-stats-ipa__bk-exact mono';
  if (data.count === 0) {
    exact.textContent = opts.emptyMsg;
  } else {
    exact.textContent = 'exakt ' + data.avg.toFixed(2)
      + ' · ' + data.count + (data.count === 1 ? ' Modul' : ' Module')
      + ' · ' + opts.weight;
  }

  main_.append(lab, val, exact);
  box.append(main_);

  // Compact-Modul-Liste als Klick-erweiterbare Pille — User kann nachlesen
  // welche Module einbezogen wurden. Solange das per Default zu ist, frisst
  // sie keinen Platz; aufgeklappt sieht der User die Bezugsbasis.
  if (data.count > 0) {
    const details = document.createElement('details');
    details.className = 'm-stats-ipa__bk-details';
    const summary = document.createElement('summary');
    summary.className = 'm-stats-ipa__bk-summary mono';
    summary.textContent = 'Module zeigen';
    details.append(summary);

    const list = document.createElement('ul');
    list.className = 'm-stats-ipa__bk-list';
    data.rows.slice().sort((a, b) => {
      // Sort: code aufsteigend (numerisch wenn rein 3-stellig, sonst alphab.).
      const ca = (a.kuerzel_code || '');
      const cb = (b.kuerzel_code || '');
      return ca.localeCompare(cb);
    }).forEach((r) => {
      const li = document.createElement('li');
      li.className = 'm-stats-ipa__bk-item';

      const code = document.createElement('span');
      code.className = 'm-stats-ipa__bk-item-code mono';
      code.textContent = (typeof modulNummerOf === 'function'
        ? (modulNummerOf(r.kuerzel_code) || '—')
        : '—');

      const name = document.createElement('span');
      name.className = 'm-stats-ipa__bk-item-name';
      name.textContent = r.fach_name || r.fach_code || r.kuerzel_full || '—';

      const grade = document.createElement('span');
      grade.className = 'm-stats-ipa__bk-item-grade mono ' + gradeClass(r.note);
      grade.textContent = r.note.toFixed(2);

      li.append(code, name, grade);
      list.append(li);
    });
    details.append(list);
    box.append(details);
  }

  return box;
}

function buildQvResult(bk, me) {
  const result = document.createElement('div');
  result.className = 'm-stats-ipa__result';

  const a = statsState.qv.a;
  const b = statsState.qv.b;
  const c = statsState.qv.c;
  const ipaInputsValid = isValid(a) && isValid(b) && isValid(c);

  // IPA-Teilberechnung (auf 0.1 gerundet — CH-Konvention für Schlussnoten).
  const ipaExact = ipaInputsValid ? (2 * a + b + c) / 4 : null;
  const ipa = ipaExact != null ? Math.round(ipaExact * 10) / 10 : null;

  // Gesamtnote: Gesamt = (IPA·0.4 + BK·0.3 + ME·0.1) / 0.8.
  // Braucht IPA-Inputs UND beide Schnitte.
  const hasBk = bk && bk.rounded != null;
  const hasMe = me && me.rounded != null;
  const allValid = ipaInputsValid && hasBk && hasMe;
  const gesamtExact = allValid
    ? (ipa * 0.4 + bk.rounded * 0.3 + me.rounded * 0.1) / 0.8
    : null;
  const gesamtR = gesamtExact != null ? Math.round(gesamtExact * 10) / 10 : null;

  const main_ = document.createElement('div');
  main_.className = 'm-stats-ipa__result-main';

  const lab = document.createElement('div');
  lab.className = 'm-stats-ipa__result-label';
  lab.textContent = 'QV-Gesamtnote';

  const val = document.createElement('div');
  val.className = 'm-stats-ipa__result-value mono ' + gradeClass(gesamtR);
  val.textContent = gesamtR != null ? gesamtR.toFixed(1) : '–';

  const exact = document.createElement('div');
  exact.className = 'm-stats-ipa__result-exact mono';
  if (!ipaInputsValid) {
    exact.textContent = 'A · B · C ausfüllen';
  } else if (!hasBk && !hasMe) {
    exact.textContent = 'IPA ' + ipa.toFixed(1) + ' · BK fehlt · M+E fehlt';
  } else if (!hasBk) {
    exact.textContent = 'IPA ' + ipa.toFixed(1)
      + ' · BK fehlt · M+E ' + me.rounded.toFixed(1);
  } else if (!hasMe) {
    exact.textContent = 'IPA ' + ipa.toFixed(1)
      + ' · BK ' + bk.rounded.toFixed(1) + ' · M+E fehlt';
  } else {
    exact.textContent = 'IPA ' + ipa.toFixed(1)
      + ' · BK ' + bk.rounded.toFixed(1)
      + ' · M+E ' + me.rounded.toFixed(1)
      + ' · exakt ' + gesamtExact.toFixed(2);
  }

  main_.append(lab, val, exact);
  result.append(main_);

  if (allValid) {
    const passed = ipa >= 4 && gesamtR >= 4;
    const pass = document.createElement('div');
    pass.className = 'm-stats-ipa__result-pass m-stats-ipa__result-pass--'
      + (passed ? 'ok' : 'fail');
    if (passed) {
      pass.textContent = '✓ Bestanden';
    } else if (ipa < 4) {
      pass.textContent = '✗ IPA < 4';
    } else {
      pass.textContent = '✗ Gesamt < 4';
    }
    result.append(pass);
  }

  // "Was-wäre-wenn"-Pillen: drei feste Szenarien (IPA 5.0 / 5.5 / 6.0)
  // mit der jeweiligen Gesamtnote bei gegebenen BK- und ME-Schnitten.
  // Nur sinnvoll wenn beide verfügbar sind — die ÷ 0.8 ergibt sonst
  // keine konsistente Note. Read-only-Display, kein Tap-Handler.
  if (hasBk && hasMe) {
    result.append(buildQvWhatIf(bk, me));

    // Zielnoten-Rechner: eigener Host, damit ein Chip-Tap nur diesen
    // Bereich neu zeichnet und den IPA-Input-Focus nicht stört. (Der
    // Goal-Seek hängt nur an BK + M+E + Ziel, nicht an den IPA-Inputs.)
    const goalHost = document.createElement('div');
    goalHost.className = 'm-stats-ipa__goalseek-host';
    goalHost.style.flexBasis = '100%';
    goalHost.append(buildQvGoalSeek(bk, me, goalHost));
    result.append(goalHost);
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* QV-Zielnoten-Rechner — Goal-Seek über das 0.1-Noten-Raster.        */
/*                                                                    */
/* Verbatim gespiegelt aus web-svelte/src/lib/utils/qv-goalseek.js.   */
/* Spezifikation + Tests: test/unit/qvGoalseek.test.mjs. Die zwei     */
/* reinen Funktionen MÜSSEN identisch zur Desktop-Quelle bleiben —    */
/* beide Surfaces teilen sich dieselbe ausführbare Spec.              */
/*                                                                    */
/* Warum iterieren statt Formel-Umkehrung: die QV-Pipeline rundet     */
/* ZWEIMAL (IPA → 0.1, dann Gesamt → 0.1). Eine algebraische          */
/* Umkehrung trifft die gerundete Stufe nicht zuverlässig. Das        */
/* 51-Schritt-Raster (1.0–6.0) ist deckungsgleich mit der Forward-    */
/* Berechnung und damit garantiert konsistent.                        */
/* ------------------------------------------------------------------ */
function qvGesamt(ipa, bkRounded, meRounded) {
  return Math.round(((ipa * 0.4 + bkRounded * 0.3 + meRounded * 0.1) / 0.8) * 10) / 10;
}
function benoetigteIpa(ziel, bkRounded, meRounded) {
  if (bkRounded == null || meRounded == null || ziel == null || !Number.isFinite(ziel)) {
    return { status: 'unknown', requiredIpa: null, gesamt: null };
  }
  for (let i = 10; i <= 60; i += 1) {
    const ipa = i / 10;
    const ges = qvGesamt(ipa, bkRounded, meRounded);
    if (ges >= ziel) {
      return {
        status: i === 10 ? 'secured' : 'reachable',
        requiredIpa: Math.round(ipa * 10) / 10,
        gesamt: ges,
      };
    }
  }
  return { status: 'impossible', requiredIpa: null, gesamt: qvGesamt(6.0, bkRounded, meRounded) };
}

/* Baut den Zielnoten-Block: Preset-Chips + Live-Verdikt.
 *
 * host ist der Container, den ein Chip-Tap neu befüllt — so bleibt der
 * Re-Render lokal und der IPA-Input-Focus unberührt. Der Block rendert
 * nur, wenn beide Schnitte da sind (Aufruf in buildQvResult bewacht das);
 * dadurch ist benoetigteIpa hier nie 'unknown' wegen fehlender Schnitte
 * — der unknown-Zweig fängt nur einen kaputten Ziel-State ab. */
function buildQvGoalSeek(bk, me, host) {
  const wrap = document.createElement('div');
  wrap.className = 'm-stats-ipa__goalseek';

  const lab = document.createElement('div');
  lab.className = 'm-stats-ipa__goalseek-label';
  lab.id = 'qvZielLabel';
  lab.textContent = 'Zielnote';
  wrap.append(lab);

  const ziel = isValid(statsState.qv.ziel) ? statsState.qv.ziel : 4.0;

  // Preset-Chips als Radiogroup: genau ein aktives Ziel. aria-pressed
  // trägt den Zustand für Screenreader; der aktive Chip ist zusätzlich
  // visuell (accent-tint) UND per Text klar — nicht nur Farbe.
  const chips = document.createElement('div');
  chips.className = 'm-stats-ipa__goalseek-chips';
  chips.setAttribute('role', 'radiogroup');
  chips.setAttribute('aria-labelledby', 'qvZielLabel');

  QV_ZIEL_PRESETS.forEach((preset) => {
    const active = Math.abs(preset - ziel) < 0.001;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'm-stats-ipa__goalseek-chip mono'
      + (active ? ' is-active' : '');
    chip.setAttribute('role', 'radio');
    chip.setAttribute('aria-checked', active ? 'true' : 'false');
    chip.setAttribute('aria-label', 'Zielnote ' + preset.toFixed(1));
    chip.textContent = preset.toFixed(1);
    chip.addEventListener('click', () => {
      statsState.qv.ziel = preset;
      // Nur den Goal-Seek-Host neu zeichnen — IPA-Inputs bleiben unberührt.
      host.replaceChildren(buildQvGoalSeek(bk, me, host));
    });
    chips.append(chip);
  });
  wrap.append(chips);

  wrap.append(buildQvGoalSeekVerdict(bk, me, ziel));
  return wrap;
}

/* Verdikt-Zeile zu einem gewählten Ziel. Vier Zustände, jeweils mit Wort
 * UND Form (Tonal-Klasse), nie nur Farbe:
 *   reachable  → benötigte IPA als grade-getönter mono-Chip
 *   secured    → ok-Ton, „schon gesichert"
 *   impossible → fail-Ton, max erreichbare Gesamtnote genannt
 *   unknown    → dezent (sollte mit vorhandenen Schnitten nicht auftreten) */
function buildQvGoalSeekVerdict(bk, me, ziel) {
  const res = benoetigteIpa(ziel, bk.rounded, me.rounded);

  const verdict = document.createElement('div');
  verdict.className = 'm-stats-ipa__goalseek-verdict '
    + 'm-stats-ipa__goalseek-verdict--' + res.status;
  verdict.setAttribute('role', 'status');
  verdict.setAttribute('aria-live', 'polite');

  const zielStr = ziel.toFixed(1);

  if (res.status === 'reachable') {
    const text = document.createElement('span');
    text.className = 'm-stats-ipa__goalseek-text';
    text.append(document.createTextNode('Dafür brauchst du IPA ≥ '));

    const ipaChip = document.createElement('span');
    // Neutrale Akzent-Farbe statt gradeClass: die benötigte IPA ist eine
    // Schwelle, kein erreichter Notenwert — eine niedrige Schwelle ist gut
    // und darf nicht rot (Fail-Ampel) erscheinen. Gut/Schlecht trägt der
    // Verdict-Zustand (--reachable/--secured/--impossible).
    ipaChip.className = 'm-stats-ipa__goalseek-ipachip mono';
    ipaChip.textContent = res.requiredIpa.toFixed(1);
    text.append(ipaChip);

    verdict.append(text);

    // Hinweis: Ziel ≥ 4 ist erreichbar, aber die nötige IPA liegt unter der
    // Bestehensgrenze 4.0 — fürs reine Bestehen zählt IPA ≥ 4.0 trotzdem.
    if (ziel >= 4 && res.requiredIpa < 4) {
      const hint = document.createElement('span');
      hint.className = 'm-stats-ipa__goalseek-hint';
      hint.textContent = '(zum Bestehen ohnehin IPA ≥ 4.0)';
      verdict.append(hint);
    }
    verdict.setAttribute('aria-label',
      'Ziel ' + zielStr + ': benötigt IPA mindestens '
      + res.requiredIpa.toFixed(1));
  } else if (res.status === 'secured') {
    const text = document.createElement('span');
    text.className = 'm-stats-ipa__goalseek-text';
    text.textContent = 'Schon gesichert — selbst IPA 1.0 hält ' + zielStr + '.';
    verdict.append(text);
    verdict.setAttribute('aria-label',
      'Ziel ' + zielStr + ' ist schon mit der kleinsten IPA gesichert');
  } else if (res.status === 'impossible') {
    const maxStr = res.gesamt != null ? res.gesamt.toFixed(1) : '–';
    const text = document.createElement('span');
    text.className = 'm-stats-ipa__goalseek-text';
    text.textContent = 'Mit BK ' + bk.rounded.toFixed(1)
      + ' · M+E ' + me.rounded.toFixed(1)
      + ' nicht erreichbar (max ' + maxStr + ').';
    verdict.append(text);
    verdict.setAttribute('aria-label',
      'Ziel ' + zielStr + ' nicht erreichbar, maximal ' + maxStr);
  } else {
    const text = document.createElement('span');
    text.className = 'm-stats-ipa__goalseek-text';
    text.textContent = 'Ziel wählen.';
    verdict.append(text);
  }

  return verdict;
}

/* Was-wäre-wenn-Pillen unter dem Result.
 *
 * Bei fixen BK- und ME-Schnitten rechnen wir für drei Standard-IPA-Werte
 * (5.0 / 5.5 / 6.0) die resultierende QV-Gesamtnote durch. Jede Pille
 * trägt eine passing/failing-Klasse, damit der User auf einen Blick
 * erkennt, ob dieses Szenario Bestehensregel (IPA ≥ 4 ∧ Gesamt ≥ 4)
 * trifft. Reine Read-only-Pillen — keine Tap-Aktion. */
function buildQvWhatIf(bk, me) {
  const wrap = document.createElement('div');
  wrap.className = 'm-stats-ipa__whatif';

  const lab = document.createElement('div');
  lab.className = 'm-stats-ipa__whatif-label';
  lab.textContent = 'Was-wäre-wenn';
  wrap.append(lab);

  const row = document.createElement('div');
  row.className = 'm-stats-ipa__whatif-row';
  const SCENARIOS = [5.0, 5.5, 6.0];
  SCENARIOS.forEach((ipa) => {
    const gesamt = (ipa * 0.4 + bk.rounded * 0.3 + me.rounded * 0.1) / 0.8;
    const gesamtR = Math.round(gesamt * 10) / 10;
    const passed = ipa >= 4 && gesamtR >= 4;

    const pill = document.createElement('div');
    pill.className = 'm-stats-ipa__whatif-btn m-stats-ipa__whatif-btn--'
      + (passed ? 'ok' : 'fail');

    const ipaSpan = document.createElement('span');
    ipaSpan.className = 'm-stats-ipa__whatif-ipa mono';
    ipaSpan.textContent = 'IPA ' + ipa.toFixed(1);

    const arrow = document.createElement('span');
    arrow.className = 'm-stats-ipa__whatif-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = '→';

    const gesSpan = document.createElement('span');
    gesSpan.className = 'm-stats-ipa__whatif-gesamt mono '
      + gradeClass(gesamtR);
    gesSpan.textContent = gesamtR.toFixed(1);

    pill.append(ipaSpan, arrow, gesSpan);
    pill.setAttribute('aria-label',
      'Bei IPA ' + ipa.toFixed(1) + ' ergibt sich Gesamtnote '
      + gesamtR.toFixed(1) + ' — ' + (passed ? 'bestanden' : 'nicht bestanden'));
    row.append(pill);
  });
  wrap.append(row);
  return wrap;
}

/* ------------------------------------------------------------------ */
/* Helper                                                              */
/* ------------------------------------------------------------------ */
function num(v) {
  return v != null && Number.isFinite(v) ? v : 0;
}
function isValid(v) {
  return v != null && Number.isFinite(v);
}
