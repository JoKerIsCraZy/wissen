/* ============================================================================
   WISSen Desktop-Dashboard — Demo-Modus (Mock-API-Layer)
   ----------------------------------------------------------------------------
   Statische Live-Demo des SvelteKit-Dashboards auf GitHub Pages, OHNE Backend.
   Patcht window.fetch (alle /api/*-Calls) und window.EventSource (/api/events)
   bevor die SvelteKit-App bootet und liefert deterministische, realistische
   Schul-Beispieldaten — exakt in den Shapes aus web-svelte/src/lib/api/types.ts.

   Wird als klassisches <script> im <head> der gebauten index.html injiziert
   (siehe demo/inject-mock.mjs), also VOR dem deferred SvelteKit-Modul. Dadurch
   sind Token, fetch und EventSource gepatcht, bevor der Auth-Guard (+layout.ts)
   und die erste Route laufen.

   Räume: ZH-201–ZH-212 (2. OG) und 401–412 (4. OG) — passend zu den Floorplan-
   Hotspots in src/lib/floorplans/data.ts (Inline-Raumplan rendert dadurch).

   ALLE Daten sind frei erfunden. Keine echten Schul-Infos.
   ============================================================================ */
(function () {
  'use strict';

  // 1) Auth-Token vorsetzen → Auth-Guard (+layout.ts hasToken) lässt durch,
  //    die Login-Route erscheint nie.
  try { localStorage.setItem('wissen.authToken', 'demo-token'); } catch (_) {}

  // 2) Service-Worker im Demo nicht registrieren (defensiv — der Demo-Build
  //    deaktiviert die Auto-Registration bereits via svelte.config.js).
  if ('serviceWorker' in navigator) {
    try {
      navigator.serviceWorker.register = () =>
        Promise.resolve({ scope: location.pathname, unregister: () => Promise.resolve(true) });
      navigator.serviceWorker.getRegistrations?.().then(
        (rs) => rs.forEach((r) => r.unregister().catch(() => {})),
      ).catch(() => {});
    } catch (_) {}
  }

  // ── Zeit-Helfer ──────────────────────────────────────────────────────────
  const NOW = Date.now();
  const ISO = (d) => new Date(d).toISOString();
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const dayOffset = (n) => {
    const d = new Date(NOW);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + n);
    return d;
  };
  // Lokales YYYY-MM-DD (nicht toISOString — das wäre UTC und würde in CET/CEST
  // die "heute"-Lektionen auf den Vortag schieben).
  const fmtDate = (d) =>
    d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');

  // ── Noten (NotenRow[]) ─────────────────────────────────────────────────────
  // Eine frische Note (M183, isFresh:1, prev_note gesetzt) treibt die
  // "Letzte Änderung"-Liste + den Notenschnitt-Streifen auf der Aktuell-Seite.
  const noten = [
    { id: 1,  kuerzel_id: 'm114', kuerzel_code: 'M114', kuerzel_full: 'M114 Codeverwaltung mit Git',        fach_code: 'M114', fach_name: 'Codeverwaltung mit Git',   semester: 'S1', typ: 'Modul', note: 5.4, note_raw: '5.40', prev_note: null, isFresh: 0, fetched_at: ISO(NOW - 26 * HOUR), note_recorded_at: ISO(NOW - 26 * HOUR) },
    { id: 2,  kuerzel_id: 'm183', kuerzel_code: 'M183', kuerzel_full: 'M183 Backup-Datenbestand sichern',   fach_code: 'M183', fach_name: 'Datenbanken',             semester: 'S1', typ: 'Modul', note: 5.4, note_raw: '5.40', prev_note: 5.0, isFresh: 1, fetched_at: ISO(NOW - 2 * MIN),  note_recorded_at: ISO(NOW - 2 * MIN) },
    { id: 3,  kuerzel_id: 'm226', kuerzel_code: 'M226', kuerzel_full: 'M226 Objektorientiert programmieren', fach_code: 'M226', fach_name: 'OOP mit Java',           semester: 'S1', typ: 'Modul', note: 4.8, note_raw: '4.80', prev_note: null, isFresh: 0, fetched_at: ISO(NOW - 48 * HOUR), note_recorded_at: ISO(NOW - 48 * HOUR) },
    { id: 4,  kuerzel_id: 'm319', kuerzel_code: 'M319', kuerzel_full: 'M319 Applikationen entwerfen',       fach_code: 'M319', fach_name: 'Software-Engineering',     semester: 'S2', typ: 'Modul', note: 5.0, note_raw: '5.00', prev_note: null, isFresh: 0, fetched_at: ISO(NOW - 4 * DAY),  note_recorded_at: ISO(NOW - 4 * DAY) },
    { id: 5,  kuerzel_id: 'm320', kuerzel_code: 'M320', kuerzel_full: 'M320 Daten der Geschäftsprozesse',   fach_code: 'M320', fach_name: 'BPMN',                   semester: 'S2', typ: 'Modul', note: 5.2, note_raw: '5.20', prev_note: null, isFresh: 0, fetched_at: ISO(NOW - 3 * DAY),  note_recorded_at: ISO(NOW - 3 * DAY) },
    { id: 6,  kuerzel_id: 'm164', kuerzel_code: 'M164', kuerzel_full: 'M164 Datenbanken erstellen',         fach_code: 'M164', fach_name: 'SQL & ER-Modell',        semester: 'S1', typ: 'Modul', note: 5.5, note_raw: '5.50', prev_note: null, isFresh: 0, fetched_at: ISO(NOW - 5 * DAY),  note_recorded_at: ISO(NOW - 5 * DAY) },
    { id: 7,  kuerzel_id: 'm346', kuerzel_code: 'M346', kuerzel_full: 'M346 Cloud-Lösungen konzipieren',    fach_code: 'M346', fach_name: 'AWS & Azure Basics',     semester: 'S2', typ: 'Modul', note: 4.6, note_raw: '4.60', prev_note: null, isFresh: 0, fetched_at: ISO(NOW - 8 * DAY),  note_recorded_at: ISO(NOW - 8 * DAY) },
    { id: 8,  kuerzel_id: 'm347', kuerzel_code: 'M347', kuerzel_full: 'M347 Container einsetzen',           fach_code: 'M347', fach_name: 'Docker & K8s',           semester: 'S2', typ: 'Modul', note: 5.7, note_raw: '5.70', prev_note: null, isFresh: 0, fetched_at: ISO(NOW - 6 * DAY),  note_recorded_at: ISO(NOW - 6 * DAY) },
    { id: 9,  kuerzel_id: 'm223', kuerzel_code: 'M223', kuerzel_full: 'M223 Multi-User-Applikation',        fach_code: 'M223', fach_name: 'Web-Frameworks',         semester: 'S2', typ: 'Modul', note: 4.9, note_raw: '4.90', prev_note: null, isFresh: 0, fetched_at: ISO(NOW - 10 * DAY), note_recorded_at: ISO(NOW - 10 * DAY) },
    { id: 10, kuerzel_id: 'm450', kuerzel_code: 'M450', kuerzel_full: 'M450 Datenmodelle entwickeln',       fach_code: 'M450', fach_name: 'Datenmodellierung',      semester: 'S3', typ: 'Modul', note: 5.1, note_raw: '5.10', prev_note: null, isFresh: 0, fetched_at: ISO(NOW - 12 * DAY), note_recorded_at: ISO(NOW - 12 * DAY) },
    { id: 11, kuerzel_id: 'all1', kuerzel_code: 'ALL1', kuerzel_full: 'Allgemeinbildung — Sprache & Kommunikation', fach_code: 'ALL1', fach_name: 'Deutsch',         semester: 'S1', typ: 'AB',    note: 5.0, note_raw: '5.00', prev_note: null, isFresh: 0, fetched_at: ISO(NOW - 70 * HOUR), note_recorded_at: ISO(NOW - 70 * HOUR) },
    { id: 12, kuerzel_id: 'all2', kuerzel_code: 'ALL2', kuerzel_full: 'Allgemeinbildung — Gesellschaft',    fach_code: 'ALL2', fach_name: 'Geschichte & Politik',   semester: 'S1', typ: 'AB',    note: 4.5, note_raw: '4.50', prev_note: null, isFresh: 0, fetched_at: ISO(NOW - 90 * HOUR), note_recorded_at: ISO(NOW - 90 * HOUR) },
    // Mathe + Englisch — kuerzel_code mit -N<digit> Niveau-Suffix, damit der
    // BK-Filter (/-N\d+$/) sie ausschliesst.
    { id: 13, kuerzel_id: 'matn2', kuerzel_code: 'MAT-N2', kuerzel_full: 'Mathematik Niveau 2', fach_code: 'MAT', fach_name: 'Mathematik', semester: 'S1', typ: 'Modul', note: 4.7, note_raw: '4.70', prev_note: null, isFresh: 0, fetched_at: ISO(NOW - 110 * HOUR), note_recorded_at: ISO(NOW - 110 * HOUR) },
    { id: 14, kuerzel_id: 'engn3', kuerzel_code: 'ENG-N3', kuerzel_full: 'Englisch Niveau 3',   fach_code: 'ENG', fach_name: 'Englisch',   semester: 'S2', typ: 'Modul', note: 5.3, note_raw: '5.30', prev_note: null, isFresh: 0, fetched_at: ISO(NOW - 130 * HOUR), note_recorded_at: ISO(NOW - 130 * HOUR) },
  ];

  // ── Prüfungen (PruefungRow[] pro kuerzel_id) ────────────────────────────────
  let pid = 100;
  const P = (kuerzel_id, typ, nr, bez, pct, bew, fresh, prev) => ({
    id: ++pid,
    kuerzel_id,
    pruefung_typ: typ,
    pruefung_nr: nr,
    bezeichnung: bez,
    gewicht: null,
    gewicht_pct: pct,
    bewertung: bew,
    bewertung_raw: bew != null ? bew.toFixed(2) : null,
    fetched_at: ISO(NOW - (fresh ? 2 * MIN : 30 * DAY)),
    prev_bewertung: prev != null ? prev : null,
    bewertung_recorded_at: bew != null ? ISO(NOW - (fresh ? 2 * MIN : 30 * DAY)) : null,
  });
  const pruefungen = {
    m114: [P('m114', 'LB', 1, 'Git Basics — Branching & Commits', 40, 5.0, 0), P('m114', 'LB', 2, 'Merge-Konflikte & Rebase', 60, 5.7, 0)],
    m183: [P('m183', 'ZP', 1, 'SQL Basics — SELECT, JOIN, WHERE', 50, 5.0, 0, 4.5), P('m183', 'ZP', 2, 'Backup-Strategien & Restore-Drill', 50, 5.8, 1)],
    m226: [P('m226', 'LB', 1, 'Klassen, Vererbung & Konstruktoren', 50, 4.5, 0), P('m226', 'LB', 2, 'Interfaces & Polymorphie', 50, 5.1, 0)],
    m319: [P('m319', 'ZP', 1, 'UML-Diagramme & GoF-Patterns', 100, 5.0, 0)],
    m320: [P('m320', 'LB', 1, 'BPMN-Modellierung Webshop-Prozess', 100, 5.2, 0)],
    m164: [P('m164', 'LB', 1, 'ER-Modell — Entitäten & Beziehungen', 50, 5.5, 0), P('m164', 'LB', 2, 'Normalisierung bis 3NF', 50, 5.5, 0)],
    m346: [P('m346', 'ZP', 1, 'Cloud-Architektur — IaaS / PaaS / SaaS', 100, 4.6, 0)],
    m347: [P('m347', 'LB', 1, 'Docker Compose Multi-Service-Stack', 50, 5.5, 0), P('m347', 'LB', 2, 'Kubernetes Deployment & Services', 50, 5.9, 0)],
    m223: [P('m223', 'ZP', 1, 'SvelteKit-App mit Auth & SSR', 100, 4.9, 0)],
    m450: [P('m450', 'LB', 1, 'Konzeptionelles Datenmodell — Domäne', 100, null, 0)],
    all1: [P('all1', 'ZP', 1, 'Aufsatz — Argumentative Erörterung', 100, 5.0, 0)],
    all2: [P('all2', 'ZP', 1, 'Politik-Test Schweiz & Demokratie', 100, 4.5, 0)],
    matn2: [P('matn2', 'ZP', 1, 'Algebra & Funktionen', 50, 4.4, 0), P('matn2', 'ZP', 2, 'Geometrie & Trigonometrie', 50, 5.0, 0)],
    engn3: [P('engn3', 'LB', 1, 'Reading & Listening Comprehension', 50, 5.2, 0), P('engn3', 'LB', 2, 'Writing & Speaking B2', 50, 5.4, 0)],
  };
  // pruefungen_total / _open je Modul nachtragen (NotenRow-Felder).
  for (const n of noten) {
    const ps = pruefungen[n.kuerzel_id] || [];
    n.pruefungen_total = ps.length;
    n.pruefungen_open = ps.filter((p) => p.bewertung == null).length;
  }

  // ── Stundenplan (StundenplanRow[]) ──────────────────────────────────────────
  // Heute: realer Tagesplan 08:00–15:45, Räume mit Floorplan-Hotspot (2. OG),
  // letzte Lektion mit FRISCHEM Zimmerwechsel (treibt "Letzte Änderung" + Plan).
  // Restliche Woche: spannt ZH-201–212 (2. OG) und 401–412 (4. OG) auf.
  let sid = 0;
  const L = (datum, von, bis, veranstaltung, dozent, raum, fresh, prevRaum) => {
    const row = {
      id: ++sid,
      datum_iso: datum,
      zeit_von: von,
      zeit_bis: bis,
      veranstaltung,
      dozent,
      klasse: 'AP24f',
      raum,
      fetched_at: ISO(NOW - (fresh ? 5 * MIN : 6 * HOUR)),
      isFresh: fresh ? 1 : 0,
    };
    if (prevRaum) row.prev_raum = prevRaum;
    return row;
  };
  const T0 = fmtDate(dayOffset(0));
  const T1 = fmtDate(dayOffset(1));
  const T2 = fmtDate(dayOffset(2));
  const T3 = fmtDate(dayOffset(3));
  const T4 = fmtDate(dayOffset(4));
  const T5 = fmtDate(dayOffset(5));
  const T6 = fmtDate(dayOffset(6));
  const stundenplan = [
    // Heute (2. OG, alle mit Hotspot) — letzte Lektion: Zimmerwechsel ZH-204→ZH-209.
    L(T0, '08:00', '09:30', 'M114 Codeverwaltung mit Git', 'Z. Müller',  'ZH-201', 0),
    L(T0, '09:55', '11:25', 'M183 Datenbanken',            'B. Keller',  'ZH-202', 0),
    L(T0, '12:25', '14:00', 'M226 OOP mit Java',           'M. Schwarz', 'ZH-203', 0),
    L(T0, '14:15', '15:45', 'M319 Software-Engineering',   'P. Brunner', 'ZH-209', 1, 'ZH-204'),
    // +1
    L(T1, '08:00', '09:30', 'M320 BPMN',          'A. Hofer', 'ZH-205', 0),
    L(T1, '09:55', '11:25', 'M347 Docker & K8s',  'L. Weber', 'ZH-206', 0),
    L(T1, '12:25', '14:00', 'M346 Cloud-Lösungen', 'L. Weber', 'Online', 0),
    // +2
    L(T2, '08:00', '09:30', 'M223 Web-Frameworks',          'P. Brunner', 'ZH-207', 0),
    L(T2, '09:55', '11:25', 'Allgemeinbildung — Deutsch',   'C. Lang',    'ZH-208', 0),
    L(T2, '12:25', '14:00', 'M164 SQL & ER-Modell',         'B. Keller',  'ZH-210', 0),
    // +3
    L(T3, '08:00', '09:30', 'M114 Codeverwaltung mit Git', 'Z. Müller', 'ZH-211', 0),
    L(T3, '09:55', '11:25', 'M183 Datenbanken',            'B. Keller', 'ZH-212', 0),
    L(T3, '12:25', '14:00', 'Mathematik Niveau 2',         'S. Vogel',  '412',    0),
    // +4 (4. OG)
    L(T4, '08:00', '09:30', 'M226 OOP mit Java',         'M. Schwarz', '401', 0),
    L(T4, '09:55', '11:25', 'M319 Software-Engineering', 'P. Brunner', '402', 0),
    L(T4, '12:25', '14:00', 'M320 BPMN',                 'A. Hofer',   '403', 0),
    // +5
    L(T5, '08:00', '09:30', 'M347 Docker & K8s',         'L. Weber', '404', 0),
    L(T5, '09:55', '11:25', 'M346 Cloud-Lösungen',       'L. Weber', '405', 0),
    L(T5, '12:25', '14:00', 'Englisch Niveau 3',         'J. Stark', '407', 0),
    // +6
    L(T6, '08:00', '09:30', 'M223 Web-Frameworks',       'P. Brunner', '406', 0),
    L(T6, '09:55', '11:25', 'M450 Datenmodellierung',    'B. Keller',  '408', 0),
    L(T6, '12:25', '14:00', 'Allgemeinbildung — Politik', 'R. Frei',   '409', 0),
    L(T6, '14:15', '15:45', 'M164 SQL & ER-Modell',      'B. Keller',  '410', 0),
  ];

  // ── Absenzen (AbsenzModulRow[]) ─────────────────────────────────────────────
  let aid = 200;
  const absenzenRows = [
    { typ: 'Modul', bezeichnung: 'M114 Codeverwaltung mit Git',       kuerzel_code: 'M114', semester: 'S1', soll: 40, besucht: 39, minimal_pct: 80, isFresh: 0 },
    { typ: 'Modul', bezeichnung: 'M183 Backup-Datenbestand sichern',  kuerzel_code: 'M183', semester: 'S1', soll: 40, besucht: 38, minimal_pct: 80, isFresh: 1 },
    { typ: 'Modul', bezeichnung: 'M226 Objektorientiert programmieren', kuerzel_code: 'M226', semester: 'S1', soll: 36, besucht: 28, minimal_pct: 80, isFresh: 0 },
    { typ: 'Modul', bezeichnung: 'M319 Applikationen entwerfen',      kuerzel_code: 'M319', semester: 'S2', soll: 32, besucht: 30, minimal_pct: 80, isFresh: 0 },
    { typ: 'Modul', bezeichnung: 'M320 Daten der Geschäftsprozesse',  kuerzel_code: 'M320', semester: 'S2', soll: 28, besucht: 27, minimal_pct: 80, isFresh: 0 },
    { typ: 'Modul', bezeichnung: 'M347 Container einsetzen',          kuerzel_code: 'M347', semester: 'S2', soll: 24, besucht: 22, minimal_pct: 80, isFresh: 0 },
    { typ: 'Modul', bezeichnung: 'M223 Multi-User-Applikation',       kuerzel_code: 'M223', semester: 'S2', soll: 30, besucht: 28, minimal_pct: 80, isFresh: 0 },
    { typ: 'GE/PE Überbetrieblicher Kurs', bezeichnung: 'ÜK 5 — Backups & Restore', kuerzel_code: 'UEK5', semester: 'S2', soll: 16, besucht: 16, minimal_pct: 80, isFresh: 0 },
  ].map((r) => {
    const anwesenheit_pct = r.soll ? Math.round((r.besucht / r.soll) * 100) : null;
    return {
      id: ++aid,
      kuerzel_code: r.kuerzel_code,
      typ: r.typ,
      bezeichnung: r.bezeichnung,
      semester: r.semester,
      soll: r.soll,
      besucht: r.besucht,
      absenzen: r.soll - r.besucht,
      minimal_pct: r.minimal_pct,
      anwesenheit_pct,
      anwesenheit_pct_scraped: anwesenheit_pct,
      fetched_at: ISO(NOW - (r.isFresh ? 2 * MIN : 8 * HOUR)),
      isFresh: r.isFresh,
      hasDetail: 1,
    };
  });
  const findAbsenzModul = (code) => absenzenRows.find((r) => r.kuerzel_code === code) || null;

  // ── Absenz-Tagesliste (AbsenzLektionRow[] pro kuerzel_code) ─────────────────
  // Deckt alle status-Kategorien ab: teilgenommen / offen / abwesend_*.
  let tid = 500;
  const TM = (code, raw, iso, von, bis, ist, soll, status, statusRaw) => ({
    id: ++tid,
    kuerzel_code: code,
    termin_raw: raw,
    termin_iso: iso,
    zeit_von: von,
    zeit_bis: bis,
    lektionen_ist: ist,
    lektionen_soll: soll,
    anwesenheit_pct: soll ? Math.round((ist / soll) * 100) : null,
    status,
    status_raw: statusRaw,
    fetched_at: ISO(NOW - 8 * HOUR),
    isFresh: 0,
  });
  const absenzTermine = {
    M114: [
      TM('M114', 'Mo, 2. Mrz 2026 · 08:00–09:30', '2026-03-02', '08:00', '09:30', 2, 2, 'teilgenommen', 'Teilgenommen'),
      TM('M114', 'Di, 3. Mrz 2026 · 09:55–11:25', '2026-03-03', '09:55', '11:25', 2, 2, 'teilgenommen', 'Teilgenommen'),
      TM('M114', 'Mo, 16. Mrz 2026 · 12:25–14:00', '2026-03-16', '12:25', '14:00', 1, 2, 'abwesend_prozent', 'Abwesend 50%'),
      TM('M114', 'Do, 26. Mrz 2026 · 12:25–14:00', '2026-03-26', '12:25', '14:00', 2, 2, 'offen', 'Offen'),
    ],
    M183: [
      TM('M183', 'Mo, 2. Mrz 2026 · 08:00–09:30', '2026-03-02', '08:00', '09:30', 2, 2, 'teilgenommen', 'Teilgenommen'),
      TM('M183', 'Mo, 16. Mrz 2026 · 12:25–14:00', '2026-03-16', '12:25', '14:00', 0, 2, 'abwesend_entschuldigt', 'Entschuldigt (Arzttermin)'),
      TM('M183', 'Do, 26. Mrz 2026 · 12:25–14:00', '2026-03-26', '12:25', '14:00', 2, 2, 'offen', 'Offen'),
    ],
    M226: [
      TM('M226', 'Mo, 2. Mrz 2026 · 08:00–09:30', '2026-03-02', '08:00', '09:30', 2, 2, 'teilgenommen', 'Teilgenommen'),
      TM('M226', 'Do, 5. Mrz 2026 · 14:15–15:45', '2026-03-05', '14:15', '15:45', 0, 2, 'abwesend_unentschuldigt', 'Unentschuldigt'),
      TM('M226', 'Mi, 11. Mrz 2026 · 14:15–15:45', '2026-03-11', '14:15', '15:45', 0, 2, 'abwesend_unentschuldigt', 'Unentschuldigt'),
      TM('M226', 'Fr, 20. Mrz 2026 · 12:25–14:00', '2026-03-20', '12:25', '14:00', 0, 2, 'abwesend_entschuldigt', 'Entschuldigt (krank)'),
      TM('M226', 'Di, 24. Mrz 2026 · 08:00–09:30', '2026-03-24', '08:00', '09:30', 2, 2, 'offen', 'Offen'),
    ],
    UEK5: [
      TM('UEK5', 'Mo, 11. Mai 2026 · 08:00–16:00', '2026-05-11', '08:00', '16:00', 8, 8, 'teilgenommen', 'Teilgenommen'),
      TM('UEK5', 'Di, 12. Mai 2026 · 08:00–16:00', '2026-05-12', '08:00', '16:00', 8, 8, 'offen', 'Offen'),
    ],
  };

  // ── Settings (SettingsView) ─────────────────────────────────────────────────
  const settings = {
    autoRun: true,
    intervalMinutes: 30,
    intervalTimeFrom: '07:00',
    intervalTimeTo: '18:00',
    scheduleMode: 'interval',
    scheduleDays: [1, 2, 3, 4, 5],
    scheduleTimes: ['07:30', '12:00', '17:00'],
    manualScrapeFullDetails: false,
    headless: true,
    slowMo: 0,
    port: 3000,
    telegramEnabled: false,
    telegramAllowedUserId: null,
    baseUrl: 'https://wiss.tocco.ch',
    notenUrl: 'https://wiss.tocco.ch/noten',
    stundenplanUrl: 'https://wiss.tocco.ch/stundenplan',
    urlsLocked: true,
    emailSet: true,
    passwordSet: true,
    telegramTokenSet: false,
    allowUiCredentials: true,
    msEmail: 'demo.user@edu.wiss.ch',
    userPk: '••••••',
  };

  // ── Aggregat-Helfer ─────────────────────────────────────────────────────────
  function notenAgg() {
    const scored = noten.filter((n) => typeof n.note === 'number');
    const avg = scored.length
      ? parseFloat((scored.reduce((a, b) => a + b.note, 0) / scored.length).toFixed(2))
      : null;
    const bucket = {};
    scored.forEach((n) => {
      if (!n.semester) return;
      bucket[n.semester] = bucket[n.semester] || { sum: 0, count: 0 };
      bucket[n.semester].sum += n.note;
      bucket[n.semester].count += 1;
    });
    const bySemester = {};
    Object.keys(bucket).sort().forEach((s) => {
      bySemester[s] = parseFloat((bucket[s].sum / bucket[s].count).toFixed(2));
    });
    return { avg, bySemester };
  }
  const maxFetched = (rows) => {
    const t = rows.reduce((acc, r) => {
      const v = r.fetched_at ? new Date(r.fetched_at).getTime() : 0;
      return v > acc ? v : acc;
    }, 0);
    return t ? ISO(t) : null;
  };

  function buildStats() {
    const agg = notenAgg();
    const graded = noten.filter((n) => typeof n.note === 'number');
    const future = stundenplan
      .map((r) => ({ r, t: new Date(`${r.datum_iso}T${r.zeit_von}:00`).getTime() }))
      .filter((x) => x.t > Date.now())
      .sort((a, b) => a.t - b.t);
    const next = future[0] ? future[0].r : null;
    const changed =
      noten.filter((n) => n.isFresh).length + stundenplan.filter((s) => s.isFresh).length;
    return {
      notenCount: noten.length,
      notenWithGradeCount: graded.length,
      avgNote: agg.avg,
      avgBySemester: agg.bySemester,
      stundenplanUpcoming: future.length,
      lastFetchedNoten: maxFetched(noten),
      lastFetchedStundenplan: maxFetched(stundenplan),
      nextEvent: next
        ? { datum_iso: next.datum_iso, zeit_von: next.zeit_von, veranstaltung: next.veranstaltung, raum: next.raum }
        : null,
      changedRecent: changed,
    };
  }

  // ── Status (ApiStatus) + Live-SSE-Simulation ────────────────────────────────
  let live = {
    running: false,
    currentPhase: null,
    phaseStartedAt: null,
    lastRun: ISO(NOW - 18 * MIN),
    lastError: null,
  };
  function statusPayload() {
    return {
      running: live.running,
      lastRun: live.lastRun,
      nextRun: ISO(Date.now() + 12 * MIN),
      lastError: live.lastError,
      enabled: true,
      intervalMinutes: 30,
      serverTime: ISO(Date.now()),
      currentPhase: live.currentPhase,
      phaseStartedAt: live.phaseStartedAt,
    };
  }

  let activeSse = null;
  let runActive = false;
  function emitStatus() {
    if (activeSse && typeof activeSse._emit === 'function') {
      activeSse._emit('status', statusPayload());
    }
  }
  function simulateAbfrage() {
    if (runActive) return;
    runActive = true;
    const steps = [
      { phase: 'browser', at: 200 },
      { phase: 'login',   at: 1200 },
      { phase: 'noten',   at: 2600 },
      { done: true,       at: 4200 },
    ];
    steps.forEach((s) => setTimeout(() => {
      if (s.done) {
        live = { running: false, currentPhase: null, phaseStartedAt: null, lastRun: ISO(Date.now()), lastError: null };
        emitStatus();
        if (activeSse && typeof activeSse._emit === 'function') {
          activeSse._emit('abfrage_done', { ok: true, error: null, stats: null, finishedAt: ISO(Date.now()) });
        }
        runActive = false;
      } else {
        live = { running: true, currentPhase: s.phase, phaseStartedAt: ISO(Date.now()), lastRun: live.lastRun, lastError: null };
        emitStatus();
        if (activeSse && typeof activeSse._emit === 'function') {
          activeSse._emit('log', { ts: ISO(Date.now()), level: 'info', message: `Phase: ${s.phase}` });
        }
      }
    }, s.at));
  }

  // ── Routen-Tabelle (Shapes exakt nach types.ts) ─────────────────────────────
  const routes = [
    { method: 'GET', re: /^\/api\/healthz\/?$/, handler: () => ({ ok: true }) },
    { method: 'GET', re: /^\/api\/status\/?$/, handler: () => statusPayload() },
    { method: 'GET', re: /^\/api\/version\/?$/, handler: () => ({
        version: '2.1.0', swVersion: 'wn-demo', node: '22.5.1',
        uptimeMs: 7 * DAY, upstream: null, updateAvailable: false,
      }) },

    { method: 'GET', re: /^\/api\/settings\/?$/, handler: () => settings },
    { method: 'PATCH', re: /^\/api\/settings\/?$/, handler: (_m, body) => {
        if (body && typeof body === 'object') {
          for (const k of Object.keys(body)) {
            if (k === 'msPassword' || k === 'telegramToken') continue; // Secrets nie zurück.
            if (body[k] !== undefined && body[k] !== '') settings[k] = body[k];
          }
        }
        return { settings, rescheduled: true, botRestarted: false };
      } },

    // Noten — NotenResponse { rows, count, avg, bySemester, fetchedAt }.
    { method: 'GET', re: /^\/api\/noten\/?$/, handler: () => {
        const agg = notenAgg();
        return { rows: noten, count: noten.length, avg: agg.avg, bySemester: agg.bySemester, fetchedAt: maxFetched(noten) };
      } },

    // Prüfungen — PruefungenResponse.
    { method: 'GET', re: /^\/api\/noten\/([^/]+)\/pruefungen\/?$/, handler: (m) => {
        const id = decodeURIComponent(m[1]);
        const note = noten.find((n) => n.kuerzel_id === id || String(n.id) === id) || null;
        return {
          rows: pruefungen[id] || [],
          modulNote: note ? note.note : null,
          modulNoteRaw: note ? note.note_raw : null,
          detailId: note ? String(note.id) : null,
          fachName: note ? note.fach_name : null,
          fachCode: note ? note.fach_code : null,
          kuerzelCode: note ? note.kuerzel_code : null,
          kuerzelFull: note ? note.kuerzel_full : null,
          semester: note ? note.semester : null,
          typ: note ? note.typ : null,
        };
      } },

    // History — NotenHistoryResponse. Eine kurze Verlaufskette für die frische Note.
    { method: 'GET', re: /^\/api\/history\/([^/]+)\/?$/, handler: (m) => {
        const id = decodeURIComponent(m[1]);
        if (id === 'm183') {
          return { rows: [
            { id: 1, kuerzel_id: 'm183', fach_name: 'Datenbanken', note: 5.0, note_raw: '5.00', recorded_at: ISO(NOW - 20 * DAY) },
            { id: 2, kuerzel_id: 'm183', fach_name: 'Datenbanken', note: 5.4, note_raw: '5.40', recorded_at: ISO(NOW - 2 * MIN) },
          ] };
        }
        return { rows: [] };
      } },

    { method: 'GET', re: /^\/api\/stats\/?$/, handler: () => buildStats() },

    // Absenzen — AbsenzenResponse { rows, count, stats, fetchedAt }.
    { method: 'GET', re: /^\/api\/absenzen\/?$/, handler: () => {
        const pcts = absenzenRows.map((r) => r.anwesenheit_pct).filter((n) => typeof n === 'number');
        const avg = pcts.length ? parseFloat((pcts.reduce((a, b) => a + b, 0) / pcts.length).toFixed(1)) : null;
        const unter = absenzenRows.filter((r) => r.minimal_pct != null && r.anwesenheit_pct != null && r.anwesenheit_pct < r.minimal_pct).length;
        const abwesend = absenzenRows.reduce((acc, r) => acc + Math.max(0, (r.soll || 0) - (r.besucht || 0)), 0);
        return {
          rows: absenzenRows,
          count: absenzenRows.length,
          stats: { avgAnwesenheit: avg, unterMinimum: unter, abwesendGesamt: abwesend },
          fetchedAt: maxFetched(absenzenRows),
        };
      } },

    // Absenz-Tagesliste — AbsenzenLektionenResponse { modul, rows }.
    { method: 'GET', re: /^\/api\/absenzen\/([^/]+)\/termine\/?$/, handler: (m) => {
        const code = decodeURIComponent(m[1]);
        const modul = findAbsenzModul(code) || {
          id: 0, kuerzel_code: code, typ: null, bezeichnung: code, semester: null,
          soll: null, besucht: null, absenzen: null, minimal_pct: null,
          anwesenheit_pct: null, anwesenheit_pct_scraped: null, fetched_at: ISO(NOW), isFresh: 0, hasDetail: 0,
        };
        return { modul, rows: absenzTermine[code] || [] };
      } },

    // Stundenplan — StundenplanResponse { rows, count, fetchedAt }.
    { method: 'GET', re: /^\/api\/stundenplan\/?$/, handler: () => ({
        rows: stundenplan, count: stundenplan.length, fetchedAt: maxFetched(stundenplan),
      }) },

    // Destruktive Ops im Demo: No-Op (Datensatz bleibt erhalten), success-Shape.
    { method: 'POST', re: /^\/api\/stundenplan\/clear\/?$/, handler: () => ({ deleted: 0 }) },
    { method: 'POST', re: /^\/api\/db\/reset\/?$/, handler: () => ({ deleted: {}, total: 0 }) },

    // Abfrage — ScrapeTriggerResponse + SSE-Phasen-Simulation.
    { method: 'POST', re: /^\/api\/(?:abfrage|scrape)\/?$/, handler: () => { simulateAbfrage(); return { triggered: true }; } },

    // Logs — LogsResponse { logs: [{ ts, level, message }] }.
    { method: 'GET', re: /^\/api\/logs\/?$/, handler: () => ({ logs: [
      { ts: ISO(NOW - 18 * MIN), level: 'info', message: 'Abfrage-Zyklus gestartet (manueller Trigger)' },
      { ts: ISO(NOW - 17 * MIN), level: 'info', message: 'Microsoft-SSO Login OK' },
      { ts: ISO(NOW - 17 * MIN), level: 'info', message: 'Noten-Seite geladen — 14 Module gefunden' },
      { ts: ISO(NOW - 17 * MIN), level: 'info', message: 'Stundenplan geladen — 23 Termine' },
      { ts: ISO(NOW - 16 * MIN), level: 'info', message: 'Diff: 1 neue Note (M183 Datenbanken: 5.0 → 5.4)' },
      { ts: ISO(NOW - 16 * MIN), level: 'info', message: 'Diff: 1 Raumwechsel (M319 ZH-204 → ZH-209)' },
      { ts: ISO(NOW - 16 * MIN), level: 'info', message: 'Push gesendet an 2 Subscriptions' },
      { ts: ISO(NOW - 16 * MIN), level: 'info', message: 'Abfrage-Zyklus abgeschlossen in 14.2s' },
    ] }) },

    // Push — VAPID + Subscribe/Unsubscribe/Test.
    { method: 'GET', re: /^\/api\/push\/vapid-key\/?$/, handler: () => ({ publicKey: 'BDemoVapidPublicKey-nicht-echt-nur-fuer-den-Demo-Modus-0000000000000000000000' }) },
    { method: 'POST', re: /^\/api\/push\/subscribe\/?$/, handler: () => ({ ok: true, total: 1 }) },
    { method: 'DELETE', re: /^\/api\/push\/subscribe\/?$/, handler: () => ({ ok: true, removed: 1 }) },
    { method: 'POST', re: /^\/api\/push\/test\/?$/, handler: () => ({ ok: true, sent: 1, removed: 0, errors: 0 }) },

    // Seen — SeenResponse { ok, updated }.
    { method: 'POST', re: /^\/api\/seen\/?$/, handler: (_m, body) => ({
        ok: true, updated: body && Array.isArray(body.ids) ? body.ids.length : 0,
      }) },

    // Dismiss — DismissResponse { ok, dismissed: { noten, stundenplan } }.
    { method: 'POST', re: /^\/api\/dismiss\/?$/, handler: (_m, body) => {
        let dn = 0, ds = 0;
        const clearNoten = () => noten.forEach((n) => { if (n.isFresh) { n.isFresh = 0; dn++; } });
        const clearPlan = () => stundenplan.forEach((s) => { if (s.isFresh) { s.isFresh = 0; ds++; } });
        if (body && body.all) { clearNoten(); clearPlan(); }
        else if (body && body.kind === 'noten' && Array.isArray(body.ids)) {
          body.ids.forEach((id) => { const n = noten.find((x) => x.kuerzel_id === id || x.id === id); if (n && n.isFresh) { n.isFresh = 0; dn++; } });
        } else if (body && body.kind === 'stundenplan' && Array.isArray(body.ids)) {
          body.ids.forEach((id) => { const s = stundenplan.find((x) => x.id === id); if (s && s.isFresh) { s.isFresh = 0; ds++; } });
        } else if (body && body.kind === 'noten') { clearNoten(); }
        else if (body && body.kind === 'stundenplan') { clearPlan(); }
        return { ok: true, dismissed: { noten: dn, stundenplan: ds } };
      } },
  ];

  // ── Fake EventSource für /api/events ────────────────────────────────────────
  const RealEventSource = window.EventSource;
  function DemoEventSource(url, init) {
    if (typeof url === 'string' && /\/api\/events/.test(url)) {
      const listeners = {};
      const es = {
        url, readyState: 1, onmessage: null, onopen: null, onerror: null,
        addEventListener: (n, cb) => { (listeners[n] = listeners[n] || []).push(cb); },
        removeEventListener: (n, cb) => { if (listeners[n]) listeners[n] = listeners[n].filter((f) => f !== cb); },
        close: () => { es.readyState = 2; if (activeSse === es) activeSse = null; },
        _emit: (n, dataObj) => {
          const evt = { data: JSON.stringify(dataObj) };
          (listeners[n] || []).forEach((cb) => { try { cb(evt); } catch (_) {} });
          if (n === 'message' && typeof es.onmessage === 'function') es.onmessage(evt);
        },
        CONNECTING: 0, OPEN: 1, CLOSED: 2,
      };
      activeSse = es;
      setTimeout(() => {
        if (typeof es.onopen === 'function') es.onopen({});
        es._emit('status', statusPayload()); // Initial-Push wie das echte Backend.
      }, 0);
      return es;
    }
    return new RealEventSource(url, init);
  }
  DemoEventSource.CONNECTING = 0;
  DemoEventSource.OPEN = 1;
  DemoEventSource.CLOSED = 2;
  window.EventSource = DemoEventSource;

  // ── fetch-Interceptor ───────────────────────────────────────────────────────
  const origFetch = window.fetch.bind(window);
  const jsonResponse = (payload, status) =>
    new Response(JSON.stringify(payload), {
      status: status || 200,
      headers: { 'Content-Type': 'application/json' },
    });

  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();

    let pathname;
    try {
      const u = url.startsWith('/') ? new URL(url, location.origin) : new URL(url);
      if (u.origin !== location.origin) return origFetch(input, init);
      pathname = u.pathname;
    } catch (_) {
      return origFetch(input, init);
    }
    // Der API-Client baut absolute /api/*-URLs (ohne base-Prefix). Defensiv
    // auch einen evtl. base-Prefix tolerieren.
    const apiIdx = pathname.indexOf('/api/');
    if (apiIdx === -1) return origFetch(input, init);
    const apiPath = pathname.slice(apiIdx);

    let body = null;
    if (init && init.body) {
      try { body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body; } catch (_) {}
    }

    for (const r of routes) {
      if (r.method !== method) continue;
      const m = apiPath.match(r.re);
      if (m) {
        try {
          const result = r.handler(m, body);
          return new Promise((resolve) => setTimeout(() => resolve(jsonResponse(result)), 90));
        } catch (e) {
          return Promise.resolve(jsonResponse({ error: (e && e.message) || 'Demo-Fehler', status: 500 }, 500));
        }
      }
    }
    return Promise.resolve(jsonResponse({ error: 'Demo-API: Endpoint nicht gestubbt: ' + method + ' ' + apiPath, status: 404 }, 404));
  };

  console.info('[WISSen Demo] Desktop-Mock-API aktiv — alle Daten sind Beispieldaten, keine echten Schul-Infos.');
})();
