---
title: Ins Internet freigeben
description: Wie du deine selbst-gehostete WISSen-Instanz sicher von außen erreichbar machst — Cloudflare Tunnel, Reverse-Proxy mit TLS, oder Port-Forwarding.
---

Standardmäßig hört WISSen nur auf **`localhost:3000`** (bzw. im LAN, wenn du `-p 3000:3000` ohne `127.0.0.1`-Bindung nutzt). Um die Instanz von unterwegs zu erreichen — und damit [Mobile-Push](/features/push/) überhaupt funktioniert — musst du sie kontrolliert nach außen freigeben.

:::caution[HTTPS ist Pflicht für Mobile-Push]
Web-Push und die PWA-Installation auf dem Handy brauchen **HTTPS** (Browser-Sicherheitsregel) — über eine nackte LAN-IP funktioniert beides nicht. Siehe [Push-Benachrichtigungen](/features/push/#push-trotzdem-nicht-angekommen). Wähle deshalb einen Weg mit echtem TLS-Zertifikat.
:::

Drei Optionen, von **empfohlen** zu **am wenigsten empfohlen**:

## 1. Cloudflare Tunnel (empfohlen)

Ein Cloudflare Tunnel baut eine ausgehende Verbindung von deinem Server zu Cloudflare auf. Du musst dafür **keine Inbound-Ports öffnen** und keine Portweiterleitung im Router einrichten — der Server bleibt von außen unsichtbar, der Traffic läuft durch den Tunnel.

**Vorteile:**

- Keine offenen Inbound-Ports, keine Router-Konfiguration
- Automatisches TLS — Cloudflare terminiert HTTPS auf einer Subdomain
- Free-Tier reicht für eine private WISSen-Instanz vollständig
- Funktioniert auch hinter CGNAT / ohne öffentliche IP

### Einrichtung (Kurzfassung)

Voraussetzung: eine Domain in deinem Cloudflare-Account.

```bash
# cloudflared installieren (Linux-Beispiel) und einloggen
cloudflared tunnel login

# Tunnel anlegen
cloudflared tunnel create wissen

# Tunnel auf die lokale App zeigen lassen
cloudflared tunnel route dns wissen wissen.example.com
cloudflared tunnel run --url http://localhost:3000 wissen
```

`cloudflared` zeigt dabei auf **`http://localhost:3000`** — also direkt auf den WISSen-Container/-Prozess. Für den Dauerbetrieb richtest du `cloudflared` als Dienst ein (`cloudflared service install`) oder lässt ihn als eigenen Container neben WISSen laufen.

### TRUST_PROXY bei Cloudflare Tunnel

Cloudflare setzt `X-Forwarded-For`, also muss WISSen genau die richtige Anzahl Proxy-Hops vertrauen — sonst wird entweder die echte Client-IP nicht erkannt oder IP-Spoofing möglich:

| Pfad zur App | `TRUST_PROXY` |
|---|---|
| Cloudflare Tunnel → App | `1` |
| Cloudflare → nginx → App | `2` |
| **Niemals** | `true` (erlaubt IP-Spoofing) |

Mehr dazu unter [Sicherheit → TRUST_PROXY korrekt setzen](/konfiguration/sicherheit/#trust_proxy-korrekt-setzen) und in den [Environment-Variablen](/konfiguration/env-variablen/).

## 2. Reverse-Proxy mit TLS (Caddy / Traefik / nginx)

Wenn du eine öffentliche IP und einen eigenen Server hast, setzt du einen Reverse-Proxy mit TLS-Terminierung davor. Du öffnest **Port 443** (HTTPS) am Router/Server, der Proxy terminiert TLS und leitet intern auf **`:3000`** weiter. WISSen selbst bleibt auf `localhost` gebunden.

Empfohlene Container-Bindung dafür (nur lokal erreichbar, der Proxy macht die Exposition):

```yaml
ports:
  - "127.0.0.1:3000:3000"
```

### Caddy (einfachster Weg, Auto-TLS)

```caddyfile
wissen.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

Caddy holt und erneuert das Let's-Encrypt-Zertifikat vollautomatisch — kein manuelles Zertifikats-Handling nötig.

Beispiele für **nginx** (inkl. der nötigen SSE-Buffering-Einstellungen) und **Traefik** findest du auf der [Sicherheits-Seite](/konfiguration/sicherheit/#reverse-proxy--tls).

### TRUST_PROXY beim Reverse-Proxy

| Setup | `TRUST_PROXY` |
|---|---|
| 1 Reverse-Proxy davor | `1` (Default) |
| Cloudflare → nginx → App | `2` |
| **Niemals** | `true` |

## 3. Port direkt aufmachen / Port-Forwarding (am wenigsten empfohlen)

Du kannst **`:3000`** auch direkt exponieren — per Portweiterleitung im Router oder indem du im Compose `-p 3000:3000` (ohne `127.0.0.1`) auf eine öffentliche IP bindest.

:::danger[Ohne TLS dringend abraten]
Bei direkter Exposition ohne TLS geht **alles im Klartext** über die Leitung: dein Bearer-Token, deine Noten, deine Daten. WISSen schützt zwar mit [Bearer-Token-Auth und Anti-Brute-Force in drei Schichten](/konfiguration/sicherheit/#anti-brute-force-drei-schichten) — das hilft aber nichts, wenn der Token unterwegs mitgelesen werden kann. Außerdem funktioniert **Mobile-Push ohne HTTPS nicht**.

Setze mindestens einen **Reverse-Proxy mit TLS** davor (Option 2) oder nimm besser gleich den **Cloudflare Tunnel** (Option 1).
:::

Wenn du `:3000` trotzdem direkt aufmachst:

- Niemals ohne gesetztes `API_TOKEN` bzw. ohne das auto-generierte Token aus `data/.api-token`
- `TRUST_PROXY` auf `loopback` lassen (es gibt keinen vertrauenswürdigen Proxy davor)
- `data/` niemals mit-exponieren — dort liegen Token, Master-Key und Credentials (siehe [Was in `data/` liegt](/konfiguration/sicherheit/#was-in-data-liegt))

## Zusammenfassung

| Option | Inbound-Port | TLS | Aufwand | Empfehlung |
|---|---|---|---|---|
| Cloudflare Tunnel | keiner | automatisch | gering | ✅ empfohlen |
| Reverse-Proxy (Caddy/Traefik/nginx) | 443 | automatisch (Caddy) / manuell | mittel | ✅ solide |
| Port direkt / Forwarding | 3000 | keins (ohne Proxy) | gering | ⛔ nur mit TLS davor |

## Weiterführend

- [Sicherheit](/konfiguration/sicherheit/) — Auth, Anti-Brute-Force, Reverse-Proxy-Details, Backup-Verschlüsselung
- [Environment-Variablen](/konfiguration/env-variablen/) — u. a. `TRUST_PROXY`, `PORT`, `API_TOKEN`
- [Docker Deployment](/docker/deployment/) — Networking-Bindung & Production-Checkliste
- [Push-Benachrichtigungen](/features/push/) — warum HTTPS Pflicht ist
