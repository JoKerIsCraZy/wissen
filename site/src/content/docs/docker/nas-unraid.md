---
title: NAS / Unraid / Synology
description: Permission-Fixes und plattformspezifische Tipps für Heim-NAS-Systeme.
---

NAS-Systeme haben eigene UID/GID-Konventionen, die zu `EACCES`-Fehlern auf `/app/data/*` führen können. Lösung: `PUID` und `PGID` als Environment-Variablen setzen.

## Permission-Fix

Bei `EACCES`-Fehlern füge dem `docker run` hinzu:

```bash
-e PUID=$(id -u) -e PGID=$(id -g)
```

Oder in `docker-compose.yml`:

```yaml
environment:
  - PUID=1000
  - PGID=1000
```

Defaults sind `1000`/`1000`.

## Plattform-Werte

| Plattform | PUID | PGID |
|---|---|---|
| Linux / macOS / WSL | `$(id -u)` | `$(id -g)` |
| **Unraid** | `99` | `100` |
| **Synology** | `1026` | `100` |
| **QNAP** | `1000` | `100` |
| **TrueNAS Scale** | `568` (apps) | `568` |
| **OpenMediaVault** | `1000` | `100` |

## Synology DSM — Container Manager

1. **Registry → ghcr.io/jokeriscrazy/wissen** suchen → Image runterladen
2. **Image → Erstellen → Container** mit:
   - Port: `3000:3000`
   - Volume: `/docker/wissen/data` → `/app/data`
   - Env: `MS_EMAIL`, `MS_PASSWORD`, `PUID=1026`, `PGID=100`, `TZ=Europe/Zurich`
3. Container starten → Logs auf API-Token prüfen

## Unraid — Community Apps

1. Apps → "Add Container" → Template manuell erstellen mit:
   - Repository: `ghcr.io/jokeriscrazy/wissen:latest`
   - Network: `bridge`
   - Port: `3000`
   - Path: `/mnt/user/appdata/wissen` → `/app/data`
   - Variables: `MS_EMAIL`, `MS_PASSWORD`, `PUID=99`, `PGID=100`
2. Apply → in Logs nach API-Token suchen

## QNAP Container Station

1. **Registry → Docker Hub → ghcr.io/jokeriscrazy/wissen**
2. **Erstellen → Erweitert:**
   - Volume: `/Container/wissen/data` → `/app/data`
   - Environment: `MS_EMAIL`, `MS_PASSWORD`, `PUID=1000`, `PGID=100`
3. Erstellen + Logs prüfen

## Docker auf Heim-Server (Linux)

Standard-`compose.yml` reicht — kein PUID/PGID nötig wenn der Docker-User dem App-User entspricht.

```bash
sudo chown -R 1000:1000 ./data   # falls nötig
chmod 750 ./data
```

## Häufige NAS-Probleme

### Container läuft, Dashboard nicht erreichbar
- Firewall des NAS prüfen (Port `3000` freigeben)
- Bei Synology: `Sicherheit → Firewall → Regeln` anpassen

### Logs zeigen `EACCES: permission denied, open '/app/data/...'`
- PUID/PGID stimmen nicht → siehe Tabelle oben
- Volume-Pfad auf NAS mit `chown -R 1000:1000` anpassen (falls SSH-Zugriff)

### App stürzt beim Login / bei der Abfrage ab — `Chromium failed to launch`
- NAS-Kernel zu alt für Chromium-Sandbox
- Setze `PLAYWRIGHT_CHROMIUM_ARGS=--no-sandbox` (siehe [Deployment](/docker/deployment/#chromium-sandbox-probleme))

### Container neu startet ständig
- Wahrscheinlich Health-Check schlägt fehl wegen langsamem Boot auf NAS
- Erhöhe `start_period` in compose.yml auf `60s`
