// Tests für den QV-Zielnoten-Rechner (Goal-Seek).
//
// Kern-Logik: gegeben eine Ziel-QV-Gesamtnote + die (0.1-gerundeten) BK- und
// M+E-Schnitte → die kleinste IPA auf dem 0.1-Raster (1.0–6.0) finden, die
// durch die ECHTE Rundungs-Pipeline (IPA→0.1, Gesamt→0.1) das Ziel erreicht.
//
// Wird vom Desktop direkt importiert (web-svelte) und vom Legacy-Mobile
// (web/mobile/views/stats.js) verbatim gespiegelt — diese Datei ist die
// ausführbare Spezifikation für beide Surfaces.
//
// ESM (.mjs), weil das Modul ESM ist. Lauf: node --test test/unit/qvGoalseek.test.mjs

import { test } from 'node:test';
import assert from 'node:assert';
import { round1, qvGesamt, benoetigteIpa } from '../../web-svelte/src/lib/utils/qv-goalseek.js';

test('round1 rundet kaufmännisch auf 0.1', () => {
  assert.strictEqual(round1(4.44), 4.4);
  assert.strictEqual(round1(4.45), 4.5); // half-up
  assert.strictEqual(round1(3.95), 4.0);
});

test('qvGesamt entspricht der Verordnungs-Formel (IPA·0.4 + BK·0.3 + ME·0.1)/0.8', () => {
  // IPA 4.0, BK 4.0, ME 4.0 → (1.6+1.2+0.4)/0.8 = 3.2/0.8 = 4.0
  assert.strictEqual(qvGesamt(4.0, 4.0, 4.0), 4.0);
  // IPA 6.0, BK 1.0, ME 1.0 → (2.4+0.3+0.1)/0.8 = 2.8/0.8 = 3.5
  assert.strictEqual(qvGesamt(6.0, 1.0, 1.0), 3.5);
});

test('reachable: BK 4.0 · ME 4.0 · Ziel 4.0 → benötigt IPA 4.0 (float-treue Pipeline)', () => {
  // IPA 3.9 → (1.56+1.2+0.4)/0.8 = 3.16/0.8 = 3.9499… → round1 = 3.9 < 4.0 ✗
  //   (3.95 ist als Double 3.9499999…, rundet also runter — exakt das Verhalten
  //    des bestehenden QV-Rechners, der dieselbe Math.round(x*10)/10-Pipeline nutzt)
  // IPA 4.0 → 3.2/0.8 = 4.0 ✓  → kleinste passende IPA = 4.0
  const r = benoetigteIpa(4.0, 4.0, 4.0);
  assert.strictEqual(r.status, 'reachable');
  assert.strictEqual(r.requiredIpa, 4.0);
  assert.strictEqual(r.gesamt, 4.0);
});

test('reachable: Rundungsgrenze BK 4.0 · ME 4.0 · Ziel 4.5 → IPA 4.9 (nicht 5.0)', () => {
  // IPA 4.9 → 3.56/0.8 = 4.45 → round 4.5 ✓ ; IPA 4.8 → 3.52/0.8 = 4.4 ✗
  const r = benoetigteIpa(4.5, 4.0, 4.0);
  assert.strictEqual(r.status, 'reachable');
  assert.strictEqual(r.requiredIpa, 4.9);
});

test('secured: hohe Schnitte, niedriges Ziel → schon mit IPA 1.0 erreicht', () => {
  // BK 6.0 · ME 6.0, IPA 1.0 → (0.4+1.8+0.6)/0.8 = 2.8/0.8 = 3.5 ≥ 3.0
  const r = benoetigteIpa(3.0, 6.0, 6.0);
  assert.strictEqual(r.status, 'secured');
  assert.strictEqual(r.requiredIpa, 1.0);
});

test('impossible: selbst IPA 6.0 reicht nicht', () => {
  // BK 1.0 · ME 1.0 · Ziel 6.0 → max erreichbar 3.5
  const r = benoetigteIpa(6.0, 1.0, 1.0);
  assert.strictEqual(r.status, 'impossible');
  assert.strictEqual(r.requiredIpa, null);
  assert.strictEqual(r.gesamt, 3.5);
});

test('unknown: fehlende Schnitte oder ungültiges Ziel', () => {
  assert.strictEqual(benoetigteIpa(4.0, null, 4.0).status, 'unknown');
  assert.strictEqual(benoetigteIpa(4.0, 4.0, null).status, 'unknown');
  assert.strictEqual(benoetigteIpa(null, 4.0, 4.0).status, 'unknown');
  assert.strictEqual(benoetigteIpa(NaN, 4.0, 4.0).status, 'unknown');
});

test('Goal-Seek ist konsistent mit qvGesamt (Forward-Check für reachable)', () => {
  for (const ziel of [4.0, 4.5, 5.0, 5.5]) {
    for (const bk of [4.0, 4.7, 5.3]) {
      for (const me of [4.0, 5.0]) {
        const r = benoetigteIpa(ziel, bk, me);
        if (r.status === 'reachable' || r.status === 'secured') {
          // die zurückgegebene IPA muss das Ziel wirklich erreichen
          assert.ok(qvGesamt(r.requiredIpa, bk, me) >= ziel,
            `IPA ${r.requiredIpa} erreicht Ziel ${ziel} nicht (BK ${bk}, ME ${me})`);
          // und eine Stufe darunter darf es NICHT erreichen (Minimalität),
          // ausser bei secured (Untergrenze 1.0).
          if (r.status === 'reachable') {
            assert.ok(qvGesamt(round1(r.requiredIpa - 0.1), bk, me) < ziel,
              `IPA ${r.requiredIpa} ist nicht minimal (BK ${bk}, ME ${me}, Ziel ${ziel})`);
          }
        }
      }
    }
  }
});
