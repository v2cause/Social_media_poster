# ADR 0039: Security-Review und Härtung

- **Status**: Akzeptiert
- **Datum**: 2026-10-18
- **Bezug**: Umsetzungsleitfaden, Schritt 8.4; `docs/ARCHITECTURE.md`, Abschnitte 7.4, 9, 10 und 12; [ADR 0006](0006-authentifizierung.md), [ADR 0009](0009-sicherheits-baseline.md), [ADR 0012](0012-e-mail-jobs-mit-link.md), [ADR 0019](0019-medien-upload-und-verarbeitung.md), [ADR 0029](0029-x-browser-freischaltung-und-kill-switch.md), [ADR 0033](0033-tarife-abo-und-nur-lesen.md), [ADR 0035](0035-nutzungsabrechnung-und-durchsetzung-der-limits.md), [ADR 0038](0038-aufbewahrungsfristen.md); [Pentest](../security/pentest-2026-10.md), [ASVS-Checkliste](../security/asvs-l2.md), [Kryptografie](../security/kryptografie.md), [Daten und Protokolle](../security/daten-und-protokolle.md), [Autorisierung und Grenzen](../security/autorisierung-und-grenzen.md), [Runbook Secret-Rotation](../runbooks/secret-rotation.md)

## Kontext

Schritt 8.4 verlangt:
- eine Checkliste nach OWASP ASVS Level 2,
- einen Pentest,
- ein Runbook zur Secret-Rotation,
- eine Prüfung der CSP,
- das Tuning der Rate-Limits.

Fertig ist der Schritt, wenn keine kritischen oder hohen Befunde offen sind.

Das Review lief in drei Teilen:
1. Alle 253 Anforderungen der Level 1 und 2 von ASVS 5.0.0 wurden gegen Code, Tests und Doku bewertet ([Checkliste](../security/asvs-l2.md)).
2. Ein Pentest mit ZAP und manuellen Prüfungen lief gegen das Compose-Profil `app` ([Bericht](../security/pentest-2026-10.md)).
3. Eine Codeprüfung deckte Anmeldung, Sessions, Mandanten, Uploads, Logs und Konfiguration ab; ihre Befunde C-01 bis C-17 stehen im Bericht.

Kritische oder hohe Befunde ergaben weder die Codeprüfung noch der Pentest. Die schwersten Befunde waren mittel, darunter:
- Der Default-Nutzer von Redis brauchte kein Passwort. Jeder Container im Netz konnte alle Schlüssel lesen und schreiben, auch den Zugriffs-Cache und die Jobs mit Reset-Links.
- Ein gestohlenes Session-Cookie blieb gültig, solange es mindestens alle sieben Tage genutzt wurde.
- Weiterleitungen nach der Anmeldung ließen sich auf fremde Seiten lenken.

Dazu meldete Trivy in den Basis-Images behebbare Schwachstellen der Stufe HIGH und in einer Schicht des Playwright-Images ein Token im npm-Cache. Alle diese Befunde sind behoben. Die Lücken der Checkliste sind niedrig oder mittel, keine ist kritisch oder hoch.

## Entscheidung

### Schwere und Fristen

| Schwere | Bedeutung | Frist ab Bekanntwerden |
|---|---|---|
| kritisch | Ohne Konto oder über Mandanten hinweg ausnutzbar, mit Zugriff auf Daten, Konten oder Geheimnisse | 24 Stunden: beheben oder die Funktion abschalten |
| hoch | Mit einem Konto oder unter verbreiteten Voraussetzungen ausnutzbar, mit erheblichem Schaden | 7 Tage |
| mittel | Braucht besondere Voraussetzungen, oder der Schaden bleibt begrenzt | 30 Tage |
| niedrig | Härtung, Defense in Depth, Doku | 90 Tage oder mit dem nächsten Release, das den Bereich ändert |

- **Abhängigkeiten** (ASVS 15.1.1, 15.2.1):
  - Die Fristen gelten ab dem Tag, an dem ein Fix verfügbar ist. Ohne Fix wird die Lücke nach ihrer Schwere bewertet und notfalls die betroffene Funktion abgeschaltet.
  - CI hält kritische und hohe Lücken auf: `pnpm audit --audit-level high` und Trivy (HIGH und CRITICAL mit verfügbarem Fix) brechen den Build ab.
  - Übrige Updates liefert Renovate mit drei Tagen Wartezeit (ADR 0009).
