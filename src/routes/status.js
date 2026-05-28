'use strict';

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const semver = require('semver');
const { marked } = require('marked');
const sanitizeHtml = require('sanitize-html');

// marked-Config: GFM (Tables, Autolinks, Strikethrough), Line-Breaks
// statt zwei-Spaces-newlines (= GitHub-Verhalten). Header-IDs aus damit
// keine kollidierenden DOM-Ids in unserer App entstehen.
marked.setOptions({ gfm: true, breaks: true });

// ---------- Release-Body HTML-Sanitizer ----------
// GitHub-Release-Bodies sind User-controlled (Repo-Maintainer kann beliebige
// Markdown reinschreiben). `marked.parse()` rendert dabei auch raw-HTML
// (Markdown-Spec erlaubt das), inkl. `<script>`, `<iframe>`, on*-Handler,
// `javascript:`-URLs. Da wir den Output via `bodyHtml` in den Mobile/Svelte-
// Update-Modal injizieren, ist das ein second-order-XSS-Vektor (Maintainer-
// Compromise oder eigene Releases mit injected Code).
//
// Sanitized wird mit `sanitize-html` — einem echten HTML-Parser. Der frühere
// Regex-Ansatz war prinzipiell umgehbar (z.B. `<scr<script>ipt>` wird nach
// EINEM Replace zu `<script>`, on*-Handler über Newlines/Verschachtelung) —
// genau das hat CodeQL als `js/incomplete-multi-character-sanitization`
// (HIGH) geflaggt. Die Allowlist deckt exakt das ab, was `marked` aus
// Markdown erzeugt; alles andere (unbekannte Tags, Attribute, URL-Schemes)
// wird verworfen. `<script>/<style>/<iframe>` + alle on*-Handler entfernt
// sanitize-html per Default.
const RELEASE_SANITIZE_OPTIONS = {
  allowedTags: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'br', 'hr', 'blockquote', 'pre', 'code',
    'ul', 'ol', 'li',
    'strong', 'em', 'b', 'i', 'del', 's',
    'a', 'span',
    'table', 'thead', 'tbody', 'tr', 'th', 'td'
  ],
  allowedAttributes: {
    a: ['href', 'title'],
    th: ['align'],
    td: ['align']
  },
  // Nur sichere URL-Schemes — kein javascript:/data:
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesAppliedToAttributes: ['href'],
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard'
};

function sanitizeReleaseHtml(html) {
  if (!html) return '';
  return sanitizeHtml(html, RELEASE_SANITIZE_OPTIONS);
}

