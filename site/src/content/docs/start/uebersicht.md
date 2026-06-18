---
title: Übersicht
description: Was WISSen ist, für wen es gedacht ist und was du damit bekommst.
---

**WISSen** ist ein inoffizieller Scraper für das WISS Tocco-Schulportal. Es holt deine Noten und deinen Stundenplan automatisch und stellt sie in einem modernen Dashboard, einer installierbaren Mobile-App (PWA) und einem Telegram-Bot zur Verfügung — mit Push-Benachrichtigungen bei jeder Änderung.

## Für wen?

- **WISS-Schüler:innen**, die ihre Noten und Termine zentral und automatisch im Blick haben wollen.
- **Selbsthoster:innen**, die ein eigenes Dashboard auf dem Heim-Server, NAS oder VPS laufen lassen möchten.
- **Hobby-Entwickler:innen**, die das Projekt forken, anpassen oder erweitern möchten.

## Funktionsumfang

| Feature | Beschreibung |
|---|---|
| 📊 **Noten-Dashboard** | SvelteKit-SPA mit Durchschnitten, Filtern, Modul-Detail (LB / ZP / Gewichtung), IPA-Rechner, Statistik |
| 📱 **Mobile-App (PWA)** | Installierbar auf iOS & Android — fühlt sich an wie eine native App |
| 🗺 **Inline-Raumpläne** | 4. OG / 2. OG mit Live-Highlighting des aktuellen Raums |
| 🔔 **Push-Benachrichtigungen** | Auf dein Handy bei neuen Noten und Zimmerwechseln — auch bei geschlossener App |
| 📅 **Stundenplan** | Tages-, Wochen- und Monatsansicht mit kommenden Terminen |
| ⏱ **Auto-Abfrage** | Intervall- oder Wochenplan-Modus |
| 💬 **Telegram-Bot** | Live-Tracking, Push und interaktives Menü |
| 🔒 **Sicher** | Bearer-Token-Auth, Anti-Brute-Force, Settings AES-256-GCM-verschlüsselt |
| 📜 **SQLite-Historie** | Alle Noten- und ZP/LB-Änderungen werden archiviert |

## Technik-Stack

Node.js 22 · Express 5 · Playwright · SQLite (nativ via `node:sqlite`) · web-push · SvelteKit 2 + Svelte 5 · Vanilla-JS-PWA

## Lizenz

WISSen steht unter der **MIT License** — frei nutzbar für privat, kommerziell, Forschung, Hobby. Forks, Re-Branding, Embedding: alles erlaubt, solange der Copyright-Hinweis erhalten bleibt. Mehr dazu: [Lizenz](/projekt/lizenz/).

## Disclaimer

Inoffizielles Hobby-Projekt. Keine Verbindung zur WISS oder Tocco AG. Bitte respektiere die ToS deiner Schule.