- **Ausnahmen**:
  - Akzeptierte Advisories stehen mit Begründung in `auditConfig` (`pnpm-workspace.yaml`, ADR 0009). Sie werden mit jedem Update der betroffenen Pakete neu bewertet, spätestens am 2027-01-16.
  - Für das Image des browser-workers überspringt der Scan `/root/.npm`, den Cache aus der Schicht des Playwright-Basis-Images. Diese Ausnahme gilt bis zum nächsten Update des Basis-Images.
- **Wiederholung**:
  - Der Pentest wiederholt sich vor jedem Release mit Änderungen an Anmeldung, Mandanten, Uploads, Proxy oder Headern, mindestens einmal im Jahr.
  - Die Checkliste wird jährlich geprüft und bei einer neuen Version des ASVS neu bewertet.
  - Nächster planmäßiger Termin für beides: Oktober 2027.

### Authentifizierung

**Wege** (ASVS 6.1.3, 6.3.4):

| Weg | Kontrollen |
|---|---|
| Anmeldung mit E-Mail und Passwort | Nur mit bestätigter Adresse. Mit 2FA folgt bei jeder Anmeldung ein TOTP- oder Backup-Code; vertrauenswürdige Geräte gibt es nicht. Limits siehe unten. |
| Registrierung | Passwortrichtlinie. Eine bekannte Adresse bekommt dieselbe Antwort wie eine neue; wer die Adresse besitzt, erhält einen Hinweis mit dem Link zur Anmeldung. |
| Bestätigung der Adresse | Der Link gilt eine Stunde, er bestätigt nur und meldet nicht an. Unbestätigte Konten löscht der nächtliche Lauf einen Tag nach der Registrierung. |
| Passwort zurücksetzen | Der Link gilt eine Stunde. Gespeichert wird nur der SHA-256 des Tokens, in Logs und Ereignissen ist er maskiert. Das Zurücksetzen beendet alle Sessions und hebt die Sperre des Kontos auf. |
| Passwort ändern | Das aktuelle Passwort ist nötig. Es gelten die Passwortrichtlinie und höchstens fünf falsche Passwörter je Nutzer in 15 Minuten. Die Seite bietet an, die anderen Geräte abzumelden. |
| 2FA einrichten, abschalten, Schlüssel abrufen, neue Backup-Codes | Das Passwort ist nötig, bei aktiver 2FA zusätzlich ein Code des Faktors. Danach bietet die Seite an, die anderen Geräte abzumelden. |
| Sensible Aktionen der API | Die Freischaltung des X-Browsers verlangt das Passwort (`PasswordCheck`, mit demselben Limit je Nutzer). |
| Betrieb | `pnpm auth:revoke-sessions --user <email>` oder `--all` beendet die Sessions eines Kontos oder aller Konten ([Runbook](../runbooks/secret-rotation.md)). Seit Schritt 8.7 entfernt `pnpm auth:reset-two-factor` einen verlorenen zweiten Faktor nach einem Passwort-Reset über den Link an die Adresse ([Runbook](../runbooks/zweiter-faktor-verloren.md)). |

Nicht vorhanden sind:
- die Anmeldung über Google oder Microsoft, die die Architektur als Option nannte (entfällt),
- Passkeys (später),
- Magic Links und Einmalcodes per E-Mail oder SMS,
- API-Schlüssel oder Bearer-Tokens für Nutzer.

Die Tokens der Plattformen sind keine Anmeldung bei der App.

