'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const producer = require('../../src/rest/producer');
const { zParts, noteRaw, semesterFromCode } = producer;

// ============================================================
// A — zParts (UTC → Europe/Zurich, DST-aware)
// ============================================================

test('zParts: Sommerzeit (CEST, UTC+2) — 11:00Z → 13:00 lokal', () => {
  const z = zParts('2026-07-11T11:00:00.000Z');
  assert.strictEqual(z.datumDDMMYY, '11.07.26');
  assert.strictEqual(z.zeit, '13:00');
});

test('zParts: 06:30Z im August → 08:30 lokal (CEST), ISO-Datum', () => {
  const z = zParts('2025-08-28T06:30:00.000Z');
  assert.strictEqual(z.datumIso, '2025-08-28');
  assert.strictEqual(z.zeit, '08:30');
});

test('zParts: null/ungültig → null', () => {
  assert.strictEqual(zParts(null), null);
  assert.strictEqual(zParts('not-a-date'), null);
});

// ============================================================
// B — noteRaw (3-Dezimal-Roh-Format)
// ============================================================

test('noteRaw: Zahl → "4.500"', () => {
  assert.strictEqual(noteRaw(4.5), '4.500');
});

test('noteRaw: null/leer → ""', () => {
  assert.strictEqual(noteRaw(null), '');
  assert.strictEqual(noteRaw(''), '');
  assert.strictEqual(noteRaw(undefined), '');
});

test('semesterFromCode: extrahiert S<n> aus dem Code', () => {
  assert.strictEqual(semesterFromCode('UIFZ-2524-020-S1-254'), 'S1');
  assert.strictEqual(semesterFromCode('ohne-semester'), null);
});

// ============================================================
// C — producer.run Integration mit Mock-Page
// ============================================================

// Echtes getDetailData-Wire-Sample (Struktur exakt; events/grade/exams/ratings).
const WIRE_SAMPLE = `throw 'allowScriptTagRemoting is false.';
//#DWR-REPLY
//#DWR-START#
(function(){
if(!window.dwr)return;
var dwr=window.dwr._[0];
dwr.engine.remote.handleCallback("1","0",dwr.engine.remote.newObject("DwrResult",{createdEntities:[],deletedEntities:[],returnValue:{"definate_grade":"4.500","input_node":"GB-ZH-UIFZ-P-B21-03-IK-GE-254 - Geschäftsprozesse im eigenen Berufsumfeld beschreiben",exams:[dwr.engine.remote.newObject("nice2.optional.qualification.ExamRecord",{average:5.448,date:null,defaultDisplay:"ZP",label:"ZP",nr:1,pk:"28786",pointsMax:0.000,weight:30.00}),dwr.engine.remote.newObject("nice2.optional.qualification.ExamRecord",{average:4.813,date:null,defaultDisplay:"LB",label:"LB",nr:2,pk:"28787",pointsMax:0.000,weight:70.00})],"num_ratings":2,dispense:false,ratings:[dwr.engine.remote.newObject("nice2.optional.qualification.RatingRecord",{defaultDisplay:"5.900",id:1,pk:"146104",value:5.900}),dwr.engine.remote.newObject("nice2.optional.qualification.RatingRecord",{defaultDisplay:"4.200",id:2,pk:"146105",value:4.200})],"num_drop_ratings":null,name:"Elio",input_type:"Noten",events:"32360 \\/ UIFZ-2524-020-S1-254 \\/ 254 - Geschäftsprozesse im eigenen Berufsumfeld beschreiben"}}));
})();`;

// --- REST-v2-Fixtures (row.paths.<feld> = { value } / Relationen via value.paths) ---
function scalar(v) { return { value: v }; }
function entity(paths) { return { value: { paths } }; }

// Input_data: 1 Modul-Row (254). key = Input_data.key = detail_id "84121".
function inputDataFixture() {
  return {
    data: [{
      key: '84121',
      paths: {
        grade: scalar(4.5),
        definate_grade: scalar('4.500'),
        relInput: entity({
          relInput_node: entity({
            short: scalar('GB-ZH-UIFZ-P-B21-03-IK-GE-254'),
            label: scalar('Geschäftsprozesse im eigenen Berufsumfeld beschreiben')
          })
        })
      }
    }]
  };
}

// Reservation: 1 Termin (Dozent Frei, Marco / Raum ZH-202).
function reservationFixture() {
  return {
    data: [{
      key: 'r1',
      paths: {
        date_from: scalar('2026-07-11T11:00:00.000Z'),
        date_till: scalar('2026-07-11T12:30:00.000Z'),
        relRoom: entity({ label: scalar('ZH-202') }),
        relReservation_lecturer_booking: entity({
          relLecturer_booking: entity({
            relUser: entity({ lastname: scalar('Frei'), firstname: scalar('Marco') })
          })
        }),
        relEvent: entity({ class_label: scalar('B21-03'), label: scalar('Veranstaltung 254') })
      }
    }]
  };
}

