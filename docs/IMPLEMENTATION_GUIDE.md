# Umsetzungsleitfaden: Social Media Poster

Granularer Schritt-für-Schritt-Leitfaden: was erstellt wird, wie es aussieht und worauf zu achten ist.

Verweise auf "Teil A" beziehen sich auf [`ARCHITECTURE.md`](./ARCHITECTURE.md), z.B. meint "Teil A, Abschnitt 7" dort den Abschnitt 7.

## B.0 So ist der Leitfaden zu lesen

Jeder Schritt hat dieselbe Struktur:
- **Erstellen**: welche Dateien, Module oder Tabellen entstehen (Pfade relativ zum Repo-Root)
- **So sieht es aus**: Inhalt, Form, Schnittstellen, UI-Aufbau
- **Darauf achten**: typische Fehler, Sicherheits- und Betriebsfallen
- **Fertig, wenn**: überprüfbares Abnahmekriterium

Die Schritte sind nummeriert (`Phase.Schritt`). Innerhalb einer Phase ist die Reihenfolge verbindlich. Jeder Schritt endet mit mindestens einem Commit, der für sich baut und dessen Tests grün sind. Code-Ausschnitte zeigen die Form, keine fertige Implementierung. Wo "gegen die Doku prüfen" steht, ist das Detail aus Sekundärquellen und wird im jeweiligen Schritt verifiziert.

---

## B.1 Projektweite Konventionen (gelten für jeden Schritt)

| Thema | Regel |
|---|---|
| Sprache | Code, Bezeichner, Commit-Messages und Code-Kommentare auf Englisch. UI-Texte ausschließlich über i18n-Keys (de + en). Projektdoku auf Deutsch. |
| Emojis | **Keine Emojis** in Code, Kommentaren, Commits, Logs, Fehlermeldungen, UI-Texten oder Doku. Die CI erzwingt das per Skript (Schritt 0.13). Ausnahme ist nur der von der KI generierte Post-Inhalt, gesteuert über die Emoji-Politik der Brand Voice; das sind Nutzdaten, kein Code. |
| Namen | npm-Scope `@smp/*`. Dateien in kebab-case, Klassen in PascalCase, Funktionen und Variablen in camelCase. DB-Tabellen und -Spalten in snake_case (Prisma `@@map`/`@map`). Env-Variablen in SCREAMING_SNAKE_CASE. |
| Imports | Nur über Package-Einstiegspunkte (`@smp/core`), nie Deep-Imports (`@smp/core/src/...`); ESLint `no-restricted-imports` erzwingt das. Keine Zyklen (dependency-cruiser). |
| Fehler | Domain-Fehler sind Klassen mit stabilem `code`. Die API liefert RFC 9457 Problem Details `{ type, title, status, code, detail, traceId }`, nie Stacktraces. Die UI übersetzt den `code`. |
| Logging | Strukturiert und eventartig: `logger.info({ variantId }, 'publish.started')`. Keine PII, keine Secrets, kein `console.log`. |
| Zeit | Im Backend und in der DB immer UTC. In Domain und Use Cases kein `new Date()`, sondern der `Clock`-Port (testbar). |
| IDs | UUID v7, in der App erzeugt (Package `uuidv7`) oder als DB-Default. |
| Validierung | Jede externe Eingabe wird mit zod validiert: HTTP, Jobs, Env, Adapter-Antworten, KI-Ausgaben. |
| Mandanten | Jede Repository-Methode bekommt `workspaceId` bzw. `organizationId` explizit übergeben. |
| Tests | Jeder Use Case hat Unit-Tests. Jeder Bugfix bekommt einen Regressionstest. |
| Commits | Conventional Commits (`feat(publishing): add scheduler tick`), klein, ein Thema pro Commit; die CI prüft das per commitlint (Schritt 0.13). |
| Definition of Done | lint, typecheck und Tests grün; `.env.example` aktualisiert; i18n-Keys in de und en; Doku/ADR angepasst; kein `TODO` ohne Issue-Verweis. |

---

## B.2 Phase 0: Fundament

#### 0.1 Root-Repository
- **Erstellen**: `.gitignore`, `.gitattributes`, `.editorconfig`, `.nvmrc`, `.npmrc`, `package.json`, `pnpm-workspace.yaml`, `turbo.json`. `README.md` und `CLAUDE.md` existieren bereits und werden um die Entwickler-Befehle ergänzt.
- **So sieht es aus**:
  ```jsonc
  // package.json
  { "name": "social-media-poster", "private": true,
    "packageManager": "pnpm@10.<exakte Version>", "engines": { "node": ">=24" },
    "scripts": { "dev": "turbo run dev", "build": "turbo run build", "lint": "turbo run lint",
      "typecheck": "turbo run typecheck", "test": "turbo run test",
      "test:integration": "turbo run test:integration", "test:e2e": "turbo run test:e2e",
      "db:migrate": "pnpm --filter @smp/db migrate:dev", "db:seed": "pnpm --filter @smp/db seed",
      "format": "prettier --write .", "gen:keys": "tsx tools/gen-keys.ts" } }
  ```
  ```yaml
  # pnpm-workspace.yaml
  packages: ["apps/*", "packages/*"]
  minimumReleaseAge: 1440          # Versionen erst nach einem Tag (Lieferkette, ADR 0009)
  trustPolicy: no-downgrade        # Abbruch bei schwächerem Herkunftsnachweis
  blockExoticSubdeps: true
  strictDepBuilds: true            # jedes Install-Skript braucht eine Entscheidung in allowBuilds
  allowBuilds: { sharp: true, prisma: true, "@prisma/engines": true, esbuild: true, "@swc/core": true, unrs-resolver: true }
  ```
  `turbo.json` definiert die Tasks: `build` (`dependsOn: ["^build"]`, outputs `dist/**`, `.next/**`), `dev` (`persistent: true`, `cache: false`), `lint`, `typecheck`, `test` und `test:integration` (alle mit `dependsOn: ["^build"]`, weil die Pakete sich über ihre `dist`-Ausgabe auflösen), `test:e2e`.
- **Darauf achten**:
  - pnpm 10 führt Install-Skripte nur für Pakete aus, die in `allowBuilds` freigegeben sind (`onlyBuiltDependencies` ist veraltet). Mit `strictDepBuilds` bricht die Installation bei jedem nicht entschiedenen Skript ab, statt nur zu warnen.
  - `packageManager` trägt den sha512 von pnpm (`pnpm@10.x.y+sha512.…`); Corepack prüft ihn beim Download.
  - Jedes Paket deklariert die Werkzeuge seiner Skripte selbst (`eslint`, `typescript`, `vitest`, ...). pnpm verlinkt nur deklarierte Abhängigkeiten nach `node_modules/.bin`; ein global installiertes Werkzeug lässt Skripte lokal laufen, die in der CI scheitern.
  - Turbo 2 läuft standardmäßig im Strict-Env-Modus: Tasks sehen nur Variablen, die in `turbo.json` unter `globalEnv`/`env` (zählen zum Cache-Hash) oder `globalPassThroughEnv`/`passThroughEnv` stehen. Fehlt z.B. `DATABASE_URL` dort, ist sie in `test:integration` leer.
  - Die pnpm-Version wird exakt gepinnt (Corepack).
  - `.gitignore` deckt `.env*` (außer `.env.example`), `dist`, `.next`, `.turbo`, `node_modules`, `coverage`, `playwright-report`, `test-results` und `**/src/generated` ab.
- **Fertig, wenn**: `pnpm install` auf einem frischen Clone ohne Warnungen läuft und `pnpm build` grün ist.

#### 0.2 Gemeinsame Konfiguration (`packages/config`)
- **Erstellen**: `tsconfig.base.json`, `tsconfig.nest.json`, `tsconfig.next.json`, `tsconfig.lib.json`, `eslint.config.js` (exportiert eine Factory), `prettier.config.js`, `vitest.base.ts`.
- **So sieht es aus**:
  - `tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `isolatedModules`, `skipLibCheck`, `target: ES2023`.
  - `tsconfig.nest.json`: zusätzlich `experimentalDecorators`, `emitDecoratorMetadata`, `module`/`moduleResolution: nodenext` (Ausgabe CommonJS, weil die Apps kein `"type": "module"` haben).
  - ESLint (Flat Config): typescript-eslint (type-checked), Regeln `no-floating-promises`, `consistent-type-imports`, `no-misused-promises`, `import-x/no-cycle`, `no-console`, `no-restricted-imports` (Deep-Imports); für Web zusätzlich `@next/eslint-plugin-next` und `react-hooks`.
  - Vitest-Basis: `environment: 'node'`, Coverage mit `v8`. Für Nest-Packages kommt das Plugin `unplugin-swc` dazu (Decorator-Metadaten).
- **Package-Typen** (verbindlich, als ADR 0002 festgehalten):

| Typ | Packages | Build |
|---|---|---|
| Nur Backend | core, db, queue, crypto, ai, media, platform-adapters, x-browser, observability, emails, testing | `tsup`, Format CJS, `.d.ts` |
| Geteilt (Backend + Web) | contracts, platform-rules | `tsup`, Format ESM + CJS, `exports` mit `import`/`require`/`types` |
| Nur Web | ui, api-client | kein Build; `exports` zeigen auf `src/index.ts`, Next.js transpiliert sie (`transpilePackages`) |
| Konfiguration | config | reines JS/JSON |

- **Darauf achten**:
  - `verbatimModuleSyntax` **nicht** für die Nest-Apps aktivieren, weil es mit CJS-Ausgabe kollidiert. Stattdessen sorgt die Lint-Regel `consistent-type-imports` für saubere Type-Imports.
  - Reine ESM-Abhängigkeiten (z.B. `file-type`) lädt die CJS-Ausgabe über `require(esm)` von Node 24; TypeScript erlaubt das ab 5.8 mit `module: nodenext`. Pakete mit Top-Level-`await` lassen sich so nicht laden; das prüft ADR 0002.
  - `packages/core` darf keine Decorators und keine Framework-Imports enthalten.
- **Fertig, wenn**: `pnpm lint` und `pnpm typecheck` in allen (noch leeren) Packages laufen.

#### 0.3 Lokale Infrastruktur (`compose.yaml`)
- **Erstellen**: `compose.yaml` (Root), `infra/docker/postgres/init/01-roles.sql`, `infra/docker/seaweedfs/s3.json` (Zugangsdaten), Service `s3-init` für Bucket und CORS.
- **So sieht es aus**:

| Service | Image (exakte Tags pinnen) | Wichtig |
|---|---|---|
| postgres | `postgres:17.x-alpine` | Healthcheck `pg_isready`; das Init-SQL legt die Rollen `app_migrator` (Owner), `app_user` (NOBYPASSRLS) und `app_system` (BYPASSRLS) sowie die Datenbanken `smp` und `smp_test` an |
| redis | `redis:7.4.x-alpine` | `redis-server --appendonly yes --maxmemory-policy noeviction`; Healthcheck `redis-cli ping` |
| s3 | `chrislusf/seaweedfs:<Version>` | `server -s3 -s3.config=/etc/seaweedfs/s3.json`, Port 8333 |
| s3-init | `amazon/aws-cli:<Version>` | einmalig: `s3 mb s3://smp-media`, CORS für `http://localhost:3000` und `http://localhost:8080` (PUT, GET, HEAD; Header `Content-Type`) |
| mailpit | `axllent/mailpit:<Version>` | SMTP 1025, UI 8025 |
| Profil `app` | api, worker, web aus den eigenen Dockerfiles, dazu `proxy` (`caddy:<Version>`, `infra/docker/caddy/Caddyfile`) | `depends_on` mit `condition: service_healthy`; der Proxy routet wie in Produktion `/api/*` an die API und alles andere an das Web, erreichbar unter `http://localhost:8080`; alle vier mit `no-new-privileges`, ohne Capabilities und mit schreibgeschütztem Root-Dateisystem (tmpfs nur, wo geschrieben wird) |
| Profil `xb` | browser-worker | `shm_size: 1gb`, `init: true` |
| Profil `observability` | `grafana/otel-lgtm:<Version>` | OTLP-Collector + Grafana in einem Container; Grafana auf Host-Port 3003, weil 3001 der API gehört |
| Profil `clamav` | `clamav/clamav:<Version>` | optionaler Virenscan |

- **Darauf achten**:
  - Nie `latest` verwenden.
  - Ports nur an `127.0.0.1` binden. Benannte Volumes nutzen.
  - `noeviction` ist Pflicht für BullMQ: Ohne sie kann Redis Job-Daten löschen.
  - Das Init-SQL entzieht `PUBLIC` das Verbindungsrecht auf alle Datenbanken (die Laufzeitrollen erreichen nur `smp` und `smp_test`) und setzt `statement_timeout` und `idle_in_transaction_session_timeout` für `app_user` und `app_system`.
  - Unterstützt der lokale S3-Server keine Bucket-CORS-API, läuft der Upload lokal same-origin über den Proxy-Pfad `/storage/*`. Das prüft der Spike 0.14(e).
- **Fertig, wenn**: `docker compose up -d` alle Dienste auf "healthy" bringt, `psql` als `app_user` funktioniert, der Bucket existiert und die Mailpit-UI erreichbar ist.

#### 0.4 Konfiguration und Secrets
- **Erstellen**: `.env.example` (kommentiert, nach Gruppen sortiert), pro App `src/config/env.schema.ts` (zod), pro Adapter-Package ein exportiertes Env-Teilschema (z.B. `@smp/db` exportiert `dbEnvSchema`), `tools/gen-keys.ts`.
- **So sieht es aus** (Gruppen in `.env.example`):
  - **App**: `NODE_ENV`, `APP_URL`, `API_PORT`, `API_INTERNAL_URL`, `LOG_LEVEL`
  - **DB**: `DATABASE_URL` (app_user), `DATABASE_SYSTEM_URL` (app_system), `MIGRATION_DATABASE_URL` (app_migrator)
  - **Redis, S3, Mail**: `REDIS_URL`; `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`, `PUBLIC_MEDIA_BASE_URL`; `SMTP_URL`, `MAIL_FROM`
  - **Auth und Verschlüsselung**: `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`; `TOKEN_KEKS`, `TOKEN_KEK_ACTIVE`, `SESSION_KEKS`, `SESSION_KEK_ACTIVE`
  - **KI**: `AI_PROVIDER`, `ANTHROPIC_API_KEY`, `AI_MODEL`, `AI_EFFORT_GENERATE`, `AI_EFFORT_REFINE`, `AI_EFFORT_IDEAS`, `AI_EFFORT_ALT_TEXT`, `AI_REFUSAL_FALLBACK`, `AI_MONTHLY_CAP_MICROS`
  - **Plattformen**:
    - Modus und Dry-Run: `PLATFORM_MODE_LINKEDIN`, `PLATFORM_MODE_META`, `PLATFORM_MODE_X` (mock oder live), `PUBLISH_DRY_RUN`
    - LinkedIn: `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_CM_CLIENT_ID`, `LINKEDIN_CM_CLIENT_SECRET`, `LINKEDIN_VERSION`
    - Meta: `META_APP_ID`, `META_APP_SECRET`, `META_GRAPH_VERSION`, `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`
    - X: `X_CLIENT_ID`, `X_CLIENT_SECRET`
  - **Worker**: `WORKER_ROLES`, `SCHEDULER_TICK_MS`, `ANALYTICS_CADENCE_SCALE`, `FEATURE_X_BROWSER_GLOBAL`
  - **Billing und Betrieb**: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SENTRY_DSN`, `OTEL_EXPORTER_OTLP_ENDPOINT`
- **Darauf achten**:
  - Bei ungültiger Konfiguration bricht der Start mit einer lesbaren Fehlermeldung ab, ohne Werte auszugeben.
  - Secrets nie mit dem Präfix `NEXT_PUBLIC_`; das Web bekommt nur öffentliche Werte.
  - Für Tests gibt es eine eigene `.env.test`.
  - Es gibt genau eine `.env` im Repo-Root, und weder pnpm noch Turbo laden sie. Die `dev`-Skripte der Nest-Apps starten Node mit `--env-file-if-exists=../../.env` (`nest start --watch --exec "node --env-file-if-exists=../../.env --require @smp/observability/register"`), `prisma.config.ts` lädt sie per `dotenv` (siehe 0.5), und Next.js liest nur `apps/web/.env*`, bekommt die Werte also per `loadEnvConfig` aus `@next/env` in `next.config.ts`. Dort muss `forceReload` gesetzt sein: Next.js hat die Umgebung des App-Verzeichnisses beim Laden der Konfiguration schon im Cache, und ohne `forceReload` liefert der Aufruf nur diesen Cache zurück. Bereits gesetzte Variablen haben jeweils Vorrang. In Containern kommen alle Werte aus der Umgebung.
  - Der Root-Befehl `pnpm dev` ruft `turbo run dev --env-mode=loose` auf, damit im Terminal gesetzte Variablen (z.B. `WORKER_ROLES=scheduler pnpm dev`) ankommen. `dev` wird nicht gecacht; für alle anderen Tasks bleibt der Strict-Modus.
  - `gen:keys` erzeugt zufällige 32-Byte-Schlüssel (Base64).
- **Fertig, wenn**: Eine fehlende Pflichtvariable zu einem klaren Startfehler führt und `pnpm gen:keys` gültige Schlüssel ausgibt.

#### 0.5 Datenbank-Package (`packages/db`, Prisma 7)
- **Erstellen**: `prisma.config.ts`, `prisma/schema.prisma`, `prisma/migrations/0000_init/` (Extensions und Grants), `src/client.ts`, `src/index.ts`, `src/seed.ts`, `tsup.config.ts`.
- **So sieht es aus**:
  ```ts
  // prisma.config.ts  (Form gegen die aktuelle Prisma-7-Doku prüfen)
  import { config } from 'dotenv';
  import { defineConfig, env } from 'prisma/config';
  config({ path: '../../.env' });   // Prisma 7 lädt .env nicht mehr selbst; in Containern ohne Datei ein No-op
  export default defineConfig({
    schema: 'prisma/schema.prisma',
    migrations: { path: 'prisma/migrations', seed: 'tsx src/seed.ts' },
    datasource: { url: env('MIGRATION_DATABASE_URL') },
  });
  ```
  ```prisma
  generator client { provider = "prisma-client"  output = "../src/generated/prisma"  moduleFormat = "cjs" }
  datasource db   { provider = "postgresql" }
  ```
  ```ts
  // src/client.ts
  import { PrismaPg } from '@prisma/adapter-pg';
  import { PrismaClient } from './generated/prisma/client';
  export const createPrismaClient = (url: string) =>
    new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  ```
  Die Init-Migration enthält `CREATE EXTENSION citext, pg_trgm` sowie `ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator ... GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user, app_system` (Sequences analog).
- **Darauf achten**:
  - Migrationen laufen nur als `app_migrator`. Zur Laufzeit verbindet sich die App nur als `app_user`; der Owner würde RLS umgehen.
  - Der generierte Client wird nicht committet; `prisma generate` ist Teil von `build` und `dev` des Packages.
  - Angewendete Migrationen werden nie verändert.
  - SQL-Migrationen (RLS, Partial Indexes) entstehen mit `prisma migrate dev --create-only`.
- **Fertig, wenn**: `pnpm db:migrate` die Init-Migration anwendet und ein Integrationstest mit `app_user` eine Verbindung aufbaut.

#### 0.6 Observability (`packages/observability`)
- **Erstellen**: `src/logger.ts` (pino-Factory), `src/otel.ts` (NodeSDK, OTLP-Exporter), `src/sentry.ts`, `src/register.ts` (Seiteneffekt-Einstieg).
- **So sieht es aus**:
  - Redact-Liste: `authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `x-api-key`, `password`, `secret`, `clientSecret`, `token`, `accessToken`, `refreshToken`, `idToken`, `sessionState`, `apiKey` und alles mit Endung `Enc`, in jeder Tiefe.
  - Sentry sammelt ab Version 11 standardmäßig Nutzerdaten, Cookies, Header, Bodies, Query-Parameter, DB-Parameter, Queue-Payloads, lokale Variablen und KI-Ein- und -Ausgaben. `dataCollection` schaltet das ab (ADR 0009).
  - Jede Logzeile trägt `service`, `env`, `traceId`, `requestId`/`jobId` und `workspaceId`.
  - Gestartet wird mit `node --require @smp/observability/register dist/main.js`.
