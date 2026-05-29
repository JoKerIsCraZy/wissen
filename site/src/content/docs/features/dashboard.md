---
title: Dashboard
description: Das SvelteKit-SPA mit Noten, Modul-Detail, Stundenplan, Statistik und Raumplan.
---

Das **WISSen Dashboard** ist eine moderne Single-Page-Application gebaut mit **SvelteKit 2 + Svelte 5**. Es ist die Hauptansicht — alles was Tocco bietet, plus deutlich mehr Features.

## Hauptansichten

### `/` — Aktueller Status

- **Now-Card:** aktuelle Lektion (Modul, Raum, Dozent, Restzeit)
- **Next-Card:** kommende Lektion + Countdown
- **Last-Changed-Tile:** zuletzt geänderte Note
- **Live-Polling** alle 30 s

### `/noten` — Notenübersicht

- Alle Module mit aktueller Note + Trend (↑ ↓)
- **Filter:** Semester, Bestanden / Nicht-Bestanden, Suche
- **Sortierung:** Note, Modulname, Datum
- **Modul-Klick** → Detail-Ansicht mit allen LB / ZP / Sonstigen Bewertungen + Gewichtung
- **IPA-Rechner** für Abschluss-Prüfung
- **Frisch-Marker** auf neuen / geänderten Noten

### `/stundenplan` — Termin-Liste

- Tages-, Wochen-, Monats-Modus
- Raumwechsel werden farblich hervorgehoben
- Vergangene Termine ausblendbar
- DB-Reset-Button für manuelle Neusynchronisation

### `/stats` — Statistiken

- Gesamtdurchschnitt + Pro-Semester-Schnitte
- Bestandene / Nicht-bestandene Module
- Note-Verteilung als Histogramm
- Notentrend über Zeit

### `/absenzen` — Absenzenübersicht

- Sortierbare **Modul-Tabelle** mit Inline-Tagesliste (Lektionen + Status: teilgenommen / offen / abwesend entschuldigt / abwesend unentschuldigt)
- **Stats-Tiles:** Ø-Anwesenheit, Module unter Minimum, Abwesenheiten gesamt
- **Filter** nach Modul / Status

### `/push` — Push-Subscription verwalten

- Aktivieren / Deaktivieren
- Test-Push senden
- Geräte-Liste

### `/settings` — Konfiguration

- Scraper-Intervall
- Telegram-Bot-Setup
- Credentials (wenn `ALLOW_UI_CREDENTIALS=true`)
- Theme (Light / Dark / System)

### `/telegram` — Bot-Status & Setup

- Bot-Status, letzter Heartbeat
- Befehl-Übersicht
- Onboarding-Hilfe

## Inline-Raumpläne

Beim Klick auf einen Raum (z. B. „W420" im Stundenplan) öffnet sich der Raumplan des entsprechenden Stockwerks (4. OG / 2. OG) mit dem **aktuellen Raum live highlightet**.

## Technik

| Schicht | Tool |
|---|---|
| Framework | SvelteKit 2 (`adapter-static`) |
| UI-Lib | Svelte 5 (Runes) |
| State | Native Svelte 5 Stores (`*.svelte.ts`) |
| API | Eigener `client.ts` mit Fetch-Wrapper + Bearer-Token |
| Live-Updates | Server-Sent-Events via `EventSource` |
| Build | Vite, baut nach `dist/` (vom Express-Server gehostet) |

## Command Palette (`Ctrl/⌘ + K`)

Schnelle Navigation zwischen allen Ansichten ohne Maus. Suche nach Modulen, Räumen, Settings.

## Help Overlay (`?`)

Tastatur-Shortcuts und Tipps im laufenden Dashboard.

## Mobile vs Desktop

- **Desktop:** SvelteKit-SPA unter `/`
- **Mobile:** legacy Vanilla-JS-PWA unter `/mobile/` — siehe [Mobile-App (PWA)](/features/mobile-pwa/)
