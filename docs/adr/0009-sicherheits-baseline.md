# ADR 0009: Sicherheits-Baseline ab Phase 0

- **Status**: Akzeptiert
- **Datum**: 2026-10-16
- **Bezug**: `docs/ARCHITECTURE.md`, Abschnitte 10 und 12; Umsetzungsleitfaden, Schritte 0.1, 0.3, 0.6, 0.7, 0.9, 0.13 und 8.4; [ADR 0039](0039-security-review-und-haertung.md)

## Kontext

Die Architektur nennt Härtung und Lieferkette (CSP mit Nonces, Log-Redaction, Renovate, Audit, CodeQL, gitleaks), verteilt sie aber auf spätere Phasen. Ein Teil davon kostet jetzt wenig und wird später teuer: Header, Datenminimierung in Logs und Fehlerberichten, Gates gegen kompromittierte Pakete und gehärtete Container. Diese Punkte gelten deshalb ab Phase 0.

## Entscheidung

### Web

- **CSP pro Request mit Nonce** in `apps/web/src/proxy.ts`: `script-src 'self' 'nonce-…' 'strict-dynamic'` (im Dev-Modus zusätzlich `'unsafe-eval'` für React), `object-src 'none'`, `base-uri 'self'` (seit Schritt 8.4 `'none'`), `form-action 'self'`, `frame-ancestors 'none'`. Next.js liest die Nonce aus dem Request-Header und setzt sie an seine Skripte. Geprüft mit Chromium gegen den Production-Build: alle Skripte tragen die Nonce, die Seite hydriert, keine Verstöße.
- **`style-src 'self' 'unsafe-inline'`**: Next.js rendert `style`-Attribute (z.B. auf den eingebauten Fehlerseiten), und Attribute können keine Nonce tragen. Eingeschleustes CSS führt keinen Code aus.
- **Feste Header** für jede Antwort (`next.config.ts`): `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, `Cross-Origin-Opener-Policy`, eine restriktive `Permissions-Policy`; kein `X-Powered-By`.
- **HSTS** setzt der TLS-terminierende Reverse Proxy in Produktion. Seit Schritt 8.4 sendet ihn auch die Web-App in Produktions-Builds (`max-age=31536000; includeSubDomains`); über HTTP ignorieren Browser ihn. Die API setzt die Policy von helmet mit `base-uri 'none'` und `frame-ancestors 'none'` (ADR 0039).
- Phase 3 ergänzt den Objektspeicher in `img-src` und `connect-src` (umgesetzt in Schritt 3.6, [ADR 0022](0022-medien-im-web.md)).

### Logs und Fehlerberichte

- **Request-Logs** der API enthalten nur Request-ID, Methode, Pfad ohne Query-String und Status. Header (Cookies, Tokens), Query-Strings (später OAuth-Codes) und die Client-Adresse (personenbezogen) werden nicht geloggt. Seit Schritt 8.4 hat auch `/api/auth` eine Request-Zeile, mit maskiertem Token im Pfad des Reset-Links; die Client-Adresse nennen nur die Sicherheitsereignisse (ADR 0039).
- **5xx-Fehler** werden mit dem Fehlerobjekt geloggt; die Antwort an den Client enthält bei 5xx nie den internen Text, auch nicht bei einer `HttpException`.
- **Redaction** zensiert zusätzlich `set-cookie`, `proxy-authorization`, `x-api-key`, `token`, `idToken`, `secret` und `clientSecret`.
- **Sentry 11** sammelt ohne Konfiguration Nutzerdaten, Cookies, Header, Bodies, Query-Parameter, Datenbank-Parameter, Queue-Payloads, lokale Variablen und KI-Ein- und -Ausgaben. Über `dataCollection` ist das abgeschaltet; nur `content-type`, `user-agent` und `x-request-id` bleiben. `beforeSend` entfernt Cookies, Body und Query-String zusätzlich.

### Lieferkette

- **pnpm-Gates** in `pnpm-workspace.yaml`: `minimumReleaseAge: 1440` (Versionen erst nach einem Tag), `trustPolicy: no-downgrade` (Abbruch, wenn ein Paket mit schwächerem Herkunftsnachweis erscheint als frühere Versionen), `blockExoticSubdeps: true`, `strictDepBuilds: true` mit allen Install-Skripten explizit in `allowBuilds`.
- **Geprüfte Ausnahme** `prisma@7.10.0`: Die Versionen 7.5.0 bis 7.9.1 wurden mit Provenance über GitHub Actions veröffentlicht, 7.10.0 über das Konto `prismabot` ohne Nachweis. Die Version entspricht dem signierten Release 7.10.0 von `prisma/prisma` vom 2026-08-25 und ist deshalb genau in dieser Version freigegeben. Jede spätere Version ohne Nachweis schlägt wieder fehl.
- **Geprüfte Ausnahme** `semver@6.3.1` (seit Schritt 1.8): der Backport des ReDoS-Fixes (CVE-2022-25883) auf die 6.x-Linie, am 2023-07-10 vom npm-CLI-Maintainer veröffentlicht. Die Version erschien nach 7.5.2 bis 7.5.4, die einen Herkunftsnachweis haben; die Prüfung nach Veröffentlichungsdatum wertet sie deshalb als Downgrade. `@babel/core` (über `eslint-plugin-react-hooks`) braucht weiterhin semver 6.
- **Audit**: `mysql2` und `js-yaml` 5 sind per `overrides` innerhalb der Major-Version gepatcht. Bewusst akzeptiert sind `GHSA-ggr8-5vv4-36mx` (`deepmerge-ts`, nur im Config-Loader der Prisma-CLI mit eigener Konfiguration; der Fix ist eine neue Major) und `GHSA-vfj7-8cjw-p6xm` (`braces`, nur in Lint-Werkzeugen, kein Fix vorhanden). Beides steht mit Begründung in `auditConfig`.
- **pnpm selbst** ist über den sha512 in `packageManager` festgelegt; Corepack prüft ihn beim Download.
- **Images** sind auf exakte Tags gepinnt (seit Schritt 8.4 `node:24.21.0-trixie-slim` auf Debian 13, vorher `node:24.21.0-slim` auf Debian 12); Renovate ist so eingestellt, dass es zusätzlich die Digests pinnt (`docker:pinDigests`), drei Tage vor Updates wartet und OSV-Schwachstellen meldet. Bis Renovate auf dem Repository läuft, tragen die Images nur ihre Tags (Security-Review, ADR 0039). Die Runtime-Stages enthalten weder npm noch corepack oder yarn: Die Apps laufen mit `node` allein, und die mitgelieferten Abhängigkeiten von npm brachten die einzigen Befunde des Image-Scans.

### CI

- Workflow `Security`: CodeQL (`security-extended`) für TypeScript und die Workflows selbst, Dependency Review auf Pull Requests (Abbruch ab Schweregrad hoch), `pnpm audit --audit-level high`, gitleaks über die ganze Historie mit prüfsummengesicherter Binärdatei. Läuft auf Pull Requests, Pushes nach `main` und wöchentlich.
- Job `images` im Workflow `CI` (seit Schritt 8.4): baut die fünf Images (api, worker, egress-proxy, web, browser-worker), legt je ein SBOM im Format CycloneDX als Artefakt für 90 Tage ab und scannt jedes Image mit Trivy 0.75.0 (prüfsummengesicherte Binärdatei) auf Schwachstellen und Secrets. Er scheitert an einem Befund ab Schweregrad hoch, für den es einen Fix gibt. Im browser-worker bleibt `/root/.npm` ausgenommen: Eine untere Schicht des Playwright-Images enthält dort Cache und Log einer npm-Installation mit einer signierten Azure-URL (SAS-Token). Eine spätere Schicht löscht das Verzeichnis, Trivy liest aber jede Schicht. Das Pushen nach GHCR folgt mit dem Deployment (Schritt 8.9).
- Jedes Paket deklariert `eslint` und `typescript` selbst; Lint und Tests bauen vorher die Abhängigkeiten. Vorher liefen sie nur dort, wo globale Werkzeuge im `PATH` lagen.

### Container und Datenbank

- **App-Container** (API, Worker, Web, Proxy) laufen mit `no-new-privileges`, ohne Linux-Capabilities und mit schreibgeschütztem Root-Dateisystem (tmpfs für `/tmp`, den Next.js-Cache und den Caddy-Zustand). Der Proxy behält nur `NET_BIND_SERVICE`, weil das Caddy-Binary diese Capability als Datei-Capability trägt.
- **Datenbank-Rollen**: `PUBLIC` darf keine Datenbank mehr verbinden; die Laufzeitrollen erreichen nur `smp` und `smp_test`. `statement_timeout` (30 s für `app_user`, 5 min für `app_system`) und `idle_in_transaction_session_timeout` (60 s) begrenzen hängende Abfragen und offene Transaktionen.

## Alternativen

- **Statische CSP ohne Nonce**: bräuchte `'unsafe-inline'` für Skripte und schützt dann kaum gegen XSS.
- **Sicherheits-Scans erst in Phase 8**: verworfen. Funde sind früh billiger zu beheben, und der Audit hat bereits fünf bestehende Advisories gezeigt.
- **Ausnahme für das ganze Paket `prisma`** statt für eine Version: verworfen, sie würde jede spätere Version ohne Nachweis durchlassen.

## Konsequenzen

- Neue Abhängigkeiten mit Install-Skript brechen die Installation, bis sie in `allowBuilds` entschieden sind.
- Ein Paket-Update, das jünger als ein Tag ist oder einen schwächeren Herkunftsnachweis hat, lässt sich nicht installieren. Das ist gewollt; Ausnahmen bekommen einen Kommentar mit Begründung.
- Wer eine App neue Pfade beschreiben lässt, braucht einen tmpfs-Eintrag in `compose.yaml`.
- Für den browser-worker gilt die Container-Härtung noch nicht: Chromium braucht eigene Einstellungen, die mit Phase 6 entschieden werden.
- Für das Rollen-Init-Skript gilt weiter: Änderungen greifen erst nach `docker compose down -v`.