- **Darauf achten**:
  - `@smp/observability` exportiert dafür zusätzlich den Subpath `./register` in `exports`. Er wird nur über `--require` geladen und nie importiert, deshalb bleibt die Sperre von Deep-Imports (`no-restricted-imports`) ohne Ausnahme.
  - OpenTelemetry muss vor allen anderen Modulen geladen werden, sonst greift die Instrumentierung nicht.
  - Laute Instrumentierungen (fs, dns) abschalten.
  - Keine PII in Span-Attributen.
- **Fertig, wenn**: Ein Request an die API im Profil `observability` als Trace in Grafana sichtbar ist.

#### 0.7 API-Gerüst (`apps/api`)
- **Erstellen**: `nest-cli.json` (Builder `swc`), `.swcrc`, `src/main.ts`, `src/app.module.ts`, `src/config/`, `src/common/filters/problem-details.filter.ts`, `src/common/request-id.middleware.ts`, `src/modules/health/health.controller.ts`, `vitest.config.ts`.
- **So sieht es aus**:
  ```ts
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true, bodyParser: false });
  app.useLogger(app.get(Logger));                 // nestjs-pino
  app.set('trust proxy', 1);
  app.setGlobalPrefix('api');
  app.use(helmet());
  // Phase 1: Better-Auth-Handler HIER einhängen, vor den Body-Parsern
  app.use('/api/webhooks', express.raw({ type: '*/*', limit: '1mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.useGlobalPipes(new ZodValidationPipe());      // nestjs-zod
  app.enableShutdownHooks();
  await app.listen(env.API_PORT, '0.0.0.0');
  ```
  Die Health-Endpunkte `/api/health/live` und `/api/health/ready` prüfen über `@nestjs/terminus` die DB, Redis und S3. OpenAPI liegt nur in Dev unter `/api/docs`.
- **Darauf achten**:
  - NestJS 11 nutzt Express 5. Wildcard-Routen haben die neue Syntax (`/*splat`).
  - Die Serialisierung läuft über `ZodSerializerInterceptor`, damit keine internen Felder durchsickern.
  - Die Request-ID wird aus dem Header `x-request-id` übernommen oder neu erzeugt.
  - Health-Endpunkte sind ohne Auth erreichbar und werden nicht geloggt.
  - Request-Logs enthalten nur Request-ID, Methode, Pfad ohne Query-String und Status: keine Header, keine Client-Adresse (PII), keine Query-Parameter (später OAuth-Codes).
  - 5xx-Fehler werden mit dem Fehlerobjekt geloggt; die Antwort enthält bei 5xx nie den internen Text, auch nicht bei einer `HttpException`.
- **Fertig, wenn**: `GET /api/health/ready` mit 200 und Details zu den drei Abhängigkeiten antwortet.

#### 0.8 Worker-Gerüst (`apps/worker`)
- **Erstellen**: `src/main.ts`, `src/worker.module.ts`, `src/roles.ts`, `src/health-server.ts`, `src/processors/noop.processor.ts`.
- **So sieht es aus**:
  - Gestartet wird mit `NestFactory.createApplicationContext(WorkerModule.forRoles(parseRoles(env.WORKER_ROLES)))`, sodass nur die Prozessoren der gewählten Rollen geladen werden.
  - Ein kleiner `node:http`-Server liefert `/health/live`, `/health/ready` und `/metrics` (prom-client).
- **Darauf achten**:
  - BullMQ-Worker-Verbindungen brauchen `maxRetriesPerRequest: null`.
  - Bei SIGTERM erst `await worker.close()`; das schließt den laufenden Job ab. Die Stop-Grace-Period (`stop_grace_period` in Compose, 10 s als Default) muss länger sein als ein typischer Job; was danach hart abbricht, fangen Lease und Reconcile auf.
  - `lockDuration` muss größer sein als die maximale Jobdauer, oder der Lock wird verlängert.
  - Eine Job-Scheduler-Definition darf es nur einmal geben, damit es keine doppelten Ticks gibt.
- **Fertig, wenn**: `WORKER_ROLES=scheduler pnpm --filter @smp/worker dev` einen Noop-Tick verarbeitet, der im Log sichtbar ist.

#### 0.9 Web-Gerüst (`apps/web`)
- **Erstellen**: Projekt per `create-next-app` (TypeScript, App Router, Tailwind, `src/`), dann `shadcn init`, `next.config.ts`, `src/i18n/request.ts`, `messages/de/common.json`, `messages/en/common.json`, `src/proxy.ts`, `src/app/layout.tsx`.
- **So sieht es aus**:
  ```ts
  // Root-.env laden; forceReload, weil Next.js die Umgebung von apps/web schon gecacht hat (siehe 0.4)
  loadEnvConfig(resolve(process.cwd(), '../..'), process.env.NODE_ENV !== 'production', console, true);
  const apiInternalUrl = process.env.API_INTERNAL_URL;   // einmal lesen, unabhängig von späteren Reloads
  const config: NextConfig = {
    output: 'standalone',
    transpilePackages: ['@smp/ui', '@smp/api-client', '@smp/contracts', '@smp/platform-rules'],
    async rewrites() {   // nur lokale Entwicklung; im Container und in Produktion routet der Reverse Proxy
      return apiInternalUrl ? [{ source: '/api/:path*', destination: `${apiInternalUrl}/api/:path*` }] : [];
    },
  };
  export default withNextIntl(config);
  ```
  next-intl läuft ohne Sprach-Routing: `getRequestConfig` liest die Sprache aus dem Cookie `NEXT_LOCALE` (später aus dem Profil), Standard ist `de`.
- **Darauf achten**:
  - Der Rewrite gilt nur für die lokale Entwicklung. In Produktion und im Compose-Profil `app` routet der Reverse Proxy `/api` direkt an die API; das spart einen Hop und vermeidet Puffern bei SSE.
  - `rewrites()` wird beim Build ausgewertet, nicht zur Laufzeit. Deshalb hängt der Rewrite an `API_INTERNAL_URL`. Im Docker-Build fehlt die Variable (keine `.env` im Build-Kontext), und das Image enthält keinen Rewrite; ein fest eingebautes Ziel würde das Image an eine Umgebung binden. `API_INTERNAL_URL` wird dem Container nur zur Laufzeit für serverseitige Aufrufe mitgegeben.
  - Server Components rufen die API mit dem weitergereichten Cookie auf.
  - `proxy.ts` (ersetzt in Next.js 16 `middleware.ts`) setzt die CSP mit einer Nonce pro Request (`script-src 'self' 'nonce-…' 'strict-dynamic'`, `frame-ancestors 'none'`, siehe ADR 0009) und macht sonst nur optimistische Redirects; es ist keine Sicherheitsgrenze. Nonces verlangen dynamisches Rendern.
  - Feste Sicherheits-Header (`nosniff`, `Referrer-Policy`, `X-Frame-Options`, `Permissions-Policy`) kommen aus `headers()` in `next.config.ts`, `poweredByHeader` ist aus.
  - Für signierte S3-URLs `next/image` mit `unoptimized` oder ein einfaches `<img>` nutzen, sonst gibt es Cache-Probleme mit ablaufenden URLs.
- **Fertig, wenn**: `http://localhost:3000` die Shell auf Deutsch zeigt und nach dem Umstellen des Cookies auf Englisch.

#### 0.10 Browser-Worker-Gerüst (`apps/browser-worker`)
- **Erstellen**: `package.json` (Playwright **exakt** gepinnt, ohne `^`), `src/main.ts`, `Dockerfile`.
- **So sieht es aus**: `FROM mcr.microsoft.com/playwright:v1.<gleiche Version>-noble`, User `pwuser`, ein BullMQ-Worker auf `xb-commands`. In Phase 0 meldet er sich nur bereit.
- **Darauf achten**:
  - Weichen npm-Version und Image-Version voneinander ab, findet Playwright die Browser nicht.
  - `init: true` (Zombie-Prozesse) und ausreichend `shm_size`.
  - Keine Browser-Downloads in der CI.
- **Fertig, wenn**: Der Container mit `--profile xb` startet und "ready" loggt.

#### 0.11 Package-Gerüste
- **Erstellen**: für jedes Package aus Teil A, Abschnitt 3: `package.json` (`@smp/<name>`, `version: 0.0.0`, `private`, `exports`, Scripts `build`/`dev`/`lint`/`typecheck`/`test`), `tsconfig.json`, ggf. `tsup.config.ts`, `src/index.ts`, `vitest.config.ts`.
- **So sieht es aus** (Backend-Package):
  ```jsonc
  { "name": "@smp/core", "main": "./dist/index.js", "types": "./dist/index.d.ts",
    "exports": { ".": { "types": "./dist/index.d.ts", "require": "./dist/index.js" } },
    "dependencies": { "zod": "^4", "uuidv7": "^1" } }
  ```
- **Darauf achten**:
  - Interne Abhängigkeiten immer mit `workspace:*`.
  - `packages/core` hat außer zod und uuidv7 keine Laufzeit-Abhängigkeiten.
  - Geteilte Packages bekommen `sideEffects: false`.
- **Fertig, wenn**: `pnpm build` alle Packages in der richtigen Reihenfolge (Turbo-Graph) baut.

#### 0.12 Dockerfiles
- **Erstellen**: `infra/docker/node-app.Dockerfile` (`ARG APP`), `infra/docker/web.Dockerfile`, `infra/docker/caddy/Caddyfile`, `.dockerignore`.
- **So sieht es aus**: vier Stages.
  1. `prune`: `turbo prune @smp/$APP --docker`
  2. `deps`: `pnpm install --frozen-lockfile` auf den gepruned-ten Manifests
  3. `build`: `turbo run build --filter=@smp/$APP...`
  4. `runtime`: `node:24-slim`, `NODE_ENV=production`, nur Produktionsabhängigkeiten (`pnpm deploy --legacy --prod`), `USER node`, `HEALTHCHECK`, `CMD ["node","--require","@smp/observability/register","dist/main.js"]`

  Das Web-Image nutzt den Next.js-Output `standalone`.
- **Darauf achten**:
  - sharp und die Prisma-Bestandteile müssen auf derselben Basis (glibc, Architektur) installiert werden, auf der sie laufen; `node_modules` nicht zwischen alpine und slim kopieren.
  - Keine `.env` im Image.
  - `pnpm deploy` verlangt in pnpm 10 entweder `inject-workspace-packages=true` oder `--legacy`. Gewählt ist `--legacy` (ADR 0002): Injizierte Workspace-Pakete wären Kopien statt Symlinks und würden das Verhalten in der lokalen Entwicklung verändern.
  - Zielgröße für api und worker unter 300 MB.
- **Fertig, wenn**: `docker compose --profile app up --build` alle drei Apps "healthy" startet und die App über den Proxy unter `http://localhost:8080` samt API-Aufrufen funktioniert.

#### 0.13 CI und Qualitäts-Gates
- **Erstellen**: `.github/workflows/ci.yml`, `renovate.json`, `.dependency-cruiser.cjs`, `tools/check-no-emoji.ts`, `commitlint.config.js`, `.github/pull_request_template.md`.
- **So sieht es aus**:
  - Jobs:
    - `quality`: lint, typecheck, dependency-cruiser, Emoji-Check, i18n-Key-Check
    - `unit`
    - `integration`: Testcontainers, Docker ist auf GitHub-Runnern vorhanden
    - `build`
    - später `e2e` und `docker`
  - `concurrency` mit `cancel-in-progress`; pnpm-Cache über `actions/setup-node`; Turbo-Cache über `actions/cache` auf `.turbo`.
  - Der Emoji-Check durchsucht alle versionierten Textdateien (`git ls-files`, Binärdateien ausgenommen) nach `\p{Extended_Pictographic}` und schlägt bei einem Treffer fehl. Eine feste Endungsliste würde z.B. `.sql`, `.prisma`, `.css` oder Dockerfiles übersehen.
  - Dieselbe Prüfung läuft über die Commit-Messages des PRs, zusammen mit `commitlint` (`@commitlint/config-conventional`) für das Conventional-Commits-Format.
- **Darauf achten**:
  - `\p{Extended_Pictographic}` trifft auch die Zeichen Copyright (U+00A9), Registered (U+00AE) und Trademark (U+2122). Diese drei stehen auf einer kleinen Allowlist (Rechtstexte, Impressum).
  - Tests, die Emojis brauchen (Zeichenzählung in 2.2, Mock-Fixtures in 2.5), schreiben sie als Escape-Sequenz (`'\u{1F600}'`, in JSON `"\ud83d\ude00"`), nie als literales Zeichen.
  - GitHub Actions per Commit-SHA pinnen (Lieferkette).
  - `permissions: contents: read` als Default.
  - Job-Timeouts setzen.
  - Keine Secrets in Builds von Forks.
  - Ein zweiter Workflow `security.yml` läuft auf Pull Requests, Pushes nach `main` und wöchentlich: CodeQL (`security-extended`, auch für die Workflows), Dependency Review (Abbruch ab Schweregrad hoch), `pnpm audit --audit-level high` mit begründeten Ausnahmen in `auditConfig`, gitleaks über die ganze Historie mit prüfsummengesicherter Binärdatei.
  - Die CI-Fehlerbilder lokal nur mit einem frischen Checkout und ohne global installierte Werkzeuge im `PATH` nachstellen.
- **Fertig, wenn**: Ein Push eine grüne CI ergibt und sowohl ein absichtlich eingefügtes Emoji als auch eine Commit-Message ohne Conventional-Commits-Format die CI rot machen.

#### 0.14 Spikes, Doku, ADRs
- **Erstellen**: `docs/adr/0001` bis `0008` (Monorepo und Stack, Modulformat, RLS, Scheduling und Outbox, X-Hybrid und Leitplanken, Auth, KI-Provider und Caching, Objektspeicher), `tools/spikes/*`.
- **Spikes** (Wegwerf-Skripte, Ergebnisse gehen in die ADRs):
  - (a) Claude: `messages.stream` mit `zodOutputFormat`, zwei `cache_control`-Blöcken und `fallbacks: "default"`. Gemessen werden Time-to-first-token, `cache_read_input_tokens` beim zweiten Aufruf, das Verhalten bei Refusals und die Kosten pro Aufruf. Ohne `ANTHROPIC_API_KEY` wird der Spike übersprungen und das dokumentiert.
  - (b) RLS mit Prisma: Tenant-Extension mit `set_config` in der Transaktion, Isolation nachgewiesen, Overhead bei 1.000 Queries gemessen.
  - (c) zod 4 mit nestjs-zod, OpenAPI und Orval: Der generierte Client kompiliert.
  - (d) Better Auth in NestJS/Express 5: Registrierung, Login und `getSession` im Rundlauf.
  - (e) S3: Presigned PUT aus dem Browser gegen SeaweedFS, inklusive CORS.
- **ADR-Format**: Kontext, Entscheidung, Alternativen, Konsequenzen, Status.
- **Fertig, wenn**: Jeder Spike ein ADR mit Ergebnis und gewählter Ausweichlösung hat.

