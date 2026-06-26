'use strict';

const { round1 } = require('./parsers');

const DEFAULT_VERLAUF_DAYS = 365;
const MAX_VERLAUF_DAYS = 365;

/** YYYY-MM-DD (UTC) verschoben um offset Tage. */
function addDaysUTC(day, offset) {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}
function maxDay(a, b) { return a > b ? a : b; }

/**
 * Carry-forward Schnitt-Verlauf aus dem append-only noten_history-Stream.
 * Pro Kalendertag = ungewichtetes Mittel der je Modul zuletzt bekannten,
 * benoteten (note != null) Snapshot-Werte (state as-of Tagesende).
 * Module ohne History-Zeile (Legacy) werden aus der Live-noten-Tabelle
 * geseedet und über das ganze Fenster mitgeführt, damit die Linie stetig
 * bleibt. Der LETZTE Punkt wird hart an die Live-noten-Tabelle gepinnt,
 * sodass er exakt dem Headline-Schnitt (round1(AVG(note))) entspricht.
 * Hinweis: bewusst OHNE stmts(db)-Cache (einmal pro Stats-Load, nicht gepollt).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ days?: number }} [opts]
 * @returns {Array<{ day: string, value: number, count: number }>}
 */
function getNotenVerlauf(db, opts = {}) {
  const raw = opts && opts.days;
  let n = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_VERLAUF_DAYS;
  if (n < 1) n = 1;
  if (n > MAX_VERLAUF_DAYS) n = MAX_VERLAUF_DAYS;

  const today = db.prepare("SELECT date('now') AS d").get().d;
  const live = db.prepare(
    'SELECT AVG(note) AS a, COUNT(note) AS c FROM noten WHERE note IS NOT NULL'
  ).get();
  const firstHist = db.prepare(
    'SELECT date(MIN(recorded_at)) AS d FROM noten_history'
  ).get();

  if (!firstHist || !firstHist.d) {
    if (!live || live.a == null) return [];
    return [{ day: today, value: round1(live.a), count: live.c }];
  }

  const windowStart = maxDay(firstHist.d, addDaysUTC(today, -(n - 1)));

  const snaps = db.prepare(`
    SELECT kuerzel_id, note, date(recorded_at) AS day
    FROM noten_history
    WHERE date(recorded_at) <= ?
    ORDER BY recorded_at ASC, id ASC
  `).all(today);

  const current = new Map();

  // Legacy-Module (Live-noten-Zeile, aber KEINE History-Zeile) seeden, sonst
  // tauchen sie nur im gepinnten Endpunkt auf -> Klippe + verzerrter Trend.
  const legacy = db.prepare(`
    SELECT kuerzel_id, note FROM noten
    WHERE kuerzel_id NOT IN (SELECT kuerzel_id FROM noten_history)
  `).all();
  for (const r of legacy) current.set(r.kuerzel_id, r.note);

  let i = 0;
  // Alle Snapshots STRIKT vor dem Fenster falten (korrekter Carry-forward-Start).
  while (i < snaps.length && snaps[i].day < windowStart) {
    current.set(snaps[i].kuerzel_id, snaps[i].note);
    i++;
  }

  const points = [];
  for (let day = windowStart; day <= today; day = addDaysUTC(day, 1)) {
    // ASC nach recorded_at: der spaeteste Snapshot gewinnt; bei gleichem
    // Timestamp entscheidet die hoechste id (Tiebreaker, wird zuletzt angewandt).
    while (i < snaps.length && snaps[i].day === day) {
      current.set(snaps[i].kuerzel_id, snaps[i].note);
      i++;
    }
    let sum = 0, cnt = 0;
    for (const v of current.values()) {
      if (v != null) { sum += v; cnt++; }
    }
    points.push({ day, value: cnt > 0 ? round1(sum / cnt) : null, count: cnt });
  }

  // Endpunkt hart an die autoritative Live-noten-Tabelle pinnen (neues Objekt
  // statt Mutation — Immutabilitaets-Regel).
  if (points.length && live && live.a != null) {
    points[points.length - 1] = {
      ...points[points.length - 1],
      value: round1(live.a),
      count: live.c
    };
  }

  // Nur fuehrendes ungraded-Prefix faellt weg; dank Legacy-Seed + Carry-forward
  // koennen nach dem ersten Grade keine inneren null-Tage mehr auftreten.
  return points.filter((p) => p.value != null);
}

module.exports = { getNotenVerlauf, DEFAULT_VERLAUF_DAYS, MAX_VERLAUF_DAYS };
