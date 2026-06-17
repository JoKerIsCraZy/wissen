/**
 * Tocco nice2 REST v2 — Standalone-Test-Spike (Export-Variante).
 *
 * Zweck: beweisen, dass Noten / Stundenplan / Absenzen (und best-effort
 * Moduldetails) ohne DOM-Scraping und ohne DWR direkt über die nice2 REST-v2-
 * API abrufbar sind — nur ein cookie-authentifizierter `fetch`. KEINE
 * scriptSessionId, KEINE DWR-Engine, KEIN DOM nötig.
 *
 * Ablauf:
 *   1. node tocco-api-test.js   (öffnet sichtbaren Chromium)
 *   2. Du meldest dich im Browser ganz normal per WISS-Office-365-SSO an.
 *   3. Sobald die Session steht, feuert das Script die REST-Calls (via
 *      page.evaluate, same-origin auf der eingeloggten tocco.ch-Seite) und
 *      schreibt ALLES in lokale Dateien unter ./tocco-export/.
 *
 * REST v2 (live verifiziert 2026-06-17):
 *   GET /nice2/rest/entities/2.0/{Entity}        -> { data:[...], _links }
 *     Query: _limit, _offset, _paths (kommagetrennte dot-paths), _where (TQL),
 *            _sort, _search.
 *   GET /nice2/rest/entities/{Entity}/model      -> Schema (echte Feldnamen).
 *   GET /nice2/username                          -> { userEntityPk, principalEntityPk, ... }
 *
 *   Scoping (LIVE bestätigt):
 *     - Reservation/Registration werden via ACL automatisch auf den User gescoped.
 *     - Input_data (Noten) NICHT -> braucht explizit _where=relUser.pk==<userEntityPk>.
 *     - Zeilen-Shape: row.paths.<feld> = { type, value }; Relationen verschachteln
 *       über value.paths (entity) bzw. value[0].paths (entity-list).
 *
 * Header (alle Calls): Accept: application/json, x-business-unit: wiss,
 *   x-client: frontend, x-language: de, x-timezone: Europe/Berlin,
 *   credentials: 'include'.
 *
 * ACHTUNG: Die Exporte enthalten echte Noten/Namen. ./tocco-export/ ist via
 * .gitignore vom Repo ausgeschlossen — niemals einchecken.
 *
 * Voraussetzung: Playwright-Chromium installiert
 *   npm install && npx playwright install chromium
 *
 * Optional: Anzahl der Moduldetail-Versuche als Argument (Default 3, "all"):
 *   node tocco-api-test.js 5
 *   node tocco-api-test.js all
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const BASE = process.env.TOCCO_BASE || 'https://wiss.tocco.ch';
const NOTEN_URL = BASE + '/extranet/Meine-Bildung/Noten-f%C3%BCr-Studierende';
const LOGIN_TIMEOUT_MS = 6 * 60 * 1000; // 6 Min Zeit zum Anmelden
const EXPORT_DIR = path.join(process.cwd(), 'tocco-export');
const REST2 = '/nice2/rest/entities/2.0';
const REST_MODEL = '/nice2/rest/entities';
const PAGE_LIMIT = 1000;

// Default: ALLE Module mit Detail abrufen. Optional Zahl als Limit:
//   node tocco-api-test.js 5   -> nur 5 Module
const detailArg = process.argv[2];
const DETAIL_COUNT = (detailArg && Number.isFinite(+detailArg)) ? +detailArg : Infinity;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- REST-Header (zentral, damit überall identisch) ----------
const REST_HEADERS = {
  Accept: 'application/json',
  'x-business-unit': 'wiss',
  'x-client': 'frontend',
  'x-language': 'de',
  'x-timezone': 'Europe/Berlin'
};

// Bestätigte _paths für Noten (live verifiziert).
const NOTEN_PATHS = [
  'grade',
  'definate_grade',
  'relInput.relInput_node.short',
  'relInput.relEvent.label',
  'relInput.relInput_node.relInput_type.unique_id'
].join(',');

// Stundenplan (Reservation) — live bestätigt (1000 Zeilen mit Daten).
const STUNDENPLAN_PATHS = [
  'date_from',
  'relRoom',
  'relType_of_execution',
  'relReservation_lecturer_booking.relLecturer_booking.relUser',
  'comment',
  'relEvent.class_label',
  'relEvent.label'
].join(',');

// Absenzen (Registration) — ECHTE Entity-Felder (live bestätigt). Die alten
// DWR-Spalten expected/is/is_percent existieren als REST-Pfad NICHT.
const ABSENZEN_PATHS = [
  'relEvent.abbreviation',
  'relEvent.label',
  'lessons_total_desired',
  'lessons_total_actual',
  'presence_rate',
  'presence_rate_total',
  'relEvent.minimal_presence'
].join(',');

// ---------- In-Page-REST-Helfer ----------
// Läuft IM Browser (same-origin), damit die Session-Cookies automatisch greifen.
// Rückgabe: { ok, status, json, text }.
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

// Holt die userEntityPk (für das Noten-_where-Scoping) live aus /nice2/username.
async function getUserPk(page) {
  const res = await restGet(page, '/nice2/username');
  if (res.json && (res.json.userEntityPk || res.json.principalEntityPk)) {
    return { pk: res.json.userEntityPk || res.json.principalEntityPk, info: res.json };
  }
  return { pk: null, info: res.json || res.text };
}

// Baut eine REST-v2-Daten-URL.
function buildDataUrl(entity, paths, where) {
  const params = new URLSearchParams();
  params.set('_limit', String(PAGE_LIMIT));
  params.set('_offset', '0');
  if (where) params.set('_where', where);
  if (paths) params.set('_paths', paths);
  return REST2 + '/' + entity + '?' + params.toString();
}

// Holt das _data-Array mit _paths (+optional _where); bei 400 ("No such path …")
// automatischer Fallback auf denselben Call OHNE _paths (Default-Darstellung
// zeigt die realen Felder). Wir raten NICHTS — der Fallback liefert die reale
// Struktur. Das _where bleibt im Fallback erhalten.
async function fetchData(page, entity, paths, where) {
  const primary = await restGet(page, buildDataUrl(entity, paths, where));
  if (primary.ok && primary.json) {
    return {
      data: primary.json.data || [],
      usedFallback: false,
      pathsUsed: paths || '(default)',
      whereUsed: where || null,
      status: primary.status
    };
  }

  const looksLikePathError = primary.status === 400 && paths;
  if (looksLikePathError) {
    const fallback = await restGet(page, buildDataUrl(entity, null, where));
    if (fallback.ok && fallback.json) {
      return {
        data: fallback.json.data || [],
        usedFallback: true,
        pathsUsed: '(default — _paths-Fallback nach HTTP 400)',
        whereUsed: where || null,
        status: fallback.status,
        primaryError: 'HTTP ' + primary.status + ': ' + primary.text.slice(0, 200)
      };
    }
    return {
      data: [],
      usedFallback: true,
      pathsUsed: '(default-Fallback ebenfalls fehlgeschlagen)',
      whereUsed: where || null,
      status: fallback.status,
      error: 'primary HTTP ' + primary.status + ' / fallback HTTP ' + fallback.status,
      primaryError: primary.text.slice(0, 300),
      fallbackError: fallback.text.slice(0, 300)
    };
  }

  return {
    data: [],
    usedFallback: false,
    pathsUsed: paths || '(default)',
    whereUsed: where || null,
    status: primary.status,
    error: 'HTTP ' + primary.status,
    primaryError: primary.text.slice(0, 300)
  };
}

// Holt das Entity-Model (Schema). Best-effort — Fehler werden mitgeschrieben.
async function fetchModel(page, entity) {
  const res = await restGet(page, REST_MODEL + '/' + entity + '/model');
  if (res.ok && res.json) return { ok: true, model: res.json, status: res.status };
  return { ok: false, status: res.status, error: 'HTTP ' + res.status, head: res.text.slice(0, 300) };
}

// ---------- Datei-Helfer ----------
function writeJson(name, obj) {
  const file = path.join(EXPORT_DIR, name);
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
  return file;
}

function writeText(name, content) {
  const file = path.join(EXPORT_DIR, name);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

// Liest einen dot-path aus der nice2-REST-v2-Darstellung. Felder liegen als
// row.paths.<feld> = { type, value }; Relationen verschachteln über value.paths
// (entity) bzw. value[0].paths (entity-list). Gibt den Wert des letzten
// Segments zurück (i.d.R. ein Skalar). Defensiv, nie werfend.
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

// Macht einen REST-Wert menschenlesbar. Defensiv, nie werfend.
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

// Einfache Texttabelle aus Zeilen-Objekten (Spalten = Keys der ersten Zeile).
function toTextTable(title, rows) {
  if (!rows.length) return title + '\n' + '='.repeat(title.length) + '\n(keine Daten)\n';
  const cols = Object.keys(rows[0]);
  const widths = cols.map((c) =>
    Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  const pad = (s, w) => String(s ?? '').padEnd(w);
  const header = cols.map((c, i) => pad(c, widths[i])).join('  ');
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  const body = rows.map((r) => cols.map((c, i) => pad(r[c], widths[i])).join('  ')).join('\n');
  return title + '\n' + '='.repeat(title.length) + '\n' + header + '\n' + sep + '\n' + body + '\n';
}

// ---------- Login-Wait (unverändert übernommen — funktioniert) ----------
async function waitForLogin(page) {
  const start = Date.now();
  let lastReason = '';
  while (Date.now() - start < LOGIN_TIMEOUT_MS) {
    const r = await page.evaluate(async () => {
      try {
        if (!location.origin.includes('tocco.ch')) return { ready: false, reason: 'noch beim Microsoft-Login' };
        const res = await fetch('/nice2/username', { credentials: 'include', headers: { Accept: 'application/json' } });
        const j = await res.json();
        const ok = j && j.username && !String(j.username).includes('anonymous');
        return { ready: !!ok, username: j && j.username };
      } catch (e) {
        return { ready: false, reason: String(e).slice(0, 60) };
      }
    }).catch((e) => ({ ready: false, reason: String(e).slice(0, 60) }));

    if (r.ready) return r.username;
    if (r.reason && r.reason !== lastReason) {
      lastReason = r.reason;
      process.stdout.write('   … warte auf Login (' + r.reason + ')\n');
    }
    await sleep(2500);
  }
  throw new Error('Login-Timeout nach ' + (LOGIN_TIMEOUT_MS / 60000) + ' Min.');
}

// Schließt den Browser mit hartem 10s-Timeout (browser.close() kann hängen).
async function closeBrowserSafe(browser) {
  if (!browser) return;
  let timedOut = false;
  await Promise.race([
    browser.close().catch(() => {}),
    new Promise((resolve) => setTimeout(() => { timedOut = true; resolve(); }, 10000))
  ]);
  if (timedOut) {
    try {
      const proc = typeof browser.process === 'function' ? browser.process() : null;
      if (proc && typeof proc.kill === 'function') proc.kill('SIGKILL');
    } catch (_) { /* swallow */ }
  }
}