---

## B.3 Phase 1: Identity und Mandanten

#### 1.1 Datenmodell Identity und Tenancy
- **Erstellen**:
  - Better-Auth-Modelle per `@better-auth/cli generate`, übernommen in `schema.prisma`: `User`, `Session`, `Account` → `@@map("auth_account")`, `Verification`, `TwoFactor`.
  - Eigene Modelle: `Organization`, `Workspace`, `WorkspaceSettings`, `Membership`, `MembershipWorkspace`, `Invitation`, `AuditLog`, `Notification`, `NotificationPreference`, `FeatureFlag`.
- **So sieht es aus**: Felder wie in Teil A, Abschnitt 6.2. Dazu:
  - `User.email` als `citext`, eindeutig.
  - Unique-Constraints: `Membership(organizationId, userId)`, `Workspace.slug` (global, weil die Routen den Workspace allein über den Slug adressieren; [ADR 0010](adr/0010-workspace-slug-global-eindeutig.md)), `Invitation.tokenHash`.
- **Darauf achten**:
  - Zusätzliche User-Felder (`locale`, `timezone`, `isPlatformAdmin`) über `additionalFields` von Better Auth deklarieren; `isPlatformAdmin` bekommt `input: false`, damit der Nutzer es nicht selbst setzen kann.
  - `User` wird auf die Tabelle `users` gemappt, weil `user` in PostgreSQL ein reserviertes Wort ist; Raw-SQL und Prüfskripte bräuchten sonst überall Anführungszeichen.
  - `onDelete` immer explizit angeben.
  - Die Auth-Tabellen sind global und haben keine RLS.
- **Fertig, wenn**: Die Migration läuft und der Seed eine Demo-Organisation mit vier Nutzern (je eine Rolle) anlegt.

#### 1.2 RLS-Migration und RLS-Check
- **Erstellen**: Migration `rls_tenancy` (create-only) und `tools/check-rls.ts`.
- **So sieht es aus**:
  ```sql
  ALTER TABLE workspace ENABLE ROW LEVEL SECURITY; ALTER TABLE workspace FORCE ROW LEVEL SECURITY;
  -- NULLIF: eine gepoolte Verbindung liefert nach dem ersten set_config '' statt NULL
  CREATE POLICY org_isolation ON workspace
    USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
    WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
  -- Membership: eigene Mitgliedschaften sind auch ohne Org-Kontext lesbar (für den Workspace-Wechsler)
  CREATE POLICY own_memberships ON membership FOR SELECT
    USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
  REVOKE UPDATE, DELETE ON audit_log FROM app_user;
  ```
  `check-rls.ts` fragt `pg_class` und `pg_policies` ab. Jede Tabelle mit einer Spalte `workspace_id` oder `organization_id` muss `relrowsecurity` und `relforcerowsecurity` gesetzt und mindestens eine Policy haben.
- **Darauf achten**:
  - Neben den Mandanten-Policies braucht es nutzerbezogene Lese-Policies: eigene Mitgliedschaften und Einladungen an die eigene E-Mail-Adresse.
  - Die Policies decken alle Operationen ab (SELECT, INSERT, UPDATE, DELETE).
  - Der Kontext wird immer als `NULLIF(current_setting('app.…', true), '')::uuid` gelesen. Ohne `NULLIF` bricht eine Abfrage ohne Kontext auf einer zuvor genutzten Verbindung mit `invalid input syntax for type uuid` ab, statt 0 Zeilen zu liefern. `check-rls.ts` prüft auch das.
- **Fertig, wenn**: `check-rls` in der CI läuft, eine Tabelle ohne Policy die CI rot macht und ein Integrationstest zeigt, dass eine Abfrage ohne Kontext auf einer zuvor genutzten Verbindung 0 Zeilen liefert.

#### 1.3 Mandanten-Kontext in der Anwendung
- **Erstellen**: `apps/api/src/common/cls/tenant-context.ts` (nestjs-cls), `packages/db/src/tenant-extension.ts`, `packages/db/src/assert-tenant-filter.extension.ts` (nur Dev/Test), `packages/db/src/system-client.ts`.
- **So sieht es aus**:
  ```ts
  // Jede Operation läuft in einer Batch-Transaktion mit transaktionslokalem Kontext
  prisma.$extends({ query: { $allOperations({ args, query }) {
    const ctx = cls.get<TenantContext>('tenant');
    return prisma.$transaction([
      prisma.$executeRaw`SELECT set_config('app.user_id', ${ctx.userId}, true),
                                set_config('app.organization_id', ${ctx.organizationId}, true),
                                set_config('app.workspace_id', ${ctx.workspaceId ?? ''}, true)`,
      query(args),
    ]).then(([, result]) => result);
  } } });
  ```
  Interaktive Transaktionen bekommen einen Helfer `withTenantTx(ctx, fn)`, der den Kontext einmal zu Beginn setzt.
- **Darauf achten**:
  - Nie ein session-weites `SET` verwenden, sonst hängt der Kontext an gepoolten Verbindungen.
  - Der System-Client (`app_system`) ist nur in Repository-Methoden erlaubt, die mit `@SystemScope()` markiert sind. `no-restricted-imports` sperrt ihn überall sonst.
  - Fehlt der Kontext, wirft die Extension einen Fehler; es wird nicht stillschweigend ohne Filter weitergearbeitet.
  - `withTenantTx` startet die interaktive Transaktion auf dem Basis-Client ohne Extension. Sonst würde die Extension jede Abfrage darin in eine eigene Batch-Transaktion auf einer anderen Verbindung auslagern, und die Atomarität ginge verloren.
- **Fertig, wenn**: Ein Integrationstest mit zwei Organisationen zeigt, dass jede Repository-Methode nur die eigenen Daten liefert.

#### 1.4 Better Auth einbinden
- **Erstellen**: `apps/api/src/modules/identity/auth.ts`, `auth.guard.ts`, `identity.module.ts`.
- **So sieht es aus**:
  ```ts
  export const auth = betterAuth({
    database: prismaAdapter(authPrisma, { provider: 'postgresql' }),   // app_user, ohne Tenant-Extension
    emailAndPassword: { enabled: true, requireEmailVerification: true, sendResetPassword },
    emailVerification: { sendOnSignUp: true, sendVerificationEmail },
    plugins: [twoFactor()],
    trustedOrigins: [env.APP_URL],
    user: { additionalFields: {
      locale: { type: 'string', defaultValue: 'de' },
      timezone: { type: 'string' },
      isPlatformAdmin: { type: 'boolean', defaultValue: false, input: false },   // nicht vom Nutzer setzbar
    } },
  });
  // main.ts, VOR express.json(); Express 5 braucht den benannten Wildcard (better-auth/node)
  const server = app.getHttpAdapter().getInstance() as express.Express;
  server.all('/api/auth/*splat', toNodeHandler(auth));
  // AuthGuard:
  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
  ```
- **Darauf achten**:
  - Der Auth-Handler muss vor dem JSON-Body-Parser stehen, sonst ist der Request-Body schon konsumiert. Gemountet wird wie in der Better-Auth-Doku für Express 5 mit `all('/api/auth/*splat', ...)`.
  - Better Auth bekommt einen eigenen Prisma-Client als `app_user` ohne Tenant-Extension: Die Auth-Tabellen haben keine RLS, und die Extension würde ohne Mandanten-Kontext einen Fehler werfen. Der System-Client (`app_system`) ist dafür nicht nötig.
  - Rate-Limits auf den Auth-Routen.
  - Keine Rückschlüsse darauf, ob eine E-Mail-Adresse existiert (gleiche Antwort bei "Passwort vergessen").
  - Backup-Codes für 2FA nur einmal anzeigen.
  - Organisationen erst nach verifizierter E-Mail anlegen.
- **Fertig, wenn**: Registrierung, E-Mail-Verifizierung (Mailpit), Login, Logout und das Aktivieren von 2FA funktionieren.

#### 1.5 Use Cases für Mandanten (`packages/core/src/tenancy`)
- **Erstellen**: `CreateOrganization`, `CreateWorkspace`, `InviteMember`, `AcceptInvitation`, `ChangeMemberRole`, `RemoveMember`, `LeaveOrganization`, `UpdateWorkspaceSettings`, jeweils mit Port-Interfaces und Unit-Tests.
- **So sieht es aus** (Fachregeln):
  - `CreateOrganization` legt in einer Transaktion Organisation, Owner-Mitgliedschaft, Standard-Workspace und Workspace-Einstellungen an.
  - Einladungen:
    - Token aus 32 zufälligen Bytes, gespeichert wird nur der SHA-256-Hash.
    - 7 Tage gültig und nur einmal verwendbar.
    - Beim Annehmen muss die E-Mail-Adresse übereinstimmen.
  - Rollenregeln:
    - Der letzte Owner kann weder gehen noch herabgestuft werden.
    - Ein Admin kann niemanden zum Owner machen.
    - Jede Änderung schreibt einen Audit-Eintrag in derselben Transaktion.
- **Fertig, wenn**: Alle Regeln als Unit-Tests abgedeckt sind, inklusive der Fehlerfälle.

#### 1.6 Rechte-Matrix und Guards
- **Erstellen**: `packages/contracts/src/permissions.ts`, `apps/api/src/common/guards/{workspace.guard.ts, permission.guard.ts}`, Decorators `@RequirePermission()`, `@Public()`, `@OrgScope()`, dazu `@WorkspaceScope()` und `@UserScope()` für Routen, die nur eine Session brauchen (Onboarding, Einladung annehmen).
- **So sieht es aus**:
  ```ts
  export const PERMISSIONS = ['post.read', 'post.write', 'post.schedule', 'post.publish', 'media.write',
    'ai.use', 'account.manage', 'member.manage', 'billing.manage', 'org.delete', /* ... */] as const;
  export const ROLE_PERMISSIONS = { OWNER: [...], ADMIN: [...], EDITOR: [...], VIEWER: [...] }
    as const satisfies Record<Role, readonly Permission[]>;
  ```
  Die Routen folgen dem Schema `/api/w/:ws/...` (Workspace) und `/api/org/:org/...` (Organisation).
- **Darauf achten**:
  - Standardmäßig wird verweigert. Ein Startup-Check listet alle Routen auf und bricht ab, wenn eine Route weder `@RequirePermission`, `@UserScope` noch `@Public` trägt.
  - Ressourcen fremder Mandanten liefern 404, nicht 403, damit nichts über ihre Existenz verraten wird.
  - Der Membership-Cache wird bei Rollenänderungen sofort invalidiert.
- **Fertig, wenn**: Der aus `ROLE_PERMISSIONS` generierte Matrix-Test (Rolle x Endpunkt) grün ist.

#### 1.7 Audit-Log
- **Erstellen**: `AuditService` in core (Port) und db (Adapter), den Endpunkt `GET /api/org/:org/audit-log` (Cursor-Pagination, Filter nach Aktion, Nutzer und Zeitraum).
- **So sieht es aus**: `audit.record({ action: 'member.invite', targetType: 'Invitation', targetId, metadata })`. Akteur, IP und User-Agent kommen aus dem CLS-Kontext.
- **Darauf achten**: Der Eintrag wird in derselben Transaktion geschrieben wie die Änderung. Keine Secrets oder Tokens in `metadata`.
- **Fertig, wenn**: Jede Mandanten-Aktion aus 1.5 einen Audit-Eintrag erzeugt.

#### 1.8 E-Mails und Benachrichtigungs-Grundgerüst
- **Erstellen**:
  - `packages/emails` mit react-email-Templates in de und en: `verify-email`, `reset-password`, `invitation`.
  - Den Port `MailPort` und einen SMTP-Adapter (nodemailer).
  - In `packages/queue` die Queue `notifications` und den Job `notify.dispatch`; im Worker die Rolle `notify`.
- **So sieht es aus**: Jede E-Mail hat eine HTML- und eine Text-Variante. Links basieren auf `APP_URL`. Der Versand läuft über die Queue mit Retries.
- **Darauf achten**:
  - Keine Tracking-Pixel.
  - Tokens in Links sind kurzlebig und nur einmal verwendbar.
  - Die Sprache kommt aus `User.locale`.
- **Fertig, wenn**: Die Einladungs-E-Mail in Mailpit in beiden Sprachen korrekt ankommt.

#### 1.9 Web: Auth, Onboarding, App-Shell, Team
- **Erstellen**:
  - Seiten: `(auth)/login`, `signup`, `verify-email`, `forgot-password`, `reset-password`, `invite/[token]`; `onboarding/`.
  - Layout `(app)/w/[ws]/layout.tsx` mit Shell.
  - Team-Seiten `(app)/org/[org]/members`; Sicherheits-Seite `(app)/account/security`.
- **So sieht es aus**:
  - **Auth-Seiten**: zentrierte Karte mit Logo, Formular (react-hook-form + zod, dieselben Schemas wie die API), Fehlermeldungen pro Feld und Links zu den jeweils anderen Auth-Seiten.
  - **Onboarding** in drei Schritten mit Fortschrittsanzeige:
    1. Organisation (Name)
    2. Workspace-Profil (Name, Branche, Zielgruppe, Ziele, Content-Sprache, Zeitzone)
    3. Fertig, mit dem Hinweis "Accounts verbinden" (aktiv ab Phase 4)
  - **App-Shell**:
    - Linke Sidebar: Dashboard, Erstellen, Kalender, Posts, Ideen, Medien, Analytics, Accounts, Brand Voices, Einstellungen; einklappbar, auf Mobilgeräten als Drawer.
    - Topbar: Workspace-Wechsler, Glocke für Benachrichtigungen, Sprachumschalter, Nutzermenü.
  - **Team**: Tabelle (Name, E-Mail, Rolle als Select, Workspaces, Beitrittsdatum, Aktionen), Button "Einladen" mit Dialog (E-Mail, Rolle, Workspaces), Liste offener Einladungen mit "Erneut senden" und "Widerrufen".
  - **Sicherheit**: 2FA einrichten (QR-Code, Bestätigungscode, Backup-Codes zum Herunterladen) und eine Liste aktiver Sessions mit "Abmelden".
- **Darauf achten**:
  - Jede Liste hat einen Lade-, einen Leer- und einen Fehlerzustand.
  - Die Session wird serverseitig im Layout geprüft, damit kein ungeschützter Inhalt aufblitzt.
  - Aktionen ohne Berechtigung werden ausgeblendet (`can(role, permission)`); der Server prüft trotzdem.
  - Alle Texte laufen über i18n.
- **Fertig, wenn**: Ein Playwright-E2E grün ist: Registrierung, Verifizierungs-Mail (über die Mailpit-API), Onboarding, Einladung, Annahme, der Viewer sieht keine Schreibaktionen.

#### 1.10 i18n-Grundlagen
- **Erstellen**: Namespaces `messages/{de,en}/{common,auth,onboarding,team,errors}.json` und `tools/check-i18n.ts` (vergleicht die Keys zwischen de und en).
- **Darauf achten**: ICU-Plural (`{count, plural, one {...} other {...}}`). Datum und Zahlen formatiert `useFormatter`. Fehlercodes der API haben eigene Keys unter `errors.*`.
- **Fertig, wenn**: Ein fehlender Key in einer Sprache die CI rot macht.

---

## B.4 Phase 2: Composer, KI und Stile

#### 2.1 Datenmodell Content und KI
- **Erstellen**: `PostStyle`, `BrandVoice` und `BrandVoiceVersion` (unveränderliche Snapshots), `Idea`, `Post`, `PostVariant` (mit allen Feldern aus Teil A, auch denen für das Scheduling, um spätere Migrationen zu vermeiden), `AiGeneration`, `UsageRecord`, `UsageCounter`, `PriceBook`; dazu die RLS-Policies für alle neuen Tabellen.
- **So sieht es aus**:
  - Seed der Style-Presets mit `key`, i18n-Namen und Prompt-Fragment: professional, storytelling, casual, educational, thought_leadership, promotional. Presets und PriceBook kommen als Migration `reference_data`, damit sie in jeder Umgebung vorhanden sind ([ADR 0014](adr/0014-content-und-ki-datenmodell.md)).
  - Seed des PriceBooks für `claude-opus-5-5`: Input 4 USD und Output 20 USD pro Mio. Tokens, Cache-Read 0,20 USD, Cache-Write das 1,25-Fache des Inputs (5-Minuten-TTL); gespeichert in Micro-USD.
  - Dazu die Preise der Fallback-Ziele aus `allowed_fallback_models` (Models API mit Beta-Header `server-side-fallback-2026-06-01`; erwartet werden `claude-opus-5` und `claude-opus-4-8`, gegen die Doku prüfen), weil Fallback-Versuche zu deren Preisen abgerechnet werden.
- **Darauf achten**: Preise stehen nur im PriceBook, nie im Code. `AiGeneration` verweist auf `BrandVoiceVersion`, damit jede Generierung nachvollziehbar bleibt.
- **Fertig, wenn**: Migration, Seed und RLS-Check grün sind.

#### 2.2 Plattformregeln (`packages/platform-rules`)
- **Erstellen**: `src/capabilities/{linkedin,facebook,instagram,x}.ts`, `src/count-text.ts`, `src/validate-post.ts`, `src/index.ts`.
- **So sieht es aus**:
  - Textlimits:
    - X: 280 Zeichen gewichtet über `twitter-text` (`parseTweet(text).weightedLength`), URLs zählen als 23 Zeichen
    - LinkedIn: 3.000
    - Instagram: Caption 2.200, höchstens 30 Hashtags
    - Facebook: großzügig, die UI empfiehlt kurze Texte
  - Alle anderen Plattformen zählen Grapheme (`Intl.Segmenter`).
  - `validatePost()` liefert Issues mit Codes: `TEXT_TOO_LONG`, `MEDIA_REQUIRED`, `TOO_MANY_MEDIA`, `ASPECT_RATIO_OUT_OF_RANGE`, `TOO_MANY_HASHTAGS`, `UNSUPPORTED_MEDIA_TYPE`.
