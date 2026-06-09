'use strict';

const { escapeHtml } = require('../shared/escapeHtml');

// ---------- Date Helpers ----------
const DAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

function isoToday(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

function dayLabel(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return DAYS[date.getDay()] + ', ' + d + '. ' + MONTHS[m - 1];
}

function nextWeekRange() {
  const now = new Date();
  const day = now.getDay();
  const daysUntilMon = day === 0 ? 1 : (8 - day);
  const mon = new Date(now);
  mon.setDate(now.getDate() + daysUntilMon);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  return { from: mon.toISOString().slice(0, 10), to: sun.toISOString().slice(0, 10) };
}

// Formats an ISO timestamp into "dd.MM.yyyy HH:mm:ss" using the local timezone.
// Node honors the TZ env var — set TZ=Europe/Zurich (etc) to control output.
function formatDateTime(iso) {
  if (!iso) return '–';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} `
       + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ---------- Note formatters ----------
function formatNoteColor(note) {
  if (note == null) return '⬜';
  if (note >= 5.5) return '🟩';
  if (note >= 4.5) return '🟦';
  if (note >= 4.0) return '🟨';
  return '🟥';
}

function formatNote(n) {
  if (n == null) return '  —';
  return n.toFixed(1); // einheitlich: 6.0, 5.5, 4.5
}

// Modul-Nummer aus kuerzel_code extrahieren — wie im Web-UI.
// "UIFZ-2524-020-S1-106"    → "106"
// "UIFZ-2524-020-S2-ENG-N3" → "ENG-N3"
function extractModulNummer(r) {
  if (!r || !r.kuerzel_code) return null;
  const parts = String(r.kuerzel_code).split('-');
  if (!parts.length) return null;
  const last = parts[parts.length - 1];
  if (/^N\d+$/i.test(last) && parts.length >= 2) {
    return parts[parts.length - 2] + '-' + last;
  }
  return last;
}

// Berechnet gewichteten Schnitt aus Pruefungen — nur wenn alle bewertet.
function calcWeightedAvg(pruefungen) {
  if (!pruefungen || !pruefungen.length) return null;
  let sumW = 0, sumWN = 0;
  for (const p of pruefungen) {
    const n = Number(p.bewertung);
    const w = Number(p.gewicht_pct);
    if (!isFinite(n)) return null;
    if (isFinite(w) && w > 0) { sumW += w; sumWN += n * w; }
  }
  if (sumW <= 0) return null;
  return sumWN / sumW;
}

// Formatiert die Prüfungs-Liste eines Moduls als kompakten Block.
// Reihenfolge: ZP zuerst, dann LB, dann OTHER (siehe db.getPruefungen).
// Layout: Type-Badge (ZP/LB) + Nummer + Gewicht + Note. Ohne Bezeichnungs-
// Doppelung wenn Bezeichnung redundant ist (z.B. "LB" + Typ "LB").
function formatPruefungenBlock(pruefungen) {
  if (!pruefungen || !pruefungen.length) return '';
  const lines = [];
  for (const p of pruefungen) {
    const note = p.bewertung != null ? Number(p.bewertung).toFixed(1) : '—';
    const color = formatNoteColor(p.bewertung);
    // Label-Strategie:
    //   - ZP/LB → "<typ> <nr>"  (z.B. "LB 1", "ZP 2")
    //   - OTHER → originale bezeichnung (z.B. "Mündliche Prüfung")
    let label;
    if (p.pruefung_typ === 'OTHER') {
      label = p.bezeichnung || ('Prüfung ' + (p.pruefung_nr || ''));
    } else {
      label = p.pruefung_typ + ' ' + (p.pruefung_nr || '');
    }
    const gewicht = p.gewicht ? ' <i>' + escapeHtml(p.gewicht) + '</i>' : '';
    lines.push('   ' + color + ' <code>' + escapeHtml(label) + '</code>' + gewicht + '  <b>' + note + '</b>');
  }
  return lines.join('\n');
}

function formatTag(label, rows) {
  if (!rows.length) return '📅 <b>' + label + '</b>\n\nKeine Termine. 🎉';
  let text = '📅 <b>' + label + '</b>\n\n';
  for (const r of rows) {
    text += '🕐 <b>' + escapeHtml(r.zeit_von) + '–' + escapeHtml(r.zeit_bis) + '</b>\n';
    text += '📚 ' + escapeHtml(r.veranstaltung) + '\n';
    if (r.raum) text += '🏫 ' + escapeHtml(r.raum) + '\n';
    if (r.dozent) text += '👤 ' + escapeHtml(r.dozent) + '\n';
    text += '\n';
  }
  return text.trim();
}

// Schätzt grob die Bytes-Größe eines Tag-Blocks (für Smart-Truncate).
function estimateDayBytes(date, events) {
  let b = 30 + Buffer.byteLength(dayLabel(date), 'utf8');
  for (const r of events) {
    b += 50;
    b += Buffer.byteLength(String(r.veranstaltung || ''), 'utf8');
    b += Buffer.byteLength(String(r.raum || ''), 'utf8');
    b += Buffer.byteLength(String(r.dozent || ''), 'utf8');
  }
  return b;
}

// Phasen-Labels (deutsch, kompakt) — synchron zu PHASE_LABELS im Frontend.
// 'stundenplan' wird seit dem Parallel-Fetch-Refactor nicht mehr vom Scraper
// emittiert — Noten + Stundenplan laufen zusammen unter 'noten'. Label
// entsprechend zusammengefasst, damit Telegram /status nicht aussieht
// als hänge die Phase auf "Noten" für 60-90 s.
const PHASE_LABELS_DE = {
  starting:      'Initialisiert…',
  browser:       'Browser startet…',
  login:         'Login läuft…',
  noten:         'Noten + Stundenplan werden geladen…',
  saving:        'In DB speichern…',
  noten_details: 'Modul-Details werden geladen…',
  absenzen_details: 'Absenzen-Details werden geladen…'
};

// Sekunden seit ISO-Zeitstempel, oder null wenn ungültig
function elapsedSec(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 1000));
}

const MONTHS_DE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
                   'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

module.exports = {
  escapeHtml,
  DAYS,
  MONTHS,
  MONTHS_DE,
  isoToday,
  dayLabel,
  nextWeekRange,
  formatDateTime,
  formatNoteColor,
  formatNote,
  extractModulNummer,
  calcWeightedAvg,
  formatPruefungenBlock,
  formatTag,
  estimateDayBytes,
  PHASE_LABELS_DE,
  elapsedSec
};