**Passwortrichtlinie** (ASVS 6.2):
- **Länge**: 12 bis 128 Zeichen, alle Unicode-Zeichen sind erlaubt. Es gibt keine Regeln zur Zusammensetzung und keinen Ablauf.
- **Prüfung**: Bei Registrierung, Zurücksetzen und Ändern wird ein neues Passwort abgelehnt, wenn eine der folgenden Regeln zutrifft:
  - **Häufig**: Es ist eines der 10.000 häufigsten Passwörter (`common-passwords.txt`, verglichen in Kleinbuchstaben).
  - **Kontextwort**: Es enthält ein Wort seines Kontexts (`password-policy.ts`).
    - Die Wörter sind der Name des Produkts (`socialmediaposter`, `socialmedia`, `mediaposter`), die Adresse, ihr lokaler Teil, die Labels der Domain ohne Top-Level-Domain sowie der Name und seine Teile.
    - Verglichen wird nach NFKC, in Kleinbuchstaben und nur mit Buchstaben und Ziffern. Wörter unter vier Zeichen zählen nicht.
  - **Leck**: Es kommt in bekannten Datenlecks vor (`breached-passwords.ts`).
    - Geprüft wird über die Range-API von Have I Been Pwned oder einen Spiegel. Nur die ersten fünf Zeichen des SHA-1 verlassen die API, die Antwort ist gepolstert, der Timeout liegt bei drei Sekunden.
    - In Produktion ist `PWNED_PASSWORDS_API_URL` Pflicht und nutzt https; leer bleibt sie nur in Entwicklung und Tests.
    - Fällt der Dienst aus oder antwortet unerwartet, gilt das Passwort als nicht geleakt, und die API schreibt die Warnung `auth.breach_check_unavailable`. Die Verfügbarkeit der Registrierung geht hier vor, die Liste der häufigen Passwörter gilt weiter.
- **Hash**:
  - scrypt mit N=2^15, r=8, p=3 (32 MiB, nach OWASP), in einem Format, das seine Parameter nennt, und mit einem Vergleich in konstanter Zeit.
  - Hashes im Format von Better Auth (N=2^14, r=16, p=1) werden weiter geprüft. Ein Rehash bei der Anmeldung fehlt; solche Hashes gibt es nur aus der Zeit vor Schritt 8.4, also nur in lokalen Datenbanken.

**Brute Force und Credential Stuffing** (ASVS 6.1.1, 6.3.1):

| Kontrolle | Wert | Ort |
|---|---|---|
| Better Auth je Client-Adresse und Pfad, gezählt in der Datenbank | alle Pfade 100 je 60 s; `/sign-in`, `/sign-up`, `/change-password` und `/change-email` 3 je 10 s; `/request-password-reset` und `/send-verification-email` 3 je 60 s; `/two-factor/*` 3 je 10 s | `auth.ts` (`rateLimit`) und die Standardregeln von Better Auth 1.7.9 |
| Fehlanmeldungen je Konto, von allen Adressen zusammen | 10 in 15 Minuten ab dem ersten Fehler | `auth-hooks.ts` |
| Fehlanmeldungen je Gerät eines gesperrten Kontos | Ein Gerät ist ein Browser mit einem signierten Cookie, gültig 180 Tage nach einer vollständigen Anmeldung. Es hat 5 eigene Fehlversuche in 15 Minuten, so kann sich die Person weiter anmelden, während Fremde das Konto sperren. | `auth-hooks.ts` |
| Falsche Passwörter je Nutzer an den Endpunkten, die das Passwort erneut verlangen | 5 in 15 Minuten | `auth-hooks.ts`, `PasswordCheck` |
| TOTP-Codes | Jeder Code gilt nur einmal, der Hook merkt ihn 120 s; ein Code gilt bis zu 90 s | `auth-hooks.ts` |
| E-Mails der Auth-Flows je Adresse | 5 je Stunde; weitere verwirft die API, ohne dass sich die Antwort ändert | `auth-mailer.ts` |
| Einladungs-Mails je Adresse, aus allen Organisationen zusammen | 5 je Stunde; weitere verwirft die API mit der Warnung `invitation.mail_dropped`, die Einladung bleibt gültig | `invitation-notifier.ts` |

Die Client-Adresse ist `X-Real-IP`, die der Reverse Proxy überschreibt (ADR 0006); IPv6-Adressen zählen nach ihrem /64-Netz. Der Nest-Throttler (unten) deckt `/api/auth` nicht ab, dort gelten nur diese Limits.

**Zweiter Faktor** (ASVS 6.3.3, 6.5, 7.5.1):
- **Verfahren**:
  - TOTP nach RFC 6238 mit 30 s und sechs Ziffern.
  - Dazu zehn Backup-Codes zu je zehn Buchstaben und Ziffern, jeder einmal verwendbar und verschlüsselt gespeichert.
- **Wer ihn braucht**:
  - Für Nutzer ist er freiwillig.
  - Owner können ihn für alle Mitglieder ihrer Organisation verlangen. Ohne zweiten Faktor antworten dann alle Routen der Organisation und ihrer Workspaces mit 403 `TWO_FACTOR_REQUIRED`; die Routen des Kontos bleiben offen, damit sich der Faktor einrichten lässt.
  - Plattform-Admins brauchen ihn für die Admin-Seite und ihre Routen.