// ---------- Domänen-Runner ----------
// Holt Model + Daten für eine Entity, schreibt JSON+TXT, gibt Statuszeile
// zurück. Jede Domäne ist in try/catch gekapselt — ein Fehler darf die
// anderen Domänen NICHT verhindern. `pk` wird in domain.where(pk) eingesetzt.
async function runDomain(page, domain, pk) {
  const { key, entity, paths, label, tableFn } = domain;
  const where = typeof domain.where === 'function' ? domain.where(pk) : (domain.where || null);
  const status = { domain: key, entity, ok: false, count: 0 };
  try {
    // Model (best-effort).
    const model = await fetchModel(page, entity);
    const modelFile = writeJson(key + '.model.json', model.ok ? model.model : model);
    status.modelOk = model.ok;
    status.modelFile = modelFile;

    // Daten (mit _where + _paths-Fallback).
    const result = await fetchData(page, entity, paths, where);
    const rows = result.data || [];

    const jsonFile = writeJson(key + '.json', {
      entity,
      whereUsed: result.whereUsed,
      pathsUsed: result.pathsUsed,
      usedFallback: result.usedFallback,
      httpStatus: result.status,
      error: result.error || null,
      primaryError: result.primaryError || null,
      count: rows.length,
      data: rows
    });

    const tableRows = rows.map(tableFn);
    const txtFile = writeText(key + '.txt', toTextTable(label, tableRows));

    status.ok = !result.error;
    status.count = rows.length;
    status.usedFallback = result.usedFallback;
    status.pathsUsed = result.pathsUsed;
    status.whereUsed = result.whereUsed;
    status.error = result.error || null;
    status.jsonFile = jsonFile;
    status.txtFile = txtFile;

    const icon = status.ok ? '✅' : '⚠️';
    const fb = result.usedFallback ? ' (Fallback ohne _paths)' : '';
    console.log('   ' + icon + ' ' + label + ': ' + rows.length + ' Datensätze' + fb +
      (result.error ? ' — ' + result.error : '') + '  → ' + jsonFile);
  } catch (e) {
    status.ok = false;
    status.error = String((e && e.message) || e);
    try { writeJson(key + '.json', { entity, error: status.error }); } catch (_) { /* swallow */ }
    console.log('   ❌ ' + label + ': ' + status.error);
  }
  return status;
}

