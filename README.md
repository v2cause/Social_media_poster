# Social Media Poster

KI-gestützte Plattform zum Erstellen, Planen und Auswerten von Social-Media-Posts, gebaut als Multi-Tenant SaaS.

## Funktionen (geplant)

- Themenvorschläge und Post-Generierung per KI (Anthropic Claude API)
- Post-Stile per Dropdown sowie eigene Stile und Brand Voices
- Bilder hochladen, die mit dem Post veröffentlicht werden
- Posts planen: Kalender, nächster geplanter Post, Zeitzonen, automatische Wiederholversuche
- KPIs: Reichweite, Impressions, Engagement pro Post, Account und Zeitraum
- Plattformen: LinkedIn (Profil und Company Page), Instagram, Facebook Pages, X
- Teams mit Rollen (Owner, Admin, Editor, Viewer), Oberfläche auf Deutsch und Englisch

## Status

Die Planung ist abgeschlossen. Phase 0 (Fundament) ist weitgehend umgesetzt: die Schritte 0.1 bis 0.14 sind gebaut, vier der fünf Spikes sind bestanden. Offen sind der Spike zur KI-Anbindung (0.14a, braucht einen API-Schlüssel) und das Größenziel der Images (siehe [ADR 0001](docs/adr/0001-monorepo-und-stack.md)).

Phase 1 (Identity und Mandanten) ist umgesetzt: Registrierung mit E-Mail-Verifizierung, Passwort-Reset und 2FA über Better Auth, Organisationen, Workspaces, Mitglieder und Einladungen per E-Mail, Rechte-Matrix mit Guards, RLS auf allen Mandantentabellen, Audit-Log, die Web-Oberfläche mit Onboarding, App-Shell, Team- und Sicherheitsseite auf Deutsch und Englisch sowie ein Playwright-E2E über den ganzen Ablauf. Architekturentscheidungen stehen in [docs/adr/](docs/adr/).

Phase 2 (Composer, KI und Stile) ist umgesetzt: Beiträge mit Varianten pro Plattform, Brand Voices mit Versionen und Stimmtest, Stil-Vorlagen und eigene Stile, die KI-Anbindung über Claude (mit Mock für Entwicklung und Tests), Generierung und Verfeinerung als Stream, Themenvorschläge, Quoten und Kostenerfassung über das PriceBook, der Composer mit Auto-Speichern und Vorschau sowie die Eval-Suite (`pnpm eval:ai`). Offen ist die gemessene Baseline der Eval-Suite mit der Claude API, weil dafür ein API-Schlüssel nötig ist ([ADR 0018](docs/adr/0018-ki-eval-suite-und-baseline.md)).

Phase 3 (Medien) ist umgesetzt: Uploads direkt in den Objektspeicher mit Speicher-Quote, Prüfung und Neukodierung im Worker (Magic Bytes, sharp mit Pixel-Limit, ohne EXIF und GPS), Thumbnails, Renditions pro Plattform mit Zuschnitt oder weißen Rändern, Alt-Text-Vorschläge der KI, die Medienbibliothek und im Composer Medien pro Variante mit Reihenfolge, Zuschnitt und Vorschau ([ADR 0019](docs/adr/0019-medien-upload-und-verarbeitung.md) bis [ADR 0022](docs/adr/0022-medien-im-web.md)). Einige Plattform-Limits (Facebook, LinkedIn) sind noch nicht an der offiziellen Doku bestätigt; das geschieht in den Adapter-Phasen ([ADR 0020](docs/adr/0020-renditions-und-zuschnitt.md)).

