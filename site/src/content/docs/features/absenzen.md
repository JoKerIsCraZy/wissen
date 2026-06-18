---
title: Absenzen
description: Anwesenheits-Tracking pro Modul — Soll/Ist, Minimalanwesenheit und Push bei jeder neuen Abwesenheit.
---

Absenzen ist die **vierte Daten-Achse** in WISSen — neben Noten, Stundenplan und Push. Aufgebaut ist sie wie der Noten-Tab: pro Modul eine Übersicht, pro Lektion eine Tagesliste.

## Was wird abgefragt

Pro Modul holt WISSen die **Anwesenheit** aus dem WISS-Tocco-Portal — plus eine **Tagesliste pro Lektion** mit dem Status jedes Termins.

### Status pro Lektion

| Status | Bedeutung |
|---|---|
| ✅ **Teilgenommen** | Anwesend gewesen |
| ⏳ **Offen** | Noch nicht erfasst / in der Zukunft |
| 🟡 **Abwesend entschuldigt** | Fehlend, aber entschuldigt |
| 🔴 **Abwesend unentschuldigt** | Fehlend ohne Entschuldigung |

### Pro Modul

| Feld | Inhalt |
|---|---|
| **Soll-Lektionen** | Geplante Lektionen total |
| **Ist-Lektionen** | Tatsächlich besuchte Lektionen |
| **Min %** | Minimalanwesenheit (Schwelle des Moduls) |
| **Ist %** | Tatsächliche Anwesenheit |

Module unter ihrer Minimalanwesenheit werden **rot markiert** — so siehst du auf einen Blick, wo es eng wird.

## Stats-Übersicht

Oben über der Modul-Liste zeigen drei Kennzahlen den Gesamtstand:

| Kennzahl | Inhalt |
|---|---|
| **Ø-Anwesenheit** | Durchschnitt über alle Module |
| **Module unter Minimum** | Anzahl gefährdeter Module |
| **Abwesenheiten gesamt** | Summe aller Fehl-Lektionen |

## Push bei neuer Abwesenheit

WISSen pusht (Telegram + Web-Push), sobald sich an deinen Abwesenheiten etwas ändert:

| Ereignis | Push? |
|---|---|
| 🔴 **Neue Abwesenheit** taucht auf | Ja |
| 🔁 **Wechsel** entschuldigt ↔ unentschuldigt | Ja |
| ✅ **Teilgenommen** | Nie |
| ⏳ **Offen** | Nie |

**Cold-Start-sicher:** Die erste Abfrage eines Moduls pusht **0×** — keine Flut historischer Absenzen beim Einrichten. Erst ab der zweiten Abfrage gilt eine Abwesenheit als „neu".

## Scheduler-Verhalten

Der Absenz-Detail-Pass (Tagesliste je Lektion) ist **teuer**, deshalb läuft er im Auto-Run gedrosselt:

| Lauf | Übersicht (Stats) | Detail-Pass + Push |
|---|---|---|
| **Auto-Run (zwischendurch)** | Jedes Mal aktualisiert | Übersprungen |
| **Auto-Run (letzter Lauf des Tages)** | Aktualisiert | Läuft |
| **Manuelle Abfrage** | Aktualisiert | Läuft immer |

So bleiben die Stats den Tag über aktuell, während der teure Detail-Pass und die Push-Logik nur **einmal täglich** (am letzten geplanten Lauf) bzw. **bei jeder manuellen Abfrage** anfallen.

## Desktop-Dashboard

Route/Tab `/absenzen`:

- **Modul-Tabelle**, sortierbar — mit **Inline-Tagesliste** pro Modul
- **Stats-Tiles** (Ø-Anwesenheit, unter Minimum, Abwesenheiten gesamt)
- **Filter:** Suche, Typ und „unter Minimum"

## Mobile-PWA

Eigene **Absenzen-View**:

- **Stats-Header** mit den drei Kennzahlen
- **Modul-Liste** (A–Z nach Modulname) mit Typ-Filter
- **Tap auf ein Modul** öffnet ein Sheet mit der **Tagesliste pro Lektion** — jeder Termin mit Status-Badge

## API

Die Absenz-Daten liegen hinter zwei Endpoints:

```http
GET /api/absenzen                  # Modul-Übersicht + Stats
GET /api/absenzen/:code/termine    # Tagesliste pro Lektion eines Moduls
```

Details siehe [API-Übersicht](/referenz/api/).
