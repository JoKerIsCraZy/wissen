/* ============================================================
   QV-Zielnoten-Rechner — Goal-Seek über das 0.1-Noten-Raster.

   Beantwortet: "Welche IPA brauche ich (mindestens), damit meine
   QV-Gesamtnote mein Ziel erreicht?" — gegeben die bereits feststehenden,
   auf 0.1 gerundeten Schnitte BK (Informatikkompetenzen) und ME (Mathe +
   Englisch).

   Warum iterieren statt Formel-Umkehrung: die echte QV-Pipeline rundet
   ZWEIMAL (IPA → 0.1, dann Gesamt → 0.1). Eine algebraische Umkehrung
   (ziel·0.8 − …)/0.4 trifft die gerundete Stufe nicht zuverlässig — sie
   liefert z.B. 4.0 wo die echte Pipeline schon mit 3.9 das Ziel erreicht.
   Das 51-Schritt-Raster (1.0–6.0) ist exakt deckungsgleich mit der
   Forward-Berechnung und damit garantiert konsistent.

   Reine, seiteneffektfreie Funktionen — vom Desktop (web-svelte) direkt
   importiert und im Legacy-Mobile (web/mobile/views/stats.js) verbatim
   gespiegelt. Spezifikation + Tests: test/unit/qvGoalseek.test.mjs.
   ============================================================ */

/**
 * Kaufmännische Rundung auf 0.1 (CH-Konvention, half-up).
 * @param {number} n
 * @returns {number}
 */
export function round1(n) {
  return Math.round(n * 10) / 10;
}

/**
 * QV-Gesamtnote nach Verordnung (BiVo, ABU dispensiert):
 *   Gesamt = (IPA·0.4 + BK·0.3 + ME·0.1) / 0.8
 * Ergebnis auf 0.1 gerundet.
 * @param {number} ipa - IPA-Note (sollte bereits auf 0.1 liegen)
 * @param {number} bkRounded - BK-Schnitt, auf 0.1 gerundet
 * @param {number} meRounded - ME-Schnitt, auf 0.1 gerundet
 * @returns {number}
 */
export function qvGesamt(ipa, bkRounded, meRounded) {
  return round1((ipa * 0.4 + bkRounded * 0.3 + meRounded * 0.1) / 0.8);
}

/**
 * @typedef {Object} GoalSeekResult
 * @property {'secured'|'reachable'|'impossible'|'unknown'} status
 *   - `secured`: Ziel schon mit der kleinstmöglichen IPA (1.0) gehalten.
 *   - `reachable`: kleinste passende IPA in `requiredIpa`.
 *   - `impossible`: selbst IPA 6.0 erreicht das Ziel nicht.
 *   - `unknown`: Schnitte fehlen oder Ziel ungültig.
 * @property {number|null} requiredIpa - kleinste IPA (0.1), die das Ziel hält.
 * @property {number|null} gesamt - resultierende Gesamtnote bei `requiredIpa`
 *   (bzw. bei IPA 6.0 für `impossible`).
 */

/**
 * Kleinste IPA auf dem 0.1-Raster (1.0–6.0), für die die QV-Gesamtnote
 * `>= ziel` wird. Berücksichtigt die echte Doppelrundung der Pipeline.
 *
 * Hinweis: Diese Funktion zielt rein auf die Gesamtnote. Die separate
 * Bestehensregel (IPA ≥ 4.0) bleibt der UI-Schicht überlassen, damit
 * "Ziel erreichen" und "bestehen" nicht vermischt werden.
 *
 * @param {number|null} ziel - Ziel-QV-Gesamtnote (z.B. 4.0)
 * @param {number|null} bkRounded - BK-Schnitt (0.1), oder null wenn unbekannt
 * @param {number|null} meRounded - ME-Schnitt (0.1), oder null wenn unbekannt
 * @returns {GoalSeekResult}
 */
export function benoetigteIpa(ziel, bkRounded, meRounded) {
  if (bkRounded == null || meRounded == null || ziel == null || !Number.isFinite(ziel)) {
    return { status: 'unknown', requiredIpa: null, gesamt: null };
  }
  // i = IPA·10, damit wir auf einem exakten Integer-Raster iterieren
  // (vermeidet 0.1-Float-Akkumulation in der Schleife).
  for (let i = 10; i <= 60; i += 1) {
    const ipa = i / 10;
    const ges = qvGesamt(ipa, bkRounded, meRounded);
    if (ges >= ziel) {
      return {
        status: i === 10 ? 'secured' : 'reachable',
        requiredIpa: round1(ipa),
        gesamt: ges,
      };
    }
  }
  return { status: 'impossible', requiredIpa: null, gesamt: qvGesamt(6.0, bkRounded, meRounded) };
}