Phase 4 (Kanäle, Publishing, Scheduling) ist umgesetzt: Token-Tresor mit Envelope-Verschlüsselung, Verbinden über OAuth mit Auswahl der Accounts, Adapter-Registry mit Mock-Plattformen und Contract-Suite, Planen mit lokalen Zeiten und Zeitzonen, Scheduler-Tick mit verpassten Zeitfenstern, Publish-Job mit Lease, Schreibmarke und Reconcile, Wiederholversuche und Dead-Letter-Queue, Token-Monitor mit Erinnerungen, Benachrichtigungen in der App und per E-Mail, Live-Events über SSE und im Web Accounts, Post-Tabelle, Planen-Leiste, Kalender mit Drag & Drop und das Dashboard mit den nächsten Posts ([ADR 0023](docs/adr/0023-planen-zeitzonen-und-zustandsautomat.md) bis [ADR 0026](docs/adr/0026-planen-im-web.md)). Die echten Adapter für LinkedIn, Facebook, Instagram und X (Schritte 4.12 bis 4.14) sind gebaut und gegen nachgebaute Antworten der Plattformen getestet ([ADR 0046](docs/adr/0046-echte-plattform-adapter.md)). Mit `PLATFORM_MODE_*=live` und den Zugangsdaten der Plattform-Apps veröffentlicht die App echte Beiträge; wie die Apps angelegt werden, steht in [Plattformen einrichten](docs/betrieb/plattformen-einrichten.md). Offen sind:

- die Prüfung gegen die offizielle Doku, die aus der Entwicklungsumgebung gesperrt ist;
- der erste echte Testbeitrag je Plattform;
- die Callbacks von Meta für "App entfernt" und "Daten löschen";
- bei LinkedIn eine zweite App für Company Pages, falls LinkedIn sie verlangt.

Ohne Zugangsdaten laufen die Plattformen über den Mock-Adapter. Statt Bull Board zeigt `pnpm queues` die Queues und die Dead-Letter-Queue (Schritt 8.7, [ADR 0043](docs/adr/0043-slos-metriken-und-alarme.md)).

Phase 5 (Analytics) ist für die Mock-Plattformen umgesetzt: Abfrage-Kaskade pro Post mit Batches und Sperren, tägliche Account-Zahlen, Rollup pro lokalem Tag der Workspace-Zone, sieben Analytics-Endpunkte mit Vorzeitraum, Redis-Cache und CSV-Export, im Web die Analytics-Seite mit barrierefreien SVG-Diagrammen, Detailseiten für Post und Account und die KPIs auf dem Dashboard, Demo-Daten über 90 Tage im Seed und Themenideen, die auf die besten Posts verweisen ([ADR 0027](docs/adr/0027-analytics-kaskade-rollup-und-api.md) und [ADR 0028](docs/adr/0028-analytics-im-web.md)). Offen sind die Mappings der echten Plattformen mit Tests auf echten Payloads, der Abgleich der Zahlen mit den Plattform-UIs auf Staging und der Eval-Lauf der neuen Prompt-Version mit der Claude API.

Phase 6 (X ohne API) ist hinter Feature-Flags umgesetzt: Freischaltung mit versionierter Risikobestätigung, der isolierte browser-worker mit Egress-Allowlist und eigener Redis-Rolle, Selector-Map und Flows für Posten, Metriken und Login, der interaktive Login mit Zwei-Faktor-Code, Kill-Switch, Circuit Breaker und täglicher Canary ([ADR 0029](docs/adr/0029-x-browser-freischaltung-und-kill-switch.md) bis [ADR 0032](docs/adr/0032-canary-und-circuit-breaker.md)). Offen sind die Prüfung von Selektoren, Antworten und Egress-Hosts gegen x.com, ein echter Login, ein interner Test-Account für den Canary und die rechtliche Freigabe des Risikotextes.

Phase 7 (Billing und Quoten) ist umgesetzt: Tarife mit Limits und Testphase, Stripe Checkout, Kundenportal und Tarifwechsel, Webhooks über die Worker-Rolle `billing`, die tägliche Meldung von KI-Mehrverbrauch und X-Kosten an die Stripe-Meter, die Limits an allen Stellen mit Nur-Lesen nach Zahlungsverzug oder Abo-Ende und die Abrechnungsseite mit Verbrauch, Tarifen und Rechnungen ([ADR 0033](docs/adr/0033-tarife-abo-und-nur-lesen.md) bis [ADR 0035](docs/adr/0035-nutzungsabrechnung-und-durchsetzung-der-limits.md)). Getestet ist alles gegen einen Fake-Stripe, der die Parameter gegen die OpenAPI-Spezifikation von Stripe prüft. Offen ist der Lauf gegen die Test Clocks des echten Stripe: Der Test liegt bereit, braucht aber einen Testschlüssel. Die Preise sind Platzhalter.