// ---------- Moduldetails (Prüfungen/Gewichte via DWR getDetailData) ----------
// getDetailData ist ein HTTP-RPC (KEIN DOM-Scraping). Braucht die geladene
// DWR-Engine für die scriptSessionId (CSRF-Schutz). Liefert pro Modul: Note,
// Anzahl Prüfungen, die Prüfungen (z.B. ZP/LB) mit Gewicht + Durchschnitt und
// die Einzelbewertungen. Antwort ist DWR-Wire-Format -> hier Node-seitig geparst.
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
    let v = part.slice(i + 1).trim();
    if (v === 'null') o[k] = null;
    else if (v.startsWith('"')) o[k] = decodeU(v.slice(1, -1));
    else if (/^-?[\d.]+$/.test(v)) o[k] = Number(v);
    else o[k] = decodeU(v);
  }
  return o;
}
function parseDetail(text) {
  const grade = (text.match(/"definate_grade":"?([\d.]+)"?/) || [])[1] || null;
  const num = (text.match(/"num_ratings":(\d+)/) || [])[1] || null;
  const node = decodeU((text.match(/input_node:"([^"]*)"/) || [])[1] || '');
  const exams = [...text.matchAll(/ExamRecord",\{([^}]*)\}/g)].map((m) => parseProps(m[1]));
  const ratings = [...text.matchAll(/RatingRecord",\{([^}]*)\}/g)].map((m) => parseProps(m[1]));
  return { grade: grade ? Number(grade) : null, num: num ? Number(num) : null, node, exams, ratings };
}

// Holt die scriptSessionId aus der geladenen DWR-Engine. Diese DWR-Version legt
// sie als PROPERTY window.dwr.engine._scriptSessionId ab (NICHT als Funktion
// _getScriptSessionId() — das war der ursprüngliche Bug). Mit Funktions-Fallback.
async function getDwrSsid(page) {
  return page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 40; i++) {
      const e = window.dwr && window.dwr.engine;
      if (e && typeof e._scriptSessionId === 'string' && e._scriptSessionId.length > 10) return e._scriptSessionId;
      if (e && typeof e._getScriptSessionId === 'function') { try { const s = e._getScriptSessionId(); if (s) return s; } catch (_) { /* weiter */ } }
      await sleep(500);
    }
    return null;
  }).catch(() => null);
}

async function dwrGetDetail(page, ssid, pk) {
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
  }, { ssid, pk }).catch((e) => ({ status: 0, text: String(e) }));
}

