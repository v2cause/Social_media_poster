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

Die Planung ist abgeschlossen. Phase 0 (Fundament) ist weitgehend umgesetzt: die Schritte 0.1 bis 0.14 sind gebaut, drei der fünf Spikes sind mit Messung bestanden. Offen sind der Spike zur KI-Anbindung (0.14a, braucht einen API-Schlüssel), der Spike zur Authentifizierung (0.14d, folgt mit Schritt 1.4) und das Größenziel der Images (siehe [ADR 0001](docs/adr/0001-monorepo-und-stack.md)). Architekturentscheidungen stehen in [docs/adr/](docs/adr/).

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
pnpm build
```

Konfiguration: `.env.example` listet alle Variablen nach Gruppen, mit Hinweis auf die Pflichtwerte. Die lokale Infrastruktur (Postgres, Redis, S3-kompatibler Speicher, Mailpit) startet über `compose.yaml`. `.env.test` enthält nur Testwerte und wird committet; Integrationstests starten ihre Datenbanken selbst über Testcontainers.

| Befehl                  | Zweck                                                                       | Verfügbar ab |
| ----------------------- | --------------------------------------------------------------------------- | ------------ |
| `pnpm dev`              | startet die Apps im Watch-Modus                                             | Schritt 0.7  |
| `pnpm build`            | baut alle Packages und Apps (Turbo, mit Cache)                              | Schritt 0.1  |
| `pnpm lint`             | ESLint über alle Packages                                                   | Schritt 0.2  |
| `pnpm typecheck`        | TypeScript-Prüfung ohne Ausgabe                                             | Schritt 0.2  |
| `pnpm test`             | Unit-Tests (Vitest)                                                         | Schritt 0.2  |
| `pnpm test:integration` | Integrationstests mit Testcontainers (braucht Docker)                       | Schritt 0.5  |
| `pnpm test:e2e`         | End-to-End-Tests (Playwright)                                               | Schritt 1.9  |
| `pnpm format`           | Prettier über das Repo schreiben                                            | Schritt 0.2  |
| `pnpm db:migrate`       | Prisma-Migrationen als `app_migrator` anwenden                              | Schritt 0.5  |
| `pnpm db:seed`          | Demo-Daten laden                                                            | Schritt 1.1  |
| `pnpm gen:keys`         | 32-Byte-Schlüssel für Token und Sessions erzeugen                           | Schritt 0.4  |
| `pnpm check:deps`       | Architekturregeln mit dependency-cruiser prüfen                             | Schritt 0.13 |
| `pnpm check:emoji`      | Emoji in verfolgten Dateien suchen; mit `--commits A..B` in Commit-Messages | Schritt 0.13 |
| `pnpm check:format`     | Prettier-Prüfung über das Repo                                              | Schritt 0.13 |

Container-Betrieb: `docker compose --profile app up -d --build --wait` startet API, Worker und Web, alle drei mit Healthcheck, dazu einen Reverse Proxy (Caddy). Die App ist dann unter `http://localhost:8080` erreichbar; der Proxy routet wie in Produktion `/api` an die API und alles andere an das Web. Das Profil `xb` startet den isolierten browser-worker, das Profil `observability` Grafana unter `http://localhost:3003`. Nach Änderungen an `infra/docker/postgres/init` einmal `docker compose down -v`, weil das Init-Skript nur auf einem leeren Volume läuft.

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