Phase 8 (Härtung, DSGVO, Betrieb) ist umgesetzt: Datenexport und Löschung auf der Seite "Daten und Löschung", die Aufbewahrungsfristen, das Security-Review, der Lasttest, die Sicherung, der Betrieb, die Barrierefreiheit und die Produktions-Vorlage:

- **Export**: Owner fordern einen Export an. Die Worker-Rolle `gdpr` schreibt alle Tabellen der Organisation als JSON und die Originale der Medien als ZIP in den Objektspeicher, und nach der E-Mail lädt der Owner das Archiv 24 Stunden lang herunter ([ADR 0036](docs/adr/0036-datenschutz-anfragen-und-datenexport.md)).
- **Löschung**: Owner löschen die Organisation mit ihrem Namen als Bestätigung. Ab da arbeitet niemand mehr darin, und 30 Tage lang können Owner die Löschung zurücknehmen. Danach löscht die Rolle `gdpr` alles: Grants bei den Plattformen, den Stripe-Kunden, die Objekte und jede Zeile der Organisation. `pnpm check:erasure <requestId>` prüft, dass nichts übrig ist ([ADR 0037](docs/adr/0037-loeschung-von-organisationen.md)).
- **Aufbewahrung**: Nachts leert der Scheduler KI-Rohdaten nach 180 Tagen, löscht verarbeitete Webhook-Ereignisse und Verbindungsdaten nach 30 Tagen und Metriken über die Analytics-Historie des Tarifs hinaus. Stündlich löscht die Rolle `gdpr` Medien, die aus der Bibliothek entfernt wurden, und Uploads, die nach 24 Stunden nicht abgeschlossen sind ([ADR 0038](docs/adr/0038-aufbewahrungsfristen.md)).
- **Security-Review**: Checkliste nach OWASP ASVS 5.0 Level 2, Pentest mit ZAP und manuellen Prüfungen, Runbook zur Rotation aller Secrets, geprüfte CSP und abgestimmte Rate-Limits. Dazu kamen unter anderem eine Passwortrichtlinie mit Prüfung gegen Datenlecks, Limits je Konto und Gerät, Sessions mit fester Laufzeit von sieben Tagen, eine 2FA-Pflicht für Plattform-Admins und auf Wunsch der Owner, Sicherheitsereignisse im Log und Images auf Debian 13 mit SBOM und Trivy-Scan. Offen ist kein kritischer oder hoher Befund ([ADR 0039](docs/adr/0039-security-review-und-haertung.md), [docs/security/](docs/security/)).
- **Lasttest**: 10.000 Varianten, die in derselben Minute fällig werden, sind höchstens 52 s nach ihrer Zeit veröffentlicht. Die API beantwortet derweil Lesezugriffe mit einem p95 von 208 ms. Gemessen ist das mit k6 auf einer Maschine mit 4 vCPU und zwei API-Instanzen; der Publish-Job spricht Postgres dafür über node-postgres an ([ADR 0040](docs/adr/0040-publish-job-ueber-node-postgres.md), [ADR 0041](docs/adr/0041-lasttest.md)).
- **Sicherung**: Postgres archiviert sein WAL laufend, zieht täglich ein Base-Backup und kopiert beides alle fünf Minuten in einen eigenen Bucket. Damit ist eine Wiederherstellung auf jeden Zeitpunkt der letzten 14 Tage möglich, mit einem RPO von 15 Minuten und einem RTO von 4 Stunden. Die Restore-Probe läuft in der CI; nach einem Restore sorgt eine Markierung dafür, dass kein Post doppelt erscheint ([ADR 0042](docs/adr/0042-backup-und-wiederherstellung.md), [Runbook](docs/runbooks/backup-restore.md)).
- **Betrieb**:
  - SLOs für pünktliches Veröffentlichen (99 % innerhalb von 2 Minuten), die Verfügbarkeit der API (99,5 %) und ihre Lesezugriffe (p95 unter 300 ms).
  - Metriken in API und Worker ohne Mandanten-Labels.
  - 37 Alarme in Prometheus, jeder mit Unit-Test und Runbook, per E-Mail über Alertmanager.
  - Runbooks für Plattform-Ausfall, massenhaften Token-Ablauf, X-Drift, Redis-Verlust und hängende Queues, alle durchgespielt. Die Fehler spielt `pnpm drill` ein, für Redis und die Queues Compose und die Rollen des Workers.

  Die Proben fanden und behoben sechs Fehler, darunter eine SLO-Regel, die unter Prometheus 3 nie anschlug, und Ticks, die nach einem Datenverlust in Redis stillstanden ([ADR 0043](docs/adr/0043-slos-metriken-und-alarme.md), [Übersicht der Alarme](docs/runbooks/alarme.md)).

