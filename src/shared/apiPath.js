'use strict';

// =============================================================
// Pfad-Prädikate für Auth-Gate und Rate-Limiter
// =============================================================
//
// WARUM DIESES MODUL EXISTIERT
//
// Express-Router matchen per Default case-INSENSITIV (`caseSensitive: false`).
// Jedes `router.get('/api/noten')` in src/routes/* wird also zu einer RegExp
// kompiliert, die auch `/API/noten`, `/Api/Noten` usw. matcht.
//
// Die Auth-Middleware und die Auth-Failure-Limiter haben ihren Geltungsbereich
// dagegen früher byte-exakt mit `req.path.startsWith('/api/')` bestimmt. Beide
// Seiten waren damit nicht deckungsgleich:
//
//   GET /API/noten  → Auth-Gate: kein '/api/'-Prefix → next() ohne Token-Check
//                   → Router:    matcht case-insensitiv → Handler läuft
//                   ⇒ vollständiger Auth-Bypass für JEDE /api/*-Route.
//
// Dieselbe Lücke betraf die Brute-Force-Limiter: ein Angreifer, der Tokens
// gegen `/API/settings` rät, wurde nie gezählt und nie gesperrt.
//
// Fix: Auth-Gate und Limiter vergleichen normalisiert (lowercase). Damit ist
// ihr Geltungsbereich eine OBERMENGE dessen, was die Router matchen — es kann
// keinen Pfad mehr geben, der eine Route trifft, aber am Gate vorbeiläuft.
// Ein Prädikat als Obermenge zu bauen ist bewusst gewählt: es bleibt korrekt,
// falls jemand später einzelne Router doch case-sensitiv macht.
//
// Hinweis zu Percent-Encoding: `req.path` ist der rohe (nicht dekodierte)
// Pfad, und Express matcht seine Layer-RegExps ebenfalls gegen den rohen Pfad.
// `/%61pi/noten` trifft also weder das Gate noch eine Route — beide Seiten
// bleiben konsistent, ohne dass hier dekodiert werden muss.

const API_PREFIX = '/api/';
const EVENTS_PATH = '/api/events';

function _norm(p) {
  return typeof p === 'string' ? p.toLowerCase() : '';
}

// True für alles, was ein Express-Router als /api/*-Route matchen könnte.
function isApiPath(p) {
  return _norm(p).startsWith(API_PREFIX);
}

// True für den SSE-Stream. Eigene Funktion statt Vergleich am Call-Site,
// damit die Normalisierung nicht an einer Stelle vergessen wird.
function isEventsPath(p) {
  return _norm(p) === EVENTS_PATH;
}

module.exports = { isApiPath, isEventsPath, API_PREFIX, EVENTS_PATH };
