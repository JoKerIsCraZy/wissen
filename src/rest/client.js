'use strict';

/* global window, location */
// window/location werden ausschliesslich INNERHALB von page.evaluate()-Callbacks
// referenziert (restGet/getDwrSsid/dwrGetDetail) — dieser Code wird IM BROWSER
// ausgeführt, nicht in Node. Der eslint-global-Hinweis verhindert no-undef-
// Fehlalarme (gleiches Muster wie src/scraper.js).

/**
 * nice2 REST v2 + DWR Client — die Datenbeschaffungs-Primitiven für den
 * REST-Producer (Ersatz für das DOM-Scraping). Alle Calls laufen IM Browser
 * (page.evaluate, same-origin auf der eingeloggten tocco.ch-Seite), damit die
 * Session-Cookies automatisch greifen — exakt wie der bewährte api()-Wrapper
 * im Scraper, nur generalisiert.
 *
 * Live verifiziert 2026-06-17 gegen wiss.tocco.ch. Siehe MIGRATION-REST-V2.md.
 */

const REST2 = '/nice2/rest/entities/2.0';
const REST_MODEL = '/nice2/rest/entities';
const DEFAULT_LIMIT = 1000;

const REST_HEADERS = {
  Accept: 'application/json',
  'x-business-unit': 'wiss',
  'x-client': 'frontend',
  'x-language': 'de',
  'x-timezone': 'Europe/Berlin'
};

/**
 * Roh-GET im Browser-Kontext.
 * @param {import('playwright').Page} page
 * @param {string} requestPath  z.B. '/nice2/rest/entities/2.0/Input_data?...'
 * @returns {Promise<{ok:boolean,status:number,json:any,text:string}>}
 */
async function restGet(page, requestPath) {
  return page.evaluate(async ({ url, headers }) => {
    try {
      const res = await fetch(url, { method: 'GET', credentials: 'include', headers });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (_) { /* kein JSON */ }
      return { ok: res.ok, status: res.status, json, text };
    } catch (e) {
      return { ok: false, status: 0, json: null, text: String(e) };
    }
  }, { url: requestPath, headers: REST_HEADERS });
}

/**
 * Holt die userEntityPk (für _where=relUser.pk-Scoping von Input_data).
 * @param {import('playwright').Page} page
 * @returns {Promise<{pk:(string|null),username:(string|null),businessUnitId:(string|null)}>}
 */
async function getUserContext(page) {
  const res = await restGet(page, '/nice2/username');
  const j = res.json || {};
  return {
    pk: j.userEntityPk || j.principalEntityPk || null,
    username: j.username || null,
    businessUnitId: j.businessUnitId || null
  };
}

/**
 * Baut eine REST-v2-Daten-URL.
 * @param {string} entity
 * @param {{paths?:string, where?:string, limit?:number, offset?:number, sort?:string}} opts
 */
function buildDataUrl(entity, opts = {}) {
  const params = new URLSearchParams();
  params.set('_limit', String(opts.limit != null ? opts.limit : DEFAULT_LIMIT));
  params.set('_offset', String(opts.offset != null ? opts.offset : 0));
  if (opts.where) params.set('_where', opts.where);
  if (opts.paths) params.set('_paths', opts.paths);
  if (opts.sort) params.set('_sort', opts.sort);
  return REST2 + '/' + entity + '?' + params.toString();
}

/**
 * Holt das data[]-Array einer Entity. Wirft bei HTTP-Fehler (außer 400-mit-
 * Fallback). Gibt zusätzlich Meta für Logging zurück.
 * @returns {Promise<{data:any[], usedFallback:boolean, status:number, whereUsed:(string|null), pathsUsed:string}>}
 */
async function fetchEntity(page, entity, opts = {}) {
  const primary = await restGet(page, buildDataUrl(entity, opts));
  if (primary.ok && primary.json) {
    return {
      data: primary.json.data || [],
      usedFallback: false,
      status: primary.status,
      whereUsed: opts.where || null,
      pathsUsed: opts.paths || '(default)'
    };
  }
  // 400 deutet meist auf einen ungültigen _path → ohne _paths erneut (Default-
  // Darstellung). _where bleibt erhalten.
  if (primary.status === 400 && opts.paths) {
    const fb = await restGet(page, buildDataUrl(entity, { ...opts, paths: null }));
    if (fb.ok && fb.json) {
      return {
        data: fb.json.data || [],
        usedFallback: true,
        status: fb.status,
        whereUsed: opts.where || null,
        pathsUsed: '(default — _paths-Fallback nach HTTP 400)'
      };
    }
  }
  const msg = (primary.json && primary.json.message) || primary.text.slice(0, 200);
  throw new Error('REST ' + entity + ' HTTP ' + primary.status + ': ' + msg);
}

