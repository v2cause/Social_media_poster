# CLAUDE.md

Arbeitsregeln für KI-Sitzungen in diesem Repository.

## Projekt

Social Media Poster: KI-gestützte Content-Plattform (Multi-Tenant SaaS) für LinkedIn, Instagram, Facebook und X.

- Architektur und Entscheidungen: `docs/ARCHITECTURE.md`
- Umsetzung Schritt für Schritt: `docs/IMPLEMENTATION_GUIDE.md`

## Vorgehen

1. Arbeite den Leitfaden `docs/IMPLEMENTATION_GUIDE.md` der Reihe nach ab. Innerhalb einer Phase ist die Reihenfolge der Schritte verbindlich.
2. Lies vor jedem Schritt dessen Abschnitte "Erstellen", "So sieht es aus", "Darauf achten" und "Fertig, wenn" sowie die verlinkten Stellen in `docs/ARCHITECTURE.md`.
3. Ein Schritt ist erst fertig, wenn sein Kriterium "Fertig, wenn" erfüllt ist und die Definition of Done gilt: lint, typecheck und Tests grün; `.env.example` aktualisiert; i18n-Keys in de und en; Doku/ADR angepasst; kein `TODO` ohne Issue-Verweis.
4. Weicht die Umsetzung von der Architektur ab, wird die Entscheidung als ADR in `docs/adr/` festgehalten und `docs/ARCHITECTURE.md` angepasst.
5. Details, die im Leitfaden mit "gegen die Doku prüfen" markiert sind, vor der Umsetzung an der offiziellen Dokumentation verifizieren.

## Konventionen (Kurzfassung von Abschnitt B.1 des Leitfadens)

- **Keine Emojis**: nicht in Code, Kommentaren, Commit-Messages, Logs, Fehlermeldungen, UI-Texten oder Doku.
- **Sprache**: Code, Bezeichner, Commit-Messages und Code-Kommentare auf Englisch. UI-Texte nur über i18n-Keys (de und en). Projektdoku auf Deutsch.
- **Commits**: Conventional Commits (`feat(publishing): add scheduler tick`), klein, ein Thema pro Commit, jeder Commit baut und hat grüne Tests.
- **Mandantentrennung**: Jede Repository-Methode bekommt `workspaceId` bzw. `organizationId` explizit. Die Laufzeit-DB-Rolle ist `app_user` (mit RLS), nie der Tabellen-Owner.
- **Validierung**: Alle externen Eingaben (HTTP, Jobs, Env, Adapter-Antworten, KI-Ausgaben) mit zod validieren.
- **Secrets**: Nie in Logs, Fehlermeldungen, `NEXT_PUBLIC_*`-Variablen oder Audit-Metadaten.
- **Zeit**: Backend und DB in UTC; Domain-Code nutzt den `Clock`-Port statt `new Date()`.
- **Imports**: Nur über Package-Einstiegspunkte (`@smp/<name>`), keine Deep-Imports, keine Zyklen.

## Befehle

Definiert in der Root-`package.json`, erklärt in der [README](README.md#entwicklung). Die Befehle `pnpm dev`, `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, `pnpm test:e2e`, `pnpm db:migrate` und `pnpm db:seed` sind verdrahtet, greifen aber erst, sobald die Pakete aus den jeweiligen Schritten des Leitfadens existieren.