- **Bestätigung vor Änderungen**:
  - Wer 2FA nutzt, bestätigt vor dem Abschalten, dem neuen Einrichten, dem Abruf des Schlüssels und neuen Backup-Codes einen Code mit der Session.
  - Die Bestätigung gilt fünf Minuten für eine Änderung; ohne sie antwortet die API mit 403 `SECOND_FACTOR_REQUIRED`.
  - Nach dem Ein- oder Ausschalten bietet die Seite an, die anderen Geräte abzumelden; die Auswahl ist vorbelegt.
- **Warum freiwillig**:
  - Das Produkt richtet sich an kleine Teams und Agenturen. Eine Pflicht für alle hätte die Registrierung erschwert, solange es für verlorene Faktoren keinen Prozess gibt (Runbook in Schritt 8.7).
  - Ausgleich schaffen die Passwortrichtlinie mit Leck-Prüfung, die Limits je Konto und Gerät, die absolute Laufzeit der Sessions, die Sicherheitsereignisse, die Pflicht auf Wunsch der Owner und die Pflicht der Plattform-Admins.
  - Wiedervorlage mit Passkeys.

### Sessions

ASVS 7.1.1, 7.1.2, 7.3.1 und 7.3.2:

- **Cookie**:
  - Über https heißt er `__Host-...` (Secure, Path=/, ohne Domain), dazu `HttpOnly` und `SameSite=Lax`.
  - Der Wert ist signiert. Ohne Cookie-Cache prüft jede Anfrage die Session in der Datenbank.
- **Laufzeit**:
  - Eine Session endet sieben Tage nach der Anmeldung ohne Verlängerung, auch wenn sie in der Zeit genutzt wird. Eine eigene Inaktivitätszeit gibt es nicht.
  - Die Oberfläche bietet kein "Angemeldet bleiben" an. Wer `rememberMe: false` an die API schickt, bekommt eine Session von einem Tag und einen Cookie, der mit dem Browser endet.
- **Parallele Sessions**:
  - Ihre Zahl ist nicht begrenzt.
  - Die Sicherheitsseite listet alle und beendet einzelne, alle anderen oder alle. Die Liste erscheint nur in einer Session, die jünger als einen Tag ist (`freshAge` von Better Auth); ältere Sessions sehen einen Hinweis und melden sich erneut an.
- **Wechsel**:
  - Eine neue Anmeldung beendet die Session, die der Browser noch hielt, auch wenn noch ein zweiter Faktor folgt.
  - Beim Abmelden antwortet die API mit `Clear-Site-Data` für Cache und Speicher, und die Web-App verwirft ihre gecachten Abfragen, auch wenn die API nicht erreichbar ist. Eine Anmeldung verwirft, was ein anderes Konto im Tab hinterlassen hat.
  - Das Zurücksetzen des Passworts beendet alle Sessions; beim Ändern des Passworts und des zweiten Faktors bietet die Seite das an.
