/* ============================================================
   Absenzen — reine Status- + Anwesenheits-Band-Logik.

   Single source of truth für die normalisierte Status-Kategorie → Pill
   (Wort + Ton) und für das Anwesenheits-Band (analog gradeClass bei Noten).
   Reine, seiteneffektfreie Funktionen, damit die Logik unabhängig vom
   Svelte-Compiler test- und im Mobile (web/mobile/) spiegelbar ist.

   Status-Kategorien (normalisiert, §3 der Spec — fix):
     teilgenommen · offen · abwesend_entschuldigt · abwesend_unentschuldigt
   Alles andere (inkl. 'unbekannt') fällt auf den neutralen Ton zurück.

   Pill-Zuordnung (§10 der Spec — fix):
     teilgenommen            → has      (gut/grün)
     offen                   → neutral  (gedämpft)
     abwesend_entschuldigt   → warning  (orange)
     abwesend_unentschuldigt → danger   (rot)

   Spezifikation + Tests: test/unit/absenzen.helpers.test.mjs.
   ============================================================ */

/**
 * @typedef {'teilgenommen'|'offen'|'abwesend_entschuldigt'|'abwesend_unentschuldigt'|'unbekannt'|(string & {})} AbsenzStatusCat
 */

/**
 * @typedef {Object} StatusLabel
 * @property {string} text - Anzeige-Wort für die Pill.
 * @property {'has'|'neutral'|'warning'|'danger'} tone - Pill-Ton (Farbe + Form).
 */

/**
 * Normalisierte Status-Kategorie → Pill-Label (Wort + Ton).
 * Unbekannte/leere Werte fallen bewusst auf den neutralen Ton zurück —
 * nie still zu „abwesend“ zwingen (vgl. §3 normalizeAbsenzStatus).
 *
 * @param {AbsenzStatusCat | null | undefined} cat
 * @returns {StatusLabel}
 */
export function statusLabel(cat) {
  switch (cat) {
    case 'teilgenommen':
      return { text: 'Teilgenommen', tone: 'has' };
    case 'abwesend_entschuldigt':
      return { text: 'Entschuldigt', tone: 'warning' };
    case 'abwesend_unentschuldigt':
      return { text: 'Unentschuldigt', tone: 'danger' };
    case 'offen':
      return { text: 'Offen', tone: 'neutral' };
    default:
      // 'unbekannt' und alles Unerwartete → neutral, nie als Absenz werten.
      return { text: 'Offen', tone: 'neutral' };
  }
}

/**
 * Farb-Band für die Ist-Anwesenheit in % relativ zur Minimal-Anforderung.
 * Analog `gradeClass` bei Noten: liefert eine CSS-Klasse, keine Hex-Farbe.
 *
 *   - a-good   : klar über dem Minimum (≥ min + 5pp) oder ≥ 100%
 *   - a-ok     : über/auf dem Minimum
 *   - a-fail   : unter dem Minimum
 *   - a-none   : kein verwertbarer Wert
 *
 * Ohne Minimal-Wert (null) wird ein fixer Schwellenwert (90%) als Fallback
 * verwendet, damit die Anzeige nie farblos bleibt.
 *
 * @param {number | null | undefined} ist - Ist-Anwesenheit in % (0–100)
 * @param {number | null | undefined} min - Minimal-Anwesenheit in % (nullable)
 * @returns {'a-good'|'a-ok'|'a-fail'|'a-none'}
 */
export function attendanceClass(ist, min) {
  if (ist == null) return 'a-none';
  const i = Number(ist);
  if (!Number.isFinite(i)) return 'a-none';
  // Fallback-Minimum (90%) wenn die Spalte leer ist — WISS-Default.
  const FALLBACK_MIN = 90;
  const GOOD_MARGIN = 5;
  const m = min != null && Number.isFinite(Number(min)) ? Number(min) : FALLBACK_MIN;
  if (i < m) return 'a-fail';
  if (i >= 100 || i >= m + GOOD_MARGIN) return 'a-good';
  return 'a-ok';
}

/**
 * Ist ein Modul unter der Minimal-Anwesenheit? Reine Schwellen-Prüfung,
 * von Filter („Unter Minimum“-Chip) + Stats-Kachel geteilt, damit beide
 * exakt dieselbe Grenze verwenden.
 *
 * @param {number | null | undefined} ist
 * @param {number | null | undefined} min
 * @returns {boolean}
 */
export function isUnterMinimum(ist, min) {
  if (ist == null || min == null) return false;
  const i = Number(ist);
  const m = Number(min);
  if (!Number.isFinite(i) || !Number.isFinite(m)) return false;
  return i < m;
}