// Registration: 1 Absenz-Row (UEK-106). key = detail_id "297250".
function registrationFixture() {
  return {
    data: [{
      key: '297250',
      paths: {
        relEvent: entity({
          abbreviation: scalar('UIFZ-2524-020-S1-UEK-106'),
          label: scalar('Überbetrieblicher Kurs 106'),
          relEvent_type: entity({ label: scalar('GE Überbetrieblicher Kurs') }),
          minimal_presence: scalar(80)
        }),
        lessons_total_desired: scalar(8),
        lessons_total_actual: scalar(8),
        presence_rate: scalar(100)
      }
    }]
  };
}

// Reservation_registration: 2 Lektionen, alle relRegistration.pk == "297250".
function reservationRegistrationFixture() {
  const lesson = (from, till, soll, ist, status) => ({
    key: 'rr-' + from,
    paths: {
      relRegistration: entity({ pk: scalar('297250') }),
      relReservation: entity({
        date_from: scalar(from),
        date_till: scalar(till),
        duration_hour_actual: scalar(soll)
      }),
      duration_hour_actual: scalar(ist),
      relRegistration_accomplishment_status: entity({ label: scalar(status) })
    }
  });
  return {
    data: [
      lesson('2026-07-11T11:00:00.000Z', '2026-07-11T12:30:00.000Z', 4, 4, 'Teilgenommen'),
      lesson('2026-07-12T11:00:00.000Z', '2026-07-12T12:30:00.000Z', 4, 4, 'Teilgenommen')
    ]
  };
}

// --- Mock-Page: dispatcht page.evaluate(fn, args) anhand der args. ---
// restGet      → args.url (Request-Pfad)
// dwrGetDetail → args.ssid + args.pk
// getDwrSsid   → keine args (nur fn)
function makeMockPage(opts = {}) {
  function jsonResponse(obj) {
    const text = JSON.stringify(obj);
    return { ok: true, status: 200, json: obj, text };
  }
  return {
    async evaluate(_fn, args) {
      // getDwrSsid: page.evaluate(fn) ohne args.
      if (args === undefined) return 'SSID';
      // dwrGetDetail: page.evaluate(fn, { ssid, pk }).
      if (args && args.pk != null && args.ssid != null) {
        return { status: 200, text: WIRE_SAMPLE };
      }
      // dwrSearch (Stundenplan): page.evaluate(fn, paramLines) — paramLines ist
      // ein Array. Liefert die gerenderten Zellen inkl. Dozent (wie der echte
      // SearchService). date_from-Zelle = gerenderte Von-Bis-Anzeige.
      if (Array.isArray(args)) {
        return { rows: [{
          'date_from': '11.07.26 13:00 - 16:30',
          'relRoom': 'ZH-202',
          'relType_of_execution': '',
          'relReservation_lecturer_booking.relLecturer_booking.relUser': 'Frei, Marco',
          'comment': '',
          'relEvent.class_label': 'B21-03',
          'relEvent.label': 'Veranstaltung 254'
        }] };
      }
      // restGet: page.evaluate(fn, { url, headers }).
      const url = args && args.url;
      if (typeof url === 'string') {
        if (url.indexOf('/nice2/username') !== -1) {
          return jsonResponse({ userEntityPk: '239687', username: 'x' });
        }
        // Reservation_registration ZUERST prüfen (enthält '/Reservation').
        if (url.indexOf('/Reservation_registration') !== -1) {
          return jsonResponse(opts.rr || reservationRegistrationFixture());
        }
        if (url.indexOf('/Input_data') !== -1) return jsonResponse(inputDataFixture());
        if (url.indexOf('/Registration') !== -1) return jsonResponse(registrationFixture());
        if (url.indexOf('/Reservation') !== -1) return jsonResponse(reservationFixture());
      }
      return { ok: false, status: 404, json: null, text: 'unhandled' };
    }
  };
}

test('producer.run: Noten-Row formgleich (fach/kuerzel/typ/note)', async () => {
  const page = makeMockPage();
  const scraped = await producer.run(page, { log: () => {} });

  assert.strictEqual(scraped.noten.length, 1);
  assert.deepStrictEqual(scraped.noten[0], {
    fach: 'GB-ZH-UIFZ-P-B21-03-IK-GE-254 Geschäftsprozesse im eigenen Berufsumfeld beschreiben',
    kuerzel: '32360 / UIFZ-2524-020-S1-254 / 254 - Geschäftsprozesse im eigenen Berufsumfeld beschreiben',
    typ: 'Noten',
    note: '4.500'
  });
});

