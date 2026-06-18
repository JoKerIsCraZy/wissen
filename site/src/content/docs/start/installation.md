---
title: Lokale Installation
description: WISSen ohne Docker installieren — für Entwicklung oder direktes Hosting.
---

Wenn du Docker nicht nutzen willst (oder das Projekt weiterentwickelst), läuft WISSen auch nativ.

## Voraussetzungen

- **Node.js ≥ 22.5** ([nodejs.org](https://nodejs.org))
- **~300 MB freier Speicher** für Chromium (Playwright)
- **WISS-Schulaccount**

## Setup

```bash
git clone https://github.com/JoKerIsCraZy/wissen.git
cd wissen

npm install            # zieht V2-Frontend-Deps mit (postinstall: cd web-svelte && npm install)
npm run setup          # Playwright Chromium installieren

cp .env.example .env   # Werte eintragen — siehe Konfiguration
```

## Server starten

```bash
npm run serve
```

Der Server baut zuerst das V2-Frontend (`preserve` = `build:web`), startet dann auf Port `3000` und fragt im konfigurierten Intervall ab.

## Dev-Modus mit HMR

Während der Frontend-Entwicklung lieber zwei Terminals:

```bash
# Terminal 1 — Backend API auf :3000
npm run serve

# Terminal 2 — SvelteKit Dev-Server auf :5173 mit Hot-Module-Replacement
npm run dev:web
```

## Einmal-Abfrage (CLI)

Statt Server: nur eine einzelne Abfrage ausführen.

```bash
npm start
```

## Nützliche Scripts

| Befehl | Wirkung |
|---|---|
| `npm run serve` | Build V2 + HTTP-Server auf `:3000` |
| `npm run dev:web` | SvelteKit-Dev-Server auf `:5173` |
| `npm run build:web` | V2-Frontend nach `dist/` bauen |
| `npm start` | Einmalige Abfrage (CLI-Modus) |
| `npm run setup` | Playwright Chromium installieren |
| `npm test` | Unit-Tests (`node:test`) |
| `npm run lint` | Syntax-Check aller `src/*.js` Dateien |

## Tipp zum Debuggen

`HEADLESS=false` in `.env` setzen, damit der Browser sichtbar ist — sehr hilfreich bei Login-Problemen.
