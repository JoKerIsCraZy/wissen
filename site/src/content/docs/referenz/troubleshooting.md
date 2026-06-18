---
title: Troubleshooting
description: Häufige Probleme und deren Lösung.
---

## Login & Abfrage

### Login schlägt fehl

- Passwort und MFA prüfen
- `HEADLESS=false` in `.env` setzen → sichtbares Chromium bei der nächsten Abfrage, du siehst direkt was schiefgeht

### `Executable doesn't exist` (Playwright)

```bash
npx playwright install chromium
```

Im Docker-Image ist Chromium bereits dabei — dieser Fehler tritt nur bei lokaler Installation auf.

> Auch im REST-v2-Pfad (`DATA_SOURCE=rest`) braucht WISSen Chromium für den Microsoft-SSO-Login.

### Abfrage hängt minutenlang

- WISS / Tocco-Portal kann gerade langsam sein
- Im DOM-Scraping-Fallback (`DATA_SOURCE=scrape`): `DEBUG_SCRAPER=true` → bei Fehlern werden DOM-Dumps in `data/` geschrieben

### Tocco-Portal hat sich geändert

- **REST-v2-Pfad (Default):** Feld-Mappings in `src/rest/` (`client.js` / `producer.js`) brauchen ggf. ein Update
- **DOM-Scraping-Fallback:** Selektoren in `src/scraper.js` und `src/db/parsers.js` brauchen Update

Issue auf GitHub eröffnen (im Scraping-Fallback gern mit DOM-Dump).

## API & Auth

### Token vergessen

```bash
rm data/.api-token
# Restart → neuer Token in den Logs
docker logs wissen | grep AUTO-GENERATED
```

### `401 Unauthorized` trotz Token

- Header-Format prüfen: `Authorization: Bearer <token>` (mit Leerzeichen)
- Token aus `data/.api-token` (komplette Zeile, ohne Whitespace)
- Bei `?token=` URL-Param: nur auf `/api/events` erlaubt

### `429 Too Many Requests`

Anti-Brute-Force greift. Warte 15 Minuten oder restarte den Container. Siehe [Sicherheit](/konfiguration/sicherheit/#anti-brute-force-drei-schichten).

## Mobile / PWA / Push

### Mobile-Push aktivieren geht nicht

Mobile-Push braucht **HTTPS**. Über LAN-IP funktioniert's nicht (Browser-Sicherheitsregel). Lösung: Reverse-Proxy mit TLS davor — siehe [Sicherheit](/konfiguration/sicherheit/#reverse-proxy--tls).

### iOS Push-Toggle ausgegraut

Die PWA muss **installiert** sein (Safari → Teilen → „Zum Home-Bildschirm"), nicht im Browser-Tab.

### Brave-Push schlägt fehl

`brave://settings/privacy` → **„Google-Dienste für Push-Nachrichten verwenden"** aktivieren. Brave blockt Google-FCM standardmäßig.

### Service-Worker-Updates kommen nicht durch

Hard-Refresh (`Ctrl+Shift+R` / Cmd+Shift+R) oder PWA deinstallieren + neu installieren.

## Daten & DB

### Stundenplan zeigt alte Einträge

Im Stundenplan-Tab → **„DB zurücksetzen"** → manuelle Abfrage. Die Tabelle wird komplett neu aufgebaut.

### Wochen-Check soll erneut laufen

```bash
rm data/.weekly-detail-at
# Restart
```

### Keine LB / ZP im Modul

Bei der nächsten Abfrage wird's nachgezogen. Manuell: „Jetzt abfragen" im Dashboard oder `/abfrage` in Telegram.

### `database is locked`

Sehr selten — meist wenn zwei Container gleichzeitig auf dasselbe `data/` zugreifen. **Nur einen Container pro `data/`-Ordner** laufen lassen.

### DB-Backup während Container läuft

```bash
docker exec wissen sh -c 'sqlite3 /app/data/wissen.db ".backup /tmp/wissen-backup.db"'
docker cp wissen:/tmp/wissen-backup.db ./wissen-backup-$(date +%Y%m%d).db
```

## Docker

### `EACCES: permission denied` auf `/app/data`

PUID / PGID stimmen nicht. Siehe [NAS / Unraid](/docker/nas-unraid/).

### Container restartet ständig

```bash
docker logs wissen
```

Häufigste Ursachen:
- Health-Check schlägt fehl (Server brauchte > 30 s zum Boot) → `start_period: 60s` in compose
- `MS_EMAIL` oder `MS_PASSWORD` fehlen → Logs zeigen Login-Error
- Port `3000` schon belegt → Port mappen `-p 3001:3000`

### Chromium-Sandbox-Error

Siehe [Docker Deployment → Chromium-Sandbox](/docker/deployment/#chromium-sandbox-probleme).

## Telegram-Bot

### Bot reagiert nicht

- `TELEGRAM_ENABLED=true` gesetzt?
- `TELEGRAM_TOKEN` korrekt (vom BotFather, mit Doppelpunkt)?
- `TELEGRAM_ALLOWED_USER_ID` ist deine ID (vom @userinfobot)?
- Server neu gestartet nach `.env`-Änderung?

### „Bot is unauthorized"

Token ist falsch oder Bot wurde im BotFather gelöscht. Neuen Token holen.

### Bot reagiert auf `/start`, aber sonst nicht

Du bist evtl. nicht der `TELEGRAM_ALLOWED_USER_ID`. Prüfe deine ID via [@userinfobot](https://t.me/userinfobot).

## Performance

### Abfrage dauert > 60 s

- Tocco-Portal langsam — abwarten
- `HEADLESS=false` + `SLOW_MO=100` für Debug
- Im DOM-Scraping-Fallback: DOM-Dumps via `DEBUG_SCRAPER=true`

### Hohe CPU-Last während Idle

Scheduler-Intervall zu kurz. In Settings auf 30 min oder mehr stellen — die Abfragen brauchen keine 5-Minuten-Granularität.

## Sonstiges

### Wo logge ich Issues?

→ <https://github.com/JoKerIsCraZy/wissen/issues>

Bitte vorher die offenen Issues durchsuchen — vielleicht gibt's das Problem schon.
