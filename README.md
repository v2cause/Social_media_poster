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

Phase 4 (Kanäle, Publishing, Scheduling) ist bis auf die echten Plattform-Adapter umgesetzt: Token-Tresor mit Envelope-Verschlüsselung, Verbinden über OAuth mit Auswahl der Accounts, Adapter-Registry mit Mock-Plattformen und Contract-Suite, Planen mit lokalen Zeiten und Zeitzonen, Scheduler-Tick mit verpassten Zeitfenstern, Publish-Job mit Lease, Schreibmarke und Reconcile, Wiederholversuche und Dead-Letter-Queue, Token-Monitor mit Erinnerungen, Benachrichtigungen in der App und per E-Mail, Live-Events über SSE und im Web Accounts, Post-Tabelle, Planen-Leiste, Kalender mit Drag & Drop und das Dashboard mit den nächsten Posts ([ADR 0023](docs/adr/0023-planen-zeitzonen-und-zustandsautomat.md) bis [ADR 0026](docs/adr/0026-planen-im-web.md)). Offen sind die Adapter für LinkedIn, Meta und X (Schritte 4.12 bis 4.14): Sie brauchen die offizielle Doku der Plattformen, die aus der Entwicklungsumgebung gesperrt ist, echte Test-Accounts und Staging. Bis dahin laufen alle Plattformen über den Mock-Adapter. Bull Board für Plattform-Admins ist noch nicht eingerichtet.

Phase 5 (Analytics) ist für die Mock-Plattformen umgesetzt: Abfrage-Kaskade pro Post mit Batches und Sperren, tägliche Account-Zahlen, Rollup pro lokalem Tag der Workspace-Zone, sieben Analytics-Endpunkte mit Vorzeitraum, Redis-Cache und CSV-Export, im Web die Analytics-Seite mit barrierefreien SVG-Diagrammen, Detailseiten für Post und Account und die KPIs auf dem Dashboard, Demo-Daten über 90 Tage im Seed und Themenideen, die auf die besten Posts verweisen ([ADR 0027](docs/adr/0027-analytics-kaskade-rollup-und-api.md) und [ADR 0028](docs/adr/0028-analytics-im-web.md)). Offen sind die Mappings der echten Plattformen mit Tests auf echten Payloads, der Abgleich der Zahlen mit den Plattform-UIs auf Staging und der Eval-Lauf der neuen Prompt-Version mit der Claude API.

Phase 6 (X ohne API) ist hinter Feature-Flags umgesetzt: Freischaltung mit versionierter Risikobestätigung, der isolierte browser-worker mit Egress-Allowlist und eigener Redis-Rolle, Selector-Map und Flows für Posten, Metriken und Login, der interaktive Login mit Zwei-Faktor-Code, Kill-Switch, Circuit Breaker und täglicher Canary ([ADR 0029](docs/adr/0029-x-browser-freischaltung-und-kill-switch.md) bis [ADR 0032](docs/adr/0032-canary-und-circuit-breaker.md)). Offen sind die Prüfung von Selektoren, Antworten und Egress-Hosts gegen x.com, ein echter Login, ein interner Test-Account für den Canary und die rechtliche Freigabe des Risikotextes.

Phase 7 (Billing und Quoten) ist umgesetzt: Tarife mit Limits und Testphase, Stripe Checkout, Kundenportal und Tarifwechsel, Webhooks über die Worker-Rolle `billing`, die tägliche Meldung von KI-Mehrverbrauch und X-Kosten an die Stripe-Meter, die Limits an allen Stellen mit Nur-Lesen nach Zahlungsverzug oder Abo-Ende und die Abrechnungsseite mit Verbrauch, Tarifen und Rechnungen ([ADR 0033](docs/adr/0033-tarife-abo-und-nur-lesen.md) bis [ADR 0035](docs/adr/0035-nutzungsabrechnung-und-durchsetzung-der-limits.md)). Getestet ist alles gegen einen Fake-Stripe, der die Parameter gegen die OpenAPI-Spezifikation von Stripe prüft. Offen ist der Lauf gegen die Test Clocks des echten Stripe: Der Test liegt bereit, braucht aber einen Testschlüssel. Die Preise sind Platzhalter.

Phase 8 (Härtung, DSGVO, Betrieb) ist in Arbeit. Umgesetzt ist der Datenexport: Owner fordern auf der Seite "Daten und Löschung" einen Export an, die Worker-Rolle `gdpr` schreibt alle Tabellen der Organisation als JSON und die Originale der Medien als ZIP in den Objektspeicher, und nach der E-Mail lädt der Owner das Archiv 24 Stunden lang herunter ([ADR 0036](docs/adr/0036-datenschutz-anfragen-und-datenexport.md)).

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

Konfiguration: `.env.example` listet alle Variablen nach Gruppen, mit Hinweis auf die Pflichtwerte. Die lokale Infrastruktur (Postgres, Redis, S3-kompatibler Speicher, Mailpit) startet über `compose.yaml`. `.env.test` enthält nur Testwerte und wird committet; Integrationstests starten ihre Datenbanken selbst über Testcontainers.

