'use strict';

function parseFach(fach) {
  const m = (fach || '').match(/^([A-Z0-9-]+)\s+(.+)$/);
  if (!m) return { code: '', name: fach || '' };
  return { code: m[1], name: m[2] };
}

function parseKuerzel(kuerzel) {
  const parts = (kuerzel || '').split(/\s*\/\s*/);
  const id = parts[0] || '';
  const code = parts[1] || '';
  const sem = code.match(/-S(\d+)-/);
  return {
    id,
    code,
    label: parts.slice(2).join(' / '),
    semester: sem ? 'S' + sem[1] : null
  };
}

function parseNote(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const clean = raw.trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(clean)) return null;
  return parseFloat(clean);
}

function parseDatum(ddmmyy) {
  const m = (ddmmyy || '').match(/^(\d{2})\.(\d{2})\.(\d{2,4})$/);
  if (!m) return ddmmyy || '';
  const year = m[3].length === 2 ? '20' + m[3] : m[3];
  return year + '-' + m[2] + '-' + m[1];
}

function parseZeit(zeit) {
  const m = (zeit || '').match(/(\d{2}:\d{2})\s*[–-]\s*(\d{2}:\d{2})/);
  if (!m) return { von: '', bis: '' };
  return { von: m[1], bis: m[2] };
}

function round1(n) {
  if (n == null || Number.isNaN(n)) return null;
  return Math.round(n * 10) / 10;
}

// Bezeichnung wie "LB 1", "ZP 2" → { typ: 'LB'|'ZP'|'OTHER', nr: <int> }
// Tolerant gegen Bezeichnungen ohne / mit beschreibendem Zusatz:
//   "LB 1"            → LB, 1
//   "LB1"             → LB, 1
//   "LB Praxisarbeit" → LB, fallbackNr  (Bezeichnung ohne Zahl, Nr aus Spalte 1)
//   "LB - Vortrag"    → LB, fallbackNr
//   "LB"              → LB, fallbackNr
//   "Mündliche"       → OTHER, fallbackNr
//   "LBA"             → OTHER, fallbackNr  (Wortgrenze fehlt nach LB/ZP)
function classifyPruefung(bezeichnung, fallbackNr) {
  const trimmed = String(bezeichnung || '').trim();
  const m = trimmed.match(/^(LB|ZP)(?:\s*(\d+))?\b/i);
  const fbN = parseInt(fallbackNr, 10);
  const fbNr = Number.isFinite(fbN) ? fbN : 0;
  if (m) {
    const nr = m[2] ? parseInt(m[2], 10) : fbNr;
    return { typ: m[1].toUpperCase(), nr };
  }
  return { typ: 'OTHER', nr: fbNr };
}

function parseGewichtPct(raw) {
  if (raw == null) return null;
  const m = String(raw).match(/(\d+(?:[.,]\d+)?)/);
  if (!m) return null;
  const v = parseFloat(m[1].replace(',', '.'));
  return Number.isFinite(v) ? v : null;
}

// Positive Zahl aus rohem Text ziehen (SOLL/Besucht/Lektionen Soll/Ist etc.).
// Toleriert Dezimal-Komma (4,00) wie Dezimal-Punkt (4.00) sowie umschliessenden
// Text/Whitespace. Liefert null wenn keine Zahl gefunden — der Caller entscheidet
// dann ob das ein harter Parse-Fehler ist oder einfach "kein Wert". Anders als
// parseGewichtPct ist dies bewusst NICHT auf Prozent-Semantik gemünzt, sondern
// der generische Zahl-Extractor für die Absenzen-Spalten.
function parsePosNum(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const m = String(raw).match(/(\d+(?:[.,]\d+)?)/);
  if (!m) return null;
  const v = parseFloat(m[1].replace(',', '.'));
  return Number.isFinite(v) ? v : null;
}

// Status-Normalisierung — single source of truth (Spec §3). Mappt den rohen
// Tocco-Status-Text auf genau eine von 5 Kategorien. Alles Unbekannte landet in
// 'unbekannt' (gilt als nicht-pushend; wird NIE still zu "abwesend" gezwungen).
//
// Tolerant: trimmt, ist case-insensitive und matched per Schlüsselwort-Reihenfolge
// (spezifisch vor generisch — "nicht teilgenommen unentschuldigt" muss vor dem
// blossen "teilgenommen"-Match greifen).
function normalizeAbsenzStatus(raw) {
  const t = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!t) return 'unbekannt';
  const nichtTeilgenommen = /nicht\s+teilgenommen/.test(t);
  if (nichtTeilgenommen) {
    if (/unentschuldigt/.test(t)) return 'abwesend_unentschuldigt';
    if (/entschuldigt/.test(t)) return 'abwesend_entschuldigt';
    return 'unbekannt';
  }
  if (/teilgenommen/.test(t)) return 'teilgenommen';
  if (/offen/.test(t)) return 'offen';
  return 'unbekannt';
}

// Echte Abwesenheit (entschuldigt ODER unentschuldigt). 'offen'/'teilgenommen'/
// 'unbekannt' sind KEINE Abwesenheit. Treibt die Push-Diff-Logik in
// saveLektionen (Spec §3/§9).
function isAbwesend(cat) {
  return cat === 'abwesend_entschuldigt' || cat === 'abwesend_unentschuldigt';
}

module.exports = {
  parseFach,
  parseKuerzel,
  parseNote,
  parseDatum,
  parseZeit,
  round1,
  classifyPruefung,
  parseGewichtPct,
  parsePosNum,
  normalizeAbsenzStatus,
  isAbwesend
};