- **Barrierefreiheit**: axe prüft in den E2E-Tests die Seiten, Menüs und Dialoge gegen WCAG 2.2 AA, im hellen und im dunklen Schema. Tests halten den Weg der Tastatur und die Breite von 320 Pixeln fest. Die Prüfung fand und behob 14 Mängel, darunter Kontraste im dunklen Schema, einen fehlenden Sprunglink und Dialoge, nach denen der Fokus verloren ging. Ein Test mit Screenreadern steht aus ([ADR 0044](docs/adr/0044-barrierefreiheit.md), [Prüfprotokoll](docs/barrierefreiheit/pruefung-2026-10.md)).
- **Deployment**: Die Vorlage `deploy/` startet die Plattform mit Docker Compose auf einer VM hinter Caddy: TLS mit einer öffentlichen CA, API und Web nur im internen Netz des Proxys, TLS und eine Identität je Dienst für Postgres, Redis und den Speicher, ausgehend nur über eine Allowlist, Secrets als Dateien, Logs 30 Tage in journald. Ein Tag `v*` baut signierte Images mit SBOM für GHCR, und `deploy.sh` prüft sie vor dem Start. Ein Staging aus der Vorlage lief am 2026-10-19 in einem Container und fand und behob 13 Fehler der Vorlage. Offen sind das erste Release, ein Deploy mit echten Namen und das Update von Caddy bis zum 2026-11-02 ([ADR 0045](docs/adr/0045-produktions-vorlage.md), [Runbook](docs/runbooks/deployment.md), [Staging-Protokoll](docs/betrieb/staging-2026-10.md)).

## Entwicklung

Voraussetzungen:

- Node.js 24 (Version steht in `.nvmrc`; `.npmrc` erzwingt das `engines`-Feld).
- pnpm 10 über Corepack. Die exakte Version steht im Feld `packageManager` der `package.json`.
- Docker ab Schritt 0.3 für die lokale Infrastruktur.

Erster Start:

```bash
corepack enable
pnpm install
cp .env.example .env
docker compose up -d
pnpm -s gen:keys   # gibt Schlüssel aus; die Zeilen in .env eintragen
pnpm db:migrate
pnpm db:seed       # optional: Demo-Organisation mit vier Rollen, Mock-Accounts und 90 Tagen Analytics
pnpm build
```

Konfiguration: `.env.example` listet alle Variablen nach Gruppen, mit Hinweis auf die Pflichtwerte. Die lokale Infrastruktur (Postgres, Redis, S3-kompatibler Speicher, Mailpit) startet über `compose.yaml`. Redis hat keinen Standardnutzer: API und Worker melden sich als Nutzer `app` mit `REDIS_APP_PASSWORD` an, dasselbe Passwort steht in `REDIS_URL`; nach einer Änderung `docker compose up -d redis` erneut ausführen. `.env.test` enthält nur Testwerte und wird committet; Integrationstests starten ihre Datenbanken selbst über Testcontainers. Jedes Secret kann statt als Wert auch aus einer Datei kommen: `<NAME>_FILE` nennt ihren Pfad (Schritt 8.9, [Runbook](docs/runbooks/secret-rotation.md)).

