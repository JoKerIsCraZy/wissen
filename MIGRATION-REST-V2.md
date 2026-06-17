# Migration: DOM-Scraping → nice2 REST v2

> Stand 2026-06-17. Quelle: Multi-Agent-Workflow (`tocco-rest-migration-plan`, 14 Agenten)
> + Live-Spike gegen echtes wiss.tocco.ch (eingeloggter Student). Alle Datenpfade
> unten sind **live verifiziert**, nicht geraten.

## 0. Endbild (Kernidee)

Das DOM-Scraping verschwindet komplett. Der Browser (Playwright) wird nur noch für **zwei** Dinge gebraucht:

1. **SSO-Login** (einmalig) → liefert die Session-Cookies (`nice_auth`, `JSESSIONID`, `DWRSESSIONID`).
2. **DWR-Engine laden** (1 Page-Navigation pro Cycle auf die Noten-Seite) → liefert die `scriptSessionId` für `getDetailData` (Prüfungsgewichte). Nötig, weil ein reiner REST-Pfad für die Gewichte **live nicht existiert** (CSRF-Schutz blockt DWR-Calls ohne geladene Engine).

Alle eigentlichen Daten laufen danach über **cookie-authentifizierte HTTP-Calls** (REST v2 + ein DWR-RPC), kein DOM, kein Page-Pool.

---

## 1. Datenquellen-Map (live verifiziert)

| WISSen DB-Tabelle | Quelle | Query / Felder | Live |
|---|---|---|---|
| `noten` | REST `Input_data` | `_where=relUser.pk==<pk> and relInput.relInput_node.relInput_type.unique_id=="grades"` · `_paths=grade,definate_grade,relInput.relInput_node.short,relInput.relEvent.label` | ✅ 28 |
| `noten_pruefungen` | **DWR** `getDetailData(gradePk)` | POST `…UserGradesActionService.getDetailData.dwr`, `c0-param1=string:<Input_data.key>` → `exams:[{label,nr,weight,average,pk}]`, `ratings`, `num_ratings` | ✅ ZP 30%/LB 70% |
| `stundenplan` | REST `Reservation` (auto-scoped) | `_paths=date_from,date_till,relRoom.label,relEvent.label,relEvent.class_label,relReservation_lecturer_booking.relLecturer_booking.relUser` | ✅ 1000 |
| `absenzen` (Übersicht) | REST `Registration` | `_where=exists(relEvent)` · `_paths=relEvent.abbreviation,relEvent.label,lessons_total_desired,lessons_total_actual,presence_rate,relEvent.minimal_presence` | ✅ 35 |
| `absenzen_termine` (Lektionen) | REST `Reservation_registration` | `_where=relRegistration.relUser.pk==<pk>` · `_paths=relReservation.date_from,relReservation.date_till,relReservation.relRoom.label,relReservation.relEvent.abbreviation,presence_rate,missed_lessons,relRegistration_accomplishment_status.label` | ✅ |
| `noten_history`, `pruefungen_history`, `push_subscriptions` | App-intern (Diff-Snapshots / PWA) | keine Tocco-Quelle | — |

**Auth/Scoping:** `userEntityPk` kommt aus `GET /nice2/username` (`{userEntityPk:239687, principalEntityPk, businessUnitId:"wiss"}`). `Reservation`/`Registration`/`Reservation_registration` werden via ACL auto-gescoped; **`Input_data` NICHT** → explizites `_where=relUser.pk==<pk>`. Header: `x-business-unit:wiss`, `x-client:frontend`, `x-language:de`, `x-timezone:Europe/Berlin`.

**Zeilen-Shape REST v2:** `row.paths.<feld>.value`; Relationen verschachteln über `value.paths` (entity) bzw. `value[0].paths` (entity-list). Ein Nested-Extraktor ist nötig (siehe `pick()` in `tocco-api-test.js`).