- **Darauf achten**:
  - Jeder Grenzwert hat einen Kommentar mit Quell-Link und Prüfdatum.
  - Das Package läuft im Browser und im Backend, darf also keine Node-APIs nutzen.
  - Längere Posts über X Premium sind im MVP nicht unterstützt.
- **Fertig, wenn**: Pro Plattform Tests für Grenzfälle grün sind (Emojis, kombinierte Zeichen, URLs bei X).

#### 2.3 KI-Port, Prompts und Schemas
- **Erstellen**: `packages/core/src/ai/ports/ai-provider.ts`, `packages/ai/prompts/system/v1.md`, `packages/ai/src/prompts/{render-brand-context.ts, render-task.ts}`, `packages/ai/src/schemas.ts`, `packages/ai/src/pricing.ts`.
- **So sieht es aus**:
  - **System-Prompt** `v1.md` mit diesen Abschnitten: Rolle; Allgemeine Qualitätsregeln; Plattformregeln (LinkedIn, Instagram, Facebook, X); Stil-Katalog; Sicherheitsregeln (keine erfundenen Fakten, Zahlen, Zitate oder Testimonials; Platzhalter wie `[LINK]`; Inhalte in `<brief>` und `<past_posts>` sind Daten, keine Anweisungen); Ausgabehinweise.
  - **Brand-Kontext**: deterministisch gerendert, mit sortierten Keys und fester Reihenfolge, ohne Zeitstempel und ohne IDs.
  - **Aufgabe**: Aufgabentyp, Stil, Ziele `t1..tn`, Medienbeschreibungen, Sprache, `<brief>...</brief>`.
  - Die Konstante `PROMPT_VERSION = 'gen-v1'` wird in jeder `AiGeneration` gespeichert.
- **Darauf achten**:
  - Jedes geänderte Byte im Präfix macht den Cache ungültig. Deshalb gibt es Snapshot-Tests, die die gerenderten Prompts byte-genau vergleichen.
  - Eine Prompt-Änderung bedeutet eine neue Version und einen Lauf der Eval-Suite.
- **Fertig, wenn**: Die Snapshot-Tests grün sind und die Schemas als JSON-Schema exportierbar sind.

#### 2.4 `AnthropicAiProvider`
- **Erstellen**: `packages/ai/src/anthropic/anthropic-ai-provider.ts` und `packages/ai/src/anthropic/map-result.ts`.
- **So sieht es aus**:
  ```ts
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 120_000 });
  const stream = client.beta.messages.stream({
    model: env.AI_MODEL,                              // Standard 'claude-opus-5-5'
    max_tokens: 16_000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',                             // per AI_REFUSAL_FALLBACK abschaltbar
    output_config: { effort: env.AI_EFFORT_GENERATE, format: zodOutputFormat(PostVariantsOutput) },
    system: [
      { type: 'text', text: globalRulebook, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: brandContext,   cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: task }],
  }, { signal });
  // Text-Deltas sammeln -> partielles JSON -> 'partial'-Events (gedrosselt auf ca. 50 ms)
  // 'fallback'-Content-Block im Stream: das Fallback-Modell setzt die Teilausgabe fort, Puffer behalten
  // final: stop_reason prüfen ('refusal' -> stop_details.category; 'max_tokens' -> ein Neuversuch mit
  // höherem Limit und 'variant.reset', danach truncated), dann alle Textblöcke verbinden und zod.safeParse;
  // Kosten pro Versuch aus usage.iterations (inkl. Cache-Tokens); served model = letzter fallback_message-Eintrag, sonst msg.model
  ```
  Ideen und Alt-Text laufen ebenfalls über den Stream mit `finalMessage()` und derselben Prüfung; `client.messages.parse(...)` würfe bei der Fortsetzung nach einem Fallback und bei abgeschnittenen Antworten ([ADR 0015](adr/0015-anthropic-adapter-fallback-und-parsing.md)).
- **Darauf achten**:
  - Kein `temperature`, kein Assistant-Prefill, kein `thinking: disabled` (alle drei liefern beim Modell einen 400-Fehler).
  - Effort ist pro Route fest, damit der Cache nicht verloren geht.
  - Bricht der Client ab, wird der Aufruf abgebrochen.
  - SDK-Fehler werden typisiert behandelt, in dieser Reihenfolge: `RateLimitError`, `APIConnectionError`, `APIError` mit Status. Im TypeScript-SDK ist `APIConnectionError` eine Unterklasse von `APIError`; andersherum geprüft, landen Netzwerkfehler im falschen Zweig. `APIUserAbortError` nach einem Client-Abbruch wird nicht als Fehler gemeldet.
  - Die Kosten kommen aus `usage.iterations`. Das Top-Level-`usage` enthält nur den Versuch, der die Antwort geliefert hat; ein abgelehnter Erstversuch und der Fallback-Versuch werden einzeln zu den Preisen ihres Modells abgerechnet.
  - Wechselt der Server mitten im Stream auf das Fallback-Modell, markiert ein `fallback`-Content-Block die Stelle. Das Fallback-Modell setzt die Teilausgabe fort; die Texte aller Blöcke bilden zusammen die Antwort ([ADR 0015](adr/0015-anthropic-adapter-fallback-und-parsing.md)).
  - Prompts mit Kundendaten werden nicht auf Info-Level geloggt.
  - Für den Beta-Pfad gibt es `betaZodOutputFormat`. Übergeben wird nur sein JSON-Schema, ohne die `parse`-Funktion, weil das SDK sonst jeden Textblock einzeln parst ([ADR 0015](adr/0015-anthropic-adapter-fallback-und-parsing.md)).
- **Fertig, wenn**: Ein Integrationstest mit msw (das SDK nutzt fetch) alle Pfade abdeckt: ok, refusal, Fallback mitten im Stream, max_tokens, ungültiges JSON, 429, 529, Verbindungsfehler, Abbruch durch den Client.

#### 2.5 `MockAiProvider`
- **Erstellen**: `packages/ai/src/mock/mock-ai-provider.ts` und `src/mock/fixtures/{de,en}.json`; dazu `aiEnvSchema`, `checkAiEnv` und `createAiProvider` in `@smp/ai`.
- **So sieht es aus**: Deterministische Antworten pro Stil und Plattform, Streaming in Häppchen mit kleinen Verzögerungen. Marker im Briefing (bei Refine im Text oder in der Anweisung) lösen die anderen Pfade aus:
  - `[mock:refusal]`: Teilausgabe, dann `REFUSED`
  - `[mock:truncated]`: Teilausgabe, `variant.reset`, Teilausgabe, dann `TRUNCATED`
  - `[mock:retry]`: Teilausgabe, `variant.reset`, dann die vollständige Antwort
  - `[mock:invalid]`: vollständige Antwort, dann `INVALID_OUTPUT`
  - `[mock:error]`: `PROVIDER_ERROR` wie bei 529, wiederholbar
  - `[mock:fallback]`: Antwort vom Fallback-Modell, Bericht mit beiden Versuchen
  - `[mock:slow]`: längere Pausen zwischen den Häppchen
  - `[mock:too-long]`: Varianten über dem Textlimit der Plattform
- **Darauf achten**: In Produktion ist der Mock nicht aktivierbar (Startup-Check): `checkAiEnv` meldet `AI_PROVIDER=mock` bei `NODE_ENV=production` als Konfigurationsfehler, `createAiProvider` wirft zusätzlich.
- **Fertig, wenn**: Alle E2E-Tests mit dem Mock deterministisch laufen.

#### 2.6 Quoten und Kosten
- **Erstellen**: `QuotaService` (core, Port) und dessen SQL-Adapter, `CostCalculator` (nutzt das PriceBook). Umgesetzt als `QuotaService` mit den Ports `QuotaStore` und `QuotaLimits`, `CostCalculator` mit dem Port `PriceCatalog` (`packages/core/src/usage`, `packages/core/src/ai/application`) und die Adapter `PrismaQuotaStore` und `PrismaPriceCatalog` in `@smp/db`.
- **So sieht es aus**: Die Zähler-Zeile der Periode wird vorher per `INSERT ... ON CONFLICT DO NOTHING` angelegt. Die Reservierung ist dann atomar: `UPDATE usage_counter SET value = value + $est WHERE ... AND value + $est <= $limit RETURNING value`; liefert das keine Zeile, ist das Limit erreicht (402). Danach folgt `finalize(actual)` als Korrektur der Differenz. Das Ledger `UsageRecord` ist pro `(sourceType, sourceId, meter)` eindeutig, also idempotent.
- **Darauf achten**: Auch bei Fehlern und Abbrüchen wird finalisiert (`try/finally`). Bis Phase 7 gilt das Monatslimit aus `AI_MONTHLY_CAP_MICROS`.
- **Fertig, wenn**: Ein Test mit parallelen Reservierungen das Limit nie überschreitet.

#### 2.7 API: Content und KI
- **Erstellen**: Controller und Use Cases für diese Endpunkte:
  - Posts: `GET/POST /api/w/:ws/posts`, `GET/PATCH/DELETE /api/w/:ws/posts/:id`, `PATCH /api/w/:ws/variants/:id`
  - KI: `POST /api/w/:ws/ai/generations` (SSE), `POST /api/w/:ws/ai/refinements` (SSE)
  - Ideen: `POST /api/w/:ws/ideas/generate`, `GET /api/w/:ws/ideas`, `PATCH /api/w/:ws/ideas/:id`
  - Stile und Brand Voices: `GET/POST/PATCH /api/w/:ws/styles`, `GET/POST/PATCH /api/w/:ws/brand-voices`, `POST /api/w/:ws/brand-voices/:id/test`
- **So sieht es aus** (SSE über POST):
  ```ts
  @Post('generations') @RequirePermission('ai.use')
  async generate(@Body() dto: GenerateDto, @Req() req: Request, @Res() res: Response) {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });   // Client hat die Verbindung getrennt
    for await (const ev of this.generateVariants.execute(dto, ac.signal)) res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    res.end();
  }
  ```
- **Darauf achten**:
  - Nests `@Sse()` unterstützt nur GET mit Observables; für POST ist der manuelle Weg nötig.
  - Den Abbruch über `res.on('close')` erkennen, nicht über `req.on('close')`: Seit Node 16 feuert `close` am Request, sobald der Body gelesen ist, und nicht beim Verbindungsabbruch. Der Claude-Aufruf liefe sonst nach dem Schließen des Tabs weiter und kostete Geld.
  - Nach `flushHeaders()` kann der Problem-Details-Filter keine Antwort mehr schreiben. Fehler werden deshalb im Use Case gefangen und als `generation.failed`-Event gesendet, danach endet der Stream.
  - Compression-Middleware muss SSE auslassen.
  - Alle 15 s ein Heartbeat (`: ping`).
  - Updates nutzen Optimistic Locking über `version` (bei Konflikt 409).
  - Umgesetzt mit zusätzlich `GET /api/w/:ws/brand-voices/:id/versions` für die Versionshistorie (Schritt 2.9). Laden und Quoten-Reservierung laufen vor dem ersten Event, ihre Fehler kommen als Problem-Dokument (404, 422, 402); die KI schreibt nie selbst in Varianten ([ADR 0016](adr/0016-content-und-ki-api.md)).
- **Fertig, wenn**: Die API-E2E-Tests für alle Endpunkte grün sind, inklusive der Rechte-Matrix.

#### 2.8 Web: Composer
- **Erstellen**: `src/features/composer/*`: `ComposerPage`, `BriefPanel`, `StyleSelect`, `VariantTabs`, `VariantEditor`, `RefineActions`, `DiffDialog`, `PlatformPreview`, `useGenerationStream`.
- **So sieht es aus**: drei Spalten auf dem Desktop, gestapelt auf dem Smartphone.
  - **Links, "Briefing"**:
    - Textarea mit Zähler (max. 4.000).
    - **Stil-Dropdown** (shadcn Select mit den Gruppen "Vorlagen" und "Eigene Stile"; jede Option mit Kurzbeschreibung).
    - Brand-Voice-Select, Zielplattformen als Chips (ab Phase 4 Zielaccounts), Sprache, Button "Generieren".
  - **Mitte, "Varianten"**:
    - Ein Tab pro Ziel.
    - Ein Editor mit Live-Zähler `123 / 280`, der bei Überschreitung rot wird.
    - Hashtag-Chips, ein Feld für den ersten Kommentar (wo die Plattform es unterstützt) und Warnungs-Badges.
    - Refine-Buttons ("Kürzer", "Formeller", ...) plus ein freies Anweisungsfeld. Das Ergebnis erscheint als Diff-Dialog mit "Übernehmen" und "Verwerfen".
  - **Rechts, "Vorschau"**: Mockup der Plattform mit "...mehr"-Kürzung.
  - **Unten**: Statusanzeige zum Auto-Speichern ("Gespeichert vor 3 s"). Ab Phase 4 kommt dort die Leiste zum Planen hin.
  - **SSE-Client**: `fetch` + `eventsource-parser`, Teil-Varianten aus `variant.partial` (der Server parst das partielle JSON), `variant.reset` leert die bisherige Teilausgabe, `AbortController` beim Abbrechen oder Verlassen der Seite.
- **Darauf achten**:
  - Streaming überschreibt nie Varianten, die der Nutzer bereits bearbeitet hat.
  - Beim Verlassen mit ungespeicherten Änderungen erscheint eine Warnung.
  - Bei einem 409-Konflikt gibt es einen Dialog "neu laden oder überschreiben".
  - Zähler und Validierung kommen aus `@smp/platform-rules`, also identisch zum Server.
  - Umgesetzt unter `/w/:ws/compose` (neu, mit `?idea=` vorbefüllt) und `/w/:ws/posts/:postId`, dazu eine einfache Beitragsliste unter `/w/:ws/posts`. Die Seiten laden Beitrag, Stile und Brand Voices auf dem Server; der Zustand des Composers ist ein getesteter Reducer (`composer-model.ts`). Auto-Speichern 800 ms nach der letzten Änderung, nacheinander und mit der gelesenen `version`. Ein neuer Beitrag entsteht, sobald Briefing und eine Plattform da sind, und bekommt seine Adresse per `history.replaceState`, ohne den Editor neu zu laden ([ADR 0017](adr/0017-composer-zustand-und-auto-speichern.md)). Vor dem Generieren wird gespeichert, weil der Server aus dem gespeicherten Briefing generiert. Teil-Varianten werden über ihre Reihenfolge den Zielen zugeordnet ([ADR 0016](adr/0016-content-und-ki-api.md)). Verbotene Wörter der Brand Voice prüft dieselbe Funktion wie auf dem Server (`findForbiddenWords`). E2E-Test: `apps/web/e2e/composer.spec.ts`.
- **Fertig, wenn**: Ein E2E-Test den Ablauf Briefing, Stil, Generieren (Mock), Bearbeiten, "Kürzer", Speichern und Neuladen grün durchläuft.

#### 2.9 Web: Brand Voices, Stile, Ideen
- **So sieht es aus**:
  - **Brand-Voice-Editor**: Name, Beschreibung, Ton (Tags), Do/Don't-Listen, verbotene Wörter, Emoji-Politik (keine, sparsam, normal), Hashtag-Politik, 3 bis 5 Beispielposts, Sprache. Der Button "Stimme testen" erzeugt einen Beispielpost. Eine Versionshistorie ist einsehbar.
  - **Eigene Stile**: Name und Anweisungen, aktiv/inaktiv, Sortierung per Drag & Drop.
  - **Ideen**: Karten-Grid mit Titel, Blickwinkel, Säulen-Badge, "Warum jetzt", Plattform-Icons und den Aktionen "Speichern", "Verwerfen" und "Post erstellen" (füllt den Composer vor). Filter nach Status.
- **Umgesetzt**:
  - Brand Voices und eigene Stile unter `/w/:ws/brand-voices`, der Editor unter `/w/:ws/brand-voices/new` und `/w/:ws/brand-voices/:id`. Do- und Don't-Listen sind Textfelder mit einem Punkt pro Zeile, Ton, Vokabular und verbotene Wörter Chips. "Stimme testen" nutzt die gespeicherte Version und ist bei ungespeicherten Änderungen gesperrt. Archivieren und Wiederherstellen sitzen im Editor; ohne `brand_voice.manage` ist alles nur lesbar.
  - Stile werden per Drag & Drop oder mit Pfeil-Buttons (für die Tastatur) sortiert; gespeichert wird die neue Position jedes verschobenen Stils als `sortOrder`. Inaktive Stile erscheinen nicht im Composer.
  - Ideen unter `/w/:ws/ideas` mit den Filtern Offen (Neu und Gespeichert), Gespeichert, Verwendet, Verworfen und Alle. "Post erstellen" öffnet `/w/:ws/compose?idea=:id`: Briefing aus Titel, Blickwinkel und "Warum jetzt", Plattformen und Stil aus dem Vorschlag, dazu die Standard-Stimme. Der Beitrag entsteht beim ersten Speichern oder Generieren und markiert die Idee als verwendet. Plattformen erscheinen als Text-Badges, weil die Icon-Bibliothek keine Marken-Logos mehr enthält.
  - E2E-Test: `apps/web/e2e/brand-and-ideas.spec.ts`.
- **Fertig, wenn**: Eine Idee per Klick einen vorausgefüllten Composer öffnet.