/**
 * Holt das Entity-Model (Schema). Best-effort.
 */
async function fetchModel(page, entity) {
  const res = await restGet(page, REST_MODEL + '/' + entity + '/model');
  return res.ok && res.json ? res.json : null;
}

// ---------------------------------------------------------------------------
// Nested-Value-Extraktor für die nice2-REST-v2-Darstellung.
// Felder liegen als row.paths.<feld> = { type, value }; Relationen verschachteln
// über value.paths (entity) bzw. value[0].paths (entity-list). pick() liefert
// den Wert des letzten dot-path-Segments (i.d.R. ein Skalar).
// ---------------------------------------------------------------------------

/**
 * @param {any} row  REST-v2 data[]-Element ({ key, paths:{...} })
 * @param {string} dotPath  z.B. 'relInput.relInput_node.short'
 * @returns {any}
 */
function pick(row, dotPath) {
  if (!row) return undefined;
  let container = row.paths || row;
  const parts = dotPath.split('.');
  for (let i = 0; i < parts.length; i++) {
    if (container == null) return undefined;
    const node = container[parts[i]];
    if (node === undefined) return undefined;
    let val = (node && typeof node === 'object' && 'value' in node) ? node.value : node;
    if (i === parts.length - 1) return val;
    if (Array.isArray(val)) val = val[0];
    container = val && val.paths ? val.paths : val;
  }
  return undefined;
}

/**
 * Macht einen REST-Wert menschenlesbar/string-fähig. Defensiv, nie werfend.
 */
function display(val) {
  if (val == null) return '';
  if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
    return String(val);
  }
  if (Array.isArray(val)) return val.map(display).filter(Boolean).join(', ');
  if (typeof val === 'object') {
    if ('value' in val && val.value != null) return display(val.value);
    if ('label' in val && val.label != null) return display(val.label);
    if ('display' in val && val.display != null) return display(val.display);
    if ('key' in val && val.key != null) return display(val.key);
  }
  return '';
}

/** Wie pick(), aber liefert direkt den display()-String. */
function pickText(row, dotPath) {
  return display(pick(row, dotPath));
}

/** Wie pick(), aber liefert eine Zahl oder null. */
function pickNum(row, dotPath) {
  const v = pick(row, dotPath);
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// DWR getDetailData (Prüfungsgewichte ZP/LB) — HTTP-RPC, KEIN DOM-Scraping.
// Braucht die geladene DWR-Engine für die scriptSessionId (CSRF). Die ID ist
// die PROPERTY window.dwr.engine._scriptSessionId (NICHT _getScriptSessionId()).
// ---------------------------------------------------------------------------

/**
 * Wartet auf die DWR-Engine und liefert die scriptSessionId (oder null).
 * Setzt voraus, dass die Page auf einer nice2-Seite ist, die DWR lädt
 * (z.B. die Noten-Seite).
 */
async function getDwrSsid(page) {
  return page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 40; i++) {
      const e = window.dwr && window.dwr.engine;
      if (e && typeof e._scriptSessionId === 'string' && e._scriptSessionId.length > 10) return e._scriptSessionId;
      if (e && typeof e._getScriptSessionId === 'function') {
        try { const s = e._getScriptSessionId(); if (s) return s; } catch (_) { /* weiter */ }
      }
      await sleep(500);
    }
    return null;
  }).catch(() => null);
}

/**
 * Feuert getDetailData(gradePk) und gibt den rohen DWR-Wire-Text zurück.
 */
async function dwrGetDetail(page, ssid, gradePk) {
  return page.evaluate(async ({ ssid, pk }) => {
    const pagePath = encodeURIComponent(location.pathname);
    const body = [
      'callCount=1', 'c0-scriptName=nice2_optional_qualification_UserGradesActionService',
      'c0-methodName=getDetailData', 'c0-id=0', 'c0-param0=array:[]', 'c0-param1=string:' + pk,
      'batchId=1', 'instanceId=0', 'page=' + pagePath, 'scriptSessionId=' + ssid, ''
    ].join('\n');
    const res = await fetch('/nice2/dwr/call/plaincall/nice2_optional_qualification_UserGradesActionService.getDetailData.dwr', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'text/plain', 'x-business-unit': 'wiss', 'x-client': 'frontend', 'x-language': 'de', 'x-timezone': 'Europe/Berlin' },
      body
    });
    return { status: res.status, text: await res.text() };
  }, { ssid, pk: gradePk }).catch((e) => ({ status: 0, text: String(e) }));
}

function decodeU(s) {
  if (s == null) return s;
  return String(s)
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\\//g, '/');
}

