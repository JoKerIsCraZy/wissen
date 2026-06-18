---
title: API-Übersicht
description: Alle REST-Endpoints mit Auth, Beispielen und Antwort-Schemas.
---

WISSen exponiert eine schlanke REST-API. Alle Endpoints (außer `/healthz`) erfordern einen **Bearer-Token** im `Authorization`-Header.

## Auth

```bash
curl -H "Authorization: Bearer $API_TOKEN" \
  http://localhost:3000/api/noten
```

`$API_TOKEN` findest du nach dem ersten Start in `data/.api-token` oder in den Logs (`AUTO-GENERATED API TOKEN`).

## Endpoints

### Public

| Methode | Pfad | Beschreibung |
|---|---|---|
| `GET` | `/healthz` | Health-Check (kein Auth) |

### Status

| Methode | Pfad | Beschreibung |
|---|---|---|
| `GET` | `/api/status` | Scheduler- und Server-Status |

### Settings

| Methode | Pfad | Beschreibung |
|---|---|---|
| `GET` | `/api/settings` | Settings lesen |
| `PATCH` | `/api/settings` | Settings ändern (validiert + persistiert) |

### Noten

| Methode | Pfad | Beschreibung |
|---|---|---|
| `GET` | `/api/noten` | Noten (`?semester=S1&sortBy=note`) |
| `GET` | `/api/noten/:id/pruefungen` | LB / ZP / OTHER eines Moduls |
| `GET` | `/api/history/:id` | Notenverlauf eines Moduls |
| `GET` | `/api/stats` | Gesamt-Statistiken |

### Stundenplan

| Methode | Pfad | Beschreibung |
|---|---|---|
| `GET` | `/api/stundenplan` | Termine (`?from=YYYY-MM-DD&limit=100`) |
| `POST` | `/api/stundenplan/clear` | Alle Stundenplan-Einträge löschen |

### Absenzen

| Methode | Pfad | Beschreibung |
|---|---|---|
| `GET` | `/api/absenzen` | Absenzen-Übersicht aller Module + Stats (Ø-Anwesenheit, unter Minimum, Abwesenheiten gesamt) |
| `GET` | `/api/absenzen/:code/termine` | Tagesliste (Lektionen mit Status) eines Moduls per `kuerzel_code` |

### Abfrage

| Methode | Pfad | Beschreibung |
|---|---|---|
| `POST` | `/api/abfrage` | Manuelle Abfrage auslösen (kanonisch) |
| `POST` | `/api/scrape` | Deprecated Alias von `/api/abfrage` — identische Response. Sendet `Deprecation: true` + `Link: </api/abfrage>; rel="successor-version"`. |

### Live-Updates

| Methode | Pfad | Beschreibung |
|---|---|---|
| `GET` | `/api/events` | SSE-Stream für Live-Status (akzeptiert `?token=…`) |
| `GET` | `/api/logs` | Letzte Log-Zeilen |

### Push

| Methode | Pfad | Beschreibung |
|---|---|---|
| `GET` | `/api/push/vapid-key` | VAPID-Public-Key der PWA |
| `POST` | `/api/push/subscribe` | Push-Subscription registrieren |
| `DELETE` | `/api/push/subscribe` | Push-Subscription entfernen |
| `POST` | `/api/push/test` | Test-Push an alle Subscriptions |

## Antwort-Format

Alle Endpoints antworten mit JSON. Standard-Envelope:

```json
{
  "data": { /* Payload */ },
  "error": null
}
```

Bei Fehlern:

```json
{
  "data": null,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Invalid or missing bearer token"
  }
}
```

## Beispiele

### Alle Noten holen

```bash
curl -H "Authorization: Bearer $API_TOKEN" \
  "http://localhost:3000/api/noten?semester=S1&sortBy=note"
```

### Modul-Detail

```bash
curl -H "Authorization: Bearer $API_TOKEN" \
  "http://localhost:3000/api/noten/M114/pruefungen"
```

### SSE-Stream (Live-Updates)

```javascript
const es = new EventSource('/api/events?token=' + API_TOKEN);

// Generischer Status (Phase, running, lastRun …)
es.addEventListener('status', (e) => {
  const payload = JSON.parse(e.data);
  console.log('status:', payload.currentPhase, payload.running);
});

// Lauf-Ende — wird unter BEIDEN Event-Namen gefeuert:
//   abfrage_done (kanonisch) + scrape_done (deprecated Alias).
// Beide tragen dasselbe Payload; ein Client lauscht nur auf EINEN davon.
es.addEventListener('abfrage_done', (e) => {
  const { ok, error, stats } = JSON.parse(e.data);
  console.log('abfrage done:', ok, error, stats);
});

// Log-Zeilen (Level via SSE_LOG_LEVEL env gefiltert)
es.addEventListener('log', (e) => console.log('log:', JSON.parse(e.data)));
```

Event-Typen (im SSE-`event:`-Feld; das `data:`-Feld ist das rohe JSON-Payload):

| Event | Payload | Bedeutung |
|---|---|---|
| `status` | `{ running, currentPhase, lastRun, nextRun, lastError, enabled, … }` | Status-/Phasen-Update |
| `log` | `{ level, message, … }` | Log-Zeile |
| `abfrage_done` | `{ ok, error, stats, finishedAt }` | Lauf-Ende (kanonisch) |
| `scrape_done` | `{ ok, error, stats, finishedAt }` | Lauf-Ende (deprecated Alias von `abfrage_done`, identisches Payload) |

### Push registrieren

```javascript
const reg = await navigator.serviceWorker.ready;
const sub = await reg.pushManager.subscribe({
  userVisibleOnly: true,
  applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
});

await fetch('/api/push/subscribe', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${API_TOKEN}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(sub),
});
```

## Rate-Limiting

| Endpoint | Limit |
|---|---|
| `/api/*` (Auth-Fehler) | 10 / 15 min, 50 / 6 h |
| `/api/events` (Auth-Fehler) | 60 / 15 min |
| `/api/abfrage` (+ Alias `/api/scrape`) | Implicit (single-flight) — gleichzeitige Aufrufe werden serialisiert |

Siehe [Sicherheit](/konfiguration/sicherheit/#anti-brute-force-drei-schichten).

## CORS

Default: **kein CORS-Header** — die API ist same-origin only (vom Dashboard / Mobile-PWA aus).

Wenn du externe Clients brauchst, ergänze einen CORS-Middleware-Hook in `src/server.js`.