#### 2.10 Eval-Suite
- **Erstellen**: `packages/ai/eval/{golden-briefs.json, run-eval.ts}` und das Skript `pnpm eval:ai`.
- **So sieht es aus**:
  - Golden Briefs: DE/EN x 6 Stile x 4 Plattformen.
  - Geprüft werden: Schema gültig, Länge eingehalten, keine verbotenen Wörter, richtige Sprache, Refusal-Quote, Kosten pro Generierung.
  - Ausgabe als Bericht mit Vergleich zur vorherigen Version.
- **Darauf achten**: Die Suite läuft nur mit Budget-Limit (`EVAL_BUDGET_MICROS`), nie in jedem CI-Lauf, sondern nachts oder manuell.
- **Umgesetzt**: 12 Generierungen mit je vier Zielen (48 Varianten), Prüfungen mit den Funktionen des Servers, Budgetprüfung vor jedem Aufruf, `--dry-run` und `--only`, Berichte in `packages/ai/eval/reports/` mit Vergleich zum letzten Lauf derselben Fälle. Der Workflow `.github/workflows/eval.yml` läuft von Hand oder nachts, wenn `EVAL_NIGHTLY` gesetzt ist ([ADR 0018](adr/0018-ki-eval-suite-und-baseline.md)). Die Pipeline ist mit dem Mock geprüft; die gemessene Baseline mit der Claude API steht aus, bis ein API-Key vorliegt.
- **Fertig, wenn**: Eine Baseline mit gemessenen Kosten in einem ADR dokumentiert ist.

---

## B.5 Phase 3: Medien

#### 3.1 Datenmodell
- **Erstellen**: `MediaAsset`, `MediaRendition`, `PostMedia` und die RLS-Policies dafür.
- **Umgesetzt**: Migrationen `0007_media` und `0008_rls_media` (Policy `tenant_isolation` über `workspace_id`). Ein Asset, das eine Variante verwendet, lässt sich nicht löschen (`onDelete: Restrict`); mit der Variante verschwindet nur die Verwendung. Test: `packages/db/test/rls-media.integration.test.ts`.
- **Fertig, wenn**: Migration und RLS-Check grün sind.

#### 3.2 Storage-Adapter (`packages/media`)
- **Erstellen**: `StoragePort` (core) mit `presignPut`, `head`, `signedGetUrl`, `put`, `delete`, `deletePrefix`; Adapter auf Basis von `@aws-sdk/client-s3` und `@aws-sdk/s3-request-presigner`.
- **So sieht es aus**:
  - Object-Keys: `ws/{workspaceId}/assets/{assetId}/original` und `.../renditions/{profile}-{cropHash}.jpg`.
  - Lokal mit `forcePathStyle: true`.
- **Darauf achten**: Keys enthalten nie Dateinamen der Nutzer. Presigned-URLs sind kurz gültig (PUT 5 min, GET 1 h).
- **Umgesetzt**: `S3Storage` in `@smp/media` mit zusätzlich `get` (mit Größenlimit) für den Worker. URLs für den Browser signiert ein zweiter Client für `S3_PUBLIC_ENDPOINT`, wenn die Dienste den Speicher unter einer anderen Adresse erreichen (Compose). `deletePrefix` löscht nur innerhalb eines Workspace. Thumbnails liegen als `.webp` unter demselben Schema. Test: `packages/media/test/s3-storage.integration.test.ts`.
- **Fertig, wenn**: Ein Integrationstest gegen SeaweedFS (Testcontainers) Upload, Head, signierten GET und Löschen abdeckt.

#### 3.3 Upload-Ablauf (API + Worker)
- **Erstellen**: `POST /api/w/:ws/media/uploads`, `POST /api/w/:ws/media/:id/complete`, `GET /api/w/:ws/media`, `DELETE /api/w/:ws/media/:id`, `PATCH /api/w/:ws/media/:id` (Alt-Text), Prozessor `media.process`.
- **So sieht es aus**:
  1. Der Client meldet Name, MIME-Typ und Größe.
  2. Die API prüft die Whitelist (JPEG, PNG, WebP, statisches GIF), die maximale Größe (20 MB) und die Quote, legt das Asset an und gibt die PUT-URL zurück.
  3. Beim `complete` prüft `HeadObject` Größe und Typ und reiht `media.process` ein.
  4. Der Worker prüft die Magic Bytes, dann `sharp(buf, { limitInputPixels: 50e6, failOn: 'error' }).rotate()`, konvertiert nach sRGB, entfernt EXIF/GPS, berechnet sha256 und Maße und erzeugt WebP-Thumbnails (320 und 640 px). Ergebnis: `READY` oder `REJECTED`.
- **Darauf achten**:
  - Der MIME-Typ des Clients wird nie geglaubt.
  - HEIC wird mit klarer Fehlermeldung abgelehnt.
  - Das Original wird nie ausgeliefert.
  - sharp läuft mit `sharp.cache(false)` und begrenzter Concurrency.
- **Umgesetzt**: Use Cases `RequestUpload`, `CompleteUpload`, `ProcessAsset`, `UpdateMediaAltText` und `DeleteMedia` im Core, `PrismaMediaUnitOfWork` und `MediaReadModel` in `@smp/db`, `SharpImageProcessor` in `@smp/media`, Producer `MediaProducer` in `@smp/queue`, zusätzlich `GET /api/w/:ws/media/:id`. Die Speicher-Quote gilt pro Workspace (`MEDIA_STORAGE_LIMIT_BYTES`) und wird unter einer Advisory-Sperre geprüft. Die Magic Bytes prüft eine eigene Signaturprüfung statt `file-type` ([ADR 0019](adr/0019-medien-upload-und-verarbeitung.md)). Gemessen: 11,4 MB JPEG in 610 ms auf `READY`. Tests: `apps/api/test/media.integration.test.ts`, `apps/worker/test/media.integration.test.ts`.
- **Fertig, wenn**: Ein 10-MB-JPEG in unter 5 s auf `READY` steht und eine als `.jpg` getarnte Nicht-Bild-Datei auf `REJECTED`.

#### 3.4 Renditions und Zuschnitt
- **Erstellen**: Profile in `@smp/platform-rules` (`instagram_feed`, `facebook_photo`, `linkedin_image`, `x_image`, `thumb_320`), Prozessor `media.render`, das Feld `crop` an `PostMedia`.
- **So sieht es aus**:
  - Rendition-Key: `(assetId, profile, cropHash)`.
  - Instagram: JPEG mit mozjpeg und Qualität 85; Breite 1080; Verhältnis zwischen 4:5 und 1.91:1.
  - Liegt das Verhältnis außerhalb, muss der Nutzer zuschneiden oder Letterbox wählen.
- **Darauf achten**: Alle Bilder eines Instagram-Carousels haben dasselbe Seitenverhältnis. Renditions werden beim Anhängen erzeugt und vor dem Posten erneut sichergestellt.
- **Umgesetzt**: Profile und `planRendition()` in `@smp/platform-rules` (dazu `thumb_640` für die Bibliothek), `SetVariantMedia`, `RenderRendition` und `RenderAttachedMedia` im Core, `PUT /api/w/:ws/variants/:variantId/media` mit der `version` der Variante; Varianten liefern ihre Medien mit signierten Thumbnails. Der Crop-Hash ist lesbar (`x200y0w960h1200`, `full-lb`). Passt eine Datei nicht ins Byte-Limit, sinkt erst die Qualität, dann die Größe. Instagram-Karussells mit verschiedenen Verhältnissen meldet `validatePost` als `MIXED_ASPECT_RATIOS` ([ADR 0020](adr/0020-renditions-und-zuschnitt.md)). Tests: `packages/platform-rules/src/renditions.test.ts` (Maße und Limits je Profil), `packages/media/src/sharp-image-processor.test.ts` (Byte-Limits mit echtem Encoder), `apps/worker/test/media.integration.test.ts`.
- **Fertig, wenn**: Für jedes Profil ein Test die Maße und Größen-Limits prüft.

#### 3.5 Alt-Text-Vorschlag
- **Erstellen**: `suggestAltText` im Provider, Job `ai.alt-text`, Button "Vorschlagen" in der UI.
- **So sieht es aus**: Gesendet wird die verkleinerte Rendition (längste Seite 1568 px) als Image-Block mit der Bitte um einen sachlichen Alt-Text in der Content-Sprache (max. 250 Zeichen).
- **Darauf achten**: Das zählt gegen die KI-Quote. Der Nutzer muss den Vorschlag bestätigen; es wird nichts automatisch übernommen.
- **Umgesetzt**: als synchrone KI-Route `POST /api/w/:ws/ai/alt-texts` statt als Job, weil der Nutzer auf den Vorschlag wartet ([ADR 0021](adr/0021-alt-text-vorschlag-synchron.md)). Use Case `SuggestAltText` mit der Rendition `ai_vision` (1568 px), Quote, Rate-Limits und `AiGeneration` (`ALT_TEXT`); die Antwort wird nicht gespeichert. Der Button "Vorschlagen" sitzt im Alt-Text-Feld (Schritt 3.6). Tests: `packages/core/test/ai/suggest-alt-text.test.ts`, `apps/api/test/media.integration.test.ts`.

#### 3.6 Web: Medien
- **Erstellen**: Seite `media` (Bibliothek), `MediaDropzone`, `UploadProgressList`, `CropDialog` (react-easy-crop mit Plattform-Presets), `AltTextField`, `VariantMediaStrip` (Reihenfolge per Drag & Drop mit dnd-kit).
- **So sieht es aus**:
  - Bibliothek: Grid mit Thumbnails, Status-Badges und Filtern (verwendet / unbenutzt).
  - Im Composer: ein Medienstreifen pro Variante, Warnungen wie "Instagram braucht mindestens 1 Bild" oder "X erlaubt höchstens 4 Bilder" und eine Zuschnitt-Schaltfläche pro Plattform.
- **Darauf achten**: Höchstens 3 parallele Uploads. Der Fortschritt kommt über XHR `upload.onprogress`. Die Vorschau nutzt signierte Thumbnail-URLs.
- **Umgesetzt**:
  - Bibliothek unter `/w/:ws/media` mit Filtern (alle, verwendet, unbenutzt, abgelehnt), Alt-Text mit KI-Vorschlag und Löschen.
  - Im Composer `VariantMediaStrip` mit Auswahldialog, der auch hochlädt, `CropDialog` mit den Verhältnissen der Plattform als Voreinstellungen und weißen Rändern als Alternative, dazu "Nach vorne" und "Nach hinten" für die Reihenfolge ohne Ziehen.
  - Die Medien einer Variante speichert das Auto-Speichern in einer eigenen Anfrage nach dem Text.
  - Die Vorschau zeigt den Zuschnitt als Fenster auf dem Thumbnail.
  - Die CSP erlaubt den Objektspeicher in `img-src` und `connect-src` ([ADR 0022](adr/0022-medien-im-web.md)).
  - Tests: `apps/web/e2e/media.spec.ts` (Hochladen, Prüfung durch den Worker, Anhängen an Instagram, Zuschnitt 1:1, Alt-Text vom Mock, Neuladen) und Unit-Tests für Upload-Warteschlange, Zuschnitt und Composer-Zustand.
- **Fertig, wenn**: Ein E2E-Test den Ablauf Hochladen, Zuschneiden, Anhängen und Vorschau mit Bild grün durchläuft.

---

## B.6 Phase 4: Kanäle, Publishing, Scheduling

#### 4.1 Datenmodell
- **Erstellen**: `SocialConnection`, `SocialAccount`, `PublishAttempt`, `OutboxEvent`, `WebhookEvent`, `ApiCostRecord`, die Partial Indexes aus Teil A und die RLS-Policies.
- **Umgesetzt**:
  - Migrationen `0009_channels_publishing` und `0010_rls_channels_publishing`.
  - Tokens und Sessions liegen als versiegelte Umschläge (`*_sealed`). Accounts werden getrennt, nicht gelöscht; `post_variant.social_account_id` zeigt mit `SET NULL` auf sie.
  - Zusätzlich zu den Partial Indexes aus Teil A gibt es zwei für den Sweeper (`QUEUED` nach `queued_at`, `PUBLISHING` nach `lease_until`).
  - `publish_attempt`, `outbox_event` und `api_cost_record` sind für `app_user` nicht löschbar; Outbox und Kostenbuch sind zusätzlich unveränderlich, das Relay markiert als `app_system`. `webhook_event` ist global ohne Mandant.
  - Test: `packages/db/test/rls-channels.integration.test.ts`.
- **Fertig, wenn**: Migration und RLS-Check grün sind.

#### 4.2 Verschlüsselung (`packages/crypto`)
- **Erstellen**: `seal(plaintext, aad)`, `open(sealed, aad)`, `KmsPort` (`wrapKey`, `unwrapKey`), `LocalKeyring`, Re-Wrap-Job.
- **So sieht es aus**: Bytes-Layout `ver(1) | kekIdLen(1) | kekId | wrappedDekLen(2) | wrappedDek | iv(12) | tag(16) | ciphertext`. AES-256-GCM mit zufälligem DEK (32 Byte) pro Secret. AAD ist `workspaceId:connectionId:field`.
- **Darauf achten**:
  - Der IV ist immer zufällig, nie wiederverwendet.
  - Fehlermeldungen enthalten keine Schlüssel- oder Klartextdaten.
  - Alte Schlüsselversionen bleiben zum Entschlüsseln lesbar.
- **Umgesetzt**:
  - `seal`, `open`, `rewrap` und `keyIdOf` in `@smp/crypto` mit genau diesem Layout. Fehler tragen nur einen Code (`MALFORMED`, `UNKNOWN_KEY`, `INVALID`).
  - `LocalKeyring` liest `TOKEN_KEKS`/`SESSION_KEKS` im Format von `pnpm gen:keys` und wrappt den DEK mit AES-256-GCM, die Key-ID als AAD. AWS KMS und Vault folgen mit dem Deployment (Phase 8) über denselben `KmsPort`.
  - Im Core: `SecretSealer` für die Use Cases, `connectionSecretAad`/`accountSecretAad` und der Use Case `RewrapSecrets`.
  - Der Re-Wrap ändert nur den gewrappten DEK. Er schreibt per Byte-Vergleich und erhöht die `version` nicht, damit ein gleichzeitiger Token-Refresh (bei X nur einmal gültig) nicht verloren geht. `PrismaSealedSecretStore` liest dafür als `app_system` über alle Workspaces. Eingeplant wird der Job in `tick.maintenance` (Schritt 4.3).
  - Tests: `packages/crypto/src/envelope.test.ts` (jedes einzelne Byte manipuliert, falsche AAD, Rotation), `local-keyring.test.ts`, `packages/core/test/channels/rewrap-secrets.test.ts`, `packages/db/test/sealed-secrets.integration.test.ts`.
- **Fertig, wenn**: Diese Tests grün sind: manipuliertes Byte schlägt fehl, falsche AAD schlägt fehl, Rotation (alt lesen, neu schreiben).

#### 4.3 Queues, Locks, Outbox
- **Erstellen**: in `packages/queue` alle Queues aus Teil A, Abschnitt 7.4, mit zod-Payloads und typisierten Producern sowie Builder-Funktionen für die Job-IDs; `withLock(key, ttlMs, fn)` (`SET NX PX` plus Freigabe per Lua mit Token-Vergleich); Prozessor `tick.outbox-relay`.
- **Darauf achten**:
  - Job-IDs entstehen nur über die Builder (z.B. `publishJobId(variantId, scheduleVersion)` liefert `pub.{variantId}.{scheduleVersion}`). BullMQ lehnt IDs mit `:` ab; ein Unit-Test prüft alle Builder darauf.
  - Getrennte Redis-Verbindungen für Queue-Producer und Worker.
  - Lock-TTL größer als die Laufzeit, oder der Lock wird verlängert.
  - Das Relay markiert Events erst nach erfolgreichem Einreihen als verarbeitet.
- **Umgesetzt**:
  - `@smp/queue` definiert alle Queues aus 7.4 mit zod-Payloads, Producern und Job-ID-Buildern (`jobIdOf` verbindet mit Punkt und lehnt `:` ab; `job-id.test.ts` prüft alle). Publish-, Token-, Analytics- und Media-Jobs tragen zusätzlich die `organizationId`, weil der Worker sie für den Mandanten-Kontext braucht.
  - `withLock` mit Warten (`waitMs`) und `extend`.
  - Das Relay (`PrismaOutboxRelay`) arbeitet als `app_system` in einer Transaktion: `FOR UPDATE SKIP LOCKED`, Dispatch, dann `processed_at`. Fehlgeschlagene Events bekommen `attempts`, `last_error` und eine wachsende Pause (`available_at`); verarbeitete werden nach 7 Tagen in `tick.maintenance` gelöscht.
  - Die Rolle `scheduler` hat statt des Platzhalters einen `SchedulerProcessor`, der für jeden Tick mit Handler einen Job-Scheduler anlegt. Bisher sind das `tick.outbox-relay` und `tick.maintenance` (Re-Wrap aus Schritt 4.2); die übrigen Ticks kommen mit ihren Schritten. Sie braucht `DATABASE_SYSTEM_URL` und die Keyrings.
  - `SCHEDULER_TICK_MS` steuert `tick.publish` (Standard 15 s, Zeitraffer 2 s).
  - Produzenten im Worker haben eine eigene Redis-Verbindung mit `enableOfflineQueue: false`.
  - Tests: `packages/queue/test/lock.integration.test.ts`, `packages/db/test/outbox-relay.integration.test.ts` und `apps/worker/test/outbox.integration.test.ts`. Letzterer prüft zwei parallele Relays: 60 Events ergeben genau 60 Jobs; außerdem den Tick der echten Rolle.
- **Fertig, wenn**: Ein Integrationstest zeigt, dass ein `OutboxEvent` genau einmal als Job ankommt, auch wenn zwei Relays parallel laufen.

