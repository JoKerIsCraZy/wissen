---
title: Push-Benachrichtigungen
description: Native Web-Push auf Handy + Desktop bei neuen Noten und Zimmerwechseln — auch bei geschlossener App.
---

WISSen sendet **echte Web-Push-Benachrichtigungen** über die Web-Push-API — Mozilla Autopush, Google FCM, Apple Push und Windows Notification Service. **Kein Firebase, kein Polling, kein Vendor-Lock.**

## Was wird gepusht?

| Ereignis | Inhalt |
|---|---|
| 🆕 **Neue Note** | Modulname + Note + Direktlink zum Modul-Detail |
| ✏️ **Notenänderung** | Vorher → Nachher + Modulname |
| 🚪 **Zimmerwechsel** | Datum, Zeit, alter → neuer Raum (auch Online ↔ Offline) |
| 📋 **Neue Abwesenheit** | Modulname + Datum/Lektion + Art (⚠️ unentschuldigt / ℹ️ entschuldigt) |
| 🔁 **Status geändert** | Wechsel entschuldigt ↔ unentschuldigt für eine Abwesenheit |

Notifications kommen **auch wenn die App komplett geschlossen ist**.

:::note[Absenz-Pushes]
Nur **abwesend entschuldigt** und **abwesend unentschuldigt** lösen einen Push aus. Die Status **„teilgenommen"** und **„offen"** pushen nie. Der Absenz-Push ist **Cold-Start-sicher**: die allererste Abfrage pusht keine historischen Abwesenheiten, sondern legt nur den Ausgangsstand an.
:::

## Voraussetzungen

| Plattform | Voraussetzung |
|---|---|
| **iOS** | PWA auf den Home-Bildschirm installiert (kein Safari-Tab) |
| **Android** | PWA installiert oder Browser-Tab offen (Tab-Push funktioniert auch) |
| **Desktop** | Browser-Tab offen oder PWA installiert |
| **Brave** | `brave://settings/privacy` → „Google-Dienste für Push-Nachrichten verwenden" aktiviert |
| **Server** | HTTPS + gültige VAPID-Keys |

## Aktivieren

### 1. Mobile-App installieren
Siehe [Mobile-App (PWA)](/features/mobile-pwa/) — auf iOS Pflicht, auf Android empfohlen.

### 2. In der App
**Settings → „Push aktivieren"** → Browser-Erlaubnis bestätigen.

### 3. Test
**„Test-Push senden"** drücken → innerhalb 1–2 s sollte die Notification kommen.

## VAPID-Keys

Beim ersten Start werden die Keys auto-generiert in `data/vapid.json`:

```json
{
  "publicKey": "BO_...",
  "privateKey": "..."
}
```

Du kannst sie auch manuell setzen über `VAPID_PUBLIC_KEY` und `VAPID_PRIVATE_KEY` in der `.env`.

`VAPID_SUBJECT` (default `mailto:admin@example.com`) ist die Kontakt-Adresse für den Push-Provider — bitte auf eine echte Adresse setzen, sonst sperren manche Provider deinen Server bei Problemen.

## SSRF-Schutz

Push-Endpoints werden nur an folgende Whitelist gesendet:

- `*.googleapis.com` (FCM)
- `updates.push.services.mozilla.com` (Mozilla)
- `*.push.apple.com` (Apple)
- `*.notify.windows.com` (Windows)

Andere URLs werden geblockt — auch wenn sich ein Client mit gefälschtem Endpoint registriert.

## Subscription verwalten

Endpoints für PWA / Dashboard:

```http
GET    /api/push/vapid-key       # VAPID Public Key
POST   /api/push/subscribe       # Subscription registrieren
DELETE /api/push/subscribe       # Subscription entfernen
POST   /api/push/test            # Test-Push an alle Subscriptions
```

Subscriptions liegen in der SQLite-Tabelle `push_subscriptions` (endpoint + Krypto-Keys).

## Push trotzdem nicht angekommen?

1. **HTTPS aktiv?** Mobile-Push braucht HTTPS. Über LAN-IP funktioniert's nicht (Browser-Sicherheitsregel)
2. **PWA wirklich installiert?** Auf iOS Pflicht
3. **Erlaubnis im Browser?** `chrome://settings/content/notifications` prüfen
4. **Subscription noch gültig?** Test-Push aus den Settings probieren
5. **Server-Logs:** Push-Provider-Antworten loggen Fehler-Codes

## Troubleshooting

### iOS: Toggle ist ausgegraut
- Erst PWA über Safari → „Zum Home-Bildschirm" installieren

### Android: Erlaubnis-Dialog kommt nicht
- Browser-Settings → Notifications für die Domain prüfen

### Test-Push kommt, echte Pushes nicht
- Subscription wurde später ungültig → in Settings deaktivieren + neu aktivieren

### Brave Desktop: Push schlägt still fehl
- `brave://settings/privacy` → „Google-Dienste für Push-Nachrichten verwenden" aktivieren
