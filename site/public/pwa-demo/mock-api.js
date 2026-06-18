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
  const fmtDate = (d) => d.toISOString().slice(0, 10); // YYYY-MM-DD

  // Noten — kuerzel_id wird vom Frontend an /api/noten/:kuerzelId/pruefungen
  // weitergereicht. Die ID muss also als pruefungen-Map-Key existieren.
  const noten = [
    { id: 'n1',  kuerzel_id: 'm114', kuerzel_code: 'M114', kuerzel_full: 'M114 Codeverwaltung mit Git',  fach_name: 'Codeverwaltung mit Git',  fach_code: 'M114', note: 5.4, note_raw: '5.40', semester: 'S2', typ: 'Modul', isFresh: 0, prev_note: null, fetched_at: ISO(NOW - 1000 * 60 * 60 * 26) },
    { id: 'n2',  kuerzel_id: 'm183', kuerzel_code: 'M183', kuerzel_full: 'M183 Backup-Datenbestand sichern', fach_name: 'Datenbanken',         fach_code: 'M183', note: 5.4, note_raw: '5.40', semester: 'S2', typ: 'Modul', isFresh: 1, prev_note: 5.0, fetched_at: ISO(NOW - 1000 * 60 * 2) },
    { id: 'n3',  kuerzel_id: 'm226', kuerzel_code: 'M226', kuerzel_full: 'M226 Objektorientiert programmieren', fach_name: 'OOP mit Java',     fach_code: 'M226', note: 4.8, note_raw: '4.80', semester: 'S2', typ: 'Modul', isFresh: 0, prev_note: null, fetched_at: ISO(NOW - 1000 * 60 * 60 * 48) },
    { id: 'n4',  kuerzel_id: 'm319', kuerzel_code: 'M319', kuerzel_full: 'M319 Applikationen entwerfen', fach_name: 'Software-Engineering',    fach_code: 'M319', note: 5.0, note_raw: '5.00', semester: 'S3', typ: 'Modul', isFresh: 0, prev_note: null, fetched_at: ISO(NOW - 1000 * 60 * 60 * 96) },
    { id: 'n5',  kuerzel_id: 'm320', kuerzel_code: 'M320', kuerzel_full: 'M320 Daten der Geschäftsprozesse', fach_name: 'BPMN',                fach_code: 'M320', note: 5.2, note_raw: '5.20', semester: 'S3', typ: 'Modul', isFresh: 0, prev_note: null, fetched_at: ISO(NOW - 1000 * 60 * 60 * 72) },
    { id: 'n6',  kuerzel_id: 'm164', kuerzel_code: 'M164', kuerzel_full: 'M164 Datenbanken erstellen',    fach_name: 'SQL & ER-Modell',        fach_code: 'M164', note: 5.5, note_raw: '5.50', semester: 'S2', typ: 'Modul', isFresh: 0, prev_note: null, fetched_at: ISO(NOW - 1000 * 60 * 60 * 120) },
    { id: 'n7',  kuerzel_id: 'm346', kuerzel_code: 'M346', kuerzel_full: 'M346 Cloud-Lösungen konzipieren', fach_name: 'AWS & Azure Basics',   fach_code: 'M346', note: 4.6, note_raw: '4.60', semester: 'S3', typ: 'Modul', isFresh: 0, prev_note: null, fetched_at: ISO(NOW - 1000 * 60 * 60 * 200) },
    { id: 'n8',  kuerzel_id: 'm347', kuerzel_code: 'M347', kuerzel_full: 'M347 Container einsetzen',      fach_name: 'Docker & K8s',           fach_code: 'M347', note: 5.7, note_raw: '5.70', semester: 'S3', typ: 'Modul', isFresh: 0, prev_note: null, fetched_at: ISO(NOW - 1000 * 60 * 60 * 156) },
    { id: 'n9',  kuerzel_id: 'm223', kuerzel_code: 'M223', kuerzel_full: 'M223 Multi-User-Applikation',   fach_name: 'Web-Frameworks',         fach_code: 'M223', note: 4.9, note_raw: '4.90', semester: 'S3', typ: 'Modul', isFresh: 0, prev_note: null, fetched_at: ISO(NOW - 1000 * 60 * 60 * 240) },
    { id: 'n10', kuerzel_id: 'm450', kuerzel_code: 'M450', kuerzel_full: 'M450 Datenmodelle entwickeln',  fach_name: 'Datenmodellierung',      fach_code: 'M450', note: 5.1, note_raw: '5.10', semester: 'S4', typ: 'Modul', isFresh: 0, prev_note: null, fetched_at: ISO(NOW - 1000 * 60 * 60 * 300) },
    { id: 'n11', kuerzel_id: 'all1', kuerzel_code: 'ALL1', kuerzel_full: 'Allgemeinbildung — Sprache & Kommunikation', fach_name: 'Deutsch',  fach_code: 'ALL1', note: 5.0, note_raw: '5.00', semester: 'S2', typ: 'AB',    isFresh: 0, prev_note: null, fetched_at: ISO(NOW - 1000 * 60 * 60 * 70) },
    { id: 'n12', kuerzel_id: 'all2', kuerzel_code: 'ALL2', kuerzel_full: 'Allgemeinbildung — Gesellschaft', fach_name: 'Geschichte & Politik', fach_code: 'ALL2', note: 4.5, note_raw: '4.50', semester: 'S2', typ: 'AB',    isFresh: 0, prev_note: null, fetched_at: ISO(NOW - 1000 * 60 * 60 * 90) },
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
  };

  // Build a realistic two-week schedule including today + tomorrow + raumwechsel.
  const stundenplan = (function () {
    const lessons = [
      { veranstaltung: 'M114 Codeverwaltung mit Git', dozent: 'Z. Müller',  klasse: 'AP24f', raum: 'W420', zeit_von: '08:00', zeit_bis: '09:30' },
      { veranstaltung: 'M183 Datenbanken',            dozent: 'B. Keller',  klasse: 'AP24f', raum: 'W214', zeit_von: '09:55', zeit_bis: '11:25' },
      { veranstaltung: 'M226 OOP mit Java',           dozent: 'M. Schwarz', klasse: 'AP24f', raum: 'W308', zeit_von: '12:25', zeit_bis: '14:00' },
      { veranstaltung: 'M319 Software-Engineering',   dozent: 'P. Brunner', klasse: 'AP24f', raum: 'W412', zeit_von: '14:15', zeit_bis: '15:45' },
      { veranstaltung: 'M320 BPMN',                   dozent: 'A. Hofer',   klasse: 'AP24f', raum: 'W215', zeit_von: '08:00', zeit_bis: '09:30' },
      { veranstaltung: 'M347 Docker & K8s',           dozent: 'L. Weber',   klasse: 'AP24f', raum: 'W420', zeit_von: '09:55', zeit_bis: '11:25' },
      { veranstaltung: 'M346 Cloud-Lösungen',         dozent: 'L. Weber',   klasse: 'AP24f', raum: 'Online', zeit_von: '12:25', zeit_bis: '14:00' },
      { veranstaltung: 'M223 Web-Frameworks',         dozent: 'P. Brunner', klasse: 'AP24f', raum: 'W407', zeit_von: '14:15', zeit_bis: '15:45' },
      { veranstaltung: 'Allgemeinbildung — Deutsch',  dozent: 'C. Lang',    klasse: 'AP24f', raum: 'W210', zeit_von: '08:00', zeit_bis: '09:30' },
      { veranstaltung: 'Allgemeinbildung — Politik',  dozent: 'R. Frei',    klasse: 'AP24f', raum: 'W210', zeit_von: '09:55', zeit_bis: '11:25' },
    ];
    // Helper: clamp hour into school-day window so the "current" lesson is
    // always plausible regardless of when someone visits the demo. If real
    // time is late at night / very early morning, anchor to mid-morning so
    // the demo always shows an interesting "in-progress" state.
    const realNow = new Date();
    const realHour = realNow.getHours();
    const anchor = new Date(realNow);
    if (realHour < 7 || realHour >= 18) {
      anchor.setHours(10, 30, 0, 0);
    }
    const fmtT = (d) => d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');

    const out = [];
    let id = 0;
    const todayDate = fmtDate(dayOffset(0));

    // Past lesson (already happened, no fresh marker)
    const pastEnd = new Date(anchor); pastEnd.setMinutes(anchor.getMinutes() - 35, 0, 0);
    const pastStart = new Date(pastEnd); pastStart.setMinutes(pastEnd.getMinutes() - 90, 0, 0);
    out.push({ id: 't' + (++id), datum_iso: todayDate, ...lessons[0],
      zeit_von: fmtT(pastStart), zeit_bis: fmtT(pastEnd),
      fetched_at: ISO(NOW - 1000 * 60 * 60), isFresh: 0 });

    // CURRENT lesson — started 25 min ago, ends in 60 min
    const ipStart = new Date(anchor); ipStart.setMinutes(anchor.getMinutes() - 25, 0, 0);
    const ipEnd   = new Date(anchor); ipEnd.setMinutes(anchor.getMinutes() + 60, 0, 0);
    out.push({ id: 't' + (++id), datum_iso: todayDate, ...lessons[1],
      zeit_von: fmtT(ipStart), zeit_bis: fmtT(ipEnd),
      fetched_at: ISO(NOW - 1000 * 60 * 60), isFresh: 0 });

    // Next lesson today — starts 30 min after current ends
    const n1Start = new Date(ipEnd); n1Start.setMinutes(ipEnd.getMinutes() + 30, 0, 0);
    const n1End   = new Date(n1Start); n1End.setMinutes(n1Start.getMinutes() + 95, 0, 0);
    out.push({ id: 't' + (++id), datum_iso: todayDate, ...lessons[2],
      zeit_von: fmtT(n1Start), zeit_bis: fmtT(n1End),
      fetched_at: ISO(NOW - 1000 * 60 * 60), isFresh: 0 });

    // Last lesson today — with FRESH Zimmerwechsel marker (drives push toast)
    const n2Start = new Date(n1End); n2Start.setMinutes(n1End.getMinutes() + 15, 0, 0);
    const n2End   = new Date(n2Start); n2End.setMinutes(n2Start.getMinutes() + 90, 0, 0);
    out.push({ id: 't' + (++id), datum_iso: todayDate, ...lessons[3],
      zeit_von: fmtT(n2Start), zeit_bis: fmtT(n2End),
      raum: 'W215', prev_raum: 'W412',
      fetched_at: ISO(NOW - 1000 * 60 * 5), isFresh: 1 });

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

  const stats = (function () {
    const ns = buildNotenStats();
    return {
      total: noten.length,
      bestanden: noten.filter((n) => n.note >= 4).length,
      durchschnitt: ns.avg,
      proSemester: {
        S2: { count: noten.filter((n) => n.semester === 'S2').length, durchschnitt: ns.bySemester.S2 || null },
        S3: { count: noten.filter((n) => n.semester === 'S3').length, durchschnitt: ns.bySemester.S3 || null },
        S4: { count: noten.filter((n) => n.semester === 'S4').length, durchschnitt: ns.bySemester.S4 || null },
      },
    };
  })();

  // 4) Route table
  const routes = [
    { method: 'GET',  re: /^\/api\/healthz\/?$/,             handler: () => ({ ok: true }) },
    { method: 'GET',  re: /^\/api\/status\/?$/,              handler: () => status },
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
    { method: 'GET',  re: /^\/api\/stundenplan\/?$/,         handler: () => ({ rows: stundenplan }) },
    { method: 'POST', re: /^\/api\/stundenplan\/clear\/?$/,  handler: () => ({ ok: true }) },
    { method: 'POST', re: /^\/api\/(?:abfrage|scrape)\/?$/,  handler: () => ({ ok: true, durationMs: 14_200, neueNoten: 0, geaendert: 0 }) },
    { method: 'GET',  re: /^\/api\/logs\/?$/,                handler: () => ({ rows: [
      { ts: ISO(NOW - 1000 * 60 * 18), level: 'info', msg: 'Scrape-Cycle gestartet (manueller Trigger)' },
      { ts: ISO(NOW - 1000 * 60 * 17), level: 'info', msg: 'Microsoft-SSO Login OK' },
      { ts: ISO(NOW - 1000 * 60 * 17), level: 'info', msg: 'Noten-Seite geladen — 12 Module gefunden' },
      { ts: ISO(NOW - 1000 * 60 * 17), level: 'info', msg: 'Stundenplan geladen — 14 Termine' },
      { ts: ISO(NOW - 1000 * 60 * 16), level: 'info', msg: 'Diff: 1 neue Note (M183 Datenbanken: 5.4)' },
      { ts: ISO(NOW - 1000 * 60 * 16), level: 'info', msg: 'Diff: 1 Raumwechsel (M319 W412→W215)' },
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

  // 5) SSE — provide a fake EventSource for /api/events that just stays open.
  const RealEventSource = window.EventSource;
  window.EventSource = function (url, init) {
    if (typeof url === 'string' && /^\/api\/events/.test(url)) {
      // Return a no-op event source — no events fire, which is fine for the demo.
      return {
        url, readyState: 1,
        onmessage: null, onopen: null, onerror: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        close: () => {},
        CONNECTING: 0, OPEN: 1, CLOSED: 2,
      };
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
