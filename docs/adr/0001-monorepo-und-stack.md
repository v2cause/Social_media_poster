# ADR 0001: Monorepo und Stack

- **Status**: Akzeptiert
- **Datum**: 2026-10-15
- **Bezug**: Umsetzungsleitfaden, Schritt 0.1 bis 0.14 (Spike c); `docs/ARCHITECTURE.md`, Abschnitt 1

## Kontext

Die Architektur legt den Stack fest: pnpm und Turborepo, Next.js, NestJS, Prisma, BullMQ, zod und Vitest. Beim Start der Umsetzung war eine Reihe der Versionen neuer als das, was die Architektur voraussetzt. Dieses ADR hält fest, welche Versionen gewählt wurden und warum.

## Entscheidung

| Bereich | Gewählt | Begründung |
|---|---|---|
| Paketmanager, Build | pnpm 10.34, Turborepo 2.11, Node 24 (`.nvmrc`, `engines`) | Architektur, Abschnitt 1 |
| Sprache | TypeScript 5.9 | typescript-eslint 8 unterstützt TypeScript bis unter 6.1. Die native TypeScript-7-Linie ist dafür nicht freigegeben. |
| API | NestJS 11.2 mit Express 5 | Architektur verlangt NestJS 11. Die Version 12 ist noch nicht übernommen. |
| Web | Next.js 16.4, React 19.3, next-intl 4.14, Tailwind 4.3 | Architektur, Abschnitt 1 |
| Datenbank | Prisma 7.10 mit `@prisma/adapter-pg`, PostgreSQL 17.11 | Architektur, Abschnitt 1 |
| Jobs | BullMQ 5.81, ioredis 5.11, Redis 7.4.11 | Architektur, Abschnitt 1. BullMQ 6 existiert, wird aber erst nach einem eigenen Entscheid übernommen. |
| Validierung | zod 4 mit nestjs-zod 5.5 und `z.toJSONSchema` | Architektur, Abschnitt 1 |
| Tests und Lint | Vitest 5, ESLint 10, typescript-eslint 8.71 | Architektur, Abschnitt 1 |
| Storage | AWS SDK v3, SeaweedFS 4.48 lokal | ADR 0008 |

## Spike (c): zod 4, nestjs-zod, OpenAPI und Orval

**Ergebnis**: bestanden. Die API liefert ihre OpenAPI-Beschreibung unter `/api/docs-json` (OpenAPI 3.0). Orval 8.43 erzeugt daraus TanStack-Query-Hooks (`react-query`, `fetch`). Der erzeugte Code kompiliert unter `strict`, `noUncheckedIndexedAccess` und `noImplicitOverride` ohne Fehler. Das Skript liegt in `tools/spikes/orval/`.

**Ausweichlösung**: Käme ein Generator-Fehler bei einer späteren Route, wird der Client für diese Route von Hand geschrieben. Der Vertrag bleibt das zod-Schema in `packages/contracts`.

## Alternativen

- **NestJS 12** (neueste Linie): verworfen, weil die Architektur 11 festlegt und Plugins wie nestjs-pino und Terminus für 11 getestet sind.
- **TypeScript 7** (nativ): verworfen, solange typescript-eslint es nicht unterstützt.

## Konsequenzen

- Vitest-Konfigurationen heißen `*.mts`. Vite lädt sie sonst als CommonJS und bricht ab.
- `components.json` für shadcn/ui ist von Hand geschrieben. Die Registry war aus dieser Umgebung nicht erreichbar, daher lief `shadcn init` nicht.
- Die Images für API und Worker sind rund 726 MB groß. Das Ziel unter 300 MB ist damit nicht erreicht. Die Hauptposten sind Prisma-Client mit Treiber-Wasm (rund 73 MB), Sentry (rund 67 MB) und OpenTelemetry (rund 33 MB) sowie der Basis-Image `node:24-slim`. Offene Entscheidung: Alpine als Basis, Sentry durch OpenTelemetry-Fehlerberichte ersetzen oder die Auto-Instrumentierungen eingrenzen. Die Zahlen stammen aus `pnpm deploy --legacy --prod --config.auto-install-peers=false`. Seit Schritt 8.4 ist die Basis `node:24.21.0-trixie-slim` (Debian 13) ohne npm, corepack und yarn; `docker image ls` zeigt dann rund 910 MB für die API und 830 MB für den Worker.