// SW-Code-Version (tm-NN) einmal beim Boot aus web/mobile/sw.js parsen.
let CACHED_SW_VERSION = null;
function readSwVersion() {
  if (CACHED_SW_VERSION) return CACHED_SW_VERSION;
  try {
    const swPath = path.join(__dirname, '..', '..', 'web', 'mobile', 'sw.js');
    const src = fs.readFileSync(swPath, 'utf8');
    const m = src.match(/const\s+VERSION\s*=\s*['"`]([^'"`]+)['"`]/);
    CACHED_SW_VERSION = m ? m[1] : 'unknown';
  } catch (_) {
    CACHED_SW_VERSION = 'unknown';
  }
  return CACHED_SW_VERSION;
}

// ---------- Upstream-Release-Check (GitHub) ----------
//
// Pollt das GitHub-Releases-API für JoKerIsCraZy/wissen und vergleicht
// den Tag-Name gegen die installierte package.json-Version via `semver`.
//
// Server-side gecached für 1h damit nicht jeder /api/version-Call eine
// externe Request triggert (GitHub-Rate-Limit ist 60/h unauthenticated).
// Errors (Network/Rate-Limit/etc.) werden zu null aufgelöst — der Endpoint
// gibt dann updateAvailable: false zurück und der Client zeigt einfach
// nichts an.
const UPSTREAM_REPO = 'JoKerIsCraZy/wissen';
const UPSTREAM_TTL_MS = 60 * 60 * 1000;          // 1h Success-TTL
const UPSTREAM_ERROR_TTL_MS = 60 * 1000;         // 60s Error-TTL — transienter GitHub-
                                                 // Error darf nicht 1h Update-Anzeige lockout
const UPSTREAM_ERROR_LOG_THROTTLE_MS = 10 * 60 * 1000;  // max 1× pro 10min loggen
let upstreamCache = null;        // { fetchedAt, data, error? }
let _lastErrorLogAt = 0;

function _logUpstreamError(loggerInstance, message) {
  const now = Date.now();
  if (!loggerInstance || typeof loggerInstance.log !== 'function') return;
  if (now - _lastErrorLogAt < UPSTREAM_ERROR_LOG_THROTTLE_MS) return;
  _lastErrorLogAt = now;
  loggerInstance.log('⚠️  /api/version Upstream-Check fehlgeschlagen: ' + message + ' (weitere Fehler innerhalb 10min werden nicht erneut geloggt)', 'warn');
}

function fetchUpstreamRelease(loggerInstance) {
  const now = Date.now();
  if (upstreamCache) {
    const age = now - upstreamCache.fetchedAt;
    const ttl = upstreamCache.error ? UPSTREAM_ERROR_TTL_MS : UPSTREAM_TTL_MS;
    if (age < ttl) {
      return Promise.resolve(upstreamCache.data);
    }
  }
  return new Promise((resolve) => {
    const https = require('node:https');
    const req = https.request({
      hostname: 'api.github.com',
      path: '/repos/' + UPSTREAM_REPO + '/releases/latest',
      method: 'GET',
      headers: {
        'User-Agent': 'wissen-version-check',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      timeout: 5000
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let data = null;
        let parsedOk = false;
        try {
          if (res.statusCode === 200) {
            const json = JSON.parse(body);
            if (json && json.tag_name) {
              const rawBody = typeof json.body === 'string'
                ? json.body.slice(0, 4000)  // capped — GitHub-Bodies können groß sein
                : null;
              let bodyHtml = null;
              if (rawBody) {
                try {
                  // marked.parse() Output durch lokalen Sanitizer — siehe Top-of-File-
                  // Kommentar zu sanitizeReleaseHtml für Threat-Model.
                  bodyHtml = sanitizeReleaseHtml(marked.parse(rawBody));
                } catch (_) { bodyHtml = null; }
              }
              // html_url kommt aus der GitHub-API. Svelte escaped href NICHT
              // gegen javascript:-Schemes — daher serverseitig auf http(s)
              // validieren, sonst landet eine evtl. manipulierte URL ungeprüft
              // als <a href> im Client. Fallback: kanonische Releases-URL.
              const fallbackUrl = 'https://github.com/' + UPSTREAM_REPO + '/releases/latest';
              const candidateUrl = typeof json.html_url === 'string' ? json.html_url : '';
              const safeUrl = /^https?:\/\//i.test(candidateUrl) ? candidateUrl : fallbackUrl;
              data = {
                tag: json.tag_name,
                name: json.name || json.tag_name,
                url: safeUrl,
                publishedAt: json.published_at || null,
                body: rawBody,        // Roh-Markdown als Fallback
                bodyHtml: bodyHtml    // Marked + sanitize HTML — primary display
              };
              parsedOk = true;
            }
          }
        } catch (_) { /* JSON-Parse-Fehler → null */ }
        if (parsedOk) {
          upstreamCache = { fetchedAt: Date.now(), data, error: false };
        } else {
          // Status != 200 oder JSON-Parse-Fehler → kurze Error-TTL setzen,
          // damit der Cache nicht 1h kein-Upstream zeigt nach transient-Glitch.
          upstreamCache = { fetchedAt: Date.now(), data: null, error: true };
          // Dieser Zweig läuft nur wenn parsedOk === false (Status != 200 oder
          // JSON-Parse-Fehler) — daher fixer Suffix, kein toter Ternary.
          _logUpstreamError(loggerInstance, 'HTTP ' + res.statusCode + ' (oder Parse-Error)');
        }
        resolve(data);
      });
    });
    req.on('error', (err) => {
      upstreamCache = { fetchedAt: Date.now(), data: null, error: true };
      _logUpstreamError(loggerInstance, err && err.message ? err.message : String(err));
      resolve(null);
    });
    req.on('timeout', () => {
      try { req.destroy(); } catch (_) {}
      upstreamCache = { fetchedAt: Date.now(), data: null, error: true };
      _logUpstreamError(loggerInstance, 'timeout nach 5s');
      resolve(null);
    });
    req.end();
  });
}

module.exports = function statusRoutes(deps) {
  const router = express.Router();
  const { state, settings, sse, logger } = deps;

  // ---------- Status ----------
  router.get('/api/status', (req, res) => {
    res.json(sse.statusPayload(settings, state));
  });

  // ---------- Version ----------
  // Liefert installierte Version + SW-Code-Version + Upstream-Release-Info
  // für die "Über"-Sektion + Release-Update-Modal in Mobile/Svelte-Dashboard.
  //
  // Bewusst leichtgewichtig. Hängt hinter requireAuth — nur eingeloggte
  // User sehen es. GitHub-Upstream-Call ist server-cached (1h TTL) damit
  // das nicht zu jedem Client-Refresh durchgereicht wird.
  router.get('/api/version', async (req, res) => {
    let version = 'unknown';
    try {
      const pkg = require('../../package.json');
      version = pkg.version || 'unknown';
    } catch (_) { /* swallow */ }

    const upstream = await fetchUpstreamRelease(logger);

    // Vergleich nur wenn beide Versionen valid-semver sind. Bei Fehlern
    // gilt updateAvailable: false (lieber kein Toast als ein falscher).
    let updateAvailable = false;
    let upstreamVersion = null;
    if (upstream && upstream.tag) {
      // Tag-Format ist meistens 'v1.2.0' — semver.coerce/clean strippt das v.
      upstreamVersion = semver.valid(semver.coerce(upstream.tag));
      const localVersion = semver.valid(semver.coerce(version));
      if (upstreamVersion && localVersion) {
        updateAvailable = semver.gt(upstreamVersion, localVersion);
      }
    }

    res.json({
      version,
      swVersion: readSwVersion(),
      node: process.version,
      uptimeMs: Math.floor(process.uptime() * 1000),
      // Upstream-Block — kann null/false sein wenn GitHub nicht erreichbar
      // war oder das Repo keine Releases hat.
      upstream: upstream ? {
        tag: upstream.tag,
        version: upstreamVersion,
        name: upstream.name,
        url: upstream.url,
        publishedAt: upstream.publishedAt,
        body: upstream.body,
        bodyHtml: upstream.bodyHtml
      } : null,
      updateAvailable
    });
  });

  return router;
};
