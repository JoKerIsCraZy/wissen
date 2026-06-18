<div align="center">

<img src="web/assets/logo.png" alt="WISSen" width="128" height="128" />

# WISSen

### _Schon WISSen, bevor man's vergisst._

**Inoffizielles Daily-Driver-Toolkit für das WISS Tocco-Schulportal.**
Noten, Stundenplan, Modul-Details, Absenzen, Raumpläne und Push-Benachrichtigungen
— als Web-Dashboard, installierbare Mobile-PWA und Telegram-Bot. Selbst gehostet,
ohne Cloud, ohne Account, ohne Datenkrake.

🌐 **Doku & Live-Demo:** <https://jokeriscrazy.github.io/wissen/>

[![Live Demo](https://img.shields.io/badge/live%20demo-github%20pages-6366f1?logo=astro&logoColor=white)](https://jokeriscrazy.github.io/wissen/)
[![Docker](https://img.shields.io/badge/docker-ghcr.io-2496ED?logo=docker&logoColor=white)](https://github.com/JoKerIsCraZy/wissen/pkgs/container/wissen)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.5-339933?logo=node.js&logoColor=white)](package.json)
[![SvelteKit](https://img.shields.io/badge/svelte-5-FF3E00?logo=svelte&logoColor=white)](https://svelte.dev)
[![Playwright](https://img.shields.io/badge/playwright-1.61-45ba4b?logo=playwright&logoColor=white)](https://playwright.dev)

</div>

---

## Warum WISSen?

Das WISS Tocco-Portal sagt dir, was du wissen sollst — irgendwann, irgendwie,
nach drei Klicks. **WISSen** sagt dir's **sofort**, **auf deinem Handy**, mit
Push, und merkt sich jede einzelne Notenänderung in einer Historie, die
Tocco selbst nicht hat.

| Was Tocco macht                          | Was WISSen daraus macht                               |
| ---------------------------------------- | ----------------------------------------------------- |
| Du musst nachschauen                     | Push sobald sich was ändert                           |
| ZP/LB-Korrekturen verschwinden lautlos   | Append-only History jeder Bewertungs-Änderung         |
| Raumwechsel siehst du im Stundenplan-PDF | Notification: alter → neuer Raum, mit Stockwerks-Plan |
| Schnitt nur grob pro Modul               | LB/ZP-Gewichtung sichtbar, IPA-Rechner, Statistik-Tab |
| Absenzen tief in einer Liste vergraben   | Anwesenheits-Tab + Push sobald eine neue Abwesenheit auftaucht |
| Kein API, keine App                      | REST-API, PWA, Telegram-Bot, Live-Logs via SSE        |

---

## Features

- 📊 **Noten-Dashboard** (SvelteKit-SPA) — Durchschnitte, Filter, Modul-Detail mit LB / ZP / Gewichtung, IPA-Rechner, Statistik-Ansicht
- 📱 **Mobile-App / PWA** unter `/mobile/` — auf iOS & Android wie eine native App installierbar
- 🔔 **Push-Benachrichtigungen** bei neuen Noten, Bewertungs-Korrekturen, Zimmerwechseln und neuen Absenzen — **auch bei geschlossener App** (Mozilla / FCM / Apple Web Push)
- 🗺 **Inline-Raumpläne** (4. OG / 2. OG) mit Live-Highlighting des aktuellen Raums
- 📅 **Stundenplan-Tab** mit kommenden Terminen und Frisch-Markern für Änderungen
- ✅ **Absenzen-Tab** — Anwesenheit pro Modul (Soll/Ist-Lektionen, Ø-Anwesenheit, Module unter Minimum). Anwesenheit zählt nur **stattgefundene Lektionen** (offene / zukünftige Termine drücken die Quote nicht), Tagesliste pro Lektion mit Status (teilgenommen / offen / abwesend entschuldigt · unentschuldigt) und Push bei neuer Abwesenheit
- ⏱ **Auto-Abfrage** im Intervall- oder Wochenplan-Modus, mit manuellem Trigger
- ⚡ **nice2 REST v2 + DWR** als primäre Datenquelle (schnell, kein DOM-Scraping) — DOM-Scraping bleibt als `DATA_SOURCE=scrape`-Fallback
- 💬 **Telegram-Bot** mit Live-Tracking, Inline-Buttons und interaktivem Menü
- 🔒 **Bearer-Token-Auth** + Anti-Brute-Force in drei Schichten — sicher hinter Reverse-Proxy
- 🔐 **AES-256-GCM** für `settings.json`-Secrets at rest — Backup-Leaks bleiben unkritisch
- 📜 **SQLite-Historie** jeder Noten- und ZP/LB-Änderung — nichts geht verloren

---

## Quick Start — in 60 Sekunden mehr WISSen

> Ersetze `MS_EMAIL` und `MS_PASSWORD` durch deine Microsoft-SSO-Zugangsdaten.

```bash
docker run -d --name wissen --restart unless-stopped -p 3000:3000 \
  -e MS_EMAIL="dein.name@schule.ch" \
  -e MS_PASSWORD="DEIN_PASSWORT" \
  -v "$(pwd)/data:/app/data" \
  ghcr.io/jokeriscrazy/wissen:latest
```

API-Token aus den Logs holen:

```bash
docker logs wissen | grep AUTO-GENERATED
```

→ **<http://localhost:3000>** öffnen, Token einloggen, fertig.

<details>
<summary><strong>Windows / Docker Compose / NAS-Varianten</strong></summary>

### Windows PowerShell

```powershell
docker run -d --name wissen --restart unless-stopped -p 3000:3000 `
  -e MS_EMAIL="dein.name@schule.ch" `
  -e MS_PASSWORD="DEIN_PASSWORT" `
  -v "${PWD}/data:/app/data" `
  ghcr.io/jokeriscrazy/wissen:latest
```

### Docker Compose

```bash
git clone https://github.com/JoKerIsCraZy/wissen.git && cd wissen
cp .env.example .env       # Werte eintragen
docker compose up -d
```

### NAS / Unraid (Permission-Fix)

Bei `EACCES`-Fehlern auf `/app/data/*` zusätzlich `-e PUID=$(id -u) -e PGID=$(id -g)` setzen.

| Plattform           | Werte                            |
| ------------------- | -------------------------------- |
| Linux / macOS / WSL | `PUID=$(id -u)`, `PGID=$(id -g)` |
| Unraid              | `PUID=99`, `PGID=100`            |
| Synology            | `PUID=1026`, `PGID=100`          |
| QNAP                | `PUID=1000`, `PGID=100`          |

</details>

<details>
<summary><strong>Lokal ohne Docker (Entwicklung)</strong></summary>

```bash
git clone https://github.com/JoKerIsCraZy/wissen.git && cd wissen
npm install            # postinstall zieht web-svelte/ Deps mit
npm run setup          # Playwright Chromium
cp .env.example .env   # Werte eintragen
npm run serve          # baut Frontend (preserve), startet Server auf :3000
```

Während Frontend-Entwicklung mit HMR:

```bash
npm run serve   # Terminal 1: Backend API auf :3000
npm run dev:web # Terminal 2: SvelteKit Dev-Server auf :5173
```

Voraussetzungen: **Node.js >= 22.5**, ~300 MB für Chromium, WISS-Schulaccount.

</details>

---

## WISSen unterwegs (Mobile-PWA)

Die Mobile-View läuft unter **`/mobile/`** und ist auf iOS & Android als
PWA installierbar — fühlt sich an wie eine native App, ist aber keine.

### Installation auf dem Handy

1. Im Dashboard auf **„Smartphone-View"** tippen → öffnet `/mobile/`
2. Token einmalig eingeben (steht im Server-Log oder in `data/.api-token`)
3. Browser-Menü:
   - **Android (Chrome / Brave / Edge):** ⋮ → **„App installieren"**
   - **iOS (Safari):** Teilen-Symbol → **„Zum Home-Bildschirm"**

Danach: normales App-Icon auf dem Handy, kein Browser-Chrome.

### Push-Benachrichtigungen aktivieren

Installierte App öffnen → **Settings → „Push aktivieren"** → Erlauben →
Test-Button drücken.

| Ereignis         | Push-Inhalt                                             |
| ---------------- | ------------------------------------------------------- |
| 🆕 Neue Note      | Modulname + Note + Direktlink zum Modul-Detail          |
| ✏️ Notenänderung  | Vorher → Nachher + Modulname                            |
| 🚪 Zimmerwechsel  | Datum, Zeit, alter → neuer Raum (auch Online ↔ Offline) |
| ⚠️ Neue Abwesenheit | Modul + Datum/Lektion, ⚠️ unentschuldigt / ℹ️ entschuldigt (auch Wechsel entschuldigt ↔ unentschuldigt) |

Notifications kommen **auch wenn die App komplett geschlossen ist**.

> **iOS:** Push funktioniert nur in der **installierten** PWA, nicht im Safari-Tab.
> **Brave Desktop:** `brave://settings/privacy` → „Google-Dienste für Push-Nachrichten verwenden" aktivieren.

---

## Konfiguration

Alle Settings über `.env`-Datei oder Docker `-e`-Flag. **Pflichtwerte** sind fett.

### Pflicht

| Variable          | Beschreibung                            |
| ----------------- | --------------------------------------- |
| **`MS_EMAIL`**    | Microsoft-SSO E-Mail (`name@schule.ch`) |
| **`MS_PASSWORD`** | Microsoft-Passwort                      |

### Häufig genutzt

| Variable                   | Default         | Beschreibung                                                                                    |
| -------------------------- | --------------- | ----------------------------------------------------------------------------------------------- |
| `API_TOKEN`                | _auto_          | Schutz für `/api/*`. Leer = Auto-Generierung beim ersten Start                                  |
| `TELEGRAM_ENABLED`         | `false`         | Telegram-Bot einschalten                                                                        |
| `TELEGRAM_TOKEN`           | —               | Bot-Token von [@BotFather](https://t.me/BotFather)                                              |
| `TELEGRAM_ALLOWED_USER_ID` | —               | Deine User-ID von [@userinfobot](https://t.me/userinfobot)                                      |
| `ALLOW_UI_CREDENTIALS`     | `true`          | Credentials im UI änderbar — Secrets via AES-256-GCM verschlüsselt                              |
| `TZ`                       | `Europe/Zurich` | Zeitzone für Logs / Telegram                                                                    |
| `PORT`                     | `3000`          | HTTP-Port                                                                                       |
| `TRUST_PROXY`              | `1`             | Reverse-Proxy-Hops. `2` für Multi-Hop (CF→nginx→app). `loopback` ohne Proxy. **Niemals `true`** |

<details>
<summary><strong>Erweitert (URLs, Browser, VAPID, PUID)</strong></summary>

| Variable            | Default                    | Beschreibung                                      |
| ------------------- | -------------------------- | ------------------------------------------------- |
| `DATA_SOURCE`       | `rest`                     | Datenquelle: `rest` (nice2 REST v2 + DWR) oder `scrape` (DOM-Fallback). **Env-only**, hat Vorrang vor dem UI |
| `TOCCO_BASE`        | _Tocco-Seite_              | Tocco-Basis-URL                                   |
| `NOTEN_URL`         | _Notenseite_               | Tocco-Noten-URL                                   |
| `STUNDENPLAN_URL`   | _Stundenplanseite_         | Tocco-Stundenplan-URL                             |
| `USER_PK`           | —                          | Tocco-User-Primärschlüssel                        |
| `HEADLESS`          | `true`                     | `false` = sichtbarer Browser (Debug)              |
| `SLOW_MO`           | `0`                        | Millisekunden zwischen Playwright-Aktionen        |
| `DEBUG_SCRAPER`     | `false`                    | DOM-Dumps bei Fehlern (nur `scrape`-Modus)        |
| `VAPID_PUBLIC_KEY`  | _auto_                     | Web-Push-Public-Key, in `data/vapid.json`         |
| `VAPID_PRIVATE_KEY` | _auto_                     | Web-Push-Private-Key                              |
| `VAPID_SUBJECT`     | `mailto:admin@example.com` | Kontakt für Push-Provider                         |
| `PUID` / `PGID`     | `1000` / `1000`            | Container-User/Group-ID für NAS-Permissions       |
| `SSE_LOG_LEVEL`     | `info,warn,error`          | Welche Levels via SSE an Clients gestreamt werden |

**URL-Variablen sind env-only** — können nicht über das UI geändert werden (SSRF-Schutz).

</details>

---

## API

Alle Endpoints (außer `/healthz` / `/healthz/ready`) erfordern Bearer-Token.

```bash
curl -H "Authorization: Bearer $API_TOKEN" http://localhost:3000/api/noten
```

| Methode         | Pfad                        | Beschreibung                               |
| --------------- | --------------------------- | ------------------------------------------ |
| `GET`           | `/healthz`                  | Liveness-Probe (kein Auth)                 |
| `GET`           | `/healthz/ready`            | Readiness-Probe (kein Auth; sensible Felder nur mit Token) |
| `GET`           | `/api/status`               | Scheduler- und Server-Status               |
| `GET`           | `/api/version`              | App-Version + Update-Check                 |
| `GET / PATCH`   | `/api/settings`             | Settings lesen / ändern                    |
| `GET`           | `/api/noten`                | Noten (`?semester=S1&sortBy=note`)         |
| `GET`           | `/api/noten/:id/pruefungen` | LB/ZP/Sonstige eines Moduls                |
| `GET`           | `/api/history/:id`          | Notenverlauf eines Moduls                  |
| `POST`          | `/api/seen`                 | Frisch-Marker als gesehen markieren (`{kind, ids[]}`) |
| `POST`          | `/api/dismiss`              | Letzte-Änderungs-Einträge entfernen (`{kind, ids?}` oder `{all:true}`) |
| `GET`           | `/api/stundenplan`          | Termine (`?from=YYYY-MM-DD&limit=100`)     |
| `POST`          | `/api/stundenplan/clear`    | Stundenplan-Cache leeren                   |
| `GET`           | `/api/stats`                | Gesamt-Statistiken                         |
| `GET`           | `/api/absenzen`             | Absenzen-Übersicht aller Module + Stats    |
| `GET`           | `/api/absenzen/:code/termine` | Tagesliste (Lektionen + Status) eines Moduls |
| `POST`          | `/api/abfrage`              | Manuelle Abfrage auslösen                  |
| `POST`          | `/api/scrape`               | Deprecated Alias für `/api/abfrage` (RFC-8594 `Deprecation`-Header) |
| `POST`          | `/api/db/reset`             | DB zurücksetzen (Noten / Stundenplan / Absenzen) |
| `GET`           | `/api/logs`                 | Letzte Log-Zeilen                          |
| `GET`           | `/api/events`               | SSE-Stream für Live-Status                 |
| `GET`           | `/api/push/vapid-key`       | VAPID-Public-Key der PWA                   |
| `GET`           | `/api/push/status`          | Push-Konfig-Status + Subscription-Zähler   |
| `POST / DELETE` | `/api/push/subscribe`       | Push-Subscription registrieren / entfernen |
| `POST`          | `/api/push/test`            | Test-Push an alle Subscriptions            |

---

## Telegram-Bot

1. Bot bei [@BotFather](https://t.me/BotFather) erstellen → Token
2. User-ID via [@userinfobot](https://t.me/userinfobot)
3. In `.env` setzen, Server neu starten

### Befehle

| Befehl                      | Funktion                                   |
| --------------------------- | ------------------------------------------ |
| `/menu`                     | Hauptmenü mit Inline-Buttons               |
| `/noten`                    | Notenübersicht (Modul-Klick → LB/ZP-Liste) |
| `/durchschnitt`             | Schnitt gesamt + pro Semester              |
| `/heute` `/morgen` `/woche` | Stundenplan-Auszüge                        |
| `/stundenplan`              | Bis 1 Monat (Multi-Message für „Alle")     |
| `/abfrage`                  | Manuelle Abfrage mit Live-Phase-Anzeige    |
| `/scrape`                   | Alias für `/abfrage`                       |
| `/status`                   | Server-Status                              |

---

## Sicherheit

- 🔐 **Bearer-Token** auf allen `/api/*`-Routen via `Authorization`-Header. Query-String-Auth (`?token=`) ist **nur** auf `/api/events` erlaubt (EventSource kann keine Header setzen) — auf allen anderen Routen wird `?token=` abgewiesen, damit der Token nicht in Proxy-Logs / Browser-History / Referrer leakt.
- 🛡 **Anti-Brute-Force** in drei Schichten:
  - 10 Fehlversuche / 15 min → 15 min Lockout (`/api/*` außer `/api/events`)
  - 50 Fehlversuche / 6 h → 6 h Lockout
  - 60 Fehlversuche / 15 min → SSE-spezifisch (toleriert EventSource-Reconnect-Storms, fängt Token-Enumeration)
- 🚫 **SSRF-Schutz:** Tocco-URLs env-only, Push-Endpoints auf Whitelist (FCM / Mozilla / Apple / Windows)
- 🔐 **Settings-Encryption at rest:** `data/settings.json`-Secrets (`msPassword`, `telegramToken`) via **AES-256-GCM**. Master-Key auto-generiert beim ersten Start (`data/.master-key`, Mode 0600), Plaintext-Bestände lazy migriert. Format `enc:v1:<iv>:<ct>:<tag>` für künftige Algo-Wechsel.
  - **Geschützt:** Backup-Leaks, Volume-Snapshots, casual File-Sharing
  - **NICHT geschützt:** Shell-Access auf den laufenden Host (Master-Key liegt daneben), Memory-Dumps, Container-Escape
- 🌐 **Netzwerk:** für öffentliche Exposition **immer** Reverse-Proxy mit TLS (Caddy / Traefik / nginx). `TRUST_PROXY` korrekt setzen.
- 📁 **`data/`** enthält Sessions, Tokens, Master-Key, optional Credentials, VAPID-Keys — **niemals public**.

### Backup-Verschlüsselung

Die App-interne Encryption schützt nur gegen versehentliche `data/`-Leaks
(Master-Key liegt daneben). Für **echte** Backup-Sicherheit das Backup
zusätzlich verschlüsseln:

```bash
# restic — incremental, deduplicated, AES-256
restic init --repo /backups/wissen
restic -r /backups/wissen backup ./data --exclude 'data/.master-key'

# borg — incremental, deduplicated
borg init --encryption=repokey /backups/wissen
borg create /backups/wissen::$(date +%Y%m%d) ./data --exclude '*/.master-key'

# gpg — single-shot tarball
tar czf - data | gpg --symmetric --cipher-algo AES256 -o wissen-backup-$(date +%Y%m%d).tar.gz.gpg
```

> Die SQLite-DB (`data/wissen.db`) enthält **keine** Secrets (Passwörter / Tokens liegen alle in der verschlüsselten `settings.json`) — nur deine eigenen Noten und Termine.

---

## Architektur

```
wissen/
├── src/
│   ├── server.js       Express-Composition + Boot
│   ├── auth.js         Bearer-Token + Anti-Brute-Force
│   ├── scheduler.js    Intervall- / Wochenplan-Logik
│   ├── runScrape.js    Abfrage-Cycle-Orchestrierung (quellen-neutral)
│   ├── scraper.js      Playwright SSO-Login + DOM-Scraping (Fallback)
│   ├── rest/           nice2 REST v2 + DWR (client, loginBridge, producer)
│   ├── secretCrypto.js AES-256-GCM für settings.json-Secrets
│   ├── push.js         Web-Push (VAPID, FCM / Mozilla / Apple)
│   ├── routes/         12 Express-Route-Module
│   ├── db/             SQLite-Layer (11 Module)
│   └── bot/            Telegram-Bot (8 Module)
├── web-svelte/         V2-Frontend (SvelteKit 2 + Svelte 5 → dist/)
├── web/mobile/         Legacy PWA (Vanilla-JS + Service-Worker, /mobile/)
├── web/floorplans/     Geteilte Raumplan-Helper
├── web/assets/         Logo, Favicons, PWA-Icons
├── data/               Runtime (Docker-Volume)
├── test/unit/          Unit-Tests (node:test)
├── Dockerfile          Multi-stage: base → deps + webbuild → runtime
└── docker-compose.yml
```

**Stack:** Node.js 22 · Express 5 · Playwright 1.61 · SQLite (`node:sqlite`) ·
web-push · **SvelteKit 2 + Svelte 5** (V2-Dashboard) · Vanilla-JS-PWA für `/mobile/` (Legacy) · `node:test`

**Datenquelle:** Default ist **nice2 REST v2** (`/nice2/rest/entities/2.0`) + **DWR**
für Prüfungsgewichte (ZP / LB). Playwright übernimmt im REST-Pfad nur den SSO-Login
und öffnet **einen** Tab auf der Noten-Seite (lädt die DWR-Engine für die
`scriptSessionId`) — alle REST/DWR-Calls laufen same-origin im Browser-Kontext.
DOM-Scraping bleibt als `DATA_SOURCE=scrape`-Fallback erhalten und liefert ein
formgleiches Ergebnis, sodass DB-Layer, Diff und Push unverändert bleiben.

### SQLite-Tabellen

| Tabelle              | Inhalt                                                                                |
| -------------------- | ------------------------------------------------------------------------------------- |
| `noten`              | Modul-Stammdaten + aktuelle Note + Frisch-Marker (`change_pending`, `change_seen_at`) |
| `noten_history`      | Append-only Verlauf jeder Modulnoten-Änderung                                         |
| `noten_pruefungen`   | LB / ZP / OTHER pro Modul mit Gewicht                                                 |
| `pruefungen_history` | Append-only Verlauf jeder ZP/LB-Änderung („4.0 → 4.5"-Diffs)                          |
| `stundenplan`        | Termine mit Datum, Zeit, Raum, Dozent + Raumwechsel-Marker + Quelle (`source`: `rest` / `scrape`) |
| `absenzen`           | Anwesenheits-Übersicht pro Modul (Soll/Besucht zählen nur stattgefundene Lektionen, Min %, Ist %, Typ, Semester) |
| `absenzen_termine`   | Eine Zeile pro Lektion: Datum, Zeit, Status (teilgenommen / offen / abwesend entschuldigt · unentschuldigt) |
| `push_subscriptions` | PWA-Push-Subscriptions (endpoint + Krypto-Keys)                                       |

---

## Troubleshooting — wenn WISSen mal nicht weiss

| Symptom                                 | Lösung                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------- |
| Login schlägt fehl                      | Passwort/MFA prüfen. `HEADLESS=false` für visuelles Debug                 |
| `Executable doesn't exist` (Playwright) | `npx playwright install chromium`                                         |
| Token vergessen                         | `data/.api-token` löschen + Restart → neuer Token in Logs                 |
| Mobile-Push aktivieren geht nicht       | Mobile braucht **HTTPS** — LAN-IP funktioniert nicht (Browser-Sicherheit) |
| iOS Push-Toggle ausgegraut              | PWA via Safari → „Zum Home-Bildschirm" installieren                       |
| Brave-Push schlägt fehl                 | `brave://settings/privacy` → „Google-Dienste für Push" aktivieren         |
| Stundenplan zeigt alte Einträge         | Settings → „DB zurücksetzen" → manuelle Abfrage                           |
| Wochen-Check soll erneut laufen         | `data/.weekly-detail-at` löschen + Restart                                |
| Keine LB/ZP im Modul                    | Bei der nächsten Abfrage automatisch nachgezogen, manuell via `/api/abfrage` |

---

## Mitwirken & Lizenz

Beiträge willkommen — siehe [CONTRIBUTING.md](CONTRIBUTING.md).

Veröffentlicht unter der [MIT License](LICENSE) — mach damit was du willst, solange der Copyright-Hinweis erhalten bleibt.

- ✅ Privatnutzung, kommerzielle Nutzung, Modifikation, Distribution, Sublicensing
- ✅ Forks, Re-Branding, Embedding in eigene Produkte
- ⚠️ Keine Garantie, kein Support-Versprechen — **Nutzung auf eigenes Risiko**

> **Disclaimer:** Inoffizielles Hobby-Projekt. Keine Verbindung zur WISS oder Tocco AG. Bitte respektiere die ToS deiner Schule. _„Tocco" und „WISS" sind Marken der jeweiligen Inhaber._

---
