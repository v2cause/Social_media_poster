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

Die Planung ist abgeschlossen. Die Umsetzung läuft nach dem Leitfaden; aktuell ist Phase 0 (Fundament) in Arbeit.

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

| Befehl                  | Zweck                                                 | Verfügbar ab |
| ----------------------- | ----------------------------------------------------- | ------------ |
| `pnpm dev`              | startet die Apps im Watch-Modus                       | Schritt 0.7  |
| `pnpm build`            | baut alle Packages und Apps (Turbo, mit Cache)        | Schritt 0.1  |
| `pnpm lint`             | ESLint über alle Packages                             | Schritt 0.2  |
| `pnpm typecheck`        | TypeScript-Prüfung ohne Ausgabe                       | Schritt 0.2  |
| `pnpm test`             | Unit-Tests (Vitest)                                   | Schritt 0.2  |
| `pnpm test:integration` | Integrationstests mit Testcontainers (braucht Docker) | Schritt 0.5  |
| `pnpm test:e2e`         | End-to-End-Tests (Playwright)                         | Schritt 1.9  |
| `pnpm format`           | Prettier über das Repo schreiben                      | Schritt 0.2  |
| `pnpm db:migrate`       | Prisma-Migrationen als `app_migrator` anwenden        | Schritt 0.5  |
| `pnpm db:seed`          | Demo-Daten laden                                      | Schritt 1.1  |
| `pnpm gen:keys`         | 32-Byte-Schlüssel für Token und Sessions erzeugen     | Schritt 0.4  |

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
