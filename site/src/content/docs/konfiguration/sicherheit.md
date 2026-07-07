---
title: Sicherheit
description: Auth, Anti-Brute-Force, Encryption-at-Rest, Reverse-Proxy, Backup-Strategien.
---

WISSen verwaltet **deine echten WISS-Zugangsdaten** und **deine Noten**. Sicherheit ist daher ernst gemeint.

## Authentifizierung

### Bearer-Token

Alle `/api/*`-Routen brauchen einen Bearer-Token im `Authorization`-Header:

```bash
curl -H "Authorization: Bearer $API_TOKEN" http://localhost:3000/api/noten
```

Der Token wird beim ersten Start auto-generiert (32 zufällige Bytes) und in `data/.api-token` abgelegt.

### Query-String-Auth (eingeschränkt)

`?token=…` ist **nur** auf `/api/events` erlaubt (EventSource kann keine Header setzen). Auf allen anderen Routen wird Query-Token abgewiesen — damit der Token nicht in Reverse-Proxy-Logs, Browser-History oder Referrer-Headern landet.

## Anti-Brute-Force (drei Schichten)

| Schicht | Limit | Lockout |
|---|---|---|
| Kurz | 10 Fehlversuche / 15 min | 15 min |
| Mittel | 50 Fehlversuche / 6 h | 6 h |
| SSE-spezifisch | 60 Fehlversuche / 15 min | (toleriert EventSource-Reconnect-Storms) |

Implementiert in `src/ratelimits.js` mit `express-rate-limit`.

## SSRF-Schutz

- **Tocco-URLs** nur via ENV-Variablen setzbar — kein UI-Zugriff
- **Push-Endpoints** auf Whitelist beschränkt: FCM (Google), Mozilla Autopush, Apple, Windows Notification Service

## Secrets-Encryption (At-Rest)

Zwei Artefakte werden mit **AES-256-GCM** verschlüsselt:

- `data/settings.json` — die Secrets `msPassword` und `telegramToken`
- `data/storage.json` — die komplette eingeloggte Tocco-Session (Cookies/Tokens)

- **Format-Versioning:** `enc:v1:<iv>:<ct>:<tag>` — erlaubt künftige Algo-Wechsel
- **Lazy Migration:** Bestands-Plaintext-Werte werden beim nächsten Save migriert

### Master-Key — Ladereihenfolge

Die erste vorhandene Quelle gewinnt:

| Priorität | Quelle | Empfehlung |
|---|---|---|
| 1 | `MASTER_KEY` (env) — 32 Bytes als 64 Hex-Chars **oder** base64 | ✅ bevorzugt |
| 2 | `MASTER_KEY_FILE` (env) — Pfad zu einer Key-Datei (z. B. Docker-Secret) | ✅ bevorzugt |
| 3 | `data/.master-key` — Legacy-Fallback, auto-generiert (Mode `0600`) | ⚠️ liegt im Volume |

:::caution[Off-volume ablegen]
Liegt der Key nur im Legacy-`data/.master-key`, reist er in **jedem** Backup/Snapshot des `data/`-Volumes mit — dann bringt die Verschlüsselung bei einem Volume-Leak nichts. Setze `MASTER_KEY` oder `MASTER_KEY_FILE` **außerhalb** von `data/`, um Key und Daten zu trennen.
:::

Ist `MASTER_KEY`/`MASTER_KEY_FILE` gesetzt aber ungültig/unlesbar, bricht der Start **laut** ab — es wird nie still ein neuer Key generiert (das würde Bestands-Ciphertexte unlesbar machen).

### Was geschützt ist

✅ Backup-Leaks & Volume-Snapshots — **vorausgesetzt der Key liegt off-volume** (`MASTER_KEY`/`MASTER_KEY_FILE`)
✅ Casual File-Sharing des `data/`-Verzeichnisses

### Was NICHT geschützt ist

❌ Shell-Access auf den laufenden Host
❌ Memory-Dumps
❌ Container-Escape
❌ **`data/wissen.db` selbst** — die SQLite-DB liegt im Klartext (siehe nächster Abschnitt)

## Verschlüsselung at rest — Volume/Disk (`wissen.db`)

`data/wissen.db` enthält **personenbezogene Daten** (Noten, Dozentennamen, Stundenplan, Anwesenheit) und liegt **im Klartext** auf der Platte — `node:sqlite` kann die DB-Datei nicht selbst verschlüsseln.

Für echten At-Rest-Schutz das `data/`-Verzeichnis (inkl. WAL-Sidecars) auf ein **verschlüsseltes Volume** legen — eine Ebene unter der App:

```bash
# gocryptfs — FUSE-Overlay, kein root für den Mount, pro-Datei-Verschlüsselung
gocryptfs -init /srv/wissen/cipher
gocryptfs /srv/wissen/cipher /srv/wissen/plain   # data/ hierhin legen

# LUKS — blockbasiert, ganze Partition/Loopback
cryptsetup luksFormat /srv/wissen.img
cryptsetup luksOpen  /srv/wissen.img wissen_crypt   # → mkfs + mount → data/
```