| Befehl                  | Zweck                                                                                                            | Verfügbar ab |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------ |
| `pnpm dev`              | startet die Apps im Watch-Modus                                                                                  | Schritt 0.7  |
| `pnpm build`            | baut alle Packages und Apps (Turbo, mit Cache)                                                                   | Schritt 0.1  |
| `pnpm lint`             | ESLint über alle Packages                                                                                        | Schritt 0.2  |
| `pnpm typecheck`        | TypeScript-Prüfung ohne Ausgabe                                                                                  | Schritt 0.2  |
| `pnpm test`             | Unit-Tests (Vitest)                                                                                              | Schritt 0.2  |
| `pnpm test:integration` | Integrationstests mit Testcontainers (braucht Docker)                                                            | Schritt 0.5  |
| `pnpm test:e2e`         | End-to-End-Tests (Playwright)                                                                                    | Schritt 1.9  |
| `pnpm format`           | Prettier über das Repo schreiben                                                                                 | Schritt 0.2  |
| `pnpm db:migrate`       | Prisma-Migrationen als `app_migrator` anwenden                                                                   | Schritt 0.5  |
| `pnpm db:seed`          | Demo-Daten laden                                                                                                 | Schritt 1.1  |
| `pnpm stripe:sync`      | Produkte, Preise, Meter und Kundenportal in Stripe anlegen bzw. abgleichen (`STRIPE_SECRET_KEY`)                 | Schritt 7.2  |
| `pnpm eval:ai`          | KI-Eval-Suite mit Budget (`EVAL_BUDGET_MICROS`), `--dry-run` schätzt nur; Bericht mit Vergleich zum letzten Lauf | Schritt 2.10 |
| `pnpm gen:keys`         | 32-Byte-Schlüssel für Token und Sessions erzeugen                                                                | Schritt 0.4  |
| `pnpm check:deps`       | Architekturregeln mit dependency-cruiser prüfen                                                                  | Schritt 0.13 |
| `pnpm check:emoji`      | Emoji und unsichtbare Zeichen in verfolgten Dateien suchen; mit `--commits A..B` in Commit-Messages              | Schritt 0.13 |
| `pnpm check:format`     | Prettier-Prüfung über das Repo                                                                                   | Schritt 0.13 |
| `pnpm check:i18n`       | Übersetzungen prüfen: gleiche Keys und Argumente in de und en, gültiges ICU                                      | Schritt 1.10 |
| `pnpm check:rls`        | RLS und Policies aller Mandantentabellen in der lokalen Datenbank prüfen                                         | Schritt 1.2  |

E2E-Tests: `pnpm test:e2e` läuft gegen den gestarteten Stack, wie im CI-Job "End-to-end tests". Vorher die Infrastruktur starten (`docker compose up -d --wait`), migrieren und bauen, dann in drei Terminals API und Worker (`node --env-file=../../.env --require @smp/observability/register dist/main.js` in `apps/api` und `apps/worker`) sowie das Web (`pnpm --filter @smp/web start`). Der Test liest die Verifizierungs- und Einladungs-Mails über die Mailpit-API. Der Medien-Test lädt in den lokalen S3-Speicher hoch; der Worker braucht dafür die Rolle `media` (in `WORKER_ROLES`, Standard in `.env.example`). Ohne heruntergeladene Playwright-Browser zeigt `PLAYWRIGHT_CHROMIUM_EXECUTABLE` auf ein installiertes Chrome oder Chromium.

Container-Betrieb: `docker compose --profile app up -d --build --wait` startet API, Worker und Web, alle drei mit Healthcheck, dazu einen Reverse Proxy (Caddy). Die Container laufen mit `NODE_ENV=production`, wo der KI-Mock gesperrt ist (Schritt 2.5); `.env` braucht dafür `AI_PROVIDER=anthropic` und einen `ANTHROPIC_API_KEY`, sonst startet die API nicht. Die App ist dann unter `http://localhost:8080` erreichbar; der Proxy routet wie in Produktion `/api` an die API und alles andere an das Web. Das Profil `xb` startet den isolierten browser-worker, das Profil `observability` Grafana unter `http://localhost:3003`. Nach Änderungen an `infra/docker/postgres/init` einmal `docker compose down -v`, weil das Init-Skript nur auf einem leeren Volume läuft.

