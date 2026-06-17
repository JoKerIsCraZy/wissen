'use strict';

/**
 * REST-Producer — liefert ein FORMGLEICHES Ergebnis-Objekt wie scraper.runScrape(),
 * aber aus der nice2 REST v2 API (+ DWR getDetailData für Prüfungsgewichte) statt
 * DOM-Scraping. Damit bleibt die gesamte Downstream-Pipeline (runScrape.js,
 * db/*-Saver, Diff, Push) UNVERÄNDERT.
 *
 * Alle Feld-Mappings sind live gegen wiss.tocco.ch verifiziert (2026-06-17) und
 * gegen die bestehende data/wissen.db als spaltengleich bestätigt — kein
 * History-/Prüfungs-Join-Bruch. Siehe MIGRATION-REST-V2.md.
 *
 * Erwartet eine BEREITS EINGELOGGTE Playwright-Page auf der Noten-Seite (DWR-
 * Engine geladen) — geliefert von loginBridge.js. Der Producer navigiert nicht.
 */

const {
  getUserContext, fetchEntity, pick, pickText, pickNum, display,
  getDwrSsid, dwrGetDetail, dwrSearch, parseDetail
} = require('./client');

const ZURICH = 'Europe/Zurich';
const DETAIL_CONCURRENCY = 6;

