---
title: Telegram-Bot
description: Live-Tracking, Push und interaktives Menü direkt in Telegram.
---

Der Telegram-Bot ist die **zweite Zugriffs-Schicht** — perfekt wenn du das Dashboard nicht öffnen willst, aber trotzdem live im Blick haben möchtest.

## Setup

### 1. Bot bei BotFather erstellen

1. Schreibe [@BotFather](https://t.me/BotFather) auf Telegram an
2. `/newbot` → Bot-Name wählen → Username wählen
3. Du erhältst einen **Token** wie `123456:ABC-DEF...`

### 2. Deine User-ID holen

1. Schreibe [@userinfobot](https://t.me/userinfobot) an
2. Er antwortet mit deiner **User-ID** (eine Zahl)

### 3. In `.env` eintragen

```properties
TELEGRAM_ENABLED=true
TELEGRAM_TOKEN=123456:ABC-DEF...
TELEGRAM_ALLOWED_USER_ID=123456789
```

### 4. Server neu starten

Der Bot meldet sich beim Boot mit „🤖 WISSen bereit". Dann `/menu` schreiben.

## Befehle

| Befehl | Funktion |
|---|---|
| `/menu` | Hauptmenü mit Inline-Buttons |
| `/noten` | Notenübersicht (Modul-Klick → LB / ZP-Liste) |
| `/durchschnitt` | Schnitt gesamt + pro Semester |
| `/heute` | Stundenplan heute |
| `/morgen` | Stundenplan morgen |
| `/woche` | Stundenplan diese Woche |
| `/stundenplan` | Bis 1 Monat (Multi-Message für „Alle") |
| `/abfrage` | Manuelle Abfrage mit Live-Phase-Anzeige (Alias: `/scrape`) |
| `/status` | Server-Status + Scheduler-Info |

## Push-Benachrichtigungen via Telegram

Wenn der Bot aktiv ist, kommen **alle Push-Events** (neue Note, Notenänderung, Raumwechsel) **zusätzlich** als Telegram-Message — keine Doppel-Notification, sondern parallel zur Web-Push.

Praktisch wenn du:
- Auf dem PC arbeitest und das Handy nicht an hast
- Telegram als zentrale Notification-Schiene nutzt
- Die Mobile-PWA nicht installieren willst

## Sicherheit

`TELEGRAM_ALLOWED_USER_ID` schützt davor, dass **fremde Telegram-Nutzer** Zugriff auf deine Daten bekommen, falls jemand deinen Bot-Username findet. Nachrichten von anderen User-IDs werden ignoriert.

Mehrere User-IDs sind aktuell **nicht** unterstützt (per Design — der Bot ist Single-User).

## Modul-Detail per Klick

Im `/noten`-Output sind die Module Inline-Buttons. Tap → ZP/LB-Liste mit Gewichtung und Trend.

Beispiel:
```
📚 M114 — Codeverwaltung
Note: 5.2 ↑ (+0.3)

LB1 (50%): 5.0
LB2 (50%): 5.4
```

## Live-Phase-Anzeige

`/abfrage` (Alias `/scrape`) zeigt den Abfrage-Fortschritt in Echtzeit:

```
🔄 Login...
🔄 Noten laden...
🔄 Stundenplan laden...
✅ Fertig in 14.2 s
   3 Module aktualisiert · 1 neue Note
```

## Bot-Architektur

| Modul | Aufgabe |
|---|---|
| `bot/index.js` | Telegram-Long-Polling, Routing |
| `bot/state.js` | Per-User-State (Conversation, Wartezustände) |
| `bot/keyboards.js` | Inline-Keyboards |
| `bot/screens.js` | Antwort-Templates |
| `bot/handlers.js` | Command-Handler |
| `bot/notify.js` | Push-Bridge (Web-Push → Telegram) |
| `bot/format.js` | Noten- und Termin-Formatter |
| `bot/telegram.js` | Telegram-API-Wrapper |