| Befehl                       | Zweck                                                                                                            | Verfügbar ab |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------ |
| `pnpm dev`                   | startet die Apps im Watch-Modus                                                                                  | Schritt 0.7  |
| `pnpm build`                 | baut alle Packages und Apps (Turbo, mit Cache)                                                                   | Schritt 0.1  |
| `pnpm lint`                  | ESLint über alle Packages                                                                                        | Schritt 0.2  |
| `pnpm typecheck`             | TypeScript-Prüfung ohne Ausgabe                                                                                  | Schritt 0.2  |
| `pnpm test`                  | Unit-Tests (Vitest)                                                                                              | Schritt 0.2  |
| `pnpm test:integration`      | Integrationstests mit Testcontainers (braucht Docker)                                                            | Schritt 0.5  |
| `pnpm test:e2e`              | End-to-End-Tests (Playwright)                                                                                    | Schritt 1.9  |
| `pnpm format`                | Prettier über das Repo schreiben                                                                                 | Schritt 0.2  |
| `pnpm db:migrate`            | Prisma-Migrationen als `app_migrator` anwenden                                                                   | Schritt 0.5  |
| `pnpm db:seed`               | Demo-Daten laden                                                                                                 | Schritt 1.1  |
| `pnpm stripe:sync`           | Produkte, Preise, Meter und Kundenportal in Stripe anlegen bzw. abgleichen (`STRIPE_SECRET_KEY`)                 | Schritt 7.2  |
| `pnpm eval:ai`               | KI-Eval-Suite mit Budget (`EVAL_BUDGET_MICROS`), `--dry-run` schätzt nur; Bericht mit Vergleich zum letzten Lauf | Schritt 2.10 |
| `pnpm gen:keys`              | 32-Byte-Schlüssel für Tokens, Sessions und E-Mails erzeugen                                                      | Schritt 0.4  |
| `pnpm check:deps`            | Architekturregeln mit dependency-cruiser prüfen                                                                  | Schritt 0.13 |
| `pnpm check:emoji`           | Emoji und unsichtbare Zeichen in verfolgten Dateien suchen; mit `--commits A..B` in Commit-Messages              | Schritt 0.13 |
| `pnpm check:format`          | Prettier-Prüfung über das Repo                                                                                   | Schritt 0.13 |
| `pnpm check:i18n`            | Übersetzungen prüfen: gleiche Keys und Argumente in de und en, gültiges ICU                                      | Schritt 1.10 |
| `pnpm check:rls`             | RLS und Policies aller Mandantentabellen in der lokalen Datenbank prüfen                                         | Schritt 1.2  |
| `pnpm load:fixture`          | Testdaten des Lasttests schreiben und für k6 beschreiben (nie in Produktion)                                     | Schritt 8.5  |
| `pnpm load:stats`            | Einen Lauf des Lasttests aus der Datenbank auswerten, auch die Abfragen der Metriken                             | Schritt 8.5  |
| `pnpm backup:drill`          | Restore-Probe: Sicherung, Wiederherstellung auf einen Zeitpunkt und Prüfungen in einem eigenen Compose-Projekt   | Schritt 8.6  |
| `pnpm restore:mark-attempts` | Nach einem Restore offene Versuche für alle noch zu sendenden Varianten anlegen (`--since <T>`)                  | Schritt 8.6  |
| `pnpm check:alerts`          | Prometheus- und Alertmanager-Konfiguration prüfen und die Unit-Tests der Alarme ausführen (Docker)               | Schritt 8.7  |
| `pnpm queues`                | Queues zählen, Dead Letters und gescheiterte Jobs zeigen, geprüfte Dead Letters entfernen                        | Schritt 8.7  |
| `pnpm drill`                 | Fehler für die Proben der Runbooks einspielen: Plattform-Ausfall, Token-Welle, X-Drift (nie in Produktion)       | Schritt 8.7  |

E2E-Tests: `pnpm test:e2e` läuft gegen den gestarteten Stack, wie im CI-Job "End-to-end tests". Vorher die Infrastruktur starten (`docker compose up -d --wait`), migrieren und bauen, dann in drei Terminals API und Worker (`node --env-file=../../.env --require @smp/observability/register dist/main.js` in `apps/api` und `apps/worker`) sowie das Web (`pnpm --filter @smp/web start`). Der Test liest die Verifizierungs- und Einladungs-Mails über die Mailpit-API. Der Medien-Test lädt in den lokalen S3-Speicher hoch; der Worker braucht dafür die Rolle `media` (in `WORKER_ROLES`, Standard in `.env.example`). Ohne heruntergeladene Playwright-Browser zeigt `PLAYWRIGHT_CHROMIUM_EXECUTABLE` auf ein installiertes Chrome oder Chromium.