**scriptSessionId (DWR):** Property `window.dwr.engine._scriptSessionId` (53 Zeichen) — **NICHT** die Funktion `_getScriptSessionId()`. Das war der ursprüngliche Bug.

---

## 2. Architektur-Schnitt

Die **einzige Naht** ist das Producer-Ergebnis-Objekt aus `scraper.runScrape()`. Wenn das formgleich bleibt
(`{ noten[], stundenplan[], absenzen[], detailIdMap, absenzDetailIdMap, scrapeDetail(id), scrapeAbsenzenDetail(id), closeBrowser() }`),
bleibt die gesamte Downstream-Pipeline (`runScrape.js`-Persistenz, `db/*`-Saver, Diff/`gradeChanges`, Bot/Push) **unverändert**. Die DB-Schicht ist bereits producer-agnostisch — das ist der große Glücksfall dieser Migration.

**Neu:** `src/rest/` — `client.js` (cookie-fetch + Nested-Value-Extraktor), `loginBridge.js` (Playwright-SSO → Cookies + Engine-Page offen halten), `producer.js` (baut das formgleiche Ergebnis-Objekt aus REST + getDetailData).

**Entfällt in `scraper.js`:** DOM-`scrapePage`/`parse*`, `setPageSize`, DWR-ID-Map (`parseDwrIdMap`/`bumpDwrPagingLimit`/`startDwrCapture`), Detail-Page-Pool (`createDetailPagePool`, `scrapeModulDetail`, `scrapeAbsenzModulDetail`, Warm-Tracking).

**Bleibt:** `ensureLoggedIn` (SSO) + ein offener Context mit geladener DWR-Engine für `getDetailData`-Fetches.

---

## 3. Rollout in Phasen

| Phase | Inhalt | Risiko |
|---|---|---|
| **0** | `src/rest/`-Client + Login-Bridge: 1 Browser-Context → SSO → Cookies + Noten-Seite (Engine). Hinter Feature-Flag `DATA_SOURCE=rest\|scrape` parallel betreibbar. | niedrig |
| **1** | Noten via REST (`Input_data`+`_where`). Ergebnis-Shape gegen alten Scraper diffen. | mittel (kuerzel_id, s.u.) |
| **2** | Stundenplan via REST (`Reservation`, `date_till`/`relRoom.label`). | niedrig |
| **3** | Absenzen-Übersicht via REST (`Registration`, `exists(relEvent)`). | niedrig |
| **4** | Absenz-Lektionen via REST (`Reservation_registration`) → **DOM `scrapeAbsenzModulDetail` löschen**. | niedrig |
| **5** | Prüfungen via `getDetailData`-**Fetch** (Engine geladen, parallel p-limit) → **Detail-Page-Pool löschen**. | mittel |
| **6** | Naming `scrape`→`Abfrage` (additiv, s. §6) + FE-Migrationswellen (web-svelte, web/mobile, pwa-demo, Bot). | niedrig (additiv) |
| **7** | Scheduler vereinfachen: Voll-Pass/Cycle, Weekly-Detail-Timer weg, `MIN_INTERVAL_MINUTES`-Floor, Default 60→15. | mittel (Tocco-Last) |
| **8** | Cleanup **bedingt**: Alias-Routen/Events entfernen (erst nach FE-Migration), DB `detail_scraped_at` droppen. `scraper.js` wird **NICHT** voll gelöscht (Login+Engine bleiben). | hoch — Bestätigung nötig |

---

## 4. Anpassungen gegenüber dem Workflow-Plan (neue Live-Infos)

Drei substanzielle Korrekturen, plus Präzisierungen:

### 4.1 Absenz-Lektionen-Pfad GEFUNDEN → DOM-Absenz-Detail entfällt
Der Workflow ließ die Absenz-Detail-Quelle als Vermutung ("Registration-Child-Entity") offen und plante, den DOM-Pfad evtl. zu behalten. **Live bestätigt:** Entity `Reservation_registration` (`_where=relRegistration.relUser.pk==<pk>`) liefert pro Lektion Datum/Raum/Status/`presence_rate`/`missed_lessons`. → `scrapeAbsenzModulDetail` (DOM) kann **vollständig weg**, nicht nur "behalten als Fallback". Phase 4 wird damit risikoarm.

