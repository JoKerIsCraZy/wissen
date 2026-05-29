---
title: Architektur
description: Modul-Layout, DB-Schema, Boot-Flow und Design-Entscheidungen.
---

## Stack

| Schicht | Tool |
|---|---|
| Runtime | Node.js 22 |
| HTTP | Express 5 |
| Browser | Playwright 1.59 (Chromium) |
| DB | SQLite — nativ via `node:sqlite` |
| Push | `web-push` |
| V2-Frontend | SvelteKit 2 + Svelte 5 (`adapter-static`) |
| V1-Frontend | Vanilla-JS-PWA unter `/mobile/` |
| Tests | `node:test` |

## Verzeichnis-Layout

```
wissen/
├── src/
│   ├── server.js       Express-Composition + Boot
│   ├── auth.js         Bearer-Token + Anti-Brute-Force
│   ├── ratelimits.js   express-rate-limit-Instanzen
│   ├── scheduler.js    Intervall- / Wochenplan-Logik
│   ├── runScrape.js    Scrape-Cycle-Orchestrierung
│   ├── sse.js          Server-Sent-Events Broadcast
│   ├── pushValidate.js SSRF-Allowlist für Push-Endpoints
│   ├── secretCrypto.js AES-256-GCM für settings.json-Secrets
│   ├── state.js        Geteilter Mutable-State
│   ├── cli.js          CLI-Entry
│   ├── settings.js     Settings-Persistenz (mit Encryption)
│   ├── scraper.js      Playwright Login + Scraping
│   ├── push.js         Web-Push (VAPID, FCM/Mozilla/Apple)
│   ├── logger.js       Logging
│   ├── routes/         12 Express-Route-Module
│   ├── db/             SQLite-Layer (10 Module)
│   ├── bot/            Telegram-Bot (8 Module)
│   └── shared/         envLoader, escapeHtml, apiError
├── test/unit/          Unit-Tests
├── web-svelte/         V2-Frontend
├── dist/               Build-Output (gitignored)
├── web/
│   ├── mobile/         Legacy PWA
│   ├── floorplans/     Geteilte RaumView-Helper
│   └── assets/         Logo, Icons
├── data/               Runtime (Docker-Volume)
├── Dockerfile
└── docker-compose.yml
```

## Routes (`src/routes/`)

| Modul | Aufgabe |
|---|---|
| `index.js` | Router-Aggregation |
| `status.js` | `GET /api/status` |
| `settings.js` | `GET/PATCH /api/settings` |
| `noten.js` | `GET /api/noten`, `/:id/pruefungen`, `/api/history/:id` |
| `stundenplan.js` | `GET /api/stundenplan`, `POST .../clear` |
| `absenzen.js` | `GET /api/absenzen`, `/:code/termine` |
| `stats.js` | `GET /api/stats` |
| `scrape.js` | `POST /api/scrape` |
| `push.js` | VAPID, subscribe, test |
| `logs.js` | `GET /api/logs` |
| `events.js` | SSE `GET /api/events` |
| `static.js` | Asset-Serving (`/`, `/mobile/`, Floorplans) |

## DB-Schicht (`src/db/`)

| Modul | Aufgabe |
|---|---|
| `index.js` | Connection-Singleton, Migrations, Bootstrap |
| `schema.js` | `CREATE TABLE`-Statements |
| `queries.js` | Generische Helper |
| `parsers.js` | DOM → Domain-Objekt |
| `noten.js` | Noten-CRUD + History-Append |
| `stundenplan.js` | Termin-CRUD + Raumwechsel-Detection |
| `absenzen.js` | Anwesenheits-Übersicht + Termin-CRUD pro Lektion |
| `pruefungen.js` | LB/ZP/OTHER-CRUD + History |
| `stats.js` | Aggregat-Queries |
| `push.js` | Subscriptions |

## Bot (`src/bot/`)

| Modul | Aufgabe |
|---|---|
| `index.js` | Long-Polling, Routing |
| `state.js` | Per-User-State |
| `telegram.js` | Telegram-API-Wrapper |
| `format.js` | Noten- / Termin-Formatter |
| `keyboards.js` | Inline-Keyboards |
| `screens.js` | Antwort-Templates |
| `handlers.js` | Command-Handler |
| `notify.js` | Push-Bridge (Web-Push → Telegram) |

## DB-Tabellen

| Tabelle | Inhalt |
|---|---|
| `noten` | Modul-Stammdaten + aktuelle Note + Frisch-Marker |
| `noten_history` | Append-only Verlauf jeder Modulnoten-Änderung |
| `noten_pruefungen` | LB / ZP / OTHER pro Modul mit Gewicht |
| `pruefungen_history` | Append-only Verlauf jeder ZP/LB-Bewertungs-Änderung |
| `stundenplan` | Termine mit Datum, Zeit, Raum, Dozent + Raumwechsel-Marker |
| `absenzen` | Modul-Anwesenheits-Übersicht: Soll-/Besucht-Lektionen, Min %, Ist %, Typ, Semester + Frisch-Marker |
| `absenzen_termine` | Eine Zeile pro Lektion: Datum, Zeit, Status (teilgenommen / offen / abwesend entschuldigt \| unentschuldigt) |
| `push_subscriptions` | PWA-Push-Subscriptions (endpoint + Krypto-Keys) |

DB-Connection ist seit v1.0.0 ein **Boot-Singleton** — Migrationen + `reclassifyOtherPruefungen` laufen einmal beim Start, alle Routen / Bot-Screens nutzen den geteilten Handle.

## Boot-Flow

```
1. envLoader            → .env + ENV merge
2. settings.load()      → data/settings.json (mit Decryption)
3. db.init()            → Connection + Migrations + Reclassify
4. push.init()          → VAPID-Keys laden / generieren
5. server start         → Express + Static
6. scheduler.start()    → Intervall/Wochenplan
7. bot.start() (opt)    → Telegram-Long-Polling
```

## Design-Entscheidungen

### Warum Vanilla-JS-PWA + SvelteKit-SPA?

- **Vanilla-PWA (`/mobile/`)** ist langlebig — kein Build, läuft unverändert über Jahre, schlanker Service-Worker
- **SvelteKit-SPA (`/`)** für die Desktop-Erfahrung mit komplexeren Interaktionen (Filter, Tabellen, Charts)

Beide werden vom selben Express-Server gehostet — `dist/` für SvelteKit, `web/mobile/` für Vanilla.

### Warum `node:sqlite` statt `better-sqlite3`?

- Native Node-API seit v22.5
- Keine native Build-Dependency mehr → schlankerer Container
- Performance ausreichend für unsere Größenordnung

### Warum ein einziger Boot-Singleton für die DB?

- Vor v1.0.0 öffnete jede Route eine neue Connection → Migrations liefen mehrfach
- Singleton + `reclassifyOtherPruefungen` einmal beim Start → robust, performant

### Warum `data/.master-key` neben den Daten liegt?

Pragmatik: das At-Rest-Encryption schützt gegen **versehentliche Leaks** (Backup, Snapshot, Sharing). Gegen Shell-Access auf den laufenden Host hilft es nicht — dafür gibt's Backup-Encryption.
