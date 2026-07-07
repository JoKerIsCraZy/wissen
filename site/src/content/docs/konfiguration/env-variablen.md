---
title: Environment-Variablen
description: Alle ENV-Variablen — Pflicht, häufig genutzt, erweitert.
---

Alle Settings über `.env`-Datei oder Docker `-e`-Flags. Eine Beispiel-Datei findest du im Repo unter [`.env.example`](https://github.com/JoKerIsCraZy/wissen/blob/main/.env.example).

## Pflicht

| Variable | Beschreibung |
|---|---|
| **`MS_EMAIL`** | Microsoft-SSO E-Mail (`name@schule.ch`) |
| **`MS_PASSWORD`** | Microsoft-Passwort |

Ohne diese beiden kann WISSen sich nicht beim Microsoft-SSO einloggen.

## Häufig genutzt

| Variable | Default | Beschreibung |
|---|---|---|
| `API_TOKEN` | *auto* | Schutz für `/api/*`-Routen. Leer lassen = Auto-Generierung beim Start (in `data/.api-token`) |
| `TELEGRAM_ENABLED` | `false` | Telegram-Bot einschalten |
| `TELEGRAM_TOKEN` | — | Bot-Token von [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_ALLOWED_USER_ID` | — | Deine User-ID von [@userinfobot](https://t.me/userinfobot) |
| `ALLOW_UI_CREDENTIALS` | `true` | Credentials im UI änderbar. Settings werden mit AES-256-GCM verschlüsselt |
| `TZ` | `Europe/Zurich` | Zeitzone für Logs/Telegram |
| `PORT` | `3000` | HTTP-Port |
| `TRUST_PROXY` | `1` | Anzahl Hops dem `X-Forwarded-For` vertraut wird |
| `SSE_LOG_LEVEL` | `info,warn,error` | Welche Logger-Level an Browser-Clients gestreamt werden |

## Erweitert

### Verschlüsselung (Master-Key)

AES-256-GCM für die Secrets in `settings.json` **und** die Session in `storage.json`. Ladereihenfolge: erste vorhandene Quelle gewinnt.

| Variable | Default | Beschreibung |
|---|---|---|
| `MASTER_KEY` | — | 32 Bytes als 64 Hex-Chars **oder** base64. Bevorzugt — liegt off-volume, kein Leak über `data/`-Backups |
| `MASTER_KEY_FILE` | — | Pfad zu einer Key-Datei (z. B. Docker-Secret). Inhalt: rohe 32 Byte oder hex/base64-Text |
| *(Fallback)* | `data/.master-key` | Auto-generiert beim ersten Start (Mode `0600`), falls keine env-Quelle gesetzt |

Key generieren: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

:::caution[Off-volume ablegen]
Ohne `MASTER_KEY`/`MASTER_KEY_FILE` liegt der Key in `data/.master-key` und reist in jedem Volume-Backup mit — die Verschlüsselung schützt dann nicht gegen Backup-Leaks. Details & Migrationspfad: [Sicherheit → Master-Key](/konfiguration/sicherheit/#master-key--ladereihenfolge).
:::

### URLs (env-only, kein UI-Zugriff = SSRF-Schutz)

| Variable | Default | Beschreibung |
|---|---|---|
| `TOCCO_BASE` | `https://wiss.tocco.ch` | Tocco-Basis-URL |
| `NOTEN_URL` | *Notenseite* | Vollständige Tocco-Noten-URL |
| `STUNDENPLAN_URL` | *Stundenplanseite* | Vollständige Tocco-Stundenplan-URL |
| `USER_PK` | — | Tocco-User-Primärschlüssel |

### Browser / Datenquelle

| Variable | Default | Beschreibung |
|---|---|---|
| `DATA_SOURCE` | `rest` | Datenquelle: `rest` = nice2 REST v2 + DWR (Default), `scrape` = DOM-Scraping (Fallback). env-only |
| `HEADLESS` | `true` | `false` = sichtbarer Browser (Debug) |
| `SLOW_MO` | `0` | Millisekunden zwischen Playwright-Aktionen |
| `DEBUG_SCRAPER` | `false` | DOM-Dumps bei Fehlern (nur im `scrape`-Fallback relevant) |

### Web-Push (VAPID)

| Variable | Default | Beschreibung |
|---|---|---|
| `VAPID_PUBLIC_KEY` | *auto* | Web-Push Public-Key. Auto-generiert in `data/vapid.json` falls leer |
| `VAPID_PRIVATE_KEY` | *auto* | Web-Push Private-Key |
| `VAPID_SUBJECT` | `mailto:admin@example.com` | Kontakt-Adresse für Push-Provider |

### NAS / Container-Permissions

| Variable | Default | Beschreibung |
|---|---|---|
| `PUID` | `1000` | Container-User-ID (siehe [NAS / Unraid](/docker/nas-unraid/)) |
| `PGID` | `1000` | Container-Group-ID |

## Wichtige Sicherheits-Hinweise

:::caution[TRUST_PROXY]
Niemals `true` setzen — das erlaubt IP-Spoofing über `X-Forwarded-For`-Header. Nutze stattdessen die exakte Anzahl Proxy-Hops (`1` für einen Reverse-Proxy, `2` für CF→nginx→app).
:::

:::tip[Credentials-Quelle]
Setze `ALLOW_UI_CREDENTIALS=false` wenn du strikt nur `.env` als Secret-Quelle willst (z. B. bei Vault/SOPS-Setups). Default `true` ist okay weil `data/settings.json` (und `storage.json`) AES-256-GCM-verschlüsselt sind — am besten mit Master-Key off-volume via `MASTER_KEY`.
:::