### 4.2 Prüfungen via getDetailData-FETCH (nicht DOM-Page-Pool)
Der Workflow nahm an, der DWR-Detail-Pass sei "browser-gebunden + teuer (Page-Pool)". **Live bestätigt:** `getDetailData` funktioniert als reiner `fetch` (text/plain POST), sobald die DWR-Engine **einmal** geladen ist — die `scriptSessionId` ist `window.dwr.engine._scriptSessionId`. → Der gesamte **Detail-Page-Pool entfällt auch für Prüfungen**; stattdessen N parallele `fetch`-Calls (p-limit) gegen einen einzigen Engine-Tab. Drastisch billiger als der DOM-Pool — also ist "Voll-Pass jeder Cycle" auch für Prüfungen tragbar (bei 15-min-Intervall).

### 4.3 Prüfungs-REST-Pfad existiert NICHT → DWR ist Dauerlösung, nicht Brücke
Der Workflow plante "Phase 3: REST-Pfad für Prüfungsgewichte live verifizieren, dann DWR ersetzen". **Live bestätigt:** Es gibt keinen — `weight` liegt nicht auf `Input_node` (400), und `Input_data` je Event liefert nur die Modulnote (die Gewichte stecken im `Evaluation_node`/`Exam_template`-Baum, nicht trivial abfragbar). → Realistisches Endbild: **`getDetailData` bleibt permanent** die Prüfungsquelle (HTTP-RPC, kein Scraping). Damit:
- Der `missing_streak`-Teil-Scrape-Löschschutz kann **entfallen** (getDetailData liefert atomares JSON mit `num_ratings` — kein Halb-Lade-Risiko wie beim DOM). Konservativ: erst nach Verifikation über alle 28 Module entfernen.
- "Endbild: Playwright nur für Login" (Workflow) wird korrigiert zu **"Playwright für Login UND 1 Engine-Tab/Cycle"**. Phase 8 darf `scraper.js` nicht voll löschen (Gap des Critics — bestätigt).

### 4.4 Feld-Präzisierungen (vorher unverifiziert/falsch)
- Stundenplan-Endzeit ist **`date_till`**, nicht `date_to` (gab 400).
- Absenzen-Felder sind **`lessons_total_desired/actual`, `presence_rate`**, nicht `expected/is/is_percent` (DWR-Spalten, keine Entity-Felder).
- Noten brauchen `_where=relUser.pk` — `Input_data` wird **nicht** auto-gescoped (im Gegensatz zu Reservation/Registration).
- `pk` zur Laufzeit aus `/nice2/username` → `userEntityPk` (kein Hardcoding).

---

## 5. DB

- **Schema bleibt** (producer-agnostisch). Kein Tabellen-Rebuild für die Funktion nötig.
- **kuerzel_id-Remap (Critic-Gap, HIGH):** Die alte `kuerzel_id` kommt aus `parseKuerzel(parts[0])` der DWR-Suche; die REST-`Input_data`-PK (z.B. 84121) ist eine **andere** Zahl. Wenn `kuerzel_id` sich ändert, brechen `noten_history`/`noten_pruefungen`-Joins aller Bestands-DBs **still**. → **Erst live verifizieren**, ob `kuerzel_id` stabil bleibt (gleiche Ableitung aus REST). Falls nicht: `PRAGMA user_version`-gegatete Remap-Migration über den **stabilen `kuerzel_code`**.
- **Spalten-Drops (Cleanup, bedingt):** `noten.detail_scraped_at`/`absenzen.detail_scraped_at` (Cooldown) droppbar sobald Achse REST-voll; `noten_pruefungen.missing_streak` droppbar nach Prüfungs-Verifikation. `detail_id` **bleibt** (= REST-/getDetailData-PK). Alle via `user_version`-Gate, idempotent.