#### 4.4 Adapter-Framework
- **Erstellen**: `packages/platform-adapters/src/http/platform-http-client.ts`, `src/rate-limit/`, `src/registry.ts`, `src/mock/mock-platform-adapter.ts`, `packages/testing/src/adapter-contract.ts`.
- **So sieht es aus**:
  - **HTTP-Client**: undici `fetch`, `AbortSignal.timeout(30_000)`, kein eigener Retry (das übernimmt der Job), zod-validierte Antworten, Mapping auf `PlatformError`.
  - Ausgewertet werden `Retry-After`, die Rate-Header von X, Metas `X-Business-Use-Case-Usage` und LinkedIns 429.
  - **Rate-Limiter**: `rate-limiter-flexible` mit Redis, Buckets pro Plattform, App und Account.
  - **Mock-Adapter**: echte Capabilities, einstellbare Latenz und `failMode` aus `SocialAccount.settings`. Dazu die Fake-OAuth-Seite `/api/dev/mock-oauth/authorize`, nur bei `PLATFORM_MODE_*=mock` und nicht in Produktion.
  - **Contract-Suite**: `describeAdapterContract(factory, fixtures)` prüft Capabilities, publish, das Fehler-Mapping 401/403/429/5xx, die Normalisierung der Metriken und reconcile.
- **Darauf achten**:
  - Request- und Response-Logs werden geschwärzt.
  - Jeder Aufruf bekommt einen OTel-Span.
  - Antworten werden nie ungeprüft weiterverarbeitet.
- **Umgesetzt**:
  - Im Core der Port `SocialPlatformAdapter` mit `OAuthConnector` und die Fehler-Taxonomie `PlatformError` (Code, Wiederholbarkeit, Wartezeit). `isPlatformError` prüft über ein Symbol, weil `instanceof` zwischen zwei Kopien eines Moduls scheitert.
  - `PlatformHttpClient`: undici `fetch` mit 30 s Timeout und ohne Retry, zod-geprüfte Antworten, `redirect: 'error'`, ein Span pro Aufruf und ein Log ohne Query, Header und Body. Kommt keine Verbindung zustande, wird der Fehler `TRANSIENT`; geht die Antwort eines nicht idempotenten Aufrufs verloren, `OUTCOME_UNKNOWN`.
  - `PlatformRateLimiter` mit Buckets pro Plattform, App und Account (Redis oder Speicher). Der Account-Bucket wird zuerst geprüft, damit ein abgelehnter Aufruf keine Punkte der App verbraucht.
  - `createAdapterRegistry` baut die `AdapterRegistry` aus `PLATFORM_MODE_*` (Meta gilt für Facebook und Instagram). Mock-Plattformen gibt es nur außerhalb der Produktion; eine Plattform auf `live` ohne Adapter verhindert den Start.
  - `MockPlatformAdapter` mit den Fail-Modes aus Teil A, Abschnitt 16, dazu `failStatus` für die Contract-Suite. Sein OAuth-Connector nutzt PKCE nur für X, wie die echten Plattformen.
  - Die Fake-OAuth-Seite `GET /api/dev/mock-oauth/authorize` (de/en nach dem Cookie der Web-App) bietet "Zugriff erlauben", eine Freigabe ohne einen Scope (Statistik, bei X `offline.access`) für den Scope-Vergleich in Schritt 4.5 und "Ablehnen". Sie leitet nur auf den eigenen Callback `APP_URL/api/oauth/{platform}/callback` zurück und steht nicht im OpenAPI-Dokument.
  - Die Contract-Suite heißt `describeAdapterContract(runner, name, factory, fixtures)`: Der Test reicht `describe`, `it` und `expect` herein, weil `@smp/testing` als CommonJS gebaut wird und Vitest sich nicht per `require` laden lässt.
  - Tests: `packages/platform-adapters/src/**/*.test.ts` (Contract-Suite für alle vier Plattformen, HTTP-Client mit msw, Rate-Limiter, Registry, Zustimmungs-Links) und `apps/api/src/modules/dev/*.test.ts`.
- **Fertig, wenn**: Der Mock-Adapter die Contract-Suite besteht.

#### 4.5 OAuth-Ablauf
- **Erstellen**:
  - `POST /api/w/:ws/channels/:platform/connect` liefert die Autorisierungs-URL.
  - `GET /api/oauth/:platform/callback` (global, damit die Redirect-URI fest registriert werden kann).
  - `GET /api/w/:ws/channels/pending/:id` und `POST /api/w/:ws/channels/pending/:id/confirm`.
  - `POST /api/w/:ws/accounts/:id/reconnect` und `DELETE /api/w/:ws/accounts/:id` (widerruft das Token und trennt den Account).
- **So sieht es aus**:
  - Der `state` liegt 10 min in Redis (`oauth:state:{state}`) zusammen mit userId, workspaceId, Plattform, Code-Verifier und Redirect-URI. Er ist nur einmal verwendbar.
  - Nach dem Code-Tausch wird das verschlüsselte Token-Set 15 min als "pending" geparkt.
  - Der Redirect geht auf `/w/:ws/accounts/connect/select?pending=...`.
- **Darauf achten**:
  - Der Callback prüft, dass der Session-Nutzer derselbe ist wie beim Start.
  - `error=access_denied` wird sauber behandelt.
  - Gewährte Scopes werden mit den angefragten verglichen; fehlen welche, wird das angezeigt.
  - Der PKCE-Verifier verlässt nie den Server.
- **Umgesetzt**:
  - Use Cases im Core: `StartConnection` (auch für "Neu verbinden"), `CompleteAuthorization`, `GetPendingConnection`, `ConfirmConnection` und `DisconnectAccount`. Ports gibt es für den `state` und die geparkte Zustimmung (Redis), für die Connectoren (die `AdapterRegistry` erfüllt den Port) und für die Zufallswerte (`oauthRandom` in `@smp/crypto`).
  - Der `state` (32 Zufallsbytes) liegt 10 min unter `oauth:state:{state}` und wird per `GETDEL` gelesen, also genau einmal. Er bindet Nutzer, Workspace, Plattform und Methode; ein Callback einer anderen Plattform oder einer anderen Session wird abgelehnt. Der PKCE-Verifier (nur X) steht nur dort.
  - Nach dem Code-Tausch liegen Token-Set und Seiten-Tokens als ein versiegelter Umschlag (AAD `workspaceId:pending.{id}:token_set`) 15 min unter `oauth:pending:{id}`, die Account-Liste ohne Tokens daneben. Beim Bestätigen wird jedes Token mit der AAD seiner Zeile neu versiegelt.
  - Der Callback `GET /api/oauth/:platform/callback` ist öffentlich und prüft die Session selbst. Ohne Session geht es zur Anmeldung, sonst zur Auswahl `/w/:ws/accounts/connect/select?pending=...` oder zurück auf `/w/:ws/accounts?connect_error=...` (`ACCESS_DENIED`, `USER_MISMATCH`, `EXCHANGE_FAILED` und weitere aus `CONNECT_FAILURES`). Ist der `state` unbekannt oder abgelaufen, ist auch der Workspace unbekannt; dann geht es auf `/?connect_error=STATE_INVALID`.
  - Eine Zustimmung desselben Plattform-Nutzers erneuert die bestehende Verbindung; verbundene und getrennte Accounts kommen unter ihrer ID zurück. "Neu verbinden" läuft deshalb über dieselbe Auswahlseite, mit dem Account vorausgewählt.
  - Trennen markiert den Account (Token gelöscht, Historie bleibt). Nutzt kein anderer Account die Verbindung mehr, wird sie `REVOKED` und verliert ihre Tokens; nach dem Commit wird der Zugriff bei der Plattform widerrufen. Scheitert das, wird es nur geloggt.
  - Zusätzlich für die Seiten aus Schritt 4.11: `GET /api/w/:ws/channels` (Plattformen mit Methode) und `GET /api/w/:ws/accounts` (Status, Ablauf des Zugangs, fehlende Scopes). Verbinden und Trennen brauchen `account.manage` (Owner, Admin), das Lesen `workspace.read`.
  - Die API braucht dafür `TOKEN_KEKS` und `TOKEN_KEK_ACTIVE`.
  - Tests: `packages/core/test/channels/oauth-flow.test.ts`, `packages/db/test/channel-adapters.integration.test.ts` und `apps/api/test/channels.integration.test.ts`. Letzterer prüft den kompletten Ablauf mit der Mock-Seite: abgelehnte Zustimmung, abgelaufener und doppelt benutzter `state`, fremde Session, PKCE, Teil-Zustimmung, Neu verbinden und Trennen.
  - Nicht gegen die Doku geprüft (die Netzwerkrichtlinie sperrt learn.microsoft.com): LinkedIns Fehlerwerte `user_cancelled_login` und `user_cancelled_authorize` für eine abgelehnte Zustimmung.
- **Fertig, wenn**: Mit dem Mock-OAuth der komplette Ablauf grün ist, inklusive abgelehnter Zustimmung und abgelaufenem state.

#### 4.6 Publishing-Domain
- **Erstellen**: `packages/core/src/publishing/domain/variant-state-machine.ts` und die Use Cases `ScheduleVariant`, `RescheduleVariant`, `CancelVariant`, `PublishNow`, `RetryVariant`, `ResolveNeedsAttention`.
- **So sieht es aus**: Die Übergangstabelle aus Teil A, Abschnitt 7.2. Jeder Use Case prüft per `can(role, permission)`, validiert (`validatePost`, Account-Status, Token-Ablauf, Quote) und schreibt Status, `scheduleVersion`, `OutboxEvent` und Audit-Eintrag in einer Transaktion.
- **Darauf achten**: Die Eingabe ist `{ localDateTime, timeZone }`. Zeiten in einer Zeitumstellungslücke ergeben 422 mit Vorschlag; Zeitpunkte in der Vergangenheit sind verboten (außer "Jetzt posten").
- **Umgesetzt**:
  - `VARIANT_TRANSITIONS` in `variant-state-machine.ts`, mit den Ergänzungen aus [ADR 0023](adr/0023-planen-zeitzonen-und-zustandsautomat.md) ("Jetzt posten", Abbrechen aus `QUEUED` und `RETRYING`, die drei Antworten auf `NEEDS_ATTENTION`, Übernahme nach abgelaufenem Lease).
  - `resolveLocalTime` rechnet im Core mit `Intl` statt mit `@date-fns/tz` in der API. Eine Zeit in der Lücke ergibt `SCHEDULE_TIME_IN_GAP` mit der ersten gültigen Minute danach in `params.suggestion`; eine doppelte Zeit nimmt den früheren Offset.
  - Use Cases `ScheduleVariant` (aus `DRAFT`, `CANCELED`), `RescheduleVariant` (aus `SCHEDULED`, `QUEUED`), `CancelVariant` (aus `SCHEDULED`, `QUEUED`, `RETRYING`), `PublishNow`, `RetryVariant` (aus `FAILED`, `NEEDS_ATTENTION`, jetzt oder später) und `ResolveNeedsAttention` (`recheck`, `publish_anyway`, `discard`).
  - Geprüft werden Rolle (Editor und höher), Zeitpunkt, Account (verbunden, gleiche Plattform, Verbindung `ACTIVE` oder `EXPIRING`) und Inhalt (`validatePost` mit den Bildern nach Zuschnitt und Letterbox, dazu "nicht leer"). Läuft der Zugang vor dem Zeitpunkt ab, gibt es nur eine Warnung. Die Quote folgt mit den Tarifen (Phase 7).
  - Jeder Wechsel schreibt Status, neue `scheduleVersion`, Outbox-Ereignisse (`variant.status`, bei `QUEUED` zusätzlich `publish.requested`) und den Audit-Eintrag in einer Transaktion. Das Relay gibt `variant.status` an den Redis-Kanal `ws:{workspaceId}:events` weiter.
  - Bearbeiten macht `FAILED` und `CANCELED` wieder zu `DRAFT`, eine geplante Variante bleibt geplant, `NEEDS_ATTENTION` ist gesperrt.
  - API: `POST /api/w/:ws/variants/:id/{schedule,reschedule,cancel,publish-now,retry,resolve}`, Antwort mit der aktuellen Variante und den Warnungen. Domain-Fehler geben `params` im Problem-Dokument weiter.
  - Tests: `packages/core/test/publishing/variant-state-machine.test.ts` (alle 100 Paare), `local-time.test.ts` (Beispiele und Property-Tests über elf Zonen und zwanzig Jahre), `planning.test.ts`, `packages/db/test/publishing-adapters.integration.test.ts` und `apps/api/test/publishing.integration.test.ts`.
- **Fertig, wenn**: Alle erlaubten und verbotenen Übergänge als Tabellentest grün sind, dazu Property-Tests für die Zeitumstellung (fast-check).

#### 4.7 Scheduler, Sweeper, verpasste Zeitfenster
- **Erstellen**: Prozessoren `tick.publish` (15 s), `tick.sweep-queued` (60 s, auch für `PUBLISHING` mit abgelaufenem Lease) und die Missed-Window-Prüfung im Tick.
- **So sieht es aus**: SQL aus Teil A, Abschnitt 7, über den System-Client. Danach läuft jede Variante im eigenen Mandanten-Kontext weiter. Job-ID: `pub.{variantId}.{scheduleVersion}`.
- **Darauf achten**:
  - Erst nach dem Commit einreihen. Bei 2 parallelen Workern darf es kein doppeltes Einreihen geben (`SKIP LOCKED` plus Job-ID).
  - Der Sweeper prüft den vorhandenen Job: Fehlt er, wird er neu eingereiht. Liegt er unter derselben Job-ID noch als fehlgeschlagen vor, ignoriert BullMQ ein erneutes `add`; dann wird er per `job.retry()` neu gestartet.
- **Umgesetzt**:
  - `PrismaPublishScheduler` (System-Client) arbeitet in einer Transaktion mit `FOR UPDATE SKIP LOCKED`: Pläne, die mehr als 6 h überfällig sind, gehen auf `FAILED` mit `MISSED_WINDOW` (außer bei `missed_window_behavior = POST_ANYWAY`), fällige (bis 30 s im Voraus) auf `QUEUED`. Jede Änderung schreibt ihr Outbox-Ereignis `variant.status`.
  - `tick.publish` reiht nach dem Commit für jede Variante `publish.variant` mit der Job-ID `pub.{variantId}.{scheduleVersion}` und einer Verzögerung bis zur geplanten Zeit ein, in bis zu zehn Paketen zu 500 pro Tick. Ein Job, der sich nicht einreihen lässt, bleibt dem Sweeper.
  - `tick.sweep-queued` (60 s) prüft Varianten, die seit mehr als 2 min auf `QUEUED` stehen, `PUBLISHING` mit abgelaufenem Lease und zusätzlich `RETRYING` seit mehr als 3 h (länger als der längste Backoff). Fehlt der Job, wird er neu eingereiht (Trigger `sweep`); liegt er als fehlgeschlagen oder erledigt vor, startet ihn `job.retry()` neu; läuft er noch, bleibt er unberührt.
  - Ein verpasstes Zeitfenster schreibt zusätzlich das Outbox-Ereignis `notification.requested` (Schritt 4.9).
  - Tests: `apps/worker/test/scheduler.integration.test.ts` (zwei Worker gleichzeitig: 1000 fällige Varianten ergeben genau 1000 Jobs; verpasstes Zeitfenster mit beiden Einstellungen; Sweeper mit verlorenem, fehlgeschlagenem, abgestürztem und noch wartendem Job) und Unit-Tests für Tick und Sweeper.
- **Fertig, wenn**: Ein Integrationstest mit 2 Workern und 1.000 fälligen Varianten genau 1.000 Jobs ergibt.

#### 4.8 Publish-Prozessor
- **Erstellen**: `apps/worker/src/processors/publish.processor.ts`.
- **So sieht es aus**: die Schritte 1 bis 9 aus Teil A, Abschnitt 7, plus die Fehlertabelle aus 7.1.
  - `RATE_LIMITED`: `await job.moveToDelayed(Date.now() + retryAfter, token)` und anschließend `throw new DelayedError()`.
  - Permanente Fehler: `throw new UnrecoverableError(code)`.
  - Die Backoff-Strategie ist im Worker als `settings.backoffStrategy` hinterlegt.
- **Darauf achten**:
  - Der Lease-Claim läuft per Compare-and-Swap auf `version`. Vor langen Schritten (Instagram-Polling bis 5 min) wird `leaseUntil` auf dieselbe Weise verlängert, sonst läuft der Lease mitten im Versuch ab.
  - Nach unklarem Ausgang folgt immer zuerst `reconcile()`.
  - Das Token wird unter Lock erneuert und danach neu gelesen.
  - Dry-Run sendet nichts.
  - Kostensätze werden bei X geschrieben.