Container-Betrieb: `docker compose --profile app up -d --build --wait` startet API, Worker und Web, alle drei mit Healthcheck, dazu einen Reverse Proxy (Caddy). Die Container laufen mit `NODE_ENV=production`, wo der KI-Mock gesperrt ist (Schritt 2.5); `.env` braucht dafür `AI_PROVIDER=anthropic` und einen `ANTHROPIC_API_KEY`, sonst startet die API nicht. Die App ist dann unter `http://localhost:8080` erreichbar; der Proxy routet wie in Produktion `/api` an die API und alles andere an das Web. Das Profil `xb` startet den isolierten browser-worker, das Profil `observability` Grafana unter `http://localhost:3003` sowie Prometheus (`http://localhost:9090`), Alertmanager (`http://localhost:9093`) und das Pushgateway. Nach Änderungen an `infra/docker/postgres/init` einmal `docker compose down -v`, weil das Init-Skript nur auf einem leeren Volume läuft.

Echte Plattformen: `PLATFORM_MODE_LINKEDIN`, `PLATFORM_MODE_META` und `PLATFORM_MODE_X` auf `live` schalten den echten Adapter ein; dazu gehören die Zugangsdaten der Plattform-App aus `.env.example`. Fehlt einer, starten API und Worker nicht und nennen die Variable. `PUBLISH_DRY_RUN=true` prüft Beiträge, ohne zu senden; zum echten Posten `false`. Die Redirect-URI jeder App ist `APP_URL/api/oauth/<plattform>/callback`, Instagram braucht einen öffentlich erreichbaren Speicher. Schritt für Schritt in [Plattformen einrichten](docs/betrieb/plattformen-einrichten.md).

X ohne API (optional, Phase 6): `FEATURE_X_BROWSER_GLOBAL=true` bietet den Browser-Adapter an; API und browser-worker brauchen dann `SESSION_KEKS`, die Worker-Rolle `publisher` zusätzlich `DATABASE_SYSTEM_URL` und `APP_URL`. `docker compose --profile xb up -d` startet den browser-worker im internen Netz `xb` mit dem Egress-Proxy; Redis kennt ihn als Nutzer `browser-worker` mit `XB_REDIS_PASSWORD`. Ein Plattform-Admin schaltet unter `/admin` die Organisation frei, ein Owner oder Admin schaltet X ohne API in den Workspace-Einstellungen nach der Risikobestätigung ein, danach verbindet die Accounts-Seite X über den Login-Dialog. Drei Drifts der Selector-Map in einer Stunde schalten X ohne API für alle aus; den Kill-Switch hebt ein Plattform-Admin auf. Mit `XB_CANARY_ACCOUNT_ID` prüft ein täglicher Canary die Selector-Map mit einem internen Test-Account. Der E2E-Test spielt den browser-worker selbst; ein echter browser-worker darf dabei nicht laufen. Details in [ADR 0029](docs/adr/0029-x-browser-freischaltung-und-kill-switch.md) bis [ADR 0032](docs/adr/0032-canary-und-circuit-breaker.md).

Datenexport und Löschung (Phase 8): Die Worker-Rolle `gdpr` (Standard in `.env.example`) braucht `DATABASE_SYSTEM_URL`, `APP_URL`, die S3-Einstellungen und `TOKEN_KEKS` (für den Widerruf der Grants einer gelöschten Organisation); mit `STRIPE_SECRET_KEY` löscht sie auch deren Stripe-Kunden. Ein Export landet unter `exports/` im Bucket der Medien und wird nach 24 Stunden gelöscht; für den Bucket ist eine Regel sinnvoll, die abgebrochene Multipart-Uploads nach einem Tag entfernt. Nach einer endgültigen Löschung prüft `pnpm check:erasure <requestId>` (nach `pnpm build`, mit `DATABASE_SYSTEM_URL` und den S3-Einstellungen) Datenbank und Objektspeicher. Details in [ADR 0036](docs/adr/0036-datenschutz-anfragen-und-datenexport.md) und [ADR 0037](docs/adr/0037-loeschung-von-organisationen.md).