---

## 6. Naming `scrape` → `Abfrage` (Workflow-Plan, unverändert übernommen)

Strikt **additiv**, kein hartes Rename (stale PWAs auf Geräten würden sonst brechen):

- **HTTP:** `POST /api/abfrage` (kanonisch) + `POST /api/scrape` (Alias, `Deprecation`/`Sunset`/`Link`-Header). Gleicher Handler, gleicher Lock (`state.scrapeLockedUntil`).
- **SSE:** Lauf-Ende-Event **dual-emit** `abfrage_done` + `scrape_done` (EventSource bindet pro Event-Typ-String → reines Rename macht alte Clients still taub). Dedup client-seitig über `runId` (Critic-Gap).
- **Status-Payload-Keys NICHT umbenennen** (`running` etc. sind bereits datenquellen-neutral). Nur die `currentPhase`-**Werte** ändern sich (`browser`/`login` entfallen).
- **Telegram:** Command-Alias `/abfrage` zusätzlich; `callback_data`-Wert `scrape` **stabil** lassen (alte Inline-Keyboards in der History würden sonst brechen), nur Button-Text → "Abfrage".
- **Doku:** `api.md` `scrape:done` (Doppelpunkt, falsch) → echter Code-Name `scrape_done`/`abfrage_done` korrigieren.
- **Frontends:** `web-svelte` (`endpoints.ts`/`live.svelte.ts`/Topbar/CommandPalette), `web/mobile` (`views/scrape.js`→`abfrage.js`, `sw.js` **VERSION bumpen**, `.m-scrape*`-CSS), **`site/public/pwa-demo/`** (vollständige Zweitkopie inkl. `mock-api.js` Regex `scrape|abfrage` — Critic-Gap, leicht übersehen).
- **Finale Aufräumwelle** (Alias/Event/Command entfernen) erst, wenn alle Frontends migriert + deployed sind. Das ist die einzige brechende Welle.

---

## 7. Risiken & offene Live-Checks (vor Umsetzung)

| Risiko / Check | Status |
|---|---|
| Prüfungs-REST-Pfad existiert nicht → Engine/Browser bleibt dauerhaft | bestätigt — eingeplant (§4.3) |
| `kuerzel_id`-Stabilität (REST-PK vs `parseKuerzel`) | **offen — kritisch live prüfen vor Phase 1** |
| Tocco-ACL-Rate-Limit bei häufigem Poll (15 min) | offen — `MIN_INTERVAL_MINUTES`-Floor als Schutz |
| `getDetailData` über alle 28 Module robust (andere Exam-Strukturen) | offen — Voll-Lauf testen |
| Dozent-Name-Feld (`…relLecturer_booking.relLecturer_booking.relUser.<name>`) | offen — Sub-Pfad live bestätigen |
| Cookie `nice_auth` 30 min → Re-Login bei 401 in der Login-Bridge | einplanen |
| `pwa-demo`-Zweitkopie beim Naming mitziehen | eingeplant (§6) |
| SSE Dual-Emit Doppel-Refetch | Dedup über `runId` (§6) |

---

## 8. Empfohlene Reihenfolge der nächsten Schritte

1. **Live-Check `kuerzel_id`-Stabilität** (chrome-devtools) — entscheidet, ob §5-Migration nötig ist.
2. **`src/rest/`-Client + Login-Bridge** bauen (Phase 0), gegen `tocco-api-test.js` als Blaupause.
3. Achsen-weise umstellen (Phasen 1–5), jeweils Producer-Output gegen den alten Scraper diffen.
4. Naming-Welle (Phase 6) additiv, dann FE-Wellen.
5. Scheduler/Cleanup (Phasen 7–8) zuletzt, bedingt.