// ---------------------------------------------------------------------------
// Zeit-Helfer: REST liefert UTC ("…Z"); die App speichert Europe/Zurich-Lokalzeit
// (DST-aware). Wir formatieren exakt die Strings, die die bestehenden Parser
// (parseDatum "DD.MM.YY", parseZeit "HH:MM – HH:MM") erwarten.
// ---------------------------------------------------------------------------
function zParts(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const part = (opts) => {
    const m = {};
    for (const p of new Intl.DateTimeFormat('de-CH', { timeZone: ZURICH, ...opts }).formatToParts(d)) {
      m[p.type] = p.value;
    }
    return m;
  };
  const dt = part({ day: '2-digit', month: '2-digit', year: 'numeric' });
  const tm = part({ hour: '2-digit', minute: '2-digit', hour12: false });
  const long = part({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return {
    datumDDMMYY: dt.day + '.' + dt.month + '.' + dt.year.slice(2),
    datumIso: dt.year + '-' + dt.month + '-' + dt.day,
    zeit: tm.hour + ':' + tm.minute,
    longDate: long.weekday + ', ' + long.day + '. ' + long.month + ' ' + long.year
  };
}

// Mini-Concurrency-Limiter (kein npm-Dep) für die getDetailData-Calls.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// Formatiert eine Note auf das 3-Dezimal-Roh-Format ("4.500"), wie es Tocco/die
// alte DB führt. Null/leer → ''.
function noteRaw(n) {
  if (n == null || n === '') return '';
  const v = typeof n === 'number' ? n : Number(String(n).replace(',', '.'));
  return Number.isFinite(v) ? v.toFixed(3) : '';
}

// ---------------------------------------------------------------------------
// NOTEN + Prüfungs-Details (getDetailData pro Modul, einmal — liefert events
// für kuerzel_id, definate_grade und die Prüfungen).
// ---------------------------------------------------------------------------
async function buildNoten(page, pk, ssid, log) {
  const NP = [
    'grade', 'definate_grade',
    'relInput.relInput_node.short', 'relInput.relInput_node.label'
  ].join(',');
  const where = 'relUser.pk==' + pk
    + ' and relInput.relInput_node.relInput_type.unique_id=="grades"';
  const res = await fetchEntity(page, 'Input_data', { where, paths: NP, limit: 1000 });
  const rows = res.data;
  log('  [Noten] ' + rows.length + ' Module via REST', 'info');

  const noten = [];
  const detailIdMap = {};
  const detailCache = {}; // detail_id(Input_data.key) -> { entries, expectedCount }

  if (!ssid) {
    log('  [Noten] ⚠️  keine DWR-scriptSessionId — Prüfungs-Details werden übersprungen', 'warn');
  }

  await mapLimit(rows, DETAIL_CONCURRENCY, async (row) => {
    const detailId = String(row.key);
    const nodeShort = pickText(row, 'relInput.relInput_node.short');
    const nodeLabel = pickText(row, 'relInput.relInput_node.label');
    const overviewGrade = pickNum(row, 'grade');

    let detail = null;
    if (ssid) {
      const raw = await dwrGetDetail(page, ssid, detailId);
      if (raw.status === 200 && raw.text) detail = parseDetail(raw.text);
    }

    // kuerzel = die events-Zeichenkette ("32360 / UIFZ-... / 254 - ...") — exakt
    // das, was die alte Übersicht als kuerzel_full speicherte. parseKuerzel zieht
    // daraus kuerzel_id (=führende Nummer, History-Join-Key), code, semester.
    const kuerzel = detail && detail.events ? detail.events : null;
    if (!kuerzel) {
      // Ohne events kein stabiler kuerzel_id → Modul diesen Cycle überspringen
      // (wird nächsten Cycle erneut versucht). Niemals mit falscher id speichern.
      log('  [Noten] ⚠️  ' + nodeShort + ' (pk ' + detailId + ') ohne getDetailData — übersprungen', 'warn');
      return;
    }
    const kuerzelId = kuerzel.split(/\s*\/\s*/)[0] || '';
    if (!kuerzelId) return;

    const gradeNum = detail && detail.grade != null ? detail.grade : overviewGrade;

    noten.push({
      fach: (nodeShort + ' ' + nodeLabel).trim(),
      kuerzel,
      typ: 'Noten',
      note: gradeNum != null ? noteRaw(gradeNum) : ''
    });
    detailIdMap[kuerzelId] = detailId;

    // Prüfungen aus exams + ratings zusammenführen. bewertung = der RATING-Wert
    // (5.900/4.200), NICHT der exam-average. exam.nr ↔ rating.id.
    const exams = (detail && detail.exams) || [];
    const ratings = (detail && detail.ratings) || [];
    const entries = exams.map((ex) => {
      const r = ratings.find((rt) => rt.id === ex.nr) || null;
      const bew = r ? (r.value != null ? r.value : r.defaultDisplay) : null;
      return {
        pruefung_nr: ex.nr,
        bezeichnung: ex.label,
        gewicht: ex.weight != null ? ex.weight + '%' : '',
        bewertung: bew != null ? noteRaw(bew) : '',
        bewertung_raw: bew != null ? noteRaw(bew) : ''
      };
    });
    detailCache[detailId] = {
      entries,
      expectedCount: detail && detail.num != null ? detail.num : null
    };
  });

  return { noten, detailIdMap, detailCache };
}

// ---------------------------------------------------------------------------
// STUNDENPLAN
// Primär via DWR-OwnTimeTable-Suche (HTTP-RPC, KEIN DOM): die einzige Quelle, die
// dem Studenten den DOZENTEN liefert — REST/ACL gibt Lecturer_booking.relUser als
// null heraus (live verifiziert), nur der SearchService rendert den Namen über
// die Form. Fallback auf reines REST (ohne Dozent), falls die DWR-Engine fehlt.
// ---------------------------------------------------------------------------

// Die c0-*-Such-Parameter der OwnTimeTable-Suche (1:1 aus dem Live-Mitschnitt,
// Paging-Limit 1000). batchId/page/scriptSessionId hängt dwrSearch in-browser an.
// Datumsfilter (date_from >= dateFromMs) als Range mit DWR-`date:`-Typ.
function stundenplanSearchBody(dateFromMs) {
  return [
    'callCount=1', 'c0-scriptName=nice2_netui_SearchService', 'c0-methodName=search', 'c0-id=0', 'c0-param0=array:[]',
    'c0-e3=boolean:true', 'c0-e4=string:entity%3A%2F%2FReservation%2F~1%2Fdate_from', 'c0-e5=string:date_from', 'c0-e7=string:datetime', 'c0-e8=date:' + dateFromMs,
    'c0-e6=Object_Object:{type:reference:c0-e7, value:reference:c0-e8}', 'c0-e10=string:datetime', 'c0-e11=null:null', 'c0-e9=Object_Object:{type:reference:c0-e10, value:reference:c0-e11}', 'c0-e12=number:0',
    'c0-e2=Object_entity.RangeRebindValue:{dirty:reference:c0-e3, fieldUri:reference:c0-e4, componentId:reference:c0-e5, from:reference:c0-e6, to:reference:c0-e9, version:reference:c0-e12}',
    'c0-e1=array:[reference:c0-e2]',
    'c0-e25=string:', 'c0-e26=string:', 'c0-e27=string:date_from', 'c0-e28=string:relRoom', 'c0-e29=string:relType_of_execution', 'c0-e30=string:relReservation_lecturer_booking.relLecturer_booking.relUser', 'c0-e31=string:comment', 'c0-e32=string:relEvent.class_label', 'c0-e33=string:relEvent.label',
    'c0-e24=array:[reference:c0-e25,reference:c0-e26,reference:c0-e27,reference:c0-e28,reference:c0-e29,reference:c0-e30,reference:c0-e31,reference:c0-e32,reference:c0-e33]',
    'c0-e35=number:0', 'c0-e36=number:1000', 'c0-e34=Object_searchService.Paging:{offset:reference:c0-e35, limit:reference:c0-e36}',
    'c0-e38=string:OwnTimeTable_list', 'c0-e39=string:list', 'c0-e37=Object_form.FormIdentifier:{formName:reference:c0-e38, scope:reference:c0-e39}',
    'c0-e41=string:OwnTimeTable_search', 'c0-e42=string:search', 'c0-e40=Object_form.FormIdentifier:{formName:reference:c0-e41, scope:reference:c0-e42}',
    'c0-e43=null:null', 'c0-e44=null:null', 'c0-e45=string:Reservation', 'c0-e46=null:null', 'c0-e47=null:null', 'c0-e48=array:[]', 'c0-e49=boolean:true',
    'c0-e52=string:date_from', 'c0-e53=string:ASC', 'c0-e51=Object_searchService.OrderItem:{path:reference:c0-e52, direction:reference:c0-e53}', 'c0-e50=array:[reference:c0-e51]', 'c0-e54=null:null',
    'c0-param1=Object_nice2.netui.SearchParameters:{queryParams:reference:c0-e1, columns:reference:c0-e24, paging:reference:c0-e34, listForm:reference:c0-e37, searchForm:reference:c0-e40, constrictionParams:reference:c0-e43, relatedTo:reference:c0-e44, entityName:reference:c0-e45, pks:reference:c0-e46, manualQuery:reference:c0-e47, searchFilters:reference:c0-e48, skipDefaultDisplay:reference:c0-e49, order:reference:c0-e50, searchFilter:reference:c0-e54}'
  ];
}

async function buildStundenplan(page, ssid, log, opts = {}) {
  const sinceDays = opts.sinceDays != null ? opts.sinceDays : 14;

  // PRIMÄR: DWR-OwnTimeTable-Suche (mit Dozent).
  if (ssid) {
    try {
      const dateFromMs = Date.now() - sinceDays * 86400000;
      const r = await dwrSearch(page, stundenplanSearchBody(dateFromMs));
      if (r && r.rows && !r.error) {
        const stundenplan = r.rows.map((row) => {
          // date_from-Zelle = gerenderte Von-Bis-Anzeige, z.B.
          // "04.06.26 08:30 - 12:00" → datum "04.06.26", zeit "08:30 - 12:00".
          const dt = String(row['date_from'] || '').trim();
          const sp = dt.indexOf(' ');
          return {
            datum: sp > 0 ? dt.slice(0, sp) : dt,
            zeit: sp > 0 ? dt.slice(sp + 1).trim() : '',
            raum: row['relRoom'] || '',
            dozent: row['relReservation_lecturer_booking.relLecturer_booking.relUser'] || '',
            klasse: row['relEvent.class_label'] || '',
            veranstaltung: row['relEvent.label'] || ''
          };
        });
        log('  [Stundenplan] ' + stundenplan.length + ' Termine via DWR-Suche (inkl. Dozent)', 'info');
        return stundenplan;
      }
      log('  [Stundenplan] DWR-Suche kein Ergebnis (' + ((r && r.error) || '?') + ') — Fallback REST ohne Dozent', 'warn');
    } catch (e) {
      log('  [Stundenplan] DWR-Suche Fehler (' + e.message + ') — Fallback REST ohne Dozent', 'warn');
    }
  }

  // FALLBACK: reines REST (Epoch-Millis-Fenster). Korrekte Tage/Zeiten/Räume, aber
  // OHNE Dozent (REST/ACL). nice2 TQL braucht das Datum als Epoch-Millis-ZAHL —
  // String-Literale geben HTTP 500, now()/today() gibt's nicht.
  const SP = ['date_from', 'date_till', 'relRoom.label', 'relEvent.class_label', 'relEvent.label'].join(',');
  const untilDays = opts.untilDays != null ? opts.untilDays : 180;
  const startMs = Date.now() - sinceDays * 86400000;
  const endMs = Date.now() + untilDays * 86400000;
  const where = 'date_from>=' + startMs + ' and date_from<=' + endMs;
  let res;
  try {
    res = await fetchEntity(page, 'Reservation', { where, paths: SP, sort: 'date_from', limit: 1000 });
  } catch (e) {
    log('  [Stundenplan] REST-Fallback Datums-_where fehlgeschlagen (' + e.message + ')', 'warn');
    res = await fetchEntity(page, 'Reservation', { paths: SP, sort: 'date_from desc', limit: 1000 });
  }
  const stundenplan = [];
  for (const row of res.data) {
    const von = zParts(pick(row, 'date_from'));
    const bis = zParts(pick(row, 'date_till'));
    if (!von) continue;
    stundenplan.push({
      datum: von.datumDDMMYY,
      zeit: von.zeit + ' – ' + (bis ? bis.zeit : ''),
      raum: pickText(row, 'relRoom.label'),
      dozent: '',
      klasse: pickText(row, 'relEvent.class_label'),
      veranstaltung: pickText(row, 'relEvent.label')
    });
  }
  log('  [Stundenplan] ' + stundenplan.length + ' Termine via REST-Fallback (ohne Dozent)', 'warn');
  return stundenplan;
}

function semesterFromCode(code) {
  const m = String(code || '').match(/-S(\d+)-/);
  return m ? 'S' + m[1] : null;
}

// ---------------------------------------------------------------------------
// ABSENZEN (Übersicht) + Lektionen-Detail.
//  - Übersicht: Registration where exists(relEvent).
//  - Lektionen: EINE Reservation_registration-Abfrage (scoped), gruppiert nach
//    relRegistration.pk. soll = Σ relReservation.duration_hour_actual,
//    besucht = Σ duration_hour_actual (des Studenten).
// ---------------------------------------------------------------------------
async function buildAbsenzen(page, pk, log) {
  // 1) Übersicht
  const AP = [
    'relEvent.abbreviation', 'relEvent.label', 'relEvent.relEvent_type.label',
    'lessons_total_desired', 'lessons_total_actual', 'presence_rate',
    'relEvent.minimal_presence'
  ].join(',');
  const ov = await fetchEntity(page, 'Registration', { where: 'exists(relEvent)', paths: AP, limit: 1000 });

  // 2) Lektionen (eine Abfrage, alle Module)
  const RR = [
    'relRegistration.pk',
    'relReservation.date_from', 'relReservation.date_till', 'relReservation.duration_hour_actual',
    'duration_hour_actual',
    'relRegistration_accomplishment_status.label'
  ].join(',');
  const rr = await fetchEntity(page, 'Reservation_registration', {
    where: 'relRegistration.relUser.pk==' + pk, paths: RR, sort: 'relReservation.date_from', limit: 1000
  });

  // Lektionen nach Registration-PK gruppieren + Summen bilden.
  const lessonsByReg = {};   // regPk -> LektionEntry[]
  const sums = {};           // regPk -> { soll, besucht }
  for (const row of rr.data) {
    const regPk = display(pick(row, 'relRegistration.pk'));
    if (!regPk) continue;
    const von = zParts(pick(row, 'relReservation.date_from'));
    const bis = zParts(pick(row, 'relReservation.date_till'));
    const soll = pickNum(row, 'relReservation.duration_hour_actual');
    const ist = pickNum(row, 'duration_hour_actual');
    const statusRaw = pickText(row, 'relRegistration_accomplishment_status.label');
    (lessonsByReg[regPk] = lessonsByReg[regPk] || []).push({
      termin_iso: von ? von.datumIso : '',
      zeit_von: von ? von.zeit : '',
      zeit_bis: bis ? bis.zeit : '',
      termin_raw: von ? (von.longDate + ', ' + von.zeit + ' - ' + (bis ? bis.zeit : '')) : null,
      lektionen_soll: soll,
      lektionen_ist: ist,
      anwesenheit_pct: (soll && ist != null) ? Math.round((ist / soll) * 100) : null,
      status_raw: statusRaw || null
    });
    const s = (sums[regPk] = sums[regPk] || { soll: 0, besucht: 0 });
    if (soll != null) s.soll += soll;
    if (ist != null) s.besucht += ist;
  }

  const absenzen = [];
  const absenzDetailIdMap = {};
  for (const row of ov.data) {
    const detailId = String(row.key);
    const code = pickText(row, 'relEvent.abbreviation');
    if (!code) continue;
    const s = sums[detailId];
    // Nur Module mit Lektionen entsprechen der alten Absenzen-Übersicht.
    if (!s) continue;
    absenzen.push({
      kuerzel_code: code,
      typ: pickText(row, 'relEvent.relEvent_type.label'),
      bezeichnung: pickText(row, 'relEvent.label'),
      semester: semesterFromCode(code),
      soll: s.soll,
      besucht: s.besucht,
      minimal_pct: pickNum(row, 'relEvent.minimal_presence'),
      anwesenheit_pct_scraped: pickNum(row, 'presence_rate')
    });
    absenzDetailIdMap[code] = detailId;
  }
  log('  [Absenzen] ' + absenzen.length + ' Module + Lektionen via REST', 'info');
  return { absenzen, absenzDetailIdMap, lessonsByReg };
}

// ---------------------------------------------------------------------------
// Haupteinstieg. page = eingeloggte Noten-Seite (DWR-Engine geladen).
// ---------------------------------------------------------------------------
async function run(page, { log } = {}) {
  const onLog = typeof log === 'function' ? log : () => {};
  const ctx = await getUserContext(page);
  if (!ctx.pk) throw new Error('REST-Producer: keine userEntityPk (nicht eingeloggt?)');
  onLog('🔑 REST-Producer als ' + ctx.username + ' (pk ' + ctx.pk + ')', 'info');

  const ssid = await getDwrSsid(page);

  const [notenRes, stundenplan, absRes] = await Promise.all([
    buildNoten(page, ctx.pk, ssid, onLog),
    buildStundenplan(page, ssid, onLog),
    buildAbsenzen(page, ctx.pk, onLog)
  ]);

  return {
    noten: notenRes.noten,
    stundenplan,
    absenzen: absRes.absenzen,
    detailIdMap: notenRes.detailIdMap,
    absenzDetailIdMap: absRes.absenzDetailIdMap,
    fetchedAt: new Date().toISOString(),
    rawText: { noten: '', stundenplan: '', absenzen: '' },
    // Detail-Calls bedienen sich aus dem Cache (alles schon geholt).
    scrapeDetail: async (detailId) => {
      const cached = notenRes.detailCache[String(detailId)];
      return cached || { entries: [], expectedCount: null };
    },
    scrapeAbsenzenDetail: async (detailId) => {
      return absRes.lessonsByReg[String(detailId)] || [];
    },
    // Page-Lifecycle gehört der loginBridge — hier kein Browser-Close.
    closeBrowser: async () => {}
  };
}

module.exports = { run, zParts, semesterFromCode, noteRaw };