- **Begründung der sieben Tage**:
  - Teams planen und prüfen Posts über die Woche und lassen die App dabei offen; eine Inaktivitätszeit würde sie mitten in der Arbeit abmelden.
  - NIST SP 800-63B-4 ([Abschnitt 2](https://pages.nist.gov/800-63-4/sp800-63b.html)) empfiehlt für AAL1 eine Gesamtzeit von höchstens 30 Tagen, für AAL2 höchstens 24 Stunden und eine Inaktivitätszeit von höchstens einer Stunde. Die sieben Tage liegen dazwischen und weichen damit bewusst von der Empfehlung für AAL2 ab.
  - Ausgleich: Passwort und zweiter Faktor lassen sich nur mit dem Passwort und gegebenenfalls einem Code ändern. Alle Sessions sind sichtbar und beendbar. Owner können 2FA verlangen.
  - Die Zahl paralleler Sessions bleibt offen, weil Teams mehrere Geräte nutzen und eine Grenze das älteste Gerät stillschweigend abmelden müsste.

### Mandanten und Tarif

- Ein Nutzer legt höchstens drei Organisationen in 30 Tagen an, jede mit einer eigenen Testphase. Gezählt wird unter einer Advisory-Sperre des Nutzers, dazu gilt ein Limit von zehn Anfragen je Stunde auf der Route (ADR 0033).
- Accounts und Posts pro Monat zählen unter einer Advisory-Sperre der Organisation (ADR 0035). Der Login des X-Browsers prüft den Tarif erneut, wenn er den Account verbindet.
- Der Zugriffs-Cache (60 s, Architektur 10) wird nach jeder Änderung von Rollen und Mitgliedschaften verworfen. Scheitert das Verwerfen, gilt der alte Zugriff höchstens 60 s weiter (akzeptiert, unten). Scheitert das Lesen, prüft der Guard die Datenbank.
- Live-Streams:
  - Ein Nutzer hält höchstens zehn offen, über alle Workspaces. Ein Stream hält seinen Platz mit einem Lease von 45 s, den der Heartbeat alle 15 s verlängert.
  - Jeder Stream endet nach fünf Minuten und öffnet sich wieder durch die Guards. Nach einer Abmeldung, dem Ende einer Session oder dem Entfernen aus dem Workspace kommen so höchstens fünf Minuten lang Ereignisse an, und diese tragen nur IDs.

### Eingehende Limits

Das Tuning der Rate-Limits (ASVS 2.4.1, 15.1.3). Die Werte prüft der Lasttest in Schritt 8.5.

**Nest-Throttler mit Redis** (`throttling.ts`), drei Stufen:

1. **Adresse**: Je Client-Adresse gelten 3.000 Anfragen je Minute, gezählt vor der Prüfung der Session. Ein Büro hinter einer Adresse passt hinein.
2. **Nutzer**: Je Nutzer gelten 600 Anfragen je Minute über alle Routen, ohne Session je Adresse. Ein Mensch macht kaum zehn Anfragen pro Sekunde.
3. **Route**: Teure Routen haben ein eigenes Limit je Nutzer und Route (`@LimitPerUser`):

| Route | Limit | Grund |
|---|---|---|
| Organisation anlegen (Onboarding) | 10 je Stunde | Testphasen |
| Einladung prüfen, Einladung annehmen | je 30 je Stunde | Raten von Einladungen |
| Einladung verschicken | 30 je Stunde | E-Mails |
| Einladung erneut senden | 10 je Stunde | E-Mails |
| Account verbinden (Start von OAuth) | 30 je Stunde | Aufrufe der Plattformen |
| OAuth-Callback | 60 je Stunde | Aufrufe der Plattformen |
| Upload anfordern | 300 je Stunde | Speicher (je Datei 20 MB) |
| Checkout, Tarifwechsel, Kundenportal | je 30 je Stunde | Aufrufe von Stripe |
| Datenexport anfordern | 5 je Tag | Archive |
| Datenexport herunterladen | 30 je Stunde | signierte Links |
| Organisation löschen, Löschung zurücknehmen | je 10 je Stunde | E-Mails an die Owner, Abo bei Stripe |
| Login des X-Browsers starten, Code senden | 10 bzw. 20 je Stunde | Browser-Sitzungen |
| Readiness (`/api/health/ready`) | 60 je Minute | Prüft Datenbank, Redis und Speicher |

Jede Ablehnung antwortet mit 429 und `Retry-After` und schreibt das Ereignis `security.rate_limited`. Die Routen der KI haben ihre eigenen Leitplanken: je Nutzer 10 Aufrufe pro Minute und 2 gleichzeitig, je Workspace 60 pro Stunde ([ADR 0016](0016-content-und-ki-api.md)), dazu die Kontingente des Tarifs (ADR 0035).

**Größe und Form der Anfragen**:
- **Proxy**: Er nimmt für `/api` und für die Web-App höchstens 1 MB an und lässt nur `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE` und `OPTIONS` durch (sonst 405).
- **API**:
  - JSON und Webhooks dürfen 1 MB groß sein, `/api/auth` 64 KB. Einen Body ohne Länge (`Transfer-Encoding: chunked`) lehnt `/api/auth` mit 411 ab.
  - Abgelehnte Bodies bekommen 400, 413 oder 415 als `application/problem+json` mit festem Text; die Meldung des Parsers gibt die API weder zurück noch ins Log.
  - Antworten tragen `Cache-Control: no-store`.
- **Uploads** (ADR 0019):
  - Eine Datei darf 20 MB und 50 Megapixel haben.
  - Die PUT-URL gilt fünf Minuten und signiert Typ und Länge; Lese-URLs gelten eine Stunde.
  - Das Upload-Objekt liegt getrennt vom geprüften Original.
  - Mit jedem Ticket plant die API den Job `media.drop-upload`. Er löscht 65 Minuten später ein Upload-Objekt, das ein später PUT neu angelegt hat, außer der Upload wartet noch oder wird gerade verarbeitet.

### Web und HTTP

- **CSP der Web-App**:
  - Skripte nur mit Nonce.
  - `object-src 'none'`, `base-uri 'none'`, `form-action 'self'` und `frame-ancestors 'none'`, dazu `X-Frame-Options: DENY`.
  - In Produktion HSTS mit `max-age=31536000; includeSubDomains`.
  - Die API setzt die Policy von helmet mit `base-uri 'none'` und `frame-ancestors 'none'`. Das Ergebnis der Prüfung steht im Pentest-Bericht.
- **Formulare**: Alle schicken ihre Felder per POST, damit sie nicht in der URL stehen.
- **Weiterleitungen**: `safeNext` erlaubt nur eigene Pfade. Abgelehnt werden `//`, Backslashes und Dot-Segmente, die zu `//` führen.
- **Origin-Prüfung**: Die Origin-Prüfungen von Better Auth bleiben auch mit `NODE_ENV=test` an. Abgelehnte Weiterleitungen werden zum Ereignis `security.redirect_rejected`.
- **Cookies**: Über https tragen die Cookies von Better Auth und der Sprach-Cookie (`__Host-NEXT_LOCALE`) das Präfix `__Host-`.

### Daten, Logs und Secrets

Die Einzelheiten stehen in den Inventaren [Daten und Protokolle](../security/daten-und-protokolle.md) und [Kryptografie](../security/kryptografie.md).

- **Logs**:
  - Jede Anfrage hat ihre eigene Request-ID, jede Zeile nennt Nutzer und Workspace, sobald sie bekannt sind.
  - Fehler loggt die Anwendung nur mit den Feldern einer Allowlist (`code`, `status`, `statusCode`, `errno`, `syscall`) und ohne E-Mail-Adressen.
  - Redaction greift auch für Schlüssel in snake_case.
  - `/api/auth` hat eine Request-Zeile; der Token des Reset-Links ist darin maskiert.
- **Traces**: Spans enthalten weder Tokens noch personenbezogene Daten, URLs erscheinen ohne Query und mit maskierten Pfaden. Über OTLP gehen nur Traces, keine Logs.
- **Sicherheitsereignisse** (ASVS 16.3):
  - Der Katalog `security.*` in `security-events.ts` umfasst Origin, Body, Validierung, Mandant, Recht, zweiter Faktor, Rate-Limit, Webhook, OAuth-State und Weiterleitung. Die Anmeldeflüsse schreiben `auth.event`.
  - Ein Ereignis nennt Methode, Route, Code und Client-Adresse, nie Daten der Anfrage. Ein Ereignis zu einem Konto nennt den Nutzer oder einen Digest der Adresse.
- **Client-Adressen**:
  - Sie stehen in den Sicherheitsereignissen und den Ereignissen der Anmeldung, damit sich Angriffe erkennen und sperren lassen. Die Request-Zeilen nennen sie nicht.
  - Das Log-Backend hält sie 30 Tage; im Audit-Log gehen sie nach 30 Tagen (ADR 0038).
- **E-Mails**:
  - Die Jobs der Rolle `notify` tragen Adresse und Link nur versiegelt (Token-Keyring, AAD `notify.email`).
  - Ein Fehler beim Versand nennt weder Adresse noch die Antwort des Servers (ADR 0012).
  - In Produktion geht jede Mail über TLS.
- **Produktion**:
  - API, Worker und browser-worker starten nicht mit Beispielwerten aus `.env.example` (`change-me`, `smp-local-`).
  - Adressen, die der Browser oder die Plattformen erreichen, müssen https nutzen.
  - Ausgenommen ist ein Produktions-Build auf diesem Rechner mit `APP_URL` auf localhost.
- **Compose**:
  - Jeder Dienst bekommt nur die Variablen, die er liest.
  - Redis kennt keinen Nutzer ohne Passwort, der Default-Nutzer ist aus:
    - `app` (API und Worker) darf keine gefährlichen Befehle außer `INFO` ausführen,
    - `health` darf nur `PING`,
    - `browser-worker` erreicht nur die Schlüssel und Queues des X-Browsers.
- **Rotation**:
  - Das [Runbook](../runbooks/secret-rotation.md) beschreibt sie für jedes Secret.
  - `BETTER_AUTH_SECRETS` ist versioniert, die Secrets der 2FA werden nach einer Rotation neu verschlüsselt.
  - KEKs wechseln in zwei Neustarts: erst hinzufügen, dann aktivieren.

### Lieferkette und Images

- Die Images laufen auf `node:24.21.0-trixie-slim` (Debian 13) ohne npm, npx, corepack und yarn.
- CI baut alle fünf Images, hält ihre SBOM (CycloneDX) 90 Tage und scannt sie mit Trivy auf Schwachstellen und Secrets: bei jedem Pull Request, jedem Push nach `main` und jeden Montag, damit neue Schwachstellen auch in unveränderten Images auffallen.
- Das Ablegen in einer Registry mit Signatur und SBOM je Release folgt mit Schritt 8.9.

### Akzeptierte Abweichungen und Restrisiken

| Thema | Entscheidung und Begründung | Ausgleich | Wiedervorlage |
|---|---|---|---|
| 2FA freiwillig (ASVS 6.3.3) | Siehe Zweiter Faktor | Owner-Pflicht, Admin-Pflicht, Passwortrichtlinie, Limits | Mit Passkeys |
| Keine Inaktivitätszeit, sieben Tage absolut (ASVS 7.3.1, NIST SP 800-63B-4) | Siehe Sessions | Sichtbare und beendbare Sessions, Bestätigung vor Änderungen | Bei Kunden mit höherem Schutzbedarf |
| Session-Token im JSON von Better Auth (ASVS 3.3.4) | `sign-in`, `get-session` und `list-sessions` liefern das Token, die Sicherheitsseite beendet Sessions darüber. Ohne Bearer-Plugin ist es ohne die Signatur des Cookies nicht verwendbar. | CSP mit Nonces, React maskiert jede Ausgabe | Mit einer Version von Better Auth, die Sessions über ihre ID beendet |
| Antwortzeiten der Anmeldung (ASVS 6.3.8, Level 3) | Bekannte und unbekannte Adressen antworten gleich, Better Auth hasht auch für unbekannte. Kleine Unterschiede der Zeit sind nicht ausgeschlossen. | Limits je Adresse und Konto | Mit Level 3 |
| Zugriffs-Cache nach einer gescheiterten Invalidierung | Der alte Zugriff gilt höchstens 60 s. Eine Generation je Nutzer würde jede Anfrage um einen Lesezugriff auf Redis verteuern. | Das Scheitern wird geloggt und gezählt, seit Schritt 8.7 mit dem Alarm `AccessCacheInvalidationFailed` (ADR 0043); Lesefehler fallen auf die Datenbank zurück | Bei Bedarf eine Generation je Nutzer |
| Ein Token-Keyring für E-Mail-Jobs und Plattform-Tokens | Die AAD trennt beide (`notify.email` gegenüber `workspaceId:connectionId:feld`). | Rotation nach dem Runbook | Schritt 8.9: eigener Keyring oder KMS |
| Fremde Registrierung einer Adresse | Bestätigt die Person mit der Adresse den Link einer fremden Registrierung, kann sich die registrierende Person bis zum Zurücksetzen des Passworts anmelden. | Hinweis-Mail bei erneuter Registrierung; das Zurücksetzen beendet alle Sessions; unbestätigte Konten gehen nach einem Tag | Mit Passkeys |
| Ältere Sessions eines Mitglieds, das 2FA erst nach der Pflicht einrichtet | Sessions anderer Geräte ohne zweiten Faktor bleiben bis zu ihrem Ende. | Das Einrichten bietet das Abmelden der anderen Geräte an (vorbelegt); sieben Tage absolut | Bei der nächsten Version von Better Auth |
| TOTP-Fenster von 90 s (ASVS 6.5.5 verlangt 30 s) | Better Auth nimmt fest einen Zeitschritt davor und danach an, das ist nicht einstellbar. | Jeder Code gilt nur einmal | Bei der nächsten Version von Better Auth |
| Backup-Codes verschlüsselt statt gehasht (ASVS 6.5.2) | Better Auth vergleicht die Codes im Klartext und bietet keinen Hash an; zehn Zeichen tragen etwa 59 bit. | Wer Datenbank und Secret hat, liest auch das TOTP-Secret; jeder Code gilt einmal | Bei der nächsten Version von Better Auth |
| Kennung des 2FA-Zwischenschritts mit 120 bit (ASVS 11.5.1 verlangt 128) | Better Auth erzeugt sie fest aus 20 Zeichen; sie gilt zehn Minuten und nur im signierten Cookie. | Ohne die HMAC-Signatur des Cookies ist sie nicht verwendbar | Bei der nächsten Version von Better Auth |
| Beenden von Sessions ohne erneute Anmeldung (ASVS 7.5.2) | Beenden nimmt nur Zugriff weg; wer die Session hat, kann damit keine Daten gewinnen. | Die Liste verlangt eine Session unter einem Tag | Mit Passkeys |
| `style-src 'unsafe-inline'` | Next.js und die Bibliotheken der Dialoge und Toasts setzen Styles ohne Nonce (Pentest-Bericht). | Skripte nur mit Nonce | Sobald alle Bibliotheken eine Nonce übernehmen |
| Kein Virenscan der Uploads (ASVS 5.4.3) | Es gibt nur Bilder; der Typ wird am Inhalt erkannt, sharp dekodiert jedes Bild, die Renditions sind neu kodiert. | ClamAV steht als Compose-Profil bereit | Wenn andere Dateitypen dazukommen |
| Ein PUT, der länger als eine Stunde nach Ablauf des Links offen bleibt | Er kann das Upload-Objekt nach dem Job `media.drop-upload` noch einmal anlegen. | 300 Tickets je Stunde und Nutzer, 20 MB je Datei | Schritt 8.9: Dauer der Anfragen am Speicher begrenzen |

### Verschoben

- **Schritt 8.9 (Deployment)**:
  - TLS 1.2 und 1.3 mit Zertifikaten einer öffentlichen CA und einer Überwachung des Ablaufs; HSTS und die Umleitung auf https am Proxy.
  - TLS für Postgres und Redis und für interne Verbindungen.
  - Nur der Proxy erreicht API und Web-App. Davon hängt das Vertrauen in `X-Real-IP` ab.
  - Eine Allowlist ausgehender Verbindungen für API und Worker.
  - Ein Secret-Store oder KMS, darin ein eigener Keyring für die E-Mail-Jobs.
  - Eigene Identitäten je Dienst und Rolle in Datenbank und Redis.
  - Readiness nur intern statt über den Proxy.
  - Eine Grenze für die Dauer von Anfragen an den Objektspeicher.
  - Ein Log-Backend mit Zugriffsschutz und 30 Tagen, Fristen auch für Traces und Fehlerberichte; Zeitsynchronisation der Hosts.
  - Verschlüsselte Datenträger und Backups für PostgreSQL, Redis und den Objektspeicher; die App verschlüsselt vertrauliche Inhalte nicht selbst.
  - Images in einer Registry mit Signatur und SBOM je Release.
- **Schritt 8.7 (Betrieb)**, umgesetzt:
  - Alarme auf ein globales Budget der KI, auf das Wachstum des Speichers und auf Sicherheitsereignisse ([ADR 0043](0043-slos-metriken-und-alarme.md)).
  - Ein Runbook für den Verlust von App und Backup-Codes, mit einer Prüfung der Identität (ASVS 6.4.4, [Runbook](../runbooks/zweiter-faktor-verloren.md)).
  - Ein Log-Kontext je Job im Worker, strukturierte Logs der Web-App, ein Sicherheitsereignis für falsche Passwörter bei `PasswordCheck` und ein Test für `auth.event` (ASVS 16.2.1, 16.2.4, 16.3.1).

## Konsequenzen

- **Positiv**:
  - Kein kritischer oder hoher Befund ist offen.
  - Jede Grenze hat einen Wert und einen Ort im Code, und jede Art von Grenze hat einen Test.
  - Die Checkliste nennt für jede Lücke Schwere und Plan, die Fristen machen das Nachhalten prüfbar.
- **Negativ**:
  - Wer die Adresse eines Kontos kennt, kann es für fremde Geräte 15 Minuten sperren; bekannte Geräte melden sich weiter an.
  - Die Leck-Prüfung hängt an einem externen Dienst, der Ausfall lässt Passwörter durch.
  - Mehrere Kontrollen hängen an Better Auth (Fenster der TOTP-Codes, Backup-Codes, Token im JSON) und warten auf dessen Versionen.
  - Die Härtung von Transport und Betrieb fehlt bis Schritt 8.9; bis dahin ist die Plattform nicht für Produktion freigegeben.