- **Umgesetzt**:
  - Use Case `PublishVariant` im Core (`packages/core/src/publishing/application/`: Claim in `publish-variant.ts`, der Lauf in `publish-run.ts`, die Tokens in `connection-tokens.ts`, seit Schritt 4.9 im Kontext `channels`, das Ende in `run-end.ts`) mit den Ports aus `ports/publish-job.ts`. Die Fehlertabelle aus 7.1 ist die reine Funktion `reactionTo`.
  - Claim in einer Transaktion: Zeile sperren (`FOR UPDATE`), Status und `scheduleVersion` prüfen, auf den lebenden Lease eines anderen Laufs warten (`moveToDelayed`, ohne Versuch), verpasstes Zeitfenster bei den automatischen Triggern, Lease per Compare-and-Swap auf `version`, Versuch `STARTED`, Outbox-Ereignis `PUBLISHING`. Inhaber des Lease ist das Lock-Token des Laufs in BullMQ.
  - Lauf: Token unter `lock:conn:{id}` erneuern und danach neu lesen (vor dem Reconcile, weil der Reconcile liest), Reconcile nach offenen Versuchen, erneut validieren mit den Renditions der Plattform und signierten URLs (1 h), Lease verlängern, Schreibmarke `UNKNOWN`, senden. `AdapterContext.keepAlive()` verlängert den Lease vor langen Schritten eines Adapters. Die Entscheidungen stehen in [ADR 0024](adr/0024-publish-job-schreibmarke-und-lease.md).
  - Ende in einer Transaktion: Kostensätze (einmal pro Versuch und Operation, zu den Preisen aus `PLATFORM_OPERATION_PRICES_MICROS`), Versuch, wo nötig `NEEDS_REAUTH`, Variante (nur solange der Lauf den Lease hält) und Outbox-Ereignis. `PUBLISHED` setzt `metricsNextAt` (+1 h, bei X +24 h).
  - Dry-Run (Workspace oder `PUBLISH_DRY_RUN` bei echten Adaptern): erneuert das Token und validiert, liest und sendet nicht und speichert den Payload-Snapshot ohne signierte URLs.
  - Worker: `apps/worker/src/processors/publish.processor.ts` übersetzt die Ergebnisse in BullMQ: Rate-Limit und fremder Lease mit `moveToDelayed` und `DelayedError`, endgültige Fehler mit `UnrecoverableError`, sonst Backoff. `PublishWorker` baut den BullMQ-Worker selbst, mit `settings.backoffStrategy` (30 s, 2 min, 8 min, 30 min, 2 h, Jitter 20 %, mindestens die Wartezeit der Plattform) und den Variablen `PUBLISH_CONCURRENCY`, `PUBLISH_LOCK_MS` und `PUBLISH_LEASE_MS`. Endgültig gescheiterte Jobs landen als Kopie in der Queue `publish-dead`; die Metrik `smp_worker_publish_dead_letters_total` ist die Grundlage für den Alarm.
  - Die Rolle `publisher` braucht `DATABASE_URL`, `TOKEN_KEKS`, `TOKEN_KEK_ACTIVE` und die S3-Variablen; die Plattformen kommen aus `PLATFORM_MODE_*`.
  - Der Mock von X bucht `x.post_create`, `x.post_create_with_url` und pro gelesenem Post `x.post_read`. Die Preise von X stammen aus Sekundärquellen und werden mit Schritt 4.14 gegen die Doku geprüft.
  - Tests: `packages/core/test/publishing/publish-variant.test.ts` und `publish-job-rules.test.ts`, `packages/db/test/publish-job-adapters.integration.test.ts` (zwei Jobs derselben Variante: genau einer sendet), Unit-Tests für Prozessor und Backoff, und `apps/worker/test/publish.integration.test.ts` mit dem Chaos-Test, dem endgültig gescheiterten Job samt Sweeper, einem Rate-Limit ohne verbrauchten Versuch und einem abgelehnten Post.
  - Seit Schritt 4.9 schreiben `FAILED`, `NEEDS_ATTENTION` und das verpasste Zeitfenster das Outbox-Ereignis `notification.requested`.
- **Fertig, wenn**: Der Chaos-Test grün ist: den Worker mitten in `publish` beenden, neu starten, und es gibt keinen doppelten Post (Mock zählt die Aufrufe). Ein zweiter Test lässt den Job endgültig scheitern; der Sweeper holt die Variante aus `PUBLISHING` zurück.

#### 4.9 Token-Überwachung und Benachrichtigungen
- **Erstellen**: `tick.tokens` (stündlich), `token.refresh`, die Templates `token-expiring`, `reauth-required`, `publish-failed` und `needs-attention` (de/en), sowie In-App-Benachrichtigungen.
- **So sieht es aus**:
  - Verbindungen mit Ablauf innerhalb von 14 Tagen werden, wo möglich, erneuert, sonst als `EXPIRING` markiert.
  - Benachrichtigungen gehen bei T-14, T-7 und T-1 Tagen raus.
  - Nach dem Ablauf wird die Verbindung auf `NEEDS_REAUTH` gesetzt und die betroffenen geplanten Varianten werden markiert.
- **Darauf achten**: Benachrichtigungen werden dedupliziert (eine pro Stufe) und respektieren die Nutzereinstellungen.
- **Umgesetzt** ([ADR 0025](adr/0025-benachrichtigungen-und-token-monitor.md)):
  - **Token-Monitor**: `MonitorTokens` (Kontext `channels`) sieht in `tick.tokens` (stündlich, Rolle `scheduler`) die Verbindungen, deren Zugang in 14 Tagen endet. Eine aktive Verbindung bekommt `token.refresh` (`tok.{connectionId}`, Rolle `publisher`). `RefreshConnection` erneuert unter `lock:conn:{id}`, setzt `EXPIRING`, wenn die Plattform keinen Refresh bietet, und `NEEDS_REAUTH`, wenn sie ihn ablehnt. Eine `EXPIRING`-Verbindung erinnert ihre Owner und Admins bei 14, 7 und 1 Tag, je Stufe einmal (`expiry_notice_days`). Nach dem Ablauf folgt `NEEDS_REAUTH(EXPIRED)`.
  - **Markierte Varianten**: Wird eine Verbindung `NEEDS_REAUTH` (Monitor, Refresh oder Publish-Job), tragen die `SCHEDULED`-Varianten ihrer Accounts den Fehlercode `REAUTH_REQUIRED`; Status und `version` bleiben. Ein neuer Grant nimmt die Markierung ab. Die Token-Logik des Publish-Jobs (`ConnectionTokens`) liegt jetzt in `channels` und wird von beiden Jobs geteilt.
  - **Zustellung**: Use Cases schreiben das Outbox-Ereignis `notification.requested`; der Relay reicht es als `notify.dispatch` (`ntf.{outboxId}`) an die Rolle `notify`. `DeliverNotification` liest den Inhalt im Mandanten des Ereignisses und findet die Empfänger: Owner und Admins für Verbindungen, die Person, die den Post erstellt hat, für Posts (sonst Owner und Admins). Pro Nutzer und Ereignis entsteht höchstens eine Benachrichtigung in der App (Migration `0011_notification_events`), und pro Empfänger höchstens eine E-Mail (`ntf.{outboxId}.{userId}`). Beide Jobs bleiben nach dem Lauf einen Tag, damit ein zweiter Dispatch nichts doppelt sendet. Ohne Einstellung sind beide Kanäle an.
  - **E-Mails** in `@smp/emails` (de und en): Sie nennen die Plattform und bis zu drei Accounts (weitere als Zahl), datieren den Ablauf in der Zeitzone des Workspace und verlinken die Accounts-Seite oder den Post unter `APP_URL`. Die Rolle `notify` braucht dafür `APP_URL` und die Datenbank als `app_user`.
  - **API**: `GET /api/me/notifications` (neueste zuerst, Cursor, nur Workspaces, die der Nutzer öffnen darf), `GET /api/me/notifications/unread-count`, `POST /api/me/notifications/read` und `/read-all`, `GET` und `PUT /api/me/notification-preferences`.
  - **Web**: Die Glocke im App-Shell zeigt die neuesten 10 mit Zähler, markiert beim Öffnen eines Eintrags und auf Wunsch alle als gelesen und fragt alle 30 s nach, bis Schritt 4.10 Live-Events liefert. Die Seite `/account/notifications` stellt pro Typ "In der App" und "Per E-Mail" ein.
  - **Mock**: Instagram und X (mit Refresh Token) erneuern, LinkedIn und Facebook antworten `not_supported` wie die echten Plattformen.
  - Nachgezogen: Der Test der Migrationen und die Rechte-Matrix kannten die Migrationen und Routen der Schritte 4.1, 4.5 und 4.6 noch nicht; beide Integrations-Suiten sind wieder grün.
  - Tests: `packages/core/test/notifications/*` und `channels/token-monitor.test.ts`, `packages/db/test/notification-adapters.integration.test.ts` und `token-maintenance-adapters.integration.test.ts`, `packages/emails/src/*.test.ts`, `apps/worker/test/notify.integration.test.ts` (Ereignis bis Mailpit und Glocke, ein zweiter Dispatch sendet nichts), `publish.integration.test.ts` (`token.refresh`), `scheduler.integration.test.ts` (Benachrichtigung zum verpassten Zeitfenster) und `apps/api/test/notifications.integration.test.ts`.

#### 4.10 Live-Events
- **Erstellen**: Redis Pub/Sub `ws:{workspaceId}:events` und `GET /api/w/:ws/events` (`@Sse()`, hier passt GET).
- **So sieht es aus**: Events wie `{ type: 'variant.status', variantId, status }` und `{ type: 'notification.created', id }`. Das Web invalidiert daraufhin die passenden Query-Keys.
- **Darauf achten**: Die Berechtigung wird beim Verbindungsaufbau geprüft. Pro Nutzer und Tab gibt es höchstens eine Verbindung; als Fallback wird alle 30 s gepollt.

#### 4.11 Web: Accounts, Kalender, Posts, Planen
- **Erstellen**: Seiten `accounts` und `accounts/connect/select`, `calendar`, `posts`; `ScheduleBar` im Composer; Dashboard-Widget "Nächster Post".
- **So sieht es aus**:
  - **Accounts**:
    - Je eine Karte pro Plattform mit "Verbinden".
    - Verbundene Accounts mit Avatar, Name, Typ (Profil, Seite, Business), Status-Badge (Aktiv, Läuft bald ab, Neu verbinden nötig), Ablaufdatum und den Aktionen "Neu verbinden" und "Trennen".
    - Bei X die Wahl der Methode (API Standard, Browser experimentell, ab Phase 6) und die bisherigen Kosten.
    - Auswahlseite nach dem OAuth: Checkboxen pro verbindbarem Account.
  - **Kalender**:
    - Ansichten Monat, Woche und Liste.
    - Ein Event zeigt Plattform-Icon, Uhrzeit, die ersten 40 Zeichen und ein Status-Icon.
    - Klick öffnet den Composer; Drag & Drop plant optimistisch um und rollt bei Fehlern zurück.
    - Die Zeitzone ist umschaltbar (Workspace oder eigene).
  - **Posts**: Tabelle mit den Spalten Vorschau, Account, Status, Geplant für, Veröffentlicht, Aktionen. Filter nach Status, Plattform, Account und Zeitraum; Massenaktionen Abbrechen und Löschen; Link zum Original-Post.
  - **Planen-Leiste**: Datum, Uhrzeit, Anzeige der Zeitzone, "Planen", "Jetzt posten", Zeitpunkt pro Variante überschreibbar, Kostenhinweis bei X, Hinweis bei bald ablaufendem Token.
  - **Dashboard-Widget**: die nächsten 5 geplanten Posts mit Countdown.
- **Darauf achten**:
  - Vergangene Zeitpunkte sind im Kalender nicht als Ziel erlaubt.
  - Tastaturnutzer bekommen einen Dialog "Umplanen".
  - Der Status-Badge aktualisiert sich live.
- **Fertig, wenn**: Ein E2E-Test mit Mock den Ablauf Planen (+1 min), veröffentlicht, Badge aktualisiert und Umplanen per Drag & Drop grün durchläuft.

#### 4.12 LinkedIn-Adapter (4a)
- **Erstellen**: `packages/platform-adapters/src/linkedin/*` mit Connector, Adapter, Image-Upload, Text-Escaping und Fixtures.
- **So sieht es aus**:
  - Die Personen-URN kommt aus OIDC `userinfo.sub` (`urn:li:person:{sub}`). Organisationen kommen über `GET /rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR`.
  - Post-Body:
    ```json
    { "author": "urn:li:person:...", "commentary": "...", "visibility": "PUBLIC",
      "distribution": { "feedDistribution": "MAIN_FEED", "targetEntities": [], "thirdPartyDistributionChannels": [] },
      "content": { "media": { "id": "urn:li:image:...", "altText": "..." } },
      "lifecycleState": "PUBLISHED", "isReshareDisabledByAuthor": false }
    ```
  - Die Post-ID kommt aus dem Response-Header `x-restli-id`.
  - Jeder Request sendet die Header `LinkedIn-Version: YYYYMM` und `X-Restli-Protocol-Version: 2.0.0`.
- **Darauf achten**:
  - **Little Text Format**: Reservierte Zeichen in `commentary` müssen escaped werden, sonst wird der Text abgeschnitten. Hashtags haben ein Template-Format. Beides gegen die aktuelle Doku prüfen.
  - Reconcile ist bei Personen-Posts nur eingeschränkt möglich, weil das Lesen eigener Posts eine zusätzliche Berechtigung braucht. Bei unklarem Ausgang wird die Variante deshalb direkt auf `NEEDS_ATTENTION` gesetzt.
  - Ohne Refresh Token gilt der 60-Tage-Ablauf.
  - Im Development-Tier sind die Aufrufe pro Tag begrenzt.
- **Fertig, wenn**: Die Contract-Suite mit Fixtures grün ist und ein echter Test-Post auf Staging erscheint (zuerst im Dry-Run).

#### 4.13 Meta-Adapter (4b)
- **Erstellen**: `meta/facebook-adapter.ts`, `meta/instagram-adapter.ts`, die Connectors (Facebook Login for Business; Instagram Login), Webhooks `POST /api/webhooks/meta/deauthorize` und `POST /api/webhooks/meta/data-deletion`.
- **So sieht es aus**:
  - **Facebook**: ein Foto über `/{page}/photos`; mehrere Fotos unveröffentlicht hochladen und dann `/{page}/feed` mit `attached_media`.
  - **Instagram**:
    1. `content_publishing_limit` prüfen.
    2. `POST /{ig-user}/media` mit `image_url` (signierte `.jpg`-URL) und Caption; für ein Carousel zuerst die Kinder, dann der Parent.
    3. `status_code` mit Backoff abfragen (5 s, 15 s, 30 s, dann minütlich, maximal 5 min).
    4. `POST /{ig-user}/media_publish`.

    Die Container-IDs werden in `PublishAttempt.meta` gespeichert.
  - **Data-Deletion-Callback**: `signed_request` per HMAC-SHA256 mit dem App-Secret prüfen; die Antwort ist `{ url, confirmation_code }`.
- **Darauf achten**:
  - Der Dev-Modus funktioniert nur für Nutzer mit einer App-Rolle.
  - Fehler 190 bedeutet, dass das Token ungültig ist.
  - Instagram akzeptiert nur JPEG.
  - Für Carousels gilt dasselbe Seitenverhältnis.
  - Die Metriknamen ändern sich laufend (z.B. `views` statt `impressions`).
  - Die Graph-API-Version wird gepinnt.
- **Fertig, wenn**: Auf Staging Facebook- und Instagram-Test-Posts mit Bild erscheinen und das App-Review eingereicht ist.

#### 4.14 X-API-Adapter (4c)
- **Erstellen**: `x/connector.ts` (OAuth 2.0 mit PKCE S256), `x/adapter.ts`, `x/media-upload.ts`, Kosten-Recorder, Ausgabenlimit, Endpunkt `GET /api/w/:ws/x/cost-estimate`.
- **So sieht es aus**:
  - `POST /2/tweets` mit `{ text, media: { media_ids } }`; Medien über den v2-Upload, Alt-Text über den Metadata-Endpunkt (Formen gegen die Doku prüfen).
  - Vor jedem kostenpflichtigen Aufruf wird das Ausgabenlimit reserviert, danach wird ein `ApiCostRecord` geschrieben (PriceBook-Keys `x.post_create`, `x.post_create_with_url`, `x.post_read`, `x.media_upload`).
- **Darauf achten**:
  - Refresh Tokens rotieren und sind nur einmal gültig, deshalb wird unter Lock erneuert und danach neu gelesen.
  - Links machen den Post teurer; das zeigt die Kostenvorschau an.
  - Doppelter Inhalt führt zu `DUPLICATE`.
  - Reconcile liest nur die letzten 5 eigenen Posts, weil Lesen Geld kostet.
- **Fertig, wenn**: Auf Staging ein X-Test-Post erscheint und die Kosten pro Workspace korrekt erfasst sind.

---

## B.7 Phase 5: Analytics

#### 5.1 Datenmodell
- **Erstellen**: `MetricSnapshot`, `PostMetricLatest`, `AccountMetricSnapshot`, `AnalyticsDaily`, die Indizes aus Teil A und RLS.

#### 5.2 Planer und Collector
- **Erstellen**: `tick.analytics` (5 min), `metrics.post`, `metrics.account`, Normalisierungs-Mappings `src/<platform>/metrics-map.ts` mit `MAP_VERSION`.
- **So sieht es aus**:
  - Der Planer wählt die fälligen Varianten (`metrics_next_at <= now()`), gruppiert sie pro Account und erzeugt Batches (X bis 100, Meta bis 50).
  - Der Collector führt `fetchPostMetrics` aus, normalisiert, fügt einen Snapshot ein, aktualisiert `PostMetricLatest` (nur wenn neuer) und setzt `metricsStep`/`metricsNextAt` weiter. Bei X werden die Lesekosten erfasst.
  - Gelöschte Posts (404) bekommen die Markierung "extern gelöscht" und keine weiteren Abrufe.
- **Darauf achten**: Fehlende Werte sind `null`, nicht 0. Rohdaten bleiben immer erhalten. Die Kaskade ist per `ANALYTICS_CADENCE_SCALE` für Tests beschleunigbar.
- **Fertig, wenn**: Normalisierungstests mit echten (bereinigten) Payloads pro Plattform grün sind.

