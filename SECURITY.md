# Security Policy

## Über dieses Projekt

WISSen ist ein **inoffizieller** Scraper für das WISS Tocco-Schulportal. Das Projekt verarbeitet sensible Daten:

- WISS Tocco Login-Credentials (Benutzername/Passwort)
- Persönliche Noten und Stundenpläne
- Telegram-Bot-Tokens und Chat-IDs
- Session-Cookies und Auth-Tokens

Bitte behandle Sicherheitslücken entsprechend verantwortungsvoll.

## Unterstützte Versionen

Sicherheitsupdates werden nur für die aktuelle `main`-Branch bereitgestellt. Forks und ältere Releases werden nicht unterstützt.

| Version | Unterstützt        |
| ------- | ------------------ |
| `main`  | :white_check_mark: |
| Andere  | :x:                |

## Sicherheitslücke melden

**Bitte melde Sicherheitslücken NICHT über öffentliche GitHub Issues.**

Stattdessen:

1. **GitHub Security Advisory** (bevorzugt): Nutze [Privately report a vulnerability](https://github.com/JoKerIsCraZy/WISSen/security/advisories/new).
2. **Alternativ**: Kontaktiere den Maintainer direkt über GitHub.

### Was bitte mitschicken

- Betroffene Komponente (Scraper, Dashboard, Scheduler, Telegram-Bot, Docker-Setup)
- Schritte zur Reproduktion
- Proof-of-Concept (falls vorhanden)
- Mögliche Auswirkung (Credential-Leak, RCE, XSS, Session-Hijacking, etc.)
- Vorschlag für einen Fix (optional)

### Was du erwarten kannst

- **Bestätigung** des Eingangs: innerhalb von 7 Tagen
- **Erste Einschätzung**: innerhalb von 14 Tagen
- **Fix oder Mitigation**: je nach Schweregrad, in der Regel 30–90 Tage
- **Coordinated Disclosure** nach Veröffentlichung des Fixes

## Scope

### Im Scope

- Code in diesem Repository (Scraper, Dashboard, Bot, Scheduler, Docker-Konfiguration)
- Standardkonfigurationen und Beispiel-Setups
- Dependencies, soweit sie durch dieses Projekt unsicher eingebunden sind

### Außerhalb des Scope

- Sicherheitslücken im offiziellen WISS Tocco-Portal selbst — bitte direkt an WISS melden
- Angriffe, die physischen Zugriff auf das Host-System voraussetzen
- Social Engineering gegen Maintainer oder Nutzer
- DoS gegen das eigene selbstgehostete Deployment
- Fehlende Best Practices ohne konkrete Exploit-Auswirkung

## Bekannte Sicherheitsaspekte für Self-Hoster

Wer WISSen selbst betreibt, sollte beachten:

1. **Credentials niemals im Code oder in Git committen** — nutze ausschließlich Umgebungsvariablen oder eine `.env`-Datei (die in `.gitignore` steht).
2. **Dashboard nicht ungeschützt ins öffentliche Internet stellen** — mindestens hinter Basic Auth, VPN oder Reverse Proxy mit Auth.
3. **Telegram-Bot-Token rotieren**, falls es jemals geleakt wurde (`/revoke` bei @BotFather).
4. **HTTPS verwenden** für alle externen Endpoints — kein Klartext-Login.
5. **Docker-Container nicht als root** laufen lassen, soweit möglich.
6. **Backups verschlüsseln**, da sie Credentials und persönliche Noten enthalten können.
7. **Master-Key off-volume ablegen** — `MASTER_KEY` (env) oder `MASTER_KEY_FILE` (Docker-Secret) setzen, statt den auto-generierten `data/.master-key` zu nutzen. Sonst liegt der AES-Key im selben `data/`-Volume wie die verschlüsselten Daten und reist in jedem Backup/Snapshot mit — die Verschlüsselung von `settings.json` und `storage.json` bringt dann bei einem Volume-Leak nichts. Siehe `.env.example`.
8. **`data/wissen.db` liegt im Klartext** (Noten, Dozentennamen, Stundenplan, Anwesenheit) — `node:sqlite` kann die DB-Datei nicht verschlüsseln. Für At-Rest-Schutz das `data/`-Verzeichnis auf ein **verschlüsseltes Volume** legen (LUKS / gocryptfs / BitLocker / NAS Encrypted Folder). Fertiges Setup: `docker-compose.encrypted.yml.example`.
9. **Dependencies aktuell halten** — regelmässig `npm audit` bzw. Dependabot-Updates einspielen.

## Verantwortlichkeit der Nutzer

Dieses Tool greift auf ein Drittanbieter-System (WISS Tocco) zu. Nutzer sind selbst verantwortlich für:

- Einhaltung der WISS-Nutzungsbedingungen
- Schutz der eigenen Login-Credentials
- Konsequenzen aus dem Einsatz dieses inoffiziellen Tools

## Danke

Wir danken allen, die verantwortungsvoll Sicherheitslücken melden und damit helfen, das Projekt und seine Nutzer zu schützen.