- **Docker:** Bind-Mount auf den entsperrten Pfad statt `./data`. Fertiges Beispiel: [`docker-compose.encrypted.yml.example`](https://github.com/JoKerIsCraZy/wissen/blob/main/docker-compose.encrypted.yml.example)
- **NAS:** Synology/QNAP „Encrypted Shared Folder" nutzen; Unraid: verschlüsselter Pool/Share
- **Desktop:** BitLocker (Windows), FileVault (macOS), LUKS (Linux) auf der Partition mit `data/`

Deckt das **komplette** `data/` ab (DB, WAL/SHM, `storage.json`, Tokens, Master-Key). Schützt gegen Platten-Diebstahl, Backup-/Snapshot-Leak und entwendete Datenträger — **nicht** gegen Zugriff auf den laufenden, entsperrten Host.

## Upgrade von einer älteren Version

Der Wechsel auf eine Version mit `MASTER_KEY`-Support ist **rückwärtskompatibel** — du musst nichts tun:

| Szenario beim Update | Ergebnis |
|---|---|
| **Nichts gesetzt** | ✅ Läuft weiter — Fallback liest die bestehende `data/.master-key` (identischer Key) |
| `MASTER_KEY` = **alter Key als hex** | ✅ Funktioniert (Migrationspfad, siehe unten) |
| `MASTER_KEY` = **frisch generiert**, ohne Migration | ⚠️ Start bricht **laut** ab — der Key passt nicht zu den alten Blobs |
| Uralt-Bestand mit **Plaintext**-Secrets | ✅ Wird durchgereicht, beim nächsten Save verschlüsselt |

:::danger[Migration off-volume — richtig machen]
Beim Umzug des Keys aus dem Volume den **vorhandenen** Key exportieren, **nicht** einen neuen erzeugen:

```bash
# 1. bestehenden Key als hex ausgeben
node -e "console.log(require('fs').readFileSync('data/.master-key').toString('hex'))"
# 2. Ausgabe als MASTER_KEY in .env / Docker-Secret setzen
# 3. erst DANN data/.master-key löschen
```

Setzt du `MASTER_KEY` auf einen **anderen** Wert als den bestehenden Key, sind `settings.json` und `storage.json` nicht mehr entschlüsselbar.
:::

## Reverse-Proxy + TLS

Für öffentliche Exposition **immer** Reverse-Proxy mit TLS davor.

### Caddy (einfachster Weg)

```caddyfile
wissen.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

Caddy holt automatisch ein Let's-Encrypt-Zertifikat.

### nginx

```nginx
server {
  listen 443 ssl http2;
  server_name wissen.example.com;

  ssl_certificate /etc/letsencrypt/live/wissen.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/wissen.example.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # SSE braucht Buffering aus
    proxy_buffering off;
    proxy_cache off;
  }
}
```

### Traefik (mit Compose-Labels)

```yaml
labels:
  - "traefik.enable=true"
  - "traefik.http.routers.wissen.rule=Host(`wissen.example.com`)"
  - "traefik.http.routers.wissen.entrypoints=websecure"
  - "traefik.http.routers.wissen.tls.certresolver=letsencrypt"
  - "traefik.http.services.wissen.loadbalancer.server.port=3000"
```

### TRUST_PROXY korrekt setzen

| Setup | `TRUST_PROXY` |
|---|---|
| Direkt (kein Proxy) | `loopback` |
| 1 Reverse-Proxy davor | `1` (Default) |
| Cloudflare → nginx → app | `2` |
| **Niemals** | `true` (IP-Spoofing) |

## Backup-Verschlüsselung

Das App-interne Encryption-Layer schützt `settings.json` gegen versehentliche `data/`-Leaks. Für **echte** Backup-Sicherheit das Backup zusätzlich verschlüsseln:

### restic — incremental, deduplicated, AES-256

```bash
restic init --repo /backups/wissen
restic -r /backups/wissen backup ./data --exclude 'data/.master-key'
```

### borg — incremental, deduplicated

```bash
borg init --encryption=repokey /backups/wissen
borg create /backups/wissen::$(date +%Y%m%d) ./data --exclude '*/.master-key'
```

### gpg — single-shot tarball

```bash
tar czf - data | gpg --symmetric --cipher-algo AES256 -o wissen-backup-$(date +%Y%m%d).tar.gz.gpg
```

:::danger[Master-Key]
Am saubersten: den Key gar nicht erst im Volume halten — via `MASTER_KEY` / `MASTER_KEY_FILE` off-volume ablegen (siehe oben). Bleibt der Legacy-`data/.master-key` in Nutzung, dann entweder:
- Vom Backup **ausschließen** UND separat an sicherem Ort sichern, **oder**
- Mit drinlassen — dann sind die verschlüsselten Secrets nur durch die Backup-Passphrase geschützt
:::

## Was in `data/` liegt

| Datei | Inhalt | Sensibel? |
|---|---|---|
| `wissen.db` | SQLite mit Noten + Stundenplan (**Klartext** — siehe Volume-Encryption) | Persönliche Daten |
| `settings.json` | Settings (verschlüsselt: msPassword, telegramToken) | Ja |
| `storage.json` | Eingeloggte Tocco-Session (verschlüsselt) | Ja |
| `.api-token` | API-Bearer-Token | Ja |
| `.master-key` | AES-256-GCM Master-Key (Legacy-Fallback; besser `MASTER_KEY` off-volume) | **Sehr** |
| `vapid.json` | Web-Push VAPID-Keys | Ja |
| `.weekly-detail-at` | Wochen-Check-Marker | Nein |

`data/` **niemals** veröffentlichen — auch nicht Read-Only.

## Content-Security-Policy

Helmet-CSP mit `script-src 'self' 'unsafe-inline'`. Hintergrund: SvelteKit `adapter-static` prerendert Inline-Bootstrap-Skripte zur Build-Zeit. Migration zu strikter CSP ist als TODO im Code dokumentiert.