Lasttest (Phase 8), auf einem eigenen Stack und nie in Produktion: Nach `pnpm build` schreibt `pnpm load:fixture --organizations 250 --due-posts 10 --due-in 7` Testdaten, deren 10.000 Varianten in derselben Minute fällig werden, und beschreibt sie in `tools/load/fixture.json`. API und Worker brauchen die Rollen `scheduler`, `publisher` und `analytics`, für die Abfragen der Metriken im Lauf `ANALYTICS_CADENCE_SCALE=3600`. Dann misst k6 2.3 mit den Variablen der `.env`: `READ_RATE=100 API_URL=http://localhost:3001 k6 run tools/load/publish-burst.ts`; mehrere Instanzen der API stehen mit Komma getrennt in `API_URL`. k6 endet mit Code 99, wenn ein Ziel verfehlt ist. Danach wertet `pnpm load:stats --cadence-scale 3600 --wait-metrics 720` den Lauf aus der Datenbank aus. Aufbau, Ergebnisse und Grenzen stehen in [ADR 0041](docs/adr/0041-lasttest.md).

Abrechnung (optional, Phase 7): Mit `STRIPE_SECRET_KEY` und `STRIPE_WEBHOOK_SECRET` bietet die API Checkout, Kundenportal und Tarifwechsel an; `pnpm stripe:sync` legt einmal Produkte, Preise und Meter an. Der Worker braucht dann die Rolle `billing` (mit `DATABASE_SYSTEM_URL` und `APP_URL`), der Webhook-Endpunkt ist `/api/webhooks/stripe`. Ohne Stripe startet jede neue Organisation eine Testphase von 14 Tagen und kann danach nur noch lesen. Lokal und im E2E-Test ersetzt ein Fake-Stripe die API: `STRIPE_SECRET_KEY=sk_test_e2e`, `STRIPE_WEBHOOK_SECRET=whsec_e2e`, `STRIPE_API_BASE=http://127.0.0.1:12111` und `billing` in `WORKER_ROLES`; der Billing-Test startet den Fake selbst, solange er läuft. Den Lauf gegen die Test Clocks von Stripe startet `STRIPE_TEST_CLOCK_SECRET_KEY=sk_test_... pnpm --filter @smp/worker test:integration -- stripe-test-clock`. Details in [ADR 0033](docs/adr/0033-tarife-abo-und-nur-lesen.md) bis [ADR 0035](docs/adr/0035-nutzungsabrechnung-und-durchsetzung-der-limits.md).

Sicherung (Phase 8): Das Compose-Profil `backup` startet mit `PG_ARCHIVE_MODE=on` die Base-Backups (`postgres-backup`) und die Kopie in den Bucket der Backups (`backup-sync`, lokal `smp-backups` in SeaweedFS); die Variablen stehen in `.env.example`. `pnpm backup:drill` (nach `pnpm build`, Docker Compose 2.36 oder neuer) übt den ganzen Ablauf in einem eigenen Projekt neben dem lokalen Stack, mit `DRILL_FILLER_MB=500` auch mit größeren Daten. Einrichtung, Überwachung und Wiederherstellung beschreibt das [Runbook](docs/runbooks/backup-restore.md), Entscheidungen und Messungen [ADR 0042](docs/adr/0042-backup-und-wiederherstellung.md).

Überwachung (Phase 8):

- **Ziele**: Prometheus im Profil `observability` fragt die API (`/metrics` auf `API_METRICS_PORT`, 9464, nicht über den Proxy), den Worker (`/metrics` auf seinem Health-Port) und das Pushgateway ab. API und Worker auf dem Host (`pnpm dev`) erreicht er mit `docker compose -f compose.yaml -f tools/observability/host-targets.compose.yaml --profile observability up -d prometheus alertmanager pushgateway`.
- **Alarme**: Alertmanager schickt sie an Mailpit.
- **Backups**: Sie melden sich mit `BACKUP_PUSHGATEWAY_URL=http://pushgateway:9091`.
- **Regeln**: Sie liegen unter `infra/observability/`. `pnpm check:alerts` prüft sie, in der CI als Job "Monitoring rules"; eine Änderung lädt `docker compose kill -s HUP prometheus`.
- **Proben**: Die Runbooks unter `docs/runbooks/` werden mit `pnpm drill` geübt ([Übersicht](docs/runbooks/alarme.md)).

