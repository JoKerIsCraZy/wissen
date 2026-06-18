---
title: Mitwirken
description: Wie du beim Projekt mithilfst — Issues, Pull Requests, Code-Style.
---

Beiträge sind willkommen — egal ob Bug-Report, Feature-Idee, Dokumentations-Verbesserung oder Code-PR.

## Lokale Entwicklung

```bash
git clone https://github.com/JoKerIsCraZy/wissen.git
cd wissen

cp .env.example .env          # Werte eintragen
npm install
npm run setup                 # Playwright Chromium

npm run serve                 # HTTP-Server auf :3000
# oder einmal-Abfrage:
npm start
```

:::tip
`HEADLESS=false` in `.env` setzen — der Browser ist sichtbar, sehr hilfreich beim Debuggen von Login-Problemen.
:::

## Workflow

### 1. Issue erstellen

Beschreibe das Problem oder die Feature-Idee kurz. **Vorher prüfen**, ob es bereits ein offenes Issue dazu gibt.

→ <https://github.com/JoKerIsCraZy/wissen/issues>

### 2. Fork + Feature-Branch

```bash
git checkout -b feat/mein-feature
# oder
git checkout -b fix/login-edge-case
```

### 3. Implementieren

- Bestehende Tests laufen lassen: `npm test`
- Neue Tests für neue Funktionalität schreiben (`test/unit/*.test.js`)
- Code-Style siehe unten

### 4. Pull Request gegen `main`

- Kurze Beschreibung: was wurde geändert und warum
- Bei UI-Änderungen: vorher / nachher Screenshots

Für Bugfixes reicht meist ein kleines reproduzierbares Beispiel im Issue.

## Code-Style

- **Sprache:** CommonJS (`require` / `module.exports`), kein Build-Schritt im Backend
- **Datei-Größe:** max. ~400 Zeilen pro Datei; lieber mehrere kleine Module
- **Fehlerbehandlung:** Fehler immer explizit behandeln — nie still verschlucken
- **Keine externen Linter-Configs** im Repo; orientiere dich am bestehenden Stil der Dateien in `src/`
- **Keine Secrets** in Commits — `.env`, `data/` und `*.png` sind gitignored
- **Immutability:** Objekte nicht in-place ändern, sondern neue Objekte zurückgeben (wie in `settings.js` praktiziert)

> Kurz: lies zwei, drei bestehende Dateien in `src/` durch — der Stil ist konsistent und selbsterklärend.

## Tests

```bash
npm test                                # alle Unit-Tests
node --test test/unit/auth.queryToken.test.js  # einzelner Test
```

Tests nutzen `node:test` und brauchen kein extra Framework.

## Frontend (V2 / SvelteKit)

```bash
npm run dev:web                # Dev-Server auf :5173 mit HMR
npm run build:web              # Build nach dist/
```

Frontend-Code in `web-svelte/`, baut nach `dist/`. Der Express-Server hostet `dist/` als Static-Files.

## Mobile-PWA

Vanilla-JS, kein Build. Direkt in `web/mobile/` editieren — Reload reicht.

## Lizenz

Mit einem Pull Request stimmst du zu, dass dein Beitrag unter der **MIT License** veröffentlicht wird — also frei nutzbar für alle, kommerziell wie privat.

Mehr dazu: [Lizenz](/projekt/lizenz/).

## Code of Conduct

Sei freundlich, sei konstruktiv. Persönliche Angriffe, Diskriminierung oder Belästigung führen zum Ausschluss aus dem Projekt.

## Fragen?

GitHub-Issues sind der bevorzugte Ort.