test('producer.run: detailIdMap kuerzel_id → Input_data.key', async () => {
  const page = makeMockPage();
  const scraped = await producer.run(page, { log: () => {} });
  assert.strictEqual(scraped.detailIdMap['32360'], '84121');
});

test('producer.run: scrapeDetail liefert ZP(30%) + LB(70%) aus dem Cache', async () => {
  const page = makeMockPage();
  const scraped = await producer.run(page, { log: () => {} });

  const detail = await scraped.scrapeDetail('84121');
  assert.strictEqual(detail.expectedCount, 2);
  assert.strictEqual(detail.entries.length, 2);

  const zp = detail.entries.find((e) => e.bezeichnung === 'ZP');
  const lb = detail.entries.find((e) => e.bezeichnung === 'LB');
  assert.strictEqual(zp.gewicht, '30%');
  assert.strictEqual(zp.bewertung, '5.900');
  assert.strictEqual(lb.gewicht, '70%');
  assert.strictEqual(lb.bewertung, '4.200');
});

test('producer.run: Stundenplan-Row (dozent/raum/zeit)', async () => {
  const page = makeMockPage();
  const scraped = await producer.run(page, { log: () => {} });

  assert.strictEqual(scraped.stundenplan.length, 1);
  const sp = scraped.stundenplan[0];
  assert.strictEqual(sp.dozent, 'Frei, Marco');
  assert.strictEqual(sp.raum, 'ZH-202');
  assert.match(sp.zeit, /\d{2}:\d{2}\s*[-–]\s*\d{2}:\d{2}/);
});

test('producer.run: Absenz-Row (kuerzel_code/typ)', async () => {
  const page = makeMockPage();
  const scraped = await producer.run(page, { log: () => {} });

  assert.strictEqual(scraped.absenzen.length, 1);
  assert.strictEqual(scraped.absenzen[0].kuerzel_code, 'UIFZ-2524-020-S1-UEK-106');
  assert.strictEqual(scraped.absenzen[0].typ, 'GE Überbetrieblicher Kurs');
});

test('producer.run: offene Lektionen drücken die Anwesenheit NICHT (soll/besucht = nur stattgefunden)', async () => {
  // 2× Teilgenommen (je 4h) + 2× Offen (je 4h, ist=null). Erwartung: soll/besucht
  // zählen NUR die stattgefundenen → 8/8 (= 100 %), die offenen Lektionen drücken
  // die Anwesenheit nicht unter 100 % (= Toccos presence_rate, altes Verhalten).
  const lesson = (from, soll, ist, status) => ({
    key: 'rr-' + from,
    paths: {
      relRegistration: entity({ pk: scalar('297250') }),
      relReservation: entity({
        date_from: scalar(from),
        date_till: scalar(from),
        duration_hour_actual: scalar(soll)
      }),
      duration_hour_actual: scalar(ist),
      relRegistration_accomplishment_status: entity({ label: scalar(status) })
    }
  });
  const mixedRR = {
    data: [
      lesson('2026-07-11T11:00:00.000Z', 4, 4, 'Teilgenommen'),
      lesson('2026-07-12T11:00:00.000Z', 4, 4, 'Teilgenommen'),
      lesson('2026-07-18T11:00:00.000Z', 4, null, 'Offen'),
      lesson('2026-07-19T11:00:00.000Z', 4, null, 'Offen')
    ]
  };
  const page = makeMockPage({ rr: mixedRR });
  const scraped = await producer.run(page, { log: () => {} });

  const abs = scraped.absenzen[0];
  assert.strictEqual(abs.soll, 8);     // nur 2 stattgefundene × 4 (offen NICHT)
  assert.strictEqual(abs.besucht, 8);  // beide teilgenommen → besucht/soll = 100 %

  // Die Tagesliste enthält trotzdem ALLE 4 Lektionen (offene inkl.) — nur die
  // Übersichts-Summe klammert sie aus.
  const lektionen = await scraped.scrapeAbsenzenDetail('297250');
  assert.strictEqual(lektionen.length, 4);
});

test('producer.run: scrapeAbsenzenDetail liefert Lektionen mit status_raw', async () => {
  const page = makeMockPage();
  const scraped = await producer.run(page, { log: () => {} });

  const lektionen = await scraped.scrapeAbsenzenDetail('297250');
  assert.strictEqual(lektionen.length, 2);
  assert.strictEqual(lektionen[0].status_raw, 'Teilgenommen');
});

test('producer.run: closeBrowser ist no-op (Lifecycle gehört der Bridge)', async () => {
  const page = makeMockPage();
  const scraped = await producer.run(page, { log: () => {} });
  // darf nicht werfen
  await scraped.closeBrowser();
});