async function runModuldetails(page, ssid, notenRows) {
  const status = { domain: 'moduldetails', ok: false, count: 0 };
  try {
    if (!ssid) {
      status.error = 'DWR-Engine nicht bereit (keine scriptSessionId)';
      writeJson('moduldetails.json', { note: status.error, results: [] });
      console.log('   ⚠️  Moduldetails: ' + status.error);
      return status;
    }
    const withPk = (notenRows || []).filter((r) => r && (r.pk != null || r.key != null));
    const take = withPk.slice(0, DETAIL_COUNT === Infinity ? withPk.length : DETAIL_COUNT);
    const results = [];
    for (const row of take) {
      const pk = row.pk != null ? row.pk : row.key;
      const modul = display(pick(row, 'relInput.relInput_node.short')) || String(pk);
      const bez = display(pick(row, 'relInput.relEvent.label'));
      const raw = await dwrGetDetail(page, ssid, pk);
      if (raw.status !== 200) { results.push({ gradePk: pk, modul, error: 'HTTP ' + raw.status }); continue; }
      const d = parseDetail(raw.text);
      results.push({
        gradePk: pk, modul, bezeichnung: bez, note: d.grade, anzahlPruefungen: d.num,
        pruefungen: d.exams.map((e) => ({ label: e.label, nr: e.nr, gewicht: e.weight, durchschnitt: e.average, pk: e.pk })),
        bewertungen: d.ratings.map((x) => (x.value != null ? x.value : x.defaultDisplay))
      });
    }
    status.ok = results.length > 0;
    status.count = results.length;
    status.results = results;
    const jsonFile = writeJson('moduldetails.json', { generatedVia: 'DWR getDetailData (HTTP-RPC)', count: results.length, results });

    // Lesbare Tabelle: eine Zeile pro Prüfung.
    const tableRows = [];
    for (const m of results) {
      if (m.error) { tableRows.push({ Modul: m.modul, Pruefung: '(Fehler)', Gewicht: m.error, Durchschnitt: '', Note: '' }); continue; }
      if (!m.pruefungen || !m.pruefungen.length) { tableRows.push({ Modul: m.modul, Pruefung: '–', Gewicht: '', Durchschnitt: '', Note: m.note != null ? m.note : '' }); continue; }
      m.pruefungen.forEach((p, i) => tableRows.push({
        Modul: i === 0 ? m.modul : '', Pruefung: p.label || '', Gewicht: p.gewicht != null ? p.gewicht + '%' : '',
        Durchschnitt: p.durchschnitt != null ? p.durchschnitt : '', Note: i === 0 && m.note != null ? m.note : ''
      }));
    }
    writeText('moduldetails.txt', toTextTable('MODULDETAILS (Prüfungen)', tableRows));
    console.log('   ✅ Moduldetails: ' + results.length + ' Module (Prüfungen/Gewichte via DWR getDetailData)  → ' + jsonFile);
  } catch (e) {
    status.error = String((e && e.message) || e);
    try { writeJson('moduldetails.json', { error: status.error }); } catch (_) { /* swallow */ }
    console.log('   ❌ Moduldetails: ' + status.error);
  }
  return status;
}

