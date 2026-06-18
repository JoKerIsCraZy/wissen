/* ============================================================
   WISSen PWA — Demo-Modus
   Mock-API-Layer für die statische Embed-Demo auf GitHub Pages.
   Intercepts ALL window.fetch() calls to /api/* and serves
   deterministic, realistic German school data.
   Loaded BEFORE mobile.js — so by the time mobile.js calls apiFetch(),
   the global fetch is already patched.
   ============================================================ */
(function () {
  'use strict';

  // 1) Auto-set token so the login overlay never appears.
  try { localStorage.setItem('wissen.authToken', 'demo-token'); } catch (_) {}

  // 2) Disable service-worker registration in demo (would conflict with docs site).
  if ('serviceWorker' in navigator) {
    const noop = () => Promise.resolve({ scope: '/pwa-demo/', unregister: () => Promise.resolve(true) });
    navigator.serviceWorker.register = noop;
    // Unregister any previously-registered SW from this scope.
    navigator.serviceWorker.getRegistrations().then(rs => rs.forEach(r => r.unregister().catch(() => {})));
  }

  // 3) Build the demo dataset.
  const NOW = Date.now();
  const ISO = (d) => new Date(d).toISOString();
  const dayOffset = (n) => {
    const d = new Date(NOW);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + n);
    return d;
  };
  // LOKALES Datum (nicht toISOString — das wäre UTC und würde in CET/CEST die
  // „heute"-Lektionen auf den Vortag und die „morgen"-Lektionen auf heute
  // schieben, sodass die Aktuell-Seite den falschen Tag als „heute" liest).
  const fmtDate = (d) => d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0'); // lokales YYYY-MM-DD

  // Noten — kuerzel_id wird vom Frontend an /api/noten/:kuerzelId/pruefungen
  // weitergereicht. Die ID muss also als pruefungen-Map-Key existieren.
  const noten = [
    { id: 'n1',  kuerzel_id: 'm114', kuerzel_code: 'M114', kuerzel_full: 'M114 Codeverwaltung mit Git',  fach_name: 'Codeverwaltung mit Git',  fach_code: 'M114', note: 5.4, note_raw: '5.40', semester: 'S1', typ: 'Modul', isFresh: 0, prev_note: null, fetched_at: ISO(NOW - 1000 * 60 * 60 * 26) },
    { id: 'n2',  kuerzel_id: 'm183', kuerzel_code: 'M183', kuerzel_full: 'M183 Backup-Datenbestand sichern', fach_name: 'Datenbanken',         fach_code: 'M183', note: 5.4, note_raw: '5.40', semester: 'S1', typ: 'Modul', isFresh: 1, prev_note: 5.0, fetched_at: ISO(NOW - 1000 * 60 * 2) },
    { id: 'n3',  kuerzel_id: 'm226', kuerzel_code: 'M226', kuerzel_full: 'M226 Objektorientiert programmieren', fach_name: 'OOP mit Java',     fach_code: 'M226', note: 4.8, note_raw: '4.80', semester: 'S1', typ: 'Modul', isFresh: 0, prev_note: null, fetched_at: ISO(NOW - 1000 * 60 * 60 * 48) },
    { id: 'n4',  kuerzel_id: 'm319', kuerzel_code: 'M319', kuerzel_full: 'M319 Applikationen entwerfen', fach_name: 'Software-Engineering',    fach_code: 'M319', note: 5.0, note_raw: '5.00', semester: 'S2', typ: 'Modul', isFresh: 0, prev_note: null, fetched_at: ISO(NOW - 1000 * 60 * 60 * 96) },
    { id: 'n5',  kuerzel_id: 'm320', kuerzel_code: 'M320', kuerzel_full: 'M320 Daten der Geschäftsprozesse', fach_name: 'BPMN',                fach_code: 'M320', note: 5.2, note_raw: '5.20', semester: 'S2', typ: 'Modul', isFresh: 0, prev_note: null, fetched_at: ISO(NOW - 1000 * 60 * 60 * 72) },
    { id: 'n6',  kuerzel_id: 'm164', kuerzel_code: 'M164', kuerzel_full: 'M164 Datenbanken erstellen',    fach_name: 'SQL & ER-Modell',        fach_code: 'M164', note: 5.5, note_raw: '5.50', semester: 'S1', typ: 'Modul', isFresh: 0, prev_note: null, fetched_at: ISO(NOW - 1000 * 60 * 60 * 120) },
    { id: 'n7',  kuerzel_id: 'm346', kuerzel_code: 'M346', kuerzel_full: 'M346 Cloud-Lösungen konzipieren', fach_name: 'AWS & Azure Basics',   fach_code: 'M346', note: 4.6, note_raw: '4.60', semester: 'S2', typ: 'Modul', isFresh: 0, prev_note: null, fetched_at: ISO(NOW - 1000 * 60 * 60 * 200) },
    { id: 'n8',  kuerzel_id: 'm347', kuerzel_code: 'M347', kuerzel_full: 'M347 Container einsetzen',      fach_name: 'Docker & K8s',           fach_code: 'M347', note: 5.7, note_raw: '5.70', semester: 'S2', typ: 'Modul', isFresh: 0, prev_note: null, fetched_at: ISO(NOW - 1000 * 60 * 60 * 156) },
    { id: 'n9',  kuerzel_id: 'm223', kuerzel_code: 'M223', kuerzel_full: 'M223 Multi-User-Applikation',   fach_name: 'Web-Frameworks',         fach_code: 'M223', note: 4.9, note_raw: '4.90', semester: 'S2', typ: 'Modul', isFresh: 0, prev_note: null, fetched_at: ISO(NOW - 1000 * 60 * 60 * 240) },
    { id: 'n10', kuerzel_id: 'm450', kuerzel_code: 'M450', kuerzel_full: 'M450 Datenmodelle entwickeln',  fach_name: 'Datenmodellierung',      fach_code: 'M450', note: 5.1, note_raw: '5.10', semester: 'S3', typ: 'Modul', isFresh: 0, prev_note: null, fetched_at: ISO(NOW - 1000 * 60 * 60 * 300) },
    { id: 'n11', kuerzel_id: 'all1', kuerzel_code: 'ALL1', kuerzel_full: 'Allgemeinbildung — Sprache & Kommunikation', fach_name: 'Deutsch',  fach_code: 'ALL1', note: 5.0, note_raw: '5.00', semester: 'S1', typ: 'AB',    isFresh: 0, prev_note: null, fetched_at: ISO(NOW - 1000 * 60 * 60 * 70) },
    { id: 'n12', kuerzel_id: 'all2', kuerzel_code: 'ALL2', kuerzel_full: 'Allgemeinbildung — Gesellschaft', fach_name: 'Geschichte & Politik', fach_code: 'ALL2', note: 4.5, note_raw: '4.50', semester: 'S1', typ: 'AB',    isFresh: 0, prev_note: null, fetched_at: ISO(NOW - 1000 * 60 * 60 * 90) },
    // Mathe + Englisch — kuerzel_code trägt das -N<digit> Niveau-Suffix, damit
    // der BK-Filter (/-N\d+$/) sie ausschliesst und der QV-Rechner sie als
    // „M+E"-Box (10 %) zählt. fach_name enthält 'Mathematik' / 'Englisch'.
    { id: 'n13', kuerzel_id: 'matn2', kuerzel_code: 'MAT-N2', kuerzel_full: 'Mathematik Niveau 2', fach_name: 'Mathematik',         fach_code: 'MAT', note: 4.7, note_raw: '4.70', semester: 'S1', typ: 'Modul', isFresh: 0, prev_note: null, fetched_at: ISO(NOW - 1000 * 60 * 60 * 110) },
    { id: 'n14', kuerzel_id: 'engn3', kuerzel_code: 'ENG-N3', kuerzel_full: 'Englisch Niveau 3',   fach_name: 'Englisch',           fach_code: 'ENG', note: 5.3, note_raw: '5.30', semester: 'S2', typ: 'Modul', isFresh: 0, prev_note: null, fetched_at: ISO(NOW - 1000 * 60 * 60 * 130) },
  ];

  // Helper: find a note row by kuerzel_id (used by /api/noten/:id/pruefungen).
  const findNote = (id) => noten.find((n) => n.kuerzel_id === id || n.id === id) || null;

  // Pruefungen — exakter Backend-Kontrakt (siehe src/db/noten.js -> getPruefungen):
  //   pruefung_typ : 'ZP' | 'LB' | sonstige
  //   pruefung_nr  : 1..N (für Tag-Anzeige "ZP1" / "LB2")
  //   bezeichnung  : freier Titel
  //   bewertung    : Note als Zahl (5.4) — NICHT als String
  //   bewertung_raw: Note als String fürs Anzeigen ("5.40")
  //   gewicht_pct  : 0..100 (Prozent) — pruefungCard rechnet daraus den
  //                  String "50%". Alternativ kann gewicht (Roh-Text) gesetzt
  //                  werden und überschreibt dann die Prozent-Anzeige.
  //   prev_bewertung: optional, triggert die "5.0 → 5.4"-Diff-Anzeige.
  const pruefungen = {
    m114: [
      { id: 'p1',  fach_id: 'm114', pruefung_typ: 'LB', pruefung_nr: 1, bezeichnung: 'Git Basics — Branching & Commits',          bewertung: 5.0, bewertung_raw: '5.00', gewicht_pct: 40, datum: '2026-03-12', isFresh: 0 },
      { id: 'p2',  fach_id: 'm114', pruefung_typ: 'LB', pruefung_nr: 2, bezeichnung: 'Merge-Konflikte & Rebase',                  bewertung: 5.7, bewertung_raw: '5.70', gewicht_pct: 60, datum: '2026-04-22', isFresh: 0 },
    ],
    m183: [
      { id: 'p3',  fach_id: 'm183', pruefung_typ: 'ZP', pruefung_nr: 1, bezeichnung: 'SQL Basics — SELECT, JOIN, WHERE',          bewertung: 5.0, bewertung_raw: '5.00', gewicht_pct: 50, datum: '2026-03-08', isFresh: 0, prev_bewertung: 4.5 },
      { id: 'p4',  fach_id: 'm183', pruefung_typ: 'ZP', pruefung_nr: 2, bezeichnung: 'Backup-Strategien & Restore-Drill',         bewertung: 5.8, bewertung_raw: '5.80', gewicht_pct: 50, datum: '2026-05-09', isFresh: 1 },
    ],
    m226: [
      { id: 'p5',  fach_id: 'm226', pruefung_typ: 'LB', pruefung_nr: 1, bezeichnung: 'Klassen, Vererbung & Konstruktoren',        bewertung: 4.5, bewertung_raw: '4.50', gewicht_pct: 50, datum: '2026-03-15', isFresh: 0 },
      { id: 'p6',  fach_id: 'm226', pruefung_typ: 'LB', pruefung_nr: 2, bezeichnung: 'Interfaces & Polymorphie',                  bewertung: 5.1, bewertung_raw: '5.10', gewicht_pct: 50, datum: '2026-04-30', isFresh: 0 },
    ],
    m319: [
      { id: 'p7',  fach_id: 'm319', pruefung_typ: 'ZP', pruefung_nr: 1, bezeichnung: 'UML-Diagramme & GoF-Patterns',              bewertung: 5.0, bewertung_raw: '5.00', gewicht_pct: 100, datum: '2026-04-05', isFresh: 0 },
    ],
    m320: [
      { id: 'p8',  fach_id: 'm320', pruefung_typ: 'LB', pruefung_nr: 1, bezeichnung: 'BPMN-Modellierung Webshop-Prozess',         bewertung: 5.2, bewertung_raw: '5.20', gewicht_pct: 100, datum: '2026-04-12', isFresh: 0 },
    ],
    m164: [
      { id: 'p9',  fach_id: 'm164', pruefung_typ: 'LB', pruefung_nr: 1, bezeichnung: 'ER-Modell — Entitäten & Beziehungen',       bewertung: 5.5, bewertung_raw: '5.50', gewicht_pct: 50, datum: '2026-02-20', isFresh: 0 },
      { id: 'p10', fach_id: 'm164', pruefung_typ: 'LB', pruefung_nr: 2, bezeichnung: 'Normalisierung bis 3NF',                    bewertung: 5.5, bewertung_raw: '5.50', gewicht_pct: 50, datum: '2026-03-25', isFresh: 0 },
    ],
    m346: [
      { id: 'p11', fach_id: 'm346', pruefung_typ: 'ZP', pruefung_nr: 1, bezeichnung: 'Cloud-Architektur — IaaS / PaaS / SaaS',    bewertung: 4.6, bewertung_raw: '4.60', gewicht_pct: 100, datum: '2026-04-18', isFresh: 0 },
    ],
    m347: [
      { id: 'p12', fach_id: 'm347', pruefung_typ: 'LB', pruefung_nr: 1, bezeichnung: 'Docker Compose Multi-Service-Stack',        bewertung: 5.5, bewertung_raw: '5.50', gewicht_pct: 50, datum: '2026-03-30', isFresh: 0 },
      { id: 'p13', fach_id: 'm347', pruefung_typ: 'LB', pruefung_nr: 2, bezeichnung: 'Kubernetes Deployment & Services',         bewertung: 5.9, bewertung_raw: '5.90', gewicht_pct: 50, datum: '2026-05-02', isFresh: 0 },
    ],
    m223: [
      { id: 'p14', fach_id: 'm223', pruefung_typ: 'ZP', pruefung_nr: 1, bezeichnung: 'SvelteKit-App mit Auth & SSR',              bewertung: 4.9, bewertung_raw: '4.90', gewicht_pct: 100, datum: '2026-04-08', isFresh: 0 },
    ],
    m450: [
      { id: 'p15', fach_id: 'm450', pruefung_typ: 'LB', pruefung_nr: 1, bezeichnung: 'Konzeptionelles Datenmodell — Domäne',     bewertung: 5.1, bewertung_raw: '5.10', gewicht_pct: 100, datum: '2026-04-25', isFresh: 0 },
    ],
    all1: [
      { id: 'p16', fach_id: 'all1', pruefung_typ: 'ZP', pruefung_nr: 1, bezeichnung: 'Aufsatz — Argumentative Erörterung',        bewertung: 5.0, bewertung_raw: '5.00', gewicht_pct: 100, datum: '2026-03-20', isFresh: 0 },
    ],
    all2: [
      { id: 'p17', fach_id: 'all2', pruefung_typ: 'ZP', pruefung_nr: 1, bezeichnung: 'Politik-Test Schweiz & Demokratie',        bewertung: 4.5, bewertung_raw: '4.50', gewicht_pct: 100, datum: '2026-03-28', isFresh: 0 },
    ],
    matn2: [
      { id: 'p18', fach_id: 'matn2', pruefung_typ: 'ZP', pruefung_nr: 1, bezeichnung: 'Algebra & Funktionen',                    bewertung: 4.4, bewertung_raw: '4.40', gewicht_pct: 50, datum: '2026-03-10', isFresh: 0 },
      { id: 'p19', fach_id: 'matn2', pruefung_typ: 'ZP', pruefung_nr: 2, bezeichnung: 'Geometrie & Trigonometrie',               bewertung: 5.0, bewertung_raw: '5.00', gewicht_pct: 50, datum: '2026-04-28', isFresh: 0 },
    ],
    engn3: [
      { id: 'p20', fach_id: 'engn3', pruefung_typ: 'LB', pruefung_nr: 1, bezeichnung: 'Reading & Listening Comprehension',       bewertung: 5.2, bewertung_raw: '5.20', gewicht_pct: 50, datum: '2026-03-18', isFresh: 0 },
      { id: 'p21', fach_id: 'engn3', pruefung_typ: 'LB', pruefung_nr: 2, bezeichnung: 'Writing & Speaking B2',                   bewertung: 5.4, bewertung_raw: '5.40', gewicht_pct: 50, datum: '2026-05-06', isFresh: 0 },
    ],
  };

  // Build a realistic two-week schedule including today + tomorrow + raumwechsel.
  const stundenplan = (function () {
    const lessons = [
      { veranstaltung: 'M114 Codeverwaltung mit Git', dozent: 'Z. Müller',  klasse: 'AP24f', raum: 'ZH-201', zeit_von: '08:00', zeit_bis: '09:30' },
      { veranstaltung: 'M183 Datenbanken',            dozent: 'B. Keller',  klasse: 'AP24f', raum: 'ZH-202', zeit_von: '09:55', zeit_bis: '11:25' },
      { veranstaltung: 'M226 OOP mit Java',           dozent: 'M. Schwarz', klasse: 'AP24f', raum: 'ZH-203', zeit_von: '12:25', zeit_bis: '14:00' },
      { veranstaltung: 'M319 Software-Engineering',   dozent: 'P. Brunner', klasse: 'AP24f', raum: 'ZH-204', zeit_von: '14:15', zeit_bis: '15:45' },
      { veranstaltung: 'M320 BPMN',                   dozent: 'A. Hofer',   klasse: 'AP24f', raum: 'ZH-205', zeit_von: '08:00', zeit_bis: '09:30' },
      { veranstaltung: 'M347 Docker & K8s',           dozent: 'L. Weber',   klasse: 'AP24f', raum: 'ZH-206', zeit_von: '09:55', zeit_bis: '11:25' },
      { veranstaltung: 'M346 Cloud-Lösungen',         dozent: 'L. Weber',   klasse: 'AP24f', raum: 'Online', zeit_von: '12:25', zeit_bis: '14:00' },
      { veranstaltung: 'M223 Web-Frameworks',         dozent: 'P. Brunner', klasse: 'AP24f', raum: 'ZH-207', zeit_von: '14:15', zeit_bis: '15:45' },
      { veranstaltung: 'Allgemeinbildung — Deutsch',  dozent: 'C. Lang',    klasse: 'AP24f', raum: 'ZH-208', zeit_von: '08:00', zeit_bis: '09:30' },
      { veranstaltung: 'Allgemeinbildung — Politik',  dozent: 'R. Frei',    klasse: 'AP24f', raum: 'ZH-208', zeit_von: '09:55', zeit_bis: '11:25' },
    ];
    // ── Heute: echter, FIXER Tagesplan mit realen Uhrzeiten (08:00–15:45).
    //    Die Aktuell-Seite bestimmt die laufende/nächste Lektion aus der
    //    REALEN Uhrzeit — z.B. um 13:22 ist die 12:25–14:00-Lektion „live".
    //    Alle Heute-Räume sind echte ZH-Zimmer, damit immer ein Raumplan
    //    rendert. (Die Online-Lektion M346 liegt morgen — dort bleibt der
    //    Online-Fall im Stundenplan sichtbar.)
    const out = [];
    let id = 0;
    const todayDate = fmtDate(dayOffset(0));

    out.push({ id: 't' + (++id), datum_iso: todayDate, ...lessons[0],
      fetched_at: ISO(NOW - 1000 * 60 * 60), isFresh: 0 });          // 08:00–09:30 · ZH-201
    out.push({ id: 't' + (++id), datum_iso: todayDate, ...lessons[1],
      fetched_at: ISO(NOW - 1000 * 60 * 60), isFresh: 0 });          // 09:55–11:25 · ZH-202
    out.push({ id: 't' + (++id), datum_iso: todayDate, ...lessons[2],
      fetched_at: ISO(NOW - 1000 * 60 * 60), isFresh: 0 });          // 12:25–14:00 · ZH-203
    // Letzte Lektion heute — FRISCHER Zimmerwechsel (treibt Push-Toast + „Letzte Änderung").
    out.push({ id: 't' + (++id), datum_iso: todayDate, ...lessons[3],
      raum: 'ZH-209', prev_raum: 'ZH-204',
      fetched_at: ISO(NOW - 1000 * 60 * 5), isFresh: 1 });           // 14:15–15:45 · ZH-204→ZH-209

    // Tomorrow: 3 lessons
    const tomDate = fmtDate(dayOffset(1));
    out.push({ id: 't' + (++id), datum_iso: tomDate, ...lessons[4], fetched_at: ISO(NOW - 1000 * 60 * 60 * 4), isFresh: 0 });
    out.push({ id: 't' + (++id), datum_iso: tomDate, ...lessons[5], fetched_at: ISO(NOW - 1000 * 60 * 60 * 4), isFresh: 0 });
    out.push({ id: 't' + (++id), datum_iso: tomDate, ...lessons[6], fetched_at: ISO(NOW - 1000 * 60 * 60 * 4), isFresh: 0 });

    // Day +2: 4 lessons
    const d2 = fmtDate(dayOffset(2));
    out.push({ id: 't' + (++id), datum_iso: d2, ...lessons[7], fetched_at: ISO(NOW - 1000 * 60 * 60 * 6), isFresh: 0 });
    out.push({ id: 't' + (++id), datum_iso: d2, ...lessons[8], fetched_at: ISO(NOW - 1000 * 60 * 60 * 6), isFresh: 0 });
    out.push({ id: 't' + (++id), datum_iso: d2, ...lessons[9], fetched_at: ISO(NOW - 1000 * 60 * 60 * 6), isFresh: 0 });

    // Day +3: 2 lessons
    const d3 = fmtDate(dayOffset(3));
    out.push({ id: 't' + (++id), datum_iso: d3, ...lessons[0], fetched_at: ISO(NOW - 1000 * 60 * 60 * 8), isFresh: 0 });
    out.push({ id: 't' + (++id), datum_iso: d3, ...lessons[1], fetched_at: ISO(NOW - 1000 * 60 * 60 * 8), isFresh: 0 });

    // Day +6 (next week)
    const d6 = fmtDate(dayOffset(6));
    out.push({ id: 't' + (++id), datum_iso: d6, ...lessons[2], fetched_at: ISO(NOW - 1000 * 60 * 60 * 10), isFresh: 0 });
    out.push({ id: 't' + (++id), datum_iso: d6, ...lessons[3], fetched_at: ISO(NOW - 1000 * 60 * 60 * 10), isFresh: 0 });

    return out;
  })();

  const settings = {
    scheduler: { mode: 'interval', intervalMinutes: 30 },
    telegram: { enabled: false },
    msEmail: 'demo.user@schule.ch',
    msPasswordSet: true,
    allowUiCredentials: true,
  };

  const status = {
    server: { uptime: 7 * 24 * 60 * 60, version: '1.0.0', node: '22.5.1' },
    scheduler: { mode: 'interval', intervalMinutes: 30, nextRunAt: ISO(NOW + 1000 * 60 * 12) },
    lastScrape: { startedAt: ISO(NOW - 1000 * 60 * 18), durationMs: 14_200, ok: true },
  };

  // --- Live scrape status + Phasen-Simulation (Demo-only) ------------------
  // Die echte PWA bekommt den Abfrage-Fortschritt per SSE vom Scraper. In der
  // Demo gibt es kein Backend — daher simulieren wir nach einem POST
  // /api/abfrage eine Phasen-Sequenz (browser → login → Daten → fertig) und
  // pushen sie über den gefälschten EventSource. So animiert die Scrape-Card
  // über exakt denselben Render-Pfad wie in Prod.
  let activeDemoSse = null;
  let demoRunActive = false;
  let liveStatus = {
    running: false,
    currentPhase: null,
    phaseStartedAt: null,
    lastRun: ISO(NOW - 1000 * 60 * 18),
    lastError: null,
  };
  const statusPayload = () => Object.assign({}, status, liveStatus);
  function emitStatus() {
    if (activeDemoSse && typeof activeDemoSse._emit === 'function') {
      activeDemoSse._emit('status', statusPayload());
    }
  }
  function simulateAbfrage() {
    if (demoRunActive) return;
    demoRunActive = true;
    const steps = [
      { phase: 'browser', at: 150 },
      { phase: 'login',   at: 1100 },
      { phase: 'noten',   at: 2300 },
      { done: true,       at: 3700 },
    ];
    steps.forEach((s) => setTimeout(() => {
      liveStatus = s.done
        ? { running: false, currentPhase: null, phaseStartedAt: null, lastRun: ISO(Date.now()), lastError: null }
        : { running: true, currentPhase: s.phase, phaseStartedAt: ISO(Date.now()), lastRun: liveStatus.lastRun, lastError: null };
      if (s.done) demoRunActive = false;
      emitStatus();
    }, s.at));
  }

  // Compute live aggregate stats from the noten array so the Noten hero card
  // (Durchschnitt + per-Semester) gets the same shape as the production API
  // returns. Recomputed on every /api/noten request to reflect dismiss-state
  // changes (frische Markierungen können sich auf den Tile-Count auswirken,
  // aber die Schnitte bleiben stabil).
  function buildNotenStats() {
    const scored = noten.filter((n) => typeof n.note === 'number');
    const avg = scored.length
      ? parseFloat((scored.reduce((a, b) => a + b.note, 0) / scored.length).toFixed(2))
      : null;
    const bySemester = {};
    scored.forEach((n) => {
      if (!n.semester) return;
      bySemester[n.semester] = bySemester[n.semester] || { sum: 0, count: 0 };
      bySemester[n.semester].sum += n.note;
      bySemester[n.semester].count += 1;
    });
    const avgBySemester = {};
    Object.keys(bySemester).sort().forEach((sem) => {
      avgBySemester[sem] = parseFloat((bySemester[sem].sum / bySemester[sem].count).toFixed(2));
    });
    return { avg, bySemester: avgBySemester };
  }

  // Stats — Shape die views/stats.js erwartet: notenCount, notenWithGradeCount,
  // avgNote. drawStats liest NUR diese drei Felder; der Rest (Histogramm, Top/
  // Flop, QV) wird clientseitig aus /api/noten abgeleitet.
  const stats = (function () {
    const ns = buildNotenStats();
    const graded = noten.filter((n) => typeof n.note === 'number');
    return {
      notenCount: noten.length,
      notenWithGradeCount: graded.length,
      avgNote: ns.avg,
    };
  })();

  // ============================================================
  // Absenzen — vierte Daten-Achse (Anwesenheit pro Modul + Tagesliste).
  // Wiederverwendung der bestehenden Modul-Codes/Bezeichnungen aus der noten-
  // Liste. Variierte Anwesenheit: die meisten ≥ 90, M226 unter Minimum (78 <
  // 80) → unterMinimum > 0 + „Unter Minimum"-Chip greift. Zwei distinkte typ-
  // Werte (Modul / GE-PE ÜK) → Typ-Chips rendern. Eine Zeile isFresh:1.
  // ============================================================
  const absenzenRows = [
    { typ: 'Modul', bezeichnung: 'M114 Codeverwaltung mit Git', kuerzel_code: 'M114', semester: 'S1', soll: 40, besucht: 39, anwesenheit_pct: 98, minimal_pct: 80, isFresh: 0 },
    { typ: 'Modul', bezeichnung: 'M183 Backup-Datenbestand sichern', kuerzel_code: 'M183', semester: 'S1', soll: 40, besucht: 38, anwesenheit_pct: 95, minimal_pct: 80, isFresh: 1 },
    { typ: 'Modul', bezeichnung: 'M226 Objektorientiert programmieren', kuerzel_code: 'M226', semester: 'S1', soll: 36, besucht: 28, anwesenheit_pct: 78, minimal_pct: 80, isFresh: 0 },
    { typ: 'Modul', bezeichnung: 'M319 Applikationen entwerfen', kuerzel_code: 'M319', semester: 'S2', soll: 32, besucht: 30, anwesenheit_pct: 94, minimal_pct: 80, isFresh: 0 },
    { typ: 'Modul', bezeichnung: 'M320 Daten der Geschäftsprozesse', kuerzel_code: 'M320', semester: 'S2', soll: 28, besucht: 27, anwesenheit_pct: 96, minimal_pct: 80, isFresh: 0 },
    { typ: 'Modul', bezeichnung: 'M347 Container einsetzen', kuerzel_code: 'M347', semester: 'S2', soll: 24, besucht: 22, anwesenheit_pct: 92, minimal_pct: 80, isFresh: 0 },
    { typ: 'Modul', bezeichnung: 'M223 Multi-User-Applikation', kuerzel_code: 'M223', semester: 'S2', soll: 30, besucht: 28, anwesenheit_pct: 93, minimal_pct: 80, isFresh: 0 },
    { typ: 'GE/PE Überbetrieblicher Kurs', bezeichnung: 'ÜK 5 — Backups & Restore', kuerzel_code: 'UEK5', semester: 'S2', soll: 16, besucht: 16, anwesenheit_pct: 100, minimal_pct: 80, isFresh: 0 },
  ];

  // Absenz-Stats aus den rows abgeleitet — avgAnwesenheit = Mittel der
  // anwesenheit_pct, unterMinimum = Anzahl unter Minimum, abwesendGesamt =
  // plausible kleine Ganzzahl (Summe Soll − Besucht).
  const absenzenStats = (function () {
    const pcts = absenzenRows.map((r) => r.anwesenheit_pct).filter((n) => typeof n === 'number');
    const avg = pcts.length
      ? parseFloat((pcts.reduce((a, b) => a + b, 0) / pcts.length).toFixed(1))
      : null;
    const unterMin = absenzenRows.filter(
      (r) => r.minimal_pct != null && r.anwesenheit_pct != null && r.anwesenheit_pct < r.minimal_pct,
    ).length;
    const abwesend = absenzenRows.reduce(
      (acc, r) => acc + Math.max(0, (r.soll || 0) - (r.besucht || 0)), 0,
    );
    return { avgAnwesenheit: avg, unterMinimum: unterMin, abwesendGesamt: abwesend };
  })();

  // Tagesliste pro Modul (kuerzel_code → termine[]). Spiegelt das pruefungen-
  // Map-Pattern. Über den ganzen Datensatz werden ALLE status-Werte mindestens
  // einmal abgedeckt: teilgenommen, offen, abwesend_entschuldigt,
  // abwesend_unentschuldigt, abwesend_prozent. Letztere trägt status_raw
  // 'Abwesend 50%'. termin_raw = deutsches Langdatum + Zeitspanne.
  const absenzTermine = {
    M114: [
      { termin_raw: 'Mo, 2. Mrz 2026 · 08:00–09:30', termin_iso: '2026-03-02', zeit_von: '08:00', zeit_bis: '09:30', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Di, 3. Mrz 2026 · 09:55–11:25', termin_iso: '2026-03-03', zeit_von: '09:55', zeit_bis: '11:25', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Mi, 4. Mrz 2026 · 12:25–14:00', termin_iso: '2026-03-04', zeit_von: '12:25', zeit_bis: '14:00', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Do, 5. Mrz 2026 · 14:15–15:45', termin_iso: '2026-03-05', zeit_von: '14:15', zeit_bis: '15:45', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Fr, 6. Mrz 2026 · 08:00–09:30', termin_iso: '2026-03-06', zeit_von: '08:00', zeit_bis: '09:30', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Mo, 9. Mrz 2026 · 09:55–11:25', termin_iso: '2026-03-09', zeit_von: '09:55', zeit_bis: '11:25', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Di, 10. Mrz 2026 · 12:25–14:00', termin_iso: '2026-03-10', zeit_von: '12:25', zeit_bis: '14:00', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Mi, 11. Mrz 2026 · 14:15–15:45', termin_iso: '2026-03-11', zeit_von: '14:15', zeit_bis: '15:45', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Do, 12. Mrz 2026 · 08:00–09:30', termin_iso: '2026-03-12', zeit_von: '08:00', zeit_bis: '09:30', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Fr, 13. Mrz 2026 · 09:55–11:25', termin_iso: '2026-03-13', zeit_von: '09:55', zeit_bis: '11:25', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Mo, 16. Mrz 2026 · 12:25–14:00', termin_iso: '2026-03-16', zeit_von: '12:25', zeit_bis: '14:00', lektionen_ist: 1, lektionen_soll: 2, anwesenheit_pct: 50, status: 'abwesend_prozent', status_raw: 'Abwesend 50%' },
      { termin_raw: 'Di, 17. Mrz 2026 · 14:15–15:45', termin_iso: '2026-03-17', zeit_von: '14:15', zeit_bis: '15:45', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Mi, 18. Mrz 2026 · 08:00–09:30', termin_iso: '2026-03-18', zeit_von: '08:00', zeit_bis: '09:30', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Do, 19. Mrz 2026 · 09:55–11:25', termin_iso: '2026-03-19', zeit_von: '09:55', zeit_bis: '11:25', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Fr, 20. Mrz 2026 · 12:25–14:00', termin_iso: '2026-03-20', zeit_von: '12:25', zeit_bis: '14:00', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Mo, 23. Mrz 2026 · 14:15–15:45', termin_iso: '2026-03-23', zeit_von: '14:15', zeit_bis: '15:45', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Di, 24. Mrz 2026 · 08:00–09:30', termin_iso: '2026-03-24', zeit_von: '08:00', zeit_bis: '09:30', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Mi, 25. Mrz 2026 · 09:55–11:25', termin_iso: '2026-03-25', zeit_von: '09:55', zeit_bis: '11:25', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Do, 26. Mrz 2026 · 12:25–14:00', termin_iso: '2026-03-26', zeit_von: '12:25', zeit_bis: '14:00', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'offen', status_raw: 'Offen' },
      { termin_raw: 'Fr, 27. Mrz 2026 · 14:15–15:45', termin_iso: '2026-03-27', zeit_von: '14:15', zeit_bis: '15:45', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'offen', status_raw: 'Offen' },
    ],
    M183: [
      { termin_raw: 'Mo, 2. Mrz 2026 · 08:00–09:30', termin_iso: '2026-03-02', zeit_von: '08:00', zeit_bis: '09:30', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Di, 3. Mrz 2026 · 09:55–11:25', termin_iso: '2026-03-03', zeit_von: '09:55', zeit_bis: '11:25', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Mi, 4. Mrz 2026 · 12:25–14:00', termin_iso: '2026-03-04', zeit_von: '12:25', zeit_bis: '14:00', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Do, 5. Mrz 2026 · 14:15–15:45', termin_iso: '2026-03-05', zeit_von: '14:15', zeit_bis: '15:45', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Fr, 6. Mrz 2026 · 08:00–09:30', termin_iso: '2026-03-06', zeit_von: '08:00', zeit_bis: '09:30', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Mo, 9. Mrz 2026 · 09:55–11:25', termin_iso: '2026-03-09', zeit_von: '09:55', zeit_bis: '11:25', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Di, 10. Mrz 2026 · 12:25–14:00', termin_iso: '2026-03-10', zeit_von: '12:25', zeit_bis: '14:00', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Mi, 11. Mrz 2026 · 14:15–15:45', termin_iso: '2026-03-11', zeit_von: '14:15', zeit_bis: '15:45', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Do, 12. Mrz 2026 · 08:00–09:30', termin_iso: '2026-03-12', zeit_von: '08:00', zeit_bis: '09:30', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Fr, 13. Mrz 2026 · 09:55–11:25', termin_iso: '2026-03-13', zeit_von: '09:55', zeit_bis: '11:25', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Mo, 16. Mrz 2026 · 12:25–14:00', termin_iso: '2026-03-16', zeit_von: '12:25', zeit_bis: '14:00', lektionen_ist: 0, lektionen_soll: 2, anwesenheit_pct: 0, status: 'abwesend_entschuldigt', status_raw: 'Entschuldigt (Arzttermin)' },
      { termin_raw: 'Di, 17. Mrz 2026 · 14:15–15:45', termin_iso: '2026-03-17', zeit_von: '14:15', zeit_bis: '15:45', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Mi, 18. Mrz 2026 · 08:00–09:30', termin_iso: '2026-03-18', zeit_von: '08:00', zeit_bis: '09:30', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Do, 19. Mrz 2026 · 09:55–11:25', termin_iso: '2026-03-19', zeit_von: '09:55', zeit_bis: '11:25', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Fr, 20. Mrz 2026 · 12:25–14:00', termin_iso: '2026-03-20', zeit_von: '12:25', zeit_bis: '14:00', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Mo, 23. Mrz 2026 · 14:15–15:45', termin_iso: '2026-03-23', zeit_von: '14:15', zeit_bis: '15:45', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Di, 24. Mrz 2026 · 08:00–09:30', termin_iso: '2026-03-24', zeit_von: '08:00', zeit_bis: '09:30', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Mi, 25. Mrz 2026 · 09:55–11:25', termin_iso: '2026-03-25', zeit_von: '09:55', zeit_bis: '11:25', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Do, 26. Mrz 2026 · 12:25–14:00', termin_iso: '2026-03-26', zeit_von: '12:25', zeit_bis: '14:00', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'offen', status_raw: 'Offen' },
      { termin_raw: 'Fr, 27. Mrz 2026 · 14:15–15:45', termin_iso: '2026-03-27', zeit_von: '14:15', zeit_bis: '15:45', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'offen', status_raw: 'Offen' },
    ],
    M226: [
      { termin_raw: 'Mo, 2. Mrz 2026 · 08:00–09:30', termin_iso: '2026-03-02', zeit_von: '08:00', zeit_bis: '09:30', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Di, 3. Mrz 2026 · 09:55–11:25', termin_iso: '2026-03-03', zeit_von: '09:55', zeit_bis: '11:25', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Mi, 4. Mrz 2026 · 12:25–14:00', termin_iso: '2026-03-04', zeit_von: '12:25', zeit_bis: '14:00', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Do, 5. Mrz 2026 · 14:15–15:45', termin_iso: '2026-03-05', zeit_von: '14:15', zeit_bis: '15:45', lektionen_ist: 0, lektionen_soll: 2, anwesenheit_pct: 0, status: 'abwesend_unentschuldigt', status_raw: 'Unentschuldigt' },
      { termin_raw: 'Fr, 6. Mrz 2026 · 08:00–09:30', termin_iso: '2026-03-06', zeit_von: '08:00', zeit_bis: '09:30', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Mo, 9. Mrz 2026 · 09:55–11:25', termin_iso: '2026-03-09', zeit_von: '09:55', zeit_bis: '11:25', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Di, 10. Mrz 2026 · 12:25–14:00', termin_iso: '2026-03-10', zeit_von: '12:25', zeit_bis: '14:00', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Mi, 11. Mrz 2026 · 14:15–15:45', termin_iso: '2026-03-11', zeit_von: '14:15', zeit_bis: '15:45', lektionen_ist: 0, lektionen_soll: 2, anwesenheit_pct: 0, status: 'abwesend_unentschuldigt', status_raw: 'Unentschuldigt' },
      { termin_raw: 'Do, 12. Mrz 2026 · 08:00–09:30', termin_iso: '2026-03-12', zeit_von: '08:00', zeit_bis: '09:30', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Fr, 13. Mrz 2026 · 09:55–11:25', termin_iso: '2026-03-13', zeit_von: '09:55', zeit_bis: '11:25', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Mo, 16. Mrz 2026 · 12:25–14:00', termin_iso: '2026-03-16', zeit_von: '12:25', zeit_bis: '14:00', lektionen_ist: 0, lektionen_soll: 2, anwesenheit_pct: 0, status: 'abwesend_unentschuldigt', status_raw: 'Unentschuldigt' },
      { termin_raw: 'Di, 17. Mrz 2026 · 14:15–15:45', termin_iso: '2026-03-17', zeit_von: '14:15', zeit_bis: '15:45', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Mi, 18. Mrz 2026 · 08:00–09:30', termin_iso: '2026-03-18', zeit_von: '08:00', zeit_bis: '09:30', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Do, 19. Mrz 2026 · 09:55–11:25', termin_iso: '2026-03-19', zeit_von: '09:55', zeit_bis: '11:25', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Fr, 20. Mrz 2026 · 12:25–14:00', termin_iso: '2026-03-20', zeit_von: '12:25', zeit_bis: '14:00', lektionen_ist: 0, lektionen_soll: 2, anwesenheit_pct: 0, status: 'abwesend_entschuldigt', status_raw: 'Entschuldigt (krank)' },
      { termin_raw: 'Mo, 23. Mrz 2026 · 14:15–15:45', termin_iso: '2026-03-23', zeit_von: '14:15', zeit_bis: '15:45', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Di, 24. Mrz 2026 · 08:00–09:30', termin_iso: '2026-03-24', zeit_von: '08:00', zeit_bis: '09:30', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'offen', status_raw: 'Offen' },
      { termin_raw: 'Mi, 25. Mrz 2026 · 09:55–11:25', termin_iso: '2026-03-25', zeit_von: '09:55', zeit_bis: '11:25', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'offen', status_raw: 'Offen' },
    ],
    M319: [
      { termin_raw: 'Mo, 2. Mrz 2026 · 08:00–09:30', termin_iso: '2026-03-02', zeit_von: '08:00', zeit_bis: '09:30', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Di, 3. Mrz 2026 · 09:55–11:25', termin_iso: '2026-03-03', zeit_von: '09:55', zeit_bis: '11:25', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Mi, 4. Mrz 2026 · 12:25–14:00', termin_iso: '2026-03-04', zeit_von: '12:25', zeit_bis: '14:00', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Do, 5. Mrz 2026 · 14:15–15:45', termin_iso: '2026-03-05', zeit_von: '14:15', zeit_bis: '15:45', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Fr, 6. Mrz 2026 · 08:00–09:30', termin_iso: '2026-03-06', zeit_von: '08:00', zeit_bis: '09:30', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Mo, 9. Mrz 2026 · 09:55–11:25', termin_iso: '2026-03-09', zeit_von: '09:55', zeit_bis: '11:25', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Di, 10. Mrz 2026 · 12:25–14:00', termin_iso: '2026-03-10', zeit_von: '12:25', zeit_bis: '14:00', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Mi, 11. Mrz 2026 · 14:15–15:45', termin_iso: '2026-03-11', zeit_von: '14:15', zeit_bis: '15:45', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Do, 12. Mrz 2026 · 08:00–09:30', termin_iso: '2026-03-12', zeit_von: '08:00', zeit_bis: '09:30', lektionen_ist: 0, lektionen_soll: 2, anwesenheit_pct: 0, status: 'abwesend_entschuldigt', status_raw: 'Entschuldigt' },
      { termin_raw: 'Fr, 13. Mrz 2026 · 09:55–11:25', termin_iso: '2026-03-13', zeit_von: '09:55', zeit_bis: '11:25', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Mo, 16. Mrz 2026 · 12:25–14:00', termin_iso: '2026-03-16', zeit_von: '12:25', zeit_bis: '14:00', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Di, 17. Mrz 2026 · 14:15–15:45', termin_iso: '2026-03-17', zeit_von: '14:15', zeit_bis: '15:45', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Mi, 18. Mrz 2026 · 08:00–09:30', termin_iso: '2026-03-18', zeit_von: '08:00', zeit_bis: '09:30', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Do, 19. Mrz 2026 · 09:55–11:25', termin_iso: '2026-03-19', zeit_von: '09:55', zeit_bis: '11:25', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Fr, 20. Mrz 2026 · 12:25–14:00', termin_iso: '2026-03-20', zeit_von: '12:25', zeit_bis: '14:00', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'offen', status_raw: 'Offen' },
      { termin_raw: 'Mo, 23. Mrz 2026 · 14:15–15:45', termin_iso: '2026-03-23', zeit_von: '14:15', zeit_bis: '15:45', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'offen', status_raw: 'Offen' },
    ],
    M320: [
      { termin_raw: 'Mo, 2. Mrz 2026 · 08:00–09:30', termin_iso: '2026-03-02', zeit_von: '08:00', zeit_bis: '09:30', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Di, 3. Mrz 2026 · 09:55–11:25', termin_iso: '2026-03-03', zeit_von: '09:55', zeit_bis: '11:25', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Mi, 4. Mrz 2026 · 12:25–14:00', termin_iso: '2026-03-04', zeit_von: '12:25', zeit_bis: '14:00', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Do, 5. Mrz 2026 · 14:15–15:45', termin_iso: '2026-03-05', zeit_von: '14:15', zeit_bis: '15:45', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Fr, 6. Mrz 2026 · 08:00–09:30', termin_iso: '2026-03-06', zeit_von: '08:00', zeit_bis: '09:30', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Mo, 9. Mrz 2026 · 09:55–11:25', termin_iso: '2026-03-09', zeit_von: '09:55', zeit_bis: '11:25', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Di, 10. Mrz 2026 · 12:25–14:00', termin_iso: '2026-03-10', zeit_von: '12:25', zeit_bis: '14:00', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Mi, 11. Mrz 2026 · 14:15–15:45', termin_iso: '2026-03-11', zeit_von: '14:15', zeit_bis: '15:45', lektionen_ist: 1, lektionen_soll: 2, anwesenheit_pct: 50, status: 'abwesend_prozent', status_raw: 'Abwesend 50%' },
      { termin_raw: 'Do, 12. Mrz 2026 · 08:00–09:30', termin_iso: '2026-03-12', zeit_von: '08:00', zeit_bis: '09:30', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Fr, 13. Mrz 2026 · 09:55–11:25', termin_iso: '2026-03-13', zeit_von: '09:55', zeit_bis: '11:25', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Mo, 16. Mrz 2026 · 12:25–14:00', termin_iso: '2026-03-16', zeit_von: '12:25', zeit_bis: '14:00', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Di, 17. Mrz 2026 · 14:15–15:45', termin_iso: '2026-03-17', zeit_von: '14:15', zeit_bis: '15:45', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Mi, 18. Mrz 2026 · 08:00–09:30', termin_iso: '2026-03-18', zeit_von: '08:00', zeit_bis: '09:30', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'offen', status_raw: 'Offen' },
      { termin_raw: 'Do, 19. Mrz 2026 · 09:55–11:25', termin_iso: '2026-03-19', zeit_von: '09:55', zeit_bis: '11:25', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'offen', status_raw: 'Offen' },
    ],
    M347: [
      { termin_raw: 'Mo, 2. Mrz 2026 · 08:00–09:30', termin_iso: '2026-03-02', zeit_von: '08:00', zeit_bis: '09:30', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Di, 3. Mrz 2026 · 09:55–11:25', termin_iso: '2026-03-03', zeit_von: '09:55', zeit_bis: '11:25', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Mi, 4. Mrz 2026 · 12:25–14:00', termin_iso: '2026-03-04', zeit_von: '12:25', zeit_bis: '14:00', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Do, 5. Mrz 2026 · 14:15–15:45', termin_iso: '2026-03-05', zeit_von: '14:15', zeit_bis: '15:45', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Fr, 6. Mrz 2026 · 08:00–09:30', termin_iso: '2026-03-06', zeit_von: '08:00', zeit_bis: '09:30', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Mo, 9. Mrz 2026 · 09:55–11:25', termin_iso: '2026-03-09', zeit_von: '09:55', zeit_bis: '11:25', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Di, 10. Mrz 2026 · 12:25–14:00', termin_iso: '2026-03-10', zeit_von: '12:25', zeit_bis: '14:00', lektionen_ist: 0, lektionen_soll: 2, anwesenheit_pct: 0, status: 'abwesend_unentschuldigt', status_raw: 'Unentschuldigt' },
      { termin_raw: 'Mi, 11. Mrz 2026 · 14:15–15:45', termin_iso: '2026-03-11', zeit_von: '14:15', zeit_bis: '15:45', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Do, 12. Mrz 2026 · 08:00–09:30', termin_iso: '2026-03-12', zeit_von: '08:00', zeit_bis: '09:30', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Fr, 13. Mrz 2026 · 09:55–11:25', termin_iso: '2026-03-13', zeit_von: '09:55', zeit_bis: '11:25', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Mo, 16. Mrz 2026 · 12:25–14:00', termin_iso: '2026-03-16', zeit_von: '12:25', zeit_bis: '14:00', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Di, 17. Mrz 2026 · 14:15–15:45', termin_iso: '2026-03-17', zeit_von: '14:15', zeit_bis: '15:45', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'offen', status_raw: 'Offen' },
    ],
    M223: [
      { termin_raw: 'Mo, 2. Mrz 2026 · 08:00–09:30', termin_iso: '2026-03-02', zeit_von: '08:00', zeit_bis: '09:30', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Di, 3. Mrz 2026 · 09:55–11:25', termin_iso: '2026-03-03', zeit_von: '09:55', zeit_bis: '11:25', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Mi, 4. Mrz 2026 · 12:25–14:00', termin_iso: '2026-03-04', zeit_von: '12:25', zeit_bis: '14:00', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Do, 5. Mrz 2026 · 14:15–15:45', termin_iso: '2026-03-05', zeit_von: '14:15', zeit_bis: '15:45', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Fr, 6. Mrz 2026 · 08:00–09:30', termin_iso: '2026-03-06', zeit_von: '08:00', zeit_bis: '09:30', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Mo, 9. Mrz 2026 · 09:55–11:25', termin_iso: '2026-03-09', zeit_von: '09:55', zeit_bis: '11:25', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Di, 10. Mrz 2026 · 12:25–14:00', termin_iso: '2026-03-10', zeit_von: '12:25', zeit_bis: '14:00', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Mi, 11. Mrz 2026 · 14:15–15:45', termin_iso: '2026-03-11', zeit_von: '14:15', zeit_bis: '15:45', lektionen_ist: 0, lektionen_soll: 2, anwesenheit_pct: 0, status: 'abwesend_entschuldigt', status_raw: 'Entschuldigt' },
      { termin_raw: 'Do, 12. Mrz 2026 · 08:00–09:30', termin_iso: '2026-03-12', zeit_von: '08:00', zeit_bis: '09:30', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Fr, 13. Mrz 2026 · 09:55–11:25', termin_iso: '2026-03-13', zeit_von: '09:55', zeit_bis: '11:25', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Mo, 16. Mrz 2026 · 12:25–14:00', termin_iso: '2026-03-16', zeit_von: '12:25', zeit_bis: '14:00', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Di, 17. Mrz 2026 · 14:15–15:45', termin_iso: '2026-03-17', zeit_von: '14:15', zeit_bis: '15:45', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Mi, 18. Mrz 2026 · 08:00–09:30', termin_iso: '2026-03-18', zeit_von: '08:00', zeit_bis: '09:30', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Do, 19. Mrz 2026 · 09:55–11:25', termin_iso: '2026-03-19', zeit_von: '09:55', zeit_bis: '11:25', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'offen', status_raw: 'Offen' },
      { termin_raw: 'Fr, 20. Mrz 2026 · 12:25–14:00', termin_iso: '2026-03-20', zeit_von: '12:25', zeit_bis: '14:00', lektionen_ist: 2, lektionen_soll: 2, anwesenheit_pct: 100, status: 'offen', status_raw: 'Offen' },
    ],
    UEK5: [
      { termin_raw: 'Mo, 11. Mai 2026 · 08:00–16:00', termin_iso: '2026-05-11', zeit_von: '08:00', zeit_bis: '16:00', lektionen_ist: 8, lektionen_soll: 8, anwesenheit_pct: 100, status: 'teilgenommen', status_raw: 'Teilgenommen' },
      { termin_raw: 'Di, 12. Mai 2026 · 08:00–16:00', termin_iso: '2026-05-12', zeit_von: '08:00', zeit_bis: '16:00', lektionen_ist: 8, lektionen_soll: 8, anwesenheit_pct: 100, status: 'offen', status_raw: 'Offen' },
    ],
  };

  // Modul-Block für /api/absenzen/:code/termine — aus der absenzenRows-Zeile.
  const findAbsenzModul = (code) => absenzenRows.find((r) => r.kuerzel_code === code) || null;

  // 4) Route table
  const routes = [
    { method: 'GET',  re: /^\/api\/healthz\/?$/,             handler: () => ({ ok: true }) },
    { method: 'GET',  re: /^\/api\/status\/?$/,              handler: () => statusPayload() },
    { method: 'GET',  re: /^\/api\/settings\/?$/,            handler: () => settings },
    { method: 'PATCH',re: /^\/api\/settings\/?$/,            handler: (_m, body) => {
        // Mutate in place so the form stays in sync after Save without a
        // page reload (mirrors the real backend behavior).
        if (body && typeof body === 'object') {
          if (body.scheduler) settings.scheduler = { ...settings.scheduler, ...body.scheduler };
          if (typeof body.msEmail === 'string') settings.msEmail = body.msEmail;
          if (body.telegram) settings.telegram = { ...settings.telegram, ...body.telegram };
        }
        return settings;
      } },

    // /api/noten: Liste + Aggregat-Felder (avg / bySemester / count / fetchedAt).
    // Frontend zeigt 'Durchschnitt' Hero-Card NUR wenn data.avg gesetzt ist.
    { method: 'GET',  re: /^\/api\/noten\/?$/, handler: () => {
        const ns = buildNotenStats();
        const lastFetched = noten.reduce((acc, n) => {
          const t = n.fetched_at ? new Date(n.fetched_at).getTime() : 0;
          return t > acc ? t : acc;
        }, 0);
        return {
          rows: noten,
          count: noten.length,
          avg: ns.avg,
          bySemester: ns.bySemester,
          fetchedAt: lastFetched ? ISO(lastFetched) : null,
        };
      } },

    // /api/noten/:kuerzelId/pruefungen: Modul-Detail-Sheet + Modul-Route.
    // Antwort braucht: rows[] (mit pruefung_typ/pruefung_nr/bezeichnung/
    // bewertung/gewicht_pct/prev_bewertung), modulNote, kuerzelCode,
    // kuerzelFull, fachName, fachCode, semester, typ, detailId.
    { method: 'GET',  re: /^\/api\/noten\/([^/]+)\/pruefungen\/?$/, handler: (m) => {
        const id = decodeURIComponent(m[1]);
        const note = findNote(id);
        const rows = pruefungen[id] || [];
        return {
          rows,
          modulNote: note ? note.note : null,
          modulNoteRaw: note ? note.note_raw : null,
          detailId: note ? note.id : null,
          fachName: note ? note.fach_name : null,
          fachCode: note ? note.fach_code : null,
          kuerzelCode: note ? note.kuerzel_code : null,
          kuerzelFull: note ? note.kuerzel_full : null,
          semester: note ? note.semester : null,
          typ: note ? note.typ : null,
        };
      } },

    { method: 'GET',  re: /^\/api\/history\/([^/]+)\/?$/,    handler: () => ({ rows: [] }) },
    { method: 'GET',  re: /^\/api\/stats\/?$/,               handler: () => stats },

    // /api/absenzen: Stats-Hero (avgAnwesenheit / unterMinimum / abwesendGesamt)
    // + Modul-Liste. Shape die views/absenzen.js erwartet.
    { method: 'GET',  re: /^\/api\/absenzen\/?$/, handler: () => ({
        stats: absenzenStats,
        rows: absenzenRows,
      }) },

    // /api/absenzen/:code/termine: Tagesliste eines Moduls fürs Absenz-Sheet.
    // code wird dekodiert; unbekannte Codes liefern ein generisches Payload
    // (kein 404) damit verwaiste Deep-Links das Sheet nicht crashen.
    { method: 'GET',  re: /^\/api\/absenzen\/([^/]+)\/termine\/?$/, handler: (m) => {
        const code = decodeURIComponent(m[1]);
        const modulRow = findAbsenzModul(code);
        const termine = absenzTermine[code] || [];
        const modul = modulRow ? {
          bezeichnung: modulRow.bezeichnung,
          kuerzel_code: modulRow.kuerzel_code,
          besucht: modulRow.besucht,
          soll: modulRow.soll,
          anwesenheit_pct: modulRow.anwesenheit_pct,
          minimal_pct: modulRow.minimal_pct,
        } : {
          bezeichnung: code,
          kuerzel_code: code,
          besucht: null,
          soll: null,
          anwesenheit_pct: null,
          minimal_pct: null,
        };
        return { modul, rows: termine };
      } },
    { method: 'GET',  re: /^\/api\/stundenplan\/?$/,         handler: () => ({ rows: stundenplan }) },
    { method: 'POST', re: /^\/api\/stundenplan\/clear\/?$/,  handler: () => ({ ok: true }) },
    { method: 'POST', re: /^\/api\/(?:abfrage|scrape)\/?$/,  handler: () => { simulateAbfrage(); return { ok: true, durationMs: 14_200, neueNoten: 0, geaendert: 0 }; } },
    { method: 'GET',  re: /^\/api\/logs\/?$/,                handler: () => ({ rows: [
      { ts: ISO(NOW - 1000 * 60 * 18), level: 'info', msg: 'Scrape-Cycle gestartet (manueller Trigger)' },
      { ts: ISO(NOW - 1000 * 60 * 17), level: 'info', msg: 'Microsoft-SSO Login OK' },
      { ts: ISO(NOW - 1000 * 60 * 17), level: 'info', msg: 'Noten-Seite geladen — 12 Module gefunden' },
      { ts: ISO(NOW - 1000 * 60 * 17), level: 'info', msg: 'Stundenplan geladen — 14 Termine' },
      { ts: ISO(NOW - 1000 * 60 * 16), level: 'info', msg: 'Diff: 1 neue Note (M183 Datenbanken: 5.4)' },
      { ts: ISO(NOW - 1000 * 60 * 16), level: 'info', msg: 'Diff: 1 Raumwechsel (M319 ZH-204→ZH-209)' },
      { ts: ISO(NOW - 1000 * 60 * 16), level: 'info', msg: 'Push gesendet an 2 Subscriptions' },
      { ts: ISO(NOW - 1000 * 60 * 16), level: 'info', msg: 'Scrape-Cycle abgeschlossen in 14.2s' },
    ] }) },
    { method: 'GET',  re: /^\/api\/push\/vapid-key\/?$/,     handler: () => ({ publicKey: 'BDemoVapidPublicKey-this-is-not-real-it-is-just-for-demo-mode' }) },
    { method: 'POST', re: /^\/api\/push\/subscribe\/?$/,     handler: () => ({ ok: true }) },
    { method: 'DELETE',re:/^\/api\/push\/subscribe\/?$/,     handler: () => ({ ok: true }) },
    { method: 'POST', re: /^\/api\/push\/test\/?$/,          handler: () => ({ ok: true, sent: 2 }) },

    // /api/seen — IntersectionObserver-Batch markiert frisch-Items als gesehen.
    // Im Demo-Mode keine echte Persistenz; fresh-Highlight wird vom Frontend
    // erst NACH 24h ausgeblendet — für die Demo-Session also visuell stabil.
    { method: 'POST', re: /^\/api\/seen\/?$/, handler: (_m, body) => {
        const ids = (body && Array.isArray(body.ids)) ? body.ids.length : 0;
        return { ok: true, updated: ids };
      } },

    // /api/dismiss — Hard-Dismiss. Liefert die selbe Shape wie das echte
    // Backend ({ ok: true, dismissed: { noten, stundenplan } }) damit
    // aktuell.js nach der Animation den richtigen Toast zeigt.
    { method: 'POST', re: /^\/api\/dismiss\/?$/,             handler: (_m, body) => {
        let dismissedNoten = 0;
        let dismissedPlan = 0;
        if (body && body.all) {
          noten.forEach((n) => { if (n.isFresh) { n.isFresh = 0; dismissedNoten++; } });
          stundenplan.forEach((s) => { if (s.isFresh) { s.isFresh = 0; dismissedPlan++; } });
        } else if (body && body.kind === 'noten' && Array.isArray(body.ids)) {
          body.ids.forEach((id) => {
            const n = noten.find((x) => x.kuerzel_id === id || x.id === id);
            if (n && n.isFresh) { n.isFresh = 0; dismissedNoten++; }
          });
        } else if (body && body.kind === 'stundenplan' && Array.isArray(body.ids)) {
          body.ids.forEach((id) => {
            const s = stundenplan.find((x) => x.id === id);
            if (s && s.isFresh) { s.isFresh = 0; dismissedPlan++; }
          });
        } else if (body && body.kind === 'noten') {
          // kind ohne ids → alle dieses kinds
          noten.forEach((n) => { if (n.isFresh) { n.isFresh = 0; dismissedNoten++; } });
        } else if (body && body.kind === 'stundenplan') {
          stundenplan.forEach((s) => { if (s.isFresh) { s.isFresh = 0; dismissedPlan++; } });
        }
        return { ok: true, dismissed: { noten: dismissedNoten, stundenplan: dismissedPlan } };
      } },
  ];

  // 5) SSE — fake EventSource for /api/events. Stays "open" and lets the demo
  //    PUSH simulated scrape-phase events (see simulateAbfrage) so the
  //    Scrape-Card animates over the SAME render path as production.
  const RealEventSource = window.EventSource;
  window.EventSource = function (url, init) {
    if (typeof url === 'string' && /^\/api\/events/.test(url)) {
      const listeners = {};
      const es = {
        url, readyState: 1,
        onmessage: null, onopen: null, onerror: null,
        addEventListener: (name, cb) => { (listeners[name] = listeners[name] || []).push(cb); },
        removeEventListener: (name, cb) => {
          if (listeners[name]) listeners[name] = listeners[name].filter((f) => f !== cb);
        },
        close: () => { es.readyState = 2; if (activeDemoSse === es) activeDemoSse = null; },
        // Demo-only: dispatch a named event to all registered listeners.
        _emit: (name, dataObj) => {
          const evt = { data: JSON.stringify(dataObj) };
          (listeners[name] || []).forEach((cb) => { try { cb(evt); } catch (_) {} });
          if (name === 'message' && typeof es.onmessage === 'function') es.onmessage(evt);
        },
        CONNECTING: 0, OPEN: 1, CLOSED: 2,
      };
      activeDemoSse = es;
      setTimeout(() => { if (typeof es.onopen === 'function') es.onopen({}); }, 0);
      return es;
    }
    return new RealEventSource(url, init);
  };
  window.EventSource.CONNECTING = 0;
  window.EventSource.OPEN = 1;
  window.EventSource.CLOSED = 2;

  // 6) The fetch interceptor.
  const origFetch = window.fetch.bind(window);

  function jsonResponse(payload, status) {
    return new Response(JSON.stringify(payload), {
      status: status || 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();

    // Only intercept same-origin /api/* paths.
    let pathname;
    try {
      const u = url.startsWith('/') ? new URL(url, window.location.origin) : new URL(url);
      if (u.origin !== window.location.origin) return origFetch(input, init);
      pathname = u.pathname;
    } catch (_) {
      return origFetch(input, init);
    }

    if (!pathname.startsWith('/api/')) return origFetch(input, init);

    // Parse body if JSON
    let body = null;
    if (init && init.body) {
      try { body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body; } catch (_) {}
    }

    for (const r of routes) {
      if (r.method !== method) continue;
      const m = pathname.match(r.re);
      if (m) {
        try {
          const result = r.handler(m, body);
          // Tiny artificial latency so the UI's transitions feel real.
          return new Promise((resolve) => setTimeout(() => resolve(jsonResponse(result)), 80));
        } catch (e) {
          return Promise.resolve(jsonResponse({ error: e.message || 'Demo-Fehler' }, 500));
        }
      }
    }

    return Promise.resolve(jsonResponse({ error: 'Demo-API: Endpoint nicht gestubbt: ' + method + ' ' + pathname }, 404));
  };

  // 7) Console hint
  console.info('[WISSen Demo] Mock-API aktiv. Alle Daten sind Beispieldaten — keine echten Schul-Infos.');
})();