Sicherheit: Die Baseline seit Phase 0 (CSP mit Nonce, Datenminimierung in Logs und Fehlerberichten, Gates gegen kompromittierte Pakete, Sicherheits-Scans in der CI, gehärtete Container und Datenbank-Rollen) steht in [ADR 0009](docs/adr/0009-sicherheits-baseline.md). `pnpm install` bricht ab, wenn ein Paket jünger als ein Tag ist, einen schwächeren Herkunftsnachweis hat als frühere Versionen oder ein nicht freigegebenes Install-Skript mitbringt. Seit dem Security-Review (Phase 8) melden sich API und Worker bei Redis als `app` mit `REDIS_APP_PASSWORD` an, der Nutzer `default` ist aus. In Produktion verlangt die API `PWNED_PASSWORDS_API_URL` (https, die Range-API von Have I Been Pwned oder ein Spiegel), und keine Anwendung startet mit Beispielwerten aus `.env.example`. `pnpm auth:revoke-sessions --user <email>` oder `--all` beendet Sessions; wie jedes Secret rotiert wird, steht im [Runbook](docs/runbooks/secret-rotation.md). `pnpm auth:reset-two-factor --user <email> --ticket <Ticket>` entfernt einen verlorenen zweiten Faktor, erst nach einem Passwort-Reset über den Link an die Adresse; `--check` zeigt vorher die Organisationen der Person ([Runbook](docs/runbooks/zweiter-faktor-verloren.md)). Grenzwerte und akzeptierte Abweichungen stehen in [ADR 0039](docs/adr/0039-security-review-und-haertung.md).

KI lokal: Ohne `ANTHROPIC_API_KEY` läuft der deterministische `MockAiProvider` (`AI_PROVIDER=mock`, Standard in `.env.example`). Marker im Briefing wie `[mock:refusal]`, `[mock:truncated]` oder `[mock:slow]` lösen die Fehlerpfade aus; die vollständige Liste steht im [Leitfaden, Schritt 2.5](docs/IMPLEMENTATION_GUIDE.md#25-mockaiprovider). In Produktion startet die App mit dem Mock nicht.

Spikes liegen unter `tools/spikes/` und laufen mit geladener `.env`, zum Beispiel `pnpm exec tsx tools/spikes/rls-overhead.ts`.

Solange ein Paket noch nicht existiert, meldet Turbo "No tasks were executed" und endet mit Exit-Code 0.

Turbo fragt beim ersten Lauf nach anonymer Telemetrie. Abschalten mit `TURBO_TELEMETRY_DISABLED=1`.

## Dokumentation

| Dokument                                                                         | Inhalt                                                                                    |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                                     | Architektur, Tech-Stack, Datenmodell, Plattform-Integration, Sicherheit, Roadmap, Risiken |
| [docs/IMPLEMENTATION_GUIDE.md](docs/IMPLEMENTATION_GUIDE.md)                     | Schritt-für-Schritt-Leitfaden: was erstellt wird, wie es aussieht, worauf zu achten ist   |
| [docs/security/](docs/security/)                                                 | Security-Review: ASVS-Checkliste, Pentest-Bericht und Inventare                           |
| [docs/runbooks/](docs/runbooks/)                                                 | Runbooks für den Betrieb mit der Übersicht der Alarme, etwa die Rotation der Secrets      |
| [docs/betrieb/plattformen-einrichten.md](docs/betrieb/plattformen-einrichten.md) | LinkedIn, Facebook, Instagram und X einrichten: Apps, Zugangsdaten, erster Testbeitrag    |
| [deploy/](deploy/)                                                               | Produktions-Vorlage: Compose für eine VM hinter Caddy, Skripte, Monitoring und Staging    |
| [CLAUDE.md](CLAUDE.md)                                                           | Arbeitsregeln für KI-Sitzungen in diesem Repository                                       |

## Tech-Stack (Kurzfassung)

TypeScript-Monorepo (pnpm + Turborepo) mit Next.js (Web), NestJS (API und Worker), PostgreSQL + Prisma, Redis + BullMQ, S3-kompatiblem Objektspeicher und Docker. Details stehen in der Architektur.