// ---------- Domänen-Definitionen ----------
const DOMAINS = [
  {
    key: 'noten',
    entity: 'Input_data',
    paths: NOTEN_PATHS,
    label: 'NOTEN',
    // Input_data wird NICHT auto-gescoped → explizit auf den User + echte Noten.
    where: (pk) => 'relUser.pk==' + pk +
      ' and relInput.relInput_node.relInput_type.unique_id=="grades"',
    tableFn: (r) => ({
      Modul: display(pick(r, 'relInput.relInput_node.short')),
      Bezeichnung: display(pick(r, 'relInput.relEvent.label')).slice(0, 50),
      Note: display(pick(r, 'grade')) || display(pick(r, 'definate_grade')) || '–'
    })
  },
  {
    key: 'stundenplan',
    entity: 'Reservation',
    paths: STUNDENPLAN_PATHS,
    label: 'STUNDENPLAN',
    // Reservation wird via ACL automatisch gescoped — kein _where nötig.
    tableFn: (r) => ({
      Datum: display(pick(r, 'date_from')),
      Raum: display(pick(r, 'relRoom')),
      Dozent: display(pick(r, 'relReservation_lecturer_booking.relLecturer_booking.relUser')),
      Klasse: display(pick(r, 'relEvent.class_label')),
      Veranstaltung: display(pick(r, 'relEvent.label')).slice(0, 45)
    })
  },
  {
    key: 'absenzen',
    entity: 'Registration',
    paths: ABSENZEN_PATHS,
    label: 'ABSENZEN',
    // Nur Registrationen mit Event = echte Absenz-/Modul-Zeilen (live: 35/40).
    where: 'exists(relEvent)',
    tableFn: (r) => ({
      Kuerzel: display(pick(r, 'relEvent.abbreviation')),
      Modul: display(pick(r, 'relEvent.label')).slice(0, 45),
      Soll: display(pick(r, 'lessons_total_desired')),
      Ist: display(pick(r, 'lessons_total_actual')),
      'Praesenz%': display(pick(r, 'presence_rate')) || display(pick(r, 'presence_rate_total')),
      'Min%': display(pick(r, 'relEvent.minimal_presence'))
    })
  }
];

