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

Phase 3 (Medien) ist umgesetzt: Uploads direkt in den Objektspeicher mit Speicher-Quote, Prüfung und Neukodierung im Worker (Magic Bytes, sharp mit Pixel-Limit, ohne EXIF und GPS), Thumbnails, Renditions pro Plattform mit Zuschnitt oder weißen Rändern, Alt-Text-Vorschläge der KI, die Medienbibliothek und im Composer Medien pro Variante mit Reihenfolge, Zuschnitt und Vorschau ([ADR 0019](docs/adr/0019-medien-upload-und-verarbeitung.md) bis [ADR 0022](docs/adr/0022-medien-im-web.md)). Einige Plattform-Limits (Facebook, LinkedIn) sind noch nicht an der offiziellen Doku bestätigt; das geschieht in den Adapter-Phasen ([ADR 0020](docs/adr/0020-renditions-und-zuschnitt.md)). Als Nächstes folgt Phase 4 (Kanäle, Publishing, Scheduling).

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
pnpm db:seed       # optional: Demo-Organisation mit vier Rollen
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
| `pnpm eval:ai`          | KI-Eval-Suite mit Budget (`EVAL_BUDGET_MICROS`), `--dry-run` schätzt nur; Bericht mit Vergleich zum letzten Lauf | Schritt 2.10 |
| `pnpm gen:keys`         | 32-Byte-Schlüssel für Token und Sessions erzeugen                                                                | Schritt 0.4  |
| `pnpm check:deps`       | Architekturregeln mit dependency-cruiser prüfen                                                                  | Schritt 0.13 |
| `pnpm check:emoji`      | Emoji und unsichtbare Zeichen in verfolgten Dateien suchen; mit `--commits A..B` in Commit-Messages              | Schritt 0.13 |
| `pnpm check:format`     | Prettier-Prüfung über das Repo                                                                                   | Schritt 0.13 |
| `pnpm check:i18n`       | Übersetzungen prüfen: gleiche Keys und Argumente in de und en, gültiges ICU                                      | Schritt 1.10 |
| `pnpm check:rls`        | RLS und Policies aller Mandantentabellen in der lokalen Datenbank prüfen                                         | Schritt 1.2  |

E2E-Tests: `pnpm test:e2e` läuft gegen den gestarteten Stack, wie im CI-Job "End-to-end tests". Vorher die Infrastruktur starten (`docker compose up -d --wait`), migrieren und bauen, dann in drei Terminals API und Worker (`node --env-file=../../.env --require @smp/observability/register dist/main.js` in `apps/api` und `apps/worker`) sowie das Web (`pnpm --filter @smp/web start`). Der Test liest die Verifizierungs- und Einladungs-Mails über die Mailpit-API. Der Medien-Test lädt in den lokalen S3-Speicher hoch; der Worker braucht dafür die Rolle `media` (in `WORKER_ROLES`, Standard in `.env.example`). Ohne heruntergeladene Playwright-Browser zeigt `PLAYWRIGHT_CHROMIUM_EXECUTABLE` auf ein installiertes Chrome oder Chromium.

Container-Betrieb: `docker compose --profile app up -d --build --wait` startet API, Worker und Web, alle drei mit Healthcheck, dazu einen Reverse Proxy (Caddy). Die App ist dann unter `http://localhost:8080` erreichbar; der Proxy routet wie in Produktion `/api` an die API und alles andere an das Web. Das Profil `xb` startet den isolierten browser-worker, das Profil `observability` Grafana unter `http://localhost:3003`. Nach Änderungen an `infra/docker/postgres/init` einmal `docker compose down -v`, weil das Init-Skript nur auf einem leeren Volume läuft.

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
