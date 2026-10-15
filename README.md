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

Die Planung ist abgeschlossen. Die Umsetzung beginnt mit Phase 0 (Fundament).

## Dokumentation

| Dokument | Inhalt |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Architektur, Tech-Stack, Datenmodell, Plattform-Integration, Sicherheit, Roadmap, Risiken |
| [docs/IMPLEMENTATION_GUIDE.md](docs/IMPLEMENTATION_GUIDE.md) | Schritt-für-Schritt-Leitfaden: was erstellt wird, wie es aussieht, worauf zu achten ist |
| [CLAUDE.md](CLAUDE.md) | Arbeitsregeln für KI-Sitzungen in diesem Repository |

## Tech-Stack (Kurzfassung)

TypeScript-Monorepo (pnpm + Turborepo) mit Next.js (Web), NestJS (API und Worker), PostgreSQL + Prisma, Redis + BullMQ, S3-kompatiblem Objektspeicher und Docker. Details stehen in der Architektur.