function parseProps(s) {
  const o = {};
  for (const part of s.split(',')) {
    const i = part.indexOf(':'); if (i < 0) continue;
    const k = part.slice(0, i).replace(/"/g, '').trim();
    const v = part.slice(i + 1).trim();
    if (v === 'null') o[k] = null;
    else if (v.startsWith('"')) o[k] = decodeU(v.slice(1, -1));
    else if (/^-?[\d.]+$/.test(v)) o[k] = Number(v);
    else o[k] = decodeU(v);
  }
  return o;
}

/**
 * Parst die getDetailData-Wire-Antwort in saubere JS-Objekte.
 * @returns {{grade:(number|null), num:(number|null), node:string, events:string,
 *            exams:Array<{label,nr,weight,average,pk,pointsMax}>,
 *            ratings:Array<{value,defaultDisplay,pk}>}}
 */
function parseDetail(text) {
  const grade = (text.match(/"definate_grade":"?([\d.]+)"?/) || [])[1] || null;
  const num = (text.match(/"num_ratings":(\d+)/) || [])[1] || null;
  const node = decodeU((text.match(/input_node:"([^"]*)"/) || [])[1] || '');
  const events = decodeU((text.match(/events:"([^"]*)"/) || [])[1] || '');
  const exams = [...text.matchAll(/ExamRecord",\{([^}]*)\}/g)].map((m) => parseProps(m[1]));
  const ratings = [...text.matchAll(/RatingRecord",\{([^}]*)\}/g)].map((m) => parseProps(m[1]));
  return {
    grade: grade ? Number(grade) : null,
    num: num ? Number(num) : null,
    node, events, exams, ratings
  };
}

/**
 * Führt eine DWR-SearchService.search-Suche aus und deserialisiert die Antwort
 * über die Page-eigene DWR-Engine (handleCallback-Intercept) — so erhalten wir
 * exakt die gerenderten Zellen-Werte inkl. Display-Felder wie dem Dozenten, den
 * REST per ACL NICHT herausgibt (Lecturer_booking.relUser ist für Studierende
 * null). HTTP-RPC, kein DOM-Scraping. `paramLines` = die c0-*-Such-Parameter
 * (callCount..c0-param1); batchId/page/scriptSessionId hängt diese Funktion
 * in-browser an (echte Engine-ssid + aktueller Pfad — funktioniert von jeder
 * nice2-Seite, deren Engine geladen ist).
 * @returns {Promise<{rows:Array<Object>}|{error:string}>}
 */
async function dwrSearch(page, paramLines) {
  return page.evaluate(async (lines) => {
    const e = window.dwr && window.dwr.engine;
    const ssid = e && e._scriptSessionId;
    if (!ssid) return { error: 'keine scriptSessionId (DWR-Engine nicht geladen)' };
    const body = lines.concat([
      'batchId=1', 'instanceId=0',
      'page=' + encodeURIComponent(location.pathname),
      'scriptSessionId=' + ssid, ''
    ]).join('\n');
    const res = await fetch('/nice2/dwr/call/plaincall/nice2_netui_SearchService.search.dwr', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'text/plain', 'x-business-unit': 'wiss', 'x-client': 'frontend', 'x-language': 'de', 'x-timezone': 'Europe/Berlin' },
      body
    });
    const text = await res.text();
    if (!res.ok) return { error: 'HTTP ' + res.status };
    const dwr = window.dwr._[0];
    const remote = dwr.engine.remote;
    const orig = remote.handleCallback;
    let cap = null;
    remote.handleCallback = function (_b, _c, result) { cap = result; };
    try {
      const marker = '//#DWR-START#';
      const idx = text.indexOf(marker);
      (0, eval)(idx >= 0 ? text.slice(idx + marker.length) : text);
    } catch (err) {
      remote.handleCallback = orig;
      return { error: 'parse: ' + String(err) };
    }
    remote.handleCallback = orig;
    const rows = (cap && cap.returnValue && cap.returnValue.rows) || [];
    return {
      rows: rows.map((r) => {
        const o = {};
        for (const k in r.cells) {
          if (!k) continue;
          const cv = r.cells[k] && r.cells[k].cellValues;
          o[k] = (cv && cv.length) ? cv.map((x) => x && x.value).filter((v) => v != null && v !== '').join(' ') : '';
        }
        return o;
      })
    };
  }, paramLines);
}

module.exports = {
  REST2,
  REST_HEADERS,
  restGet,
  getUserContext,
  buildDataUrl,
  fetchEntity,
  fetchModel,
  pick,
  display,
  pickText,
  pickNum,
  getDwrSsid,
  dwrGetDetail,
  dwrSearch,
  parseDetail
};
