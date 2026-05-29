---
title: Mobile-App (PWA)
description: Installierbar auf iOS und Android — fühlt sich an wie eine echte App.
---

WISSen hat eine **dedizierte Mobile-View** unter `/mobile/`, gebaut als **Progressive Web App (PWA)** — komplett offline-fähig, mit App-Icon auf dem Homescreen, Push-Benachrichtigungen und Service-Worker.

## Installation

### 1. Mobile-View öffnen

Im Dashboard auf **„Smartphone-View"** tippen → öffnet `/mobile/`. Token einmalig eingeben (kommt aus dem Dashboard-Login).

### 2. Auf den Homescreen

#### Android (Chrome / Brave / Edge)
- Browser-Menü `⋮` → **„App installieren"** oder **„Zum Startbildschirm hinzufügen"**

#### iOS (Safari)
- Teilen-Symbol `⤴` → **„Zum Home-Bildschirm"**

Danach hast du ein normales App-Icon auf dem Handy. Beim Tap startet die App im **Standalone-Modus** ohne Browser-UI.

:::caution[iOS-Hinweis]
Push-Benachrichtigungen funktionieren auf iOS **nur in der installierten PWA**, nicht im Safari-Tab (iOS-Sicherheitsregel). Erst installieren, dann Push aktivieren.
:::

## Was die Mobile-App kann

| Bereich | Inhalt |
|---|---|
| **Aktuell** | Now-Card, Next-Card, Last-Changed |
| **Stundenplan** | Tages-/Wochen-Listen, Raumwechsel-Highlights |
| **Noten** | Übersicht, Modul-Sheet mit LB/ZP-Liste |
| **Absenzen** | Stats-Header + Modul-Liste (A–Z, Typ-Filter); Tap aufs Modul öffnet Sheet mit Tagesliste pro Lektion + Status-Badge |
| **Push** | Aktivieren, Test-Push, Subscriptions verwalten |
| **Settings** | Scraper, Telegram, Credentials |
| **Scrape** | Manueller Scrape mit Live-Phase-Anzeige |

## Service-Worker

Die PWA nutzt einen Service-Worker (`web/mobile/sw.js`) für:

- **Offline-Caching** statischer Assets (CSS, JS, Icons)
- **Push-Empfang** auch bei geschlossener App
- **Stale-while-revalidate** für API-Antworten

## Theme & Look

- **Dark by default** (Schul-Setup, Abend-Lernen)
- **Bottom-Tab-Bar** für Daumen-Navigation
- **Pull-to-Refresh** auf den Listen-Views
- **Vollbild-Sheets** für Modul-Details (kein Tab-Wechsel nötig)

## Push aktivieren

In der **installierten** Mobile-App: **Settings → „Push aktivieren"** → Browser-Erlaubnis bestätigen → Test-Button drücken.

Vollständige Anleitung: [Push-Benachrichtigungen](/features/push/).

## Brave-spezifischer Hinweis

Auf Brave Desktop muss `brave://settings/privacy` → **„Google-Dienste für Push-Nachrichten verwenden"** aktiviert sein. Andernfalls schlägt die Subscription stillschweigend fehl.

## Updates

Da der Service-Worker statische Assets cached, kann die App **nach einem Update einen Reload brauchen** — meist erkennt sie das automatisch und zeigt einen kleinen Toast.

## Technik

- **Vanilla-JS** (kein Build-Schritt) — schlank, schnell, langfristig wartbar
- **Pure-CSS** mit Custom-Properties + responsive Tokens
- **Web-Push** via Standard-Web-Push-API (kein Firebase-Lock-in auf Client-Seite)