#### 5.3 Rollups
- **Erstellen**: `metrics.rollup` (nach jedem Collector-Lauf für den betroffenen Tag) und einen nächtlichen Komplettlauf über die letzten 35 Tage.
- **So sieht es aus**: `AnalyticsDaily` wird per SQL-Upsert aus den Deltas aufeinanderfolgender Snapshots befüllt, pro Account und Tag in der **Workspace-Zeitzone**.
- **Darauf achten**: Tagesgrenzen richten sich nach der Workspace-Zeitzone, nicht nach UTC. Die Reichweite wird nicht summiert, sondern als "Summe der Post-Reichweiten" gekennzeichnet.

#### 5.4 Analytics-API
- **Erstellen**:
  - `GET /api/w/:ws/analytics/overview` (KPIs + Vorzeitraum)
  - `GET /api/w/:ws/analytics/timeseries?metric&granularity`
  - `GET /api/w/:ws/analytics/top-posts`
  - `GET /api/w/:ws/analytics/breakdown?by=platform|style|weekday`
  - `GET /api/w/:ws/analytics/posts/:variantId`
  - `GET /api/w/:ws/analytics/accounts/:id`
  - `GET /api/w/:ws/analytics/export.csv` (gestreamt)
- **Darauf achten**: Quoten und Raten werden einheitlich auf dem Server berechnet. Die Übersicht wird 5 min in Redis gecacht. Der Zeitraum ist durch die Analytics-Historie des Tarifs begrenzt.

#### 5.5 Web: Dashboard und Analytics
- **So sieht es aus** (bei der Umsetzung das `dataviz`-Skill für Farben und Diagrammregeln laden):
  - **Filterleiste**: Zeitraum (7, 30, 90 Tage, frei wählbar), Plattformen, Accounts.
  - **KPI-Reihe** mit 6 Kacheln: Impressions, Reichweite, Engagements, Engagement-Rate, Follower-Zuwachs, Veröffentlichte Posts; jeweils mit Veränderung zum Vorzeitraum und Sparkline.
  - **Liniendiagramm** über die Zeit pro Plattform; **Balkendiagramm** für den Plattformvergleich.
  - **Tabelle** der Top-Posts und eine Auswertung nach Post-Stil.
  - Die Detailseiten für Post und Account zeigen den Verlauf der Snapshots.
  - **Leerer Zustand**: "Noch keine Daten. Erste Metriken etwa 1 Stunde nach der Veröffentlichung."
- **Darauf achten**: "n. v." und 0 werden sichtbar unterschieden. Die Diagramme sind barrierefrei (Tabellenalternative, keine Information nur über Farbe).
- **Fertig, wenn**: Mit Seed-Daten (90 Tage) alle Ansichten korrekt rendern und die Zahlen auf Staging im Rahmen der Toleranz mit den Plattform-UIs übereinstimmen.

#### 5.6 Rückkopplung in die Themenvorschläge
- **Erstellen**: Die Top-5-Performer der letzten 90 Tage fließen in `suggestTopics` ein.
- **Fertig, wenn**: Die Themenideen in `basedOn` auf echte Posts verweisen.

---

## B.8 Phase 6: X-Browser-Adapter (Feature-Flag)

#### 6.1 Recht und Freischaltung
- **Erstellen**: `RiskAcknowledgement`, die Rechtstexte `packages/contracts/src/legal/x-browser-risk.{de,en}.md` (versioniert, mit Hash), die Flags `x_browser_automation` (global als Kill-Switch und pro Workspace), das Tarif-Gate (bis Phase 7 nur per Plattform-Admin).
- **So sieht es aus**: In den Einstellungen gibt es den Bereich "X ohne API (experimentell)" mit Risikotext, der Checkbox "Ich habe die Risiken verstanden" und einer erneuten Passwortabfrage.
- **Darauf achten**: Eine neue Textversion erfordert eine neue Bestätigung. Ohne gültige Bestätigung verweigert die Registry den Adapter.

#### 6.2 Laufzeit des browser-worker
- **So sieht es aus**:
  - Ein Browser pro Container.
  - Pro Task ein neuer Kontext mit dem entschlüsselten `storageState`, Timeout 30 s pro Aktion, realistischer Viewport, Sprache des Accounts.
  - Nach dem Task wird der aktualisierte `storageState` verschlüsselt zurückgegeben.
- **Darauf achten**:
  - Keine Stealth-Plugins und keine Fingerprint-Manipulation.
  - Kein DB-Zugriff.
  - Egress nur zu den Domains der X-Web-App und zu S3, durchgesetzt über das Docker-Netz bzw. einen Proxy; intern nur Redis. `x.com` allein reicht nicht, weil die Web-App Skripte und Bilder von weiteren Hosts lädt (z.B. `*.x.com`, `*.twimg.com`). Die Liste wird gegen die Live-UI ermittelt und mit den Selector-Maps versioniert.
  - Höchstens ein Task pro Account (Lock) und mindestens 2 min Abstand zwischen Posts pro Account.

#### 6.3 Selector-Maps und Flows (`packages/x-browser`)
- **Erstellen**: `selectors/v1.ts` und die Flows `login`, `verifySession`, `publish`, `metrics`, `delete`, `detectChallenge`.
- **So sieht es aus** (Form; die echten Selektoren werden in Phase 6 gegen die Live-UI ermittelt):
  ```ts
  export const selectorsV1 = {
    version: 'x-v1',
    composer: { textbox: { role: 'textbox' }, fileInput: { css: 'input[type=file]' }, submit: { testId: 'tweetButton' } },
    challenge: { urlPatterns: [/\/account\/access/, /challenge/i] },
    network: { createPost: /\/graphql\/[^/]+\/CreateTweet/, postDetail: /\/graphql\/[^/]+\/TweetDetail/ },
  } as const;
  ```
  Nach jeder Navigation läuft `detectChallenge`. Wird eine Challenge erkannt, endet der Flow sofort mit `CHALLENGE_REQUIRED`.
- **Darauf achten**: Die Post-ID und die Metriken kommen aus den JSON-Antworten, nie aus geparstem HTML. Fehlt ein Selector, endet der Flow mit `SELECTOR_DRIFT`; es gibt keine Rate-Versuche.

#### 6.4 Interaktiver Login
- **Erstellen**: `POST /api/w/:ws/x-browser/login-sessions`, `POST .../login-sessions/:id/code`, Status über SSE, Job `xb.login.start`.
- **So sieht es aus**:
  1. Der Nutzer gibt Benutzername und Passwort ein.
  2. Die API verschlüsselt die Zugangsdaten mit dem Session-Keyring (`SESSION_KEKS`) und legt sie nur in den Job-Payload; entschlüsselt werden sie nur im browser-worker.
  3. Der Worker meldet `AWAITING_2FA`, die UI fragt den Code ab und reicht ihn über Redis (`xb:login:{id}:input`) weiter.
  4. Bei Erfolg wird der `storageState` gespeichert. Zeitlimit insgesamt 5 min.
- **Darauf achten**: Zugangsdaten werden nie in der DB gespeichert und nie geloggt. Der Job wird sofort nach Abschluss gelöscht (`removeOnComplete` und `removeOnFail` auf `true`).

#### 6.5 Canary und Circuit Breaker
- **Erstellen**: `xb.canary` (täglich, interner Test-Account, prüft nur das Vorhandensein der Selektoren) und den Circuit Breaker.
- **So sieht es aus**: Drei `SELECTOR_DRIFT` innerhalb einer Stunde setzen das globale Flag auf aus und alarmieren die Admins.

#### 6.6 Tests
- **So sieht es aus**: Lokale DOM-Fixtures (über `page.route` ausgeliefert) für Login, Composer, Challenge und Drift, dazu aufgezeichnete JSON-Antworten.
- **Fertig, wenn**: Challenge zu Pause plus `NEEDS_REAUTH` führt, Drift zu `SELECTOR_DRIFT` plus Breaker, der Kill-Switch geprüft ist und die rechtliche Freigabe vorliegt.

---

## B.9 Phase 7: Billing und Quoten

#### 7.1 Pläne
- **Erstellen**: Seed mit `Plan`-Einträgen (z.B. Trial, Starter, Pro, Agency) und Limits als zod-validiertes JSON. Die Preise legst du fest; im Code sind es nur Platzhalter.

#### 7.2 Stripe-Integration
- **Erstellen**:
  - `tools/stripe-sync.ts` (Produkte und Preise aus der Konfiguration anlegen).
  - `POST /api/org/:org/billing/checkout`, `POST /api/org/:org/billing/portal`, `POST /api/webhooks/stripe`.
  - Den Prozessor `stripe.webhook` und den `EntitlementsService`.
- **So sieht es aus**:
  - Behandelte Webhook-Events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`.
  - Jedes Event wird zuerst idempotent in `WebhookEvent` gespeichert und dann über die Queue verarbeitet.
  - Die Subscription wird bei jedem Event frisch von Stripe geladen, damit die Reihenfolge der Events keine Rolle spielt.
- **Darauf achten**:
  - Nur Webhooks ändern den Status, nie die Erfolgsseite nach dem Checkout.
  - Die Signatur wird mit dem Raw Body geprüft.
  - Steuern laufen über Stripe Tax.

#### 7.3 Nutzungsabrechnung
- **Erstellen**: `usage.report` (täglich) über Stripe Billing Meters für KI-Mehrverbrauch und die weiterberechneten X-Kosten.
- **Darauf achten**: Meter-Events werden mit einem Idempotenz-Identifier gesendet. `UsageRecord.reportedToStripeAt` verhindert Doppelmeldungen.

#### 7.4 Durchsetzung der Limits

| Stelle | Limit |
|---|---|
| Workspace anlegen | maxWorkspaces |
| Account verbinden | maxSocialAccounts |
| Mitglied einladen | maxMembers |
| KI-Aufruf | aiCreditsMicros |
| Post planen | scheduledPostsPerMonth |
| Upload | storageBytes |
| Analytics-Zeitraum | analyticsHistoryDays |
| X-Browser aktivieren | xBrowserAllowed |
| X-API-Aufruf | xApiSpendCapMicros |

- **Darauf achten**:
  - `past_due`: 7 Tage Kulanzfrist, danach Nur-Lesen; geplante Posts werden pausiert und der Nutzer wird benachrichtigt.
  - Downgrade mit zu vielen Ressourcen: Bestehendes bleibt, Neues wird blockiert, und es gibt einen Hinweis zum Reduzieren.

#### 7.5 Web: Billing
- **So sieht es aus**: aktueller Plan, Verbrauchsbalken pro Limit, Buttons "Upgrade" (führt zum Checkout) und "Verwalten" (führt zum Kundenportal), Liste der Rechnungen.
- **Fertig, wenn**: Ein Stripe-Test-Clock-E2E Upgrade, Downgrade, Kündigung und `past_due` korrekt abbildet.

---

## B.10 Phase 8: Härtung, DSGVO, Betrieb

| Schritt | Erstellen | Fertig, wenn |
|---|---|---|
| 8.1 Datenexport | `gdpr.export`: alle Daten der Organisation als JSON pro Entität plus Medien-Originale als ZIP in S3; signierter Link (24 h) per E-Mail | Export vollständig und lesbar |
| 8.2 Löschung | Soft-Delete, nach 30 Tagen `gdpr.erase`: DB-Kaskade, S3-Prefix löschen, Plattform-Tokens widerrufen, Stripe-Kunde löschen bzw. anonymisieren; Audit-Eintrag anonymisiert | keine Restdaten (Prüfskript) |
| 8.3 Aufbewahrung | Jobs: KI-Rohdaten 180 Tage, Screenshots 7 Tage, Logs 30 Tage, Metriken nach Tarif | Jobs laufen nachts |
| 8.4 Security-Review | Checkliste OWASP ASVS Level 2, Pentest, Runbook zur Secret-Rotation, CSP-Prüfung, Tuning der Rate-Limits | keine offenen kritischen oder hohen Befunde |
| 8.5 Lasttest | k6-Skripte: 10.000 fällige Varianten pro Minute, API-p95 unter 300 ms für Lesezugriffe | Ziele erreicht |
| 8.6 Backup | PITR, Restore-Probe, RPO 15 min und RTO 4 h dokumentiert | Restore erfolgreich geübt |
| 8.7 Betrieb | SLOs, Alarme, `docs/runbooks/*.md` (Plattform-Ausfall, massenhafter Token-Ablauf, X-Drift, Redis-Verlust, hängende Queue) | Runbooks durchgespielt |
| 8.8 Barrierefreiheit | axe-Checks in Playwright, manuelle Tastaturprüfung | keine kritischen Verstöße |
| 8.9 Deployment | Produktions-Vorlage, z.B. Compose für eine VM mit Caddy/Traefik und TLS oder ein Helm-Chart (Entscheidung gemeinsam mit dir) | Staging aus der Vorlage deployt |

---

## B.11 Globale Stolperfallen (Checkliste für jedes Review)

1. pnpm 10: Pakete mit Install-Skripten (sharp, prisma, esbuild, swc) in `allowBuilds` entscheiden (`strictDepBuilds` bricht sonst ab); jedes Paket deklariert seine Werkzeuge selbst; `pnpm deploy` braucht `inject-workspace-packages` oder `--legacy`. Turbo 2 filtert nicht deklarierte Env-Variablen (Strict-Modus), und die Root-`.env` lädt niemand automatisch.
2. BullMQ: Worker-Verbindungen mit `maxRetriesPerRequest: null`, Redis mit `noeviction` und AOF. Eigene Job-IDs enthalten keinen `:` (Punkt als Trenner).
3. Die Laufzeit-DB-Rolle ist nie der Tabellen-Owner (das würde RLS umgehen). `FORCE ROW LEVEL SECURITY` ist überall gesetzt.
4. `set_config(..., true)` immer transaktionslokal, nie ein session-weites `SET`. Policies lesen den Kontext mit `NULLIF(current_setting(..., true), '')::uuid`, weil eine gepoolte Verbindung danach einen Leerstring statt NULL liefert.
5. Materialized Views ignorieren RLS, deshalb Rollup-Tabellen statt Views.
6. Nest `@Sse()` nur für GET; POST-Streaming manuell; SSE ohne Compression und ohne Proxy-Puffer. Verbindungsabbruch über `res.on('close')` erkennen, nie über `req.on('close')`.
7. Better-Auth-Handler vor dem JSON-Body-Parser und mit `all('/api/auth/*splat')` gemountet; Better Auth nutzt einen Prisma-Client ohne Tenant-Extension; Webhooks mit Raw Body.
8. Express 5 (NestJS 11) hat eine neue Wildcard-Syntax für Routen.
9. Prisma 7: Driver Adapter ist Pflicht, die URL steht in `prisma.config.ts`, `.env` wird dort explizit per `dotenv` geladen, der generierte Client liegt im Package und nicht in `node_modules`.
10. Die Playwright-Version im npm-Paket muss exakt zur Docker-Image-Version passen.
11. sharp-Binaries passend zu Betriebssystem und Architektur des Laufzeit-Images.
12. MinIO-Community ist archiviert: lokal SeaweedFS, Upload per Presigned PUT plus `HeadObject`-Prüfung.
13. Instagram: öffentliche JPEG-URL, Tageslimit, Dev-Modus nur für App-Rollen; `impressions` sind durch `views` ersetzt.
14. LinkedIn: Little Text Format escapen, `LinkedIn-Version` pinnen, 60-Tage-Tokens, Reconcile eingeschränkt.
15. X: rotierende Refresh Tokens (Lock und neu lesen), gewichtete Zeichenzählung, Posts mit Link sind teurer, Lesen kostet.
16. Zeitzonen: UTC plus IANA-Zone speichern, Zeitumstellung explizit behandeln, Tagesgrenzen der Analytics in der Workspace-Zeitzone.
17. Doppelte Posts: Idempotenz-Keys, Lease, Reconcile, `NEEDS_ATTENTION` statt Raten.
18. Prompt Caching: Jede Byte-Änderung im Präfix (Zeitstempel, unsortiertes JSON) macht den Cache ungültig.
19. Claude Opus 5.5: kein `temperature`, kein Prefill, Thinking nicht abschaltbar, immer `stop_reason` prüfen, Effort explizit setzen (Default ist `medium`). Kosten aus `usage.iterations` (Fallback-Versuche), SDK-Fehler in der Reihenfolge `RateLimitError`, `APIConnectionError`, `APIError` prüfen.
20. Secrets nie in `NEXT_PUBLIC_*`, in Logs, in Fehlermeldungen, in Audit-Metadaten oder in Job-Payloads (Ausnahme: verschlüsselt und sofort gelöscht, siehe 6.4).
21. Signierte URLs nicht durch den `next/image`-Optimizer cachen lassen.
22. Fremde Mandanten-Ressourcen liefern 404, nicht 403.
23. Keine Emojis im Code (der CI-Check erzwingt das). Testdaten mit Emojis als Escape-Sequenz schreiben; nur U+00A9, U+00AE und U+2122 stehen auf der Allowlist.

---

## B.12 Reihenfolge und Abhängigkeiten

```
Phase 0 --> Phase 1 --> Phase 2 --> Phase 3 --> Phase 4a --> 4b --> 4c --> Phase 5 --> Phase 6 / Phase 7 (parallel möglich) --> Phase 8
Externe Anträge (Rechtstexte, LinkedIn, Meta, X, Stripe, Anthropic): parallel ab Phase 0
```

- Phase 4 braucht die Medien aus Phase 3, weil Instagram ohne Bild nicht postet.
- Phase 5 braucht veröffentlichte Posts aus Phase 4.
- Phase 6 braucht das Adapter-Framework (4.4) und die Benachrichtigungen (4.9).
- Phase 7 kann parallel zu Phase 6 laufen, weil die Limits schon ab Phase 2 als Platzhalter durchgesetzt werden.