X ohne API (optional, Phase 6): `FEATURE_X_BROWSER_GLOBAL=true` bietet den Browser-Adapter an; API und browser-worker brauchen dann `SESSION_KEKS`, die Worker-Rolle `publisher` zusätzlich `DATABASE_SYSTEM_URL` und `APP_URL`. `docker compose --profile xb up -d` startet den browser-worker im internen Netz `xb` mit dem Egress-Proxy; Redis kennt ihn als Nutzer `browser-worker` mit `XB_REDIS_PASSWORD`. Ein Plattform-Admin schaltet unter `/admin` die Organisation frei, ein Owner oder Admin schaltet X ohne API in den Workspace-Einstellungen nach der Risikobestätigung ein, danach verbindet die Accounts-Seite X über den Login-Dialog. Drei Drifts der Selector-Map in einer Stunde schalten X ohne API für alle aus; den Kill-Switch hebt ein Plattform-Admin auf. Mit `XB_CANARY_ACCOUNT_ID` prüft ein täglicher Canary die Selector-Map mit einem internen Test-Account. Der E2E-Test spielt den browser-worker selbst; ein echter browser-worker darf dabei nicht laufen. Details in [ADR 0029](docs/adr/0029-x-browser-freischaltung-und-kill-switch.md) bis [ADR 0032](docs/adr/0032-canary-und-circuit-breaker.md).

Datenexport (Phase 8): Die Worker-Rolle `gdpr` (Standard in `.env.example`) braucht `DATABASE_SYSTEM_URL`, `APP_URL` und die S3-Einstellungen. Ein Export landet unter `exports/` im Bucket der Medien und wird nach 24 Stunden gelöscht; für den Bucket ist eine Regel sinnvoll, die abgebrochene Multipart-Uploads nach einem Tag entfernt. Details in [ADR 0036](docs/adr/0036-datenschutz-anfragen-und-datenexport.md).

Abrechnung (optional, Phase 7): Mit `STRIPE_SECRET_KEY` und `STRIPE_WEBHOOK_SECRET` bietet die API Checkout, Kundenportal und Tarifwechsel an; `pnpm stripe:sync` legt einmal Produkte, Preise und Meter an. Der Worker braucht dann die Rolle `billing` (mit `DATABASE_SYSTEM_URL` und `APP_URL`), der Webhook-Endpunkt ist `/api/webhooks/stripe`. Ohne Stripe startet jede neue Organisation eine Testphase von 14 Tagen und kann danach nur noch lesen. Lokal und im E2E-Test ersetzt ein Fake-Stripe die API: `STRIPE_SECRET_KEY=sk_test_e2e`, `STRIPE_WEBHOOK_SECRET=whsec_e2e`, `STRIPE_API_BASE=http://127.0.0.1:12111` und `billing` in `WORKER_ROLES`; der Billing-Test startet den Fake selbst, solange er läuft. Den Lauf gegen die Test Clocks von Stripe startet `STRIPE_TEST_CLOCK_SECRET_KEY=sk_test_... pnpm --filter @smp/worker test:integration -- stripe-test-clock`. Details in [ADR 0033](docs/adr/0033-tarife-abo-und-nur-lesen.md) bis [ADR 0035](docs/adr/0035-nutzungsabrechnung-und-durchsetzung-der-limits.md).

Sicherheit: Die Baseline seit Phase 0 (CSP mit Nonce, Datenminimierung in Logs und Fehlerberichten, Gates gegen kompromittierte Pakete, Sicherheits-Scans in der CI, gehärtete Container und Datenbank-Rollen) steht in [ADR 0009](docs/adr/0009-sicherheits-baseline.md). `pnpm install` bricht ab, wenn ein Paket jünger als ein Tag ist, einen schwächeren Herkunftsnachweis hat als frühere Versionen oder ein nicht freigegebenes Install-Skript mitbringt.

KI lokal: Ohne `ANTHROPIC_API_KEY` läuft der deterministische `MockAiProvider` (`AI_PROVIDER=mock`, Standard in `.env.example`). Marker im Briefing wie `[mock:refusal]`, `[mock:truncated]` oder `[mock:slow]` lösen die Fehlerpfade aus; die vollständige Liste steht im [Leitfaden, Schritt 2.5](docs/IMPLEMENTATION_GUIDE.md#25-mockaiprovider). In Produktion startet die App mit dem Mock nicht.

Spikes liegen unter `tools/spikes/` und laufen mit geladener `.env`, zum Beispiel `pnpm exec tsx tools/spikes/rls-overhead.ts`.

Solange ein Paket noch nicht existiert, meldet Turbo "No tasks were executed" und endet mit Exit-Code 0.

Turbo fragt beim ersten Lauf nach anonymer Telemetrie. Abschalten mit `TURBO_TELEMETRY_DISABLED=1`.

## Dokumentation

| Dokument                                                     | Inhalt                                                                                    |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                 | Architektur, Tech-Stack, Datenmodell, Plattform-Integration, Sicherheit, Roadmap, Risiken |
| [docs/IMPLEMENTATION_GUIDE.md](docs/IMPLEMENTATION_GUIDE.md) | Schritt-für-Schritt-Leitfaden: was erstellt wird, wie es aussieht, worauf zu achten ist   |
| [CLAUDE.md](CLAUDE.md)                                       | Arbeitsregeln für KI-Sitzungen in diesem Repository                                       |

## Tech-Stack (Kurzfassung)

TypeScript-Monorepo (pnpm + Turborepo) mit Next.js (Web), NestJS (API und Worker), PostgreSQL + Prisma, Redis + BullMQ, S3-kompatiblem Objektspeicher und Docker. Details stehen in der Architektur.
