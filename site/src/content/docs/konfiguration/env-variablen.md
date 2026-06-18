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
Setze `ALLOW_UI_CREDENTIALS=false` wenn du strikt nur `.env` als Secret-Quelle willst (z. B. bei Vault/SOPS-Setups). Default `true` ist okay weil `data/settings.json` AES-256-GCM-verschlüsselt ist.
:::