// ---------- Main ----------
(async () => {
  console.log('🎓 Tocco nice2 REST v2 — Export-Spike');
  console.log('   Basis:', BASE);
  console.log('   Export:', EXPORT_DIR);
  console.log('   Moduldetail-Versuche:', DETAIL_COUNT === Infinity ? 'alle' : DETAIL_COUNT, '\n');

  fs.mkdirSync(EXPORT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  const statuses = [];
  let username = '(unbekannt)';
  let pk = null;

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log('👉 Bitte melde dich jetzt im Browser an (WISS Office 365 / Microsoft-SSO).');
    console.log('   Das Script wartet automatisch, bis die Session steht …\n');

    username = await waitForLogin(page);
    const u = await getUserPk(page);
    pk = u.pk;
    console.log('✅ Eingeloggt als:', username, '(userEntityPk: ' + pk + ')\n');
    if (!pk) console.log('⚠️  Keine userEntityPk ermittelt — Noten-Scoping schlägt evtl. fehl.\n');

    // Noten-Seite laden: lädt nice2 + DWR-Engine (für Moduldetail-getDetailData).
    // REST läuft von hier same-origin weiter.
    console.log('⏳ Lade Noten-Seite (für DWR-Engine) …');
    await page.goto(NOTEN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const dwrSsid = await getDwrSsid(page);
    console.log(dwrSsid
      ? '   DWR-Engine bereit (scriptSessionId ok)\n'
      : '   ⚠️  DWR-Engine nicht bereit — Moduldetails werden übersprungen\n');

    console.log('═══ REST-Abrufe → ' + EXPORT_DIR + ' ═══');

    let notenStatus = null;
    let notenRows = [];
    for (const domain of DOMAINS) {
      const st = await runDomain(page, domain, pk);
      statuses.push(st);
      if (domain.key === 'noten') {
        notenStatus = st;
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(EXPORT_DIR, 'noten.json'), 'utf8'));
          notenRows = raw.data || [];
        } catch (_) { notenRows = []; }
      }
    }

    const mdStatus = await runModuldetails(page, dwrSsid, notenRows);
    statuses.push(mdStatus);

    // --- Producer-Validierung (end-to-end gegen src/rest/producer.js) ---
    // Ruft den ECHTEN REST-Producer mit dieser eingeloggten Page und schreibt
    // sein formgleiches Ergebnis-Objekt weg. KEIN DB-Schreibzugriff — reine
    // Validierung, dass der Producer live dieselben Daten liefert wie erwartet.
    try {
      const producer = require('./src/rest/producer');
      const result = await producer.run(page, { log: (m) => console.log('   [producer] ' + m) });
      const firstDetailId = Object.values(result.detailIdMap)[0];
      const pruef = firstDetailId ? await result.scrapeDetail(firstDetailId) : null;
      const firstAbsId = Object.values(result.absenzDetailIdMap)[0];
      const lek = firstAbsId ? await result.scrapeAbsenzenDetail(firstAbsId) : null;
      writeJson('producer-output.json', {
        counts: { noten: result.noten.length, stundenplan: result.stundenplan.length, absenzen: result.absenzen.length },
        noten0: result.noten[0] || null,
        stundenplan0: result.stundenplan[0] || null,
        absenzen0: result.absenzen[0] || null,
        detailIdMapSize: Object.keys(result.detailIdMap).length,
        pruefungen_firstModule: pruef,
        lektionen_firstModule_count: lek ? lek.length : 0,
        lektion0: lek ? lek[0] : null,
        noten: result.noten,
        stundenplan: result.stundenplan,
        absenzen: result.absenzen
      });
      console.log('\n═══ PRODUCER-VALIDIERUNG (src/rest/producer.js) ═══');
      console.log('   Noten ' + result.noten.length + ' | Stundenplan ' + result.stundenplan.length + ' | Absenzen ' + result.absenzen.length);
      console.log('   noten[0]      ' + JSON.stringify(result.noten[0]));
      console.log('   pruefungen[0] ' + JSON.stringify(pruef));
      console.log('   stundenplan[0]' + JSON.stringify(result.stundenplan[0]));
      console.log('   → tocco-export/producer-output.json');
    } catch (e) {
      console.log('\n   ❌ Producer-Validierung: ' + (e && e.message ? e.message : e));
    }

    // Index / README schreiben.
    const indexObj = {
      generatedAt: new Date().toISOString(),
      base: BASE,
      username,
      userEntityPk: pk,
      api: 'nice2 REST v2 (' + REST2 + ')',
      domains: statuses.map((s) => ({
        domain: s.domain,
        entity: s.entity || null,
        ok: !!s.ok,
        count: s.count || 0,
        usedFallback: !!s.usedFallback,
        pathsUsed: s.pathsUsed || null,
        whereUsed: s.whereUsed || null,
        experimental: !!s.experimental,
        error: s.error || null
      }))
    };
    const indexFile = writeJson('_index.json', indexObj);

    const readmeLines = [
      'Tocco REST-v2 Export',
      '====================',
      'Erzeugt: ' + indexObj.generatedAt,
      'Basis:   ' + BASE,
      'User:    ' + username + ' (pk ' + pk + ')',
      'API:     ' + indexObj.api,
      '',
      'WARNUNG: enthält echte Noten/Namen — NICHT einchecken (./tocco-export ist',
      'via .gitignore ausgeschlossen).',
      '',
      'Status pro Domäne:'
    ];
    for (const s of indexObj.domains) {
      const icon = s.ok ? '✅' : (s.experimental ? '🧪' : '❌');
      const parts = [icon, s.domain];
      if (s.entity) parts.push('(' + s.entity + ')');
      parts.push('— ' + (s.count || 0) + ' Datensätze');
      if (s.usedFallback) parts.push('[_paths-Fallback]');
      if (s.experimental) parts.push('[experimentell]');
      if (s.error) parts.push('— Fehler: ' + s.error);
      readmeLines.push('  ' + parts.join(' '));
    }
    readmeLines.push('');
    readmeLines.push('Dateien:');
    readmeLines.push('  _index.json                  Lauf-Metadaten + Status');
    readmeLines.push('  noten.json / .txt / .model   Noten (Input_data, _where=relUser.pk + grades)');
    readmeLines.push('  stundenplan.json / .txt / .model  Stundenplan (Reservation, auto-scoped)');
    readmeLines.push('  absenzen.json / .txt / .model     Absenzen (Registration, _where=exists(relEvent))');
    readmeLines.push('  moduldetails.json / .txt     Prüfungen pro Modul (z.B. ZP/LB: Gewicht + Durchschnitt) via DWR getDetailData');
    const readmeFile = writeText('README.txt', readmeLines.join('\n') + '\n');

    console.log('\n═══ ZUSAMMENFASSUNG ═══');
    for (const s of indexObj.domains) {
      const icon = s.ok ? '✅' : (s.experimental ? '🧪' : '❌');
      console.log('   ' + icon + ' ' + s.domain + ': ' + (s.count || 0) + ' Datensätze' +
        (s.usedFallback ? ' (Fallback)' : '') + (s.error ? ' — ' + s.error : ''));
    }
    console.log('\n✅ Fertig. Alle Daten via REST v2 — ohne DWR, ohne DOM-Scraping.');
    console.log('   Index:  ' + indexFile);
    console.log('   README: ' + readmeFile);
  } catch (e) {
    console.error('\n❌ Fehler:', e && e.message ? e.message : e);
    try {
      writeJson('_index.json', {
        generatedAt: new Date().toISOString(),
        base: BASE, username, userEntityPk: pk,
        fatalError: String((e && e.message) || e),
        domains: statuses
      });
    } catch (_) { /* swallow */ }
    process.exitCode = 1;
  } finally {
    await sleep(1500);
    await closeBrowserSafe(browser);
  }
})();
