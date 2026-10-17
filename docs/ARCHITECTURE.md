# Architektur: Social Media Poster

KI-gestützte Content-Plattform für Social Media als Multi-Tenant SaaS.

Dieses Dokument beschreibt die Architektur und die getroffenen Entscheidungen. Die konkrete Umsetzung Schritt für Schritt steht in [`IMPLEMENTATION_GUIDE.md`](./IMPLEMENTATION_GUIDE.md). Abweichungen von diesem Dokument werden als ADR in `docs/adr/` festgehalten.

Stand: Oktober 2026, Planungsphase abgeschlossen.

## Kontext

Gebaut wird eine SaaS-Plattform, auf der Teams:
- Themen vorschlagen lassen und Posts per KI erzeugen,
- einen Post-Stil per Dropdown wählen oder eigene Stile und eine Brand Voice hinterlegen,
- Bilder hochladen, die mitgepostet werden,
- Posts planen (Kalender, "nächster Post"),
- KPIs auswerten (Reach, Impressions, Engagement).

Das Projekt startet ohne bestehenden Code. Umgesetzt wird Phase für Phase nach dem Umsetzungsleitfaden.

### Getroffene Entscheidungen

| Thema | Entscheidung |
|---|---|
| Plattformen (MVP) | LinkedIn (Profil + Company Page), Instagram (Business/Creator), Facebook Pages, X |
| Tech-Stack | TypeScript-Monorepo: Next.js (Web), NestJS (API + Worker), PostgreSQL + Prisma, Redis + BullMQ |
| KI | Extern über die Anthropic Claude API (`@anthropic-ai/sdk`), hinter einem austauschbaren `AiProvider`-Port |
| Nutzer | Multi-Tenant SaaS: Organisationen, Workspaces, Rollen, Mandantentrennung, Stripe-Billing |
| Bilder | Nur Upload, keine KI-Bildgenerierung (KI schlägt höchstens Alt-Texte vor) |
| Hosting | Docker überall, lokal Docker Compose, später beliebige Cloud in einer EU-Region (DSGVO) |
| UI-Sprache | Deutsch (Standard) + Englisch über next-intl |
| X-Anbindung | Hybrid: Standard ist die offizielle Pay-per-Use-API, optional ein Browser-Automation-Adapter (Playwright) per Feature-Flag |

### Faktenlage zu den Plattform-APIs (Stand Oktober 2026)

- **LinkedIn**: Posting ist kostenlos.
  - Persönliche Posts: `w_member_social`.
  - Company Pages und Organisations-Analytics: Community Management API, App-Review nötig. Im Development-Tier sind die Aufrufe begrenzt; für den Standard-Tier braucht es einen Screencast.
  - Impressions persönlicher Posts: Member Post Analytics API (`r_member_postAnalytics`, Endpoint `memberCreatorPostAnalytics`).
  - Access Tokens laufen nach 60 Tagen ab. Refresh Tokens bekommen nur freigeschaltete Partner.
- **Meta (Instagram/Facebook)**: Die Graph API ist kostenlos, aber App-Review und Business Verification sind nötig.
  - Instagram holt Bilder selbst von einer öffentlichen URL und limitiert API-Posts pro 24 Stunden.
  - `impressions` sind abgekündigt; stattdessen gibt es `views` und `reach`.
- **X**: Seit Februar 2026 gibt es keinen Free-Tier mehr, sondern nur Pay-per-Use.
  - Ein Post kostet ca. 0,015 USD, laut Sekundärquellen ein Post mit Link deutlich mehr (ca. 0,20 USD). Ein gelesener Post kostet ca. 0,005 USD.
  - Browser-Automation verstößt gegen die Nutzungsbedingungen von X. Deshalb ist sie nur optional, isoliert und mit ausdrücklicher Zustimmung nutzbar.

Einige Details (exakte X-Preise und Endpunkt-Formen, Instagram-Tageslimit, Meta-Metriknamen) stammen aus Sekundärquellen. Sie werden in der jeweiligen Adapter-Phase gegen die offizielle Doku geprüft.

---

## 1. Tech-Stack im Detail

| Bereich | Wahl | Begründung |
|---|---|---|
| Monorepo | pnpm Workspaces + Turborepo, Node 24 LTS, TypeScript strict | schnelle Installs, Task-Caching, `turbo prune --docker` für schlanke Images |
| Web | Next.js 16 (App Router, React 19), Tailwind 4, shadcn/ui, TanStack Query 5, react-hook-form + zod, next-intl, Recharts, FullCalendar | ausgereift und weit verbreitet; FullCalendar inkl. Drag & Drop ist MIT-lizenziert |
| API | NestJS 11 (Express-Adapter) mit hexagonalem Kern | breiteste Middleware-Kompatibilität (Auth-Handler, Raw Body für Webhooks) |
| API-Vertrag | zod-Schemas in `packages/contracts`, nestjs-zod (Validierung und Routen-Metadaten), Component-Schemas des OpenAPI-3.0-Dokuments direkt aus zod, Orval generiert den typisierten Client mit TanStack-Query-Hooks (ADR 0013) | eine Quelle der Wahrheit für Formulare, API und KI-Output; OpenAPI als Basis für eine spätere Public API; die CI schlägt bei Abweichungen fehl |
| Auth | Better Auth, eingebunden in NestJS (die API ist die einzige Auth-Instanz), DB-Sessions in einem httpOnly-Cookie, same-origin | Auth.js wird seit 2025 vom Better-Auth-Team betreut. Better Auth bringt E-Mail/Passwort, Verifizierung, 2FA (TOTP), Social Login und Passkeys mit, ohne selbstgebauten Security-Code. Mandanten und Rollen bleiben in unserer eigenen Domain. |
| DB | PostgreSQL 17 + Prisma 7 (Driver Adapter `@prisma/adapter-pg`, `prisma.config.ts`) | RLS-Policies, Partial Indexes und Trigger als SQL-Migrationen |
| Jobs | Redis 7.4 (oder Valkey 8) + BullMQ 5 | Postgres bleibt die Quelle der Wahrheit (Abschnitt 7) |
| KI | `@anthropic-ai/sdk`, Modell per Env (Standard `claude-opus-5-5`) | Structured Outputs, Streaming, Prompt Caching |
| Storage | S3-kompatibel (AWS SDK v3), lokal SeaweedFS, Presigned PUT mit serverseitiger Prüfung beim Abschluss, sharp | cloud-unabhängig. Presigned PUT funktioniert bei allen S3-Anbietern, Presigned POST z.B. nicht bei Cloudflare R2. MinIO ist als Community-Edition seit 2026 archiviert und bekommt keine Images mehr, deshalb SeaweedFS (Alternativen: Garage, RustFS). |
| Tests | Vitest (+ `unplugin-swc` für Nest-Decorators), msw v2, Testcontainers, Playwright | ein Test-Runner überall |

In Phase 0 prüfen kurze Spikes fünf Punkte vorab: Structured Outputs + Streaming + Caching + Fallbacks der Claude API, den Overhead von RLS mit Prisma, zod 4 mit nestjs-zod und Orval, Better Auth in NestJS sowie Presigned PUT mit CORS gegen SeaweedFS (Leitfaden, Schritt 0.14).

---

## 2. Systemarchitektur

```
Browser --HTTPS--> Reverse Proxy (same origin: app.example.com)
                     |-- /        -> web (Next.js: SSR/RSC, UI)
                     '-- /api/*   -> api (NestJS: REST + SSE, Auth, OAuth-Callbacks, Webhooks)

api ----Prisma (Rolle app_user, RLS)----> PostgreSQL (Quelle der Wahrheit)
api ----Presign---------------------------> S3 (lokal SeaweedFS)
api ----Streaming------------------------> Anthropic Claude API
api ----OutboxEvent in derselben Tx-----> PostgreSQL --Relay--> BullMQ (Redis)

worker (Rollen: scheduler | publisher | analytics | media | ai | notify | billing | gdpr)
   <--BullMQ--> Redis
   -----------> PostgreSQL, S3, Claude, LinkedIn/Meta/X-APIs, SMTP, Stripe
   --Queue "xb-commands"--> browser-worker --Queue "xb-results"--> worker

browser-worker (Playwright/Chromium, eigener Container, Egress nur X-Web-App + S3)
   KEINE Datenbank-Zugangsdaten, nur Redis-Zugriff auf die xb-*-Queues

worker --Redis Pub/Sub--> api --SSE--> Browser (Live-Status, Benachrichtigungen)
```

- **web**: nur UI und SSR, keine Fachlogik, kein direkter DB-Zugriff.
- **api**: zustandslos und latenzkritisch. Die interaktive KI-Generierung läuft direkt hier und wird per SSE gestreamt. Bricht der Client ab, wird der Claude-Aufruf per `AbortSignal` beendet, das spart Kosten. Alles Langsame, Periodische oder Retry-Lastige geht in Queues.
- **worker**: eine Codebasis, die als mehrere Prozesse läuft. Die Rollen werden über `WORKER_ROLES` gewählt, z.B. `scheduler,publisher` oder `analytics` oder `media,ai,notify`. So lässt sich jede Rolle unabhängig skalieren. Periodische Ticks laufen über BullMQ Job Scheduler und sind dadurch nur einmal aktiv.
- **browser-worker**: bewusst isoliert, aus vier Gründen:
  - die Angriffsfläche von Chromium,
  - der hohe RAM-Bedarf,
  - das ToS-Risiko, das so abtrennbar bleibt (der Container kann einfach nicht deployt werden),
  - ein eigener Release-Takt für Selector-Updates.

  Er ist ein reiner Ausführer: Die Befehle sind in sich geschlossen (Text, signierte Medien-URLs, verschlüsselter Session-State), die Ergebnisse gehen über `xb-results` zurück.

### 2.1 Hexagonale Architektur (Ports & Adapters)

Die Fachlogik liegt frameworkfrei in `packages/core` und wird von API und Worker gemeinsam genutzt:

```
packages/core/src/<context>/
  domain/        Entities, Value Objects, Zustandsautomaten, Policies, Domain Events (pures TS)
  application/   Use Cases (Commands/Queries), Transaktionsgrenzen
  ports/         Interfaces: Repositories, SocialPlatformAdapter, AiProvider, Storage, Clock, Queue, Kms
Adapter (Infrastruktur): packages/db, platform-adapters, ai, media, queue, crypto
Schnittstellen: Controller und Guards in apps/api, Job-Prozessoren in apps/worker
```

**Bounded Contexts**:
- `identity`
- `tenancy` (Organisationen, Workspaces, Mitglieder, Einladungen, RBAC)
- `content` (Posts, Varianten, Brand Voices, Stile, Ideen)
- `ai`, `media`
- `channels` (Verbindungen, Accounts, Tokens)
- `publishing` (Scheduling, Zustandsautomat)
- `analytics`, `billing`, `notifications`, `audit`
- `compliance` (DSGVO)

**Regeln, in der CI per dependency-cruiser erzwungen**:
- `domain` importiert nichts.
- `application` importiert nur `domain` und `ports`.
- Kontexte sprechen über Application Services oder Domain Events (Outbox) miteinander, nie über die Repositories anderer Kontexte.

---

## 3. Monorepo-Struktur

```
social-media-poster/
  apps/
    web/                    Next.js: src/app (Routen), src/features (composer, calendar, analytics, ...),
                            messages/{de,en}, src/proxy.ts (nur Redirects/CSP, keine Security-Grenze)
    api/                    NestJS HTTP: modules/<context>, common (Guards, CLS, Filter, Throttling),
                            ai-stream (SSE), webhooks (stripe, meta), admin (Bull Board, Flags)
    worker/                 NestJS Application Context + /health und /metrics; processors/*
    browser-worker/         Playwright-Host, konsumiert nur xb-commands (Image: mcr.microsoft.com/playwright)
  packages/
    core/                   hexagonaler Kern (siehe 2.1)
    contracts/              zod-DTOs, Enums, Fehlercodes, SSE-Events, Rechte-Matrix
    api-client/             Orval-Output (TanStack-Query-Hooks)
    db/                     schema.prisma, Migrationen (inkl. RLS-SQL), Tenant-Extension, Repositories, Seed
    platform-rules/         Plattform-Capabilities, validatePost, Zeichenzählung (twitter-text); Web + Backend
    platform-adapters/      linkedin/, meta/, x/, mock/, HTTP-Client, Metrik-Mappings
    x-browser/              versionierte Selector-Maps, Flows (login, publish, metrics), Parser
    ai/                     AnthropicAiProvider, MockAiProvider, versionierte Prompts, Output-Schemas, Preise
    media/                  sharp-Pipeline, Rendition-Profile, Dateityp-Prüfung, S3-Adapter
    queue/                  Queue-Namen, zod-Job-Payloads, typisierte Producer, Locks
    crypto/                 Envelope-Encryption, KMS-Adapter (lokaler Keyring, AWS KMS, Vault)
    observability/          pino-Konfiguration inkl. Redaction, OpenTelemetry, Sentry
    emails/                 react-email-Templates (de/en)
    ui/                     Design-System auf Basis von shadcn/ui
    config/                 eslint, prettier, tsconfig-Basis, vitest-Presets
    testing/                Factories, Testcontainers-Helfer, msw-Fixtures, Adapter-Contract-Suite
  compose.yaml              Docker Compose (Profile: default, app, e2e, xb, clamav, observability)
  infra/
    docker/                 Dockerfiles (multi-stage, non-root), DB-Rollen-Init, S3-Bucket-Init, Caddyfile (lokaler Reverse Proxy)
  tools/                    Repo-Skripte: gen-keys, check-no-emoji, check-rls, check-i18n, stripe-sync, spikes/
  docs/                     ARCHITECTURE.md, IMPLEMENTATION_GUIDE.md, adr/ (Architecture Decision Records), runbooks/
  .github/workflows/        ci.yml, e2e.yml, release.yml, nightly-live-smoke.yml
```

---

## 4. Plattform-Integration

### 4.1 Port

```ts
interface SocialPlatformAdapter {
  readonly platform: Platform;                         // LINKEDIN | FACEBOOK | INSTAGRAM | X
  readonly method: ConnectionMethod;                   // API | BROWSER | MOCK
  readonly connector: OAuthConnector | InteractiveSessionConnector;
  capabilities(type: AccountType): PlatformCapabilities;   // Textlimits, Medienregeln, Features, Metriken
  refreshCredentials(ctx: AdapterContext): Promise<RefreshOutcome>;
  validatePost(req: PublishRequest, type: AccountType): ValidationIssue[];   // rein, ohne I/O
  publish(req: PublishRequest, ctx: AdapterContext): Promise<PublishResult>;
  reconcile(q: { text: string; since: Date; contentHash: string }, ctx: AdapterContext): Promise<PublishResult | null>;
  deletePost(ref: ExternalPostRef, ctx: AdapterContext): Promise<void>;
  fetchPostMetrics(refs: ExternalPostRef[], ctx: AdapterContext): Promise<PostMetricsResult[]>;   // gebatcht
  fetchAccountMetrics(range: DateRange, ctx: AdapterContext): Promise<AccountMetricsResult>;
}
// AdapterContext: Account, CredentialsAccessor (entschlüsselt erst bei Bedarf, nur im Speicher),
// HTTP-Client (Timeouts, OTel, Rate-Limiter), ApiCostRecorder (X), Logger, AbortSignal, dryRun,
// keepAlive (verlängert den Lease des Publish-Jobs vor langen Schritten, ADR 0024)
// OAuthConnector: authorizationUrl, exchangeCode, listConnectableAccounts, revoke
```

- **Implementierungen**: `LinkedInApiAdapter` (Person + Organisation), `MetaFacebookAdapter`, `MetaInstagramAdapter`, `XApiAdapter` und `MockPlatformAdapter`, der die echten Capability-Tabellen nutzt. Dazu kommt `XBrowserRemoteAdapter`: ein Proxy, der Befehle an `xb-commands` schickt; die Playwright-Logik liegt in `packages/x-browser`.
- **HTTP-Clients**: schlank und selbstgebaut (undici fetch), mit zod-validierten Antworten und gepinnten API-Versionen (`LINKEDIN_VERSION=YYYYMM`, `META_GRAPH_VERSION=vNN.0`). Keine schweren Vendor-SDKs.
- **AdapterRegistry**: wählt den Adapter nach der Verbindungsmethode des Accounts. Für BROWSER prüft sie zusätzlich den globalen Kill-Switch, das Workspace-Flag, den Tarif und eine gültige Risikobestätigung. Es gibt keinen stillen Wechsel zwischen X-API und X-Browser.
- **Fehler-Taxonomie** (`PlatformError` mit `code`, `retryable`, `retryAfterMs`): `AUTH_EXPIRED`, `PERMISSION_DENIED`, `RATE_LIMITED`, `VALIDATION_REJECTED`, `DUPLICATE`, `MEDIA_PROCESSING`, `TRANSIENT`, `OUTCOME_UNKNOWN`, `CHALLENGE_REQUIRED`, `SELECTOR_DRIFT`, `SPEND_CAP_REACHED`.

### 4.2 Plattformen im Überblick

| Plattform | OAuth / Scopes | Posting + Medien | Token |
|---|---|---|---|
| LinkedIn Person | 3-legged; `openid profile email w_member_social r_member_postAnalytics` | Images API (`initializeUpload`, PUT, auf `AVAILABLE` warten), dann `POST /rest/posts` (Einzelbild oder `multiImage`) | 60 Tage; Refresh nur mit Partner-Freigabe, sonst Erinnerung zum Reconnect |
| LinkedIn Organisation | Community Management App; `w_organization_social r_organization_social rw_organization_admin` | wie oben mit Organization-URN | wie oben |
| Facebook Pages | Facebook Login for Business; `pages_show_list pages_manage_posts pages_read_engagement read_insights` | `/{page}/photos` bzw. mehrere unveröffentlichte Fotos + `/{page}/feed` mit `attached_media` | Page Token langlebig; Datenzugriff läuft nach 90 Tagen ab; Fehler 190 führt zu NEEDS_REAUTH |
| Instagram | Instagram API mit Instagram Login; `instagram_business_basic instagram_business_content_publish instagram_business_manage_insights` | Container `/media` (Carousel bis 10), auf `FINISHED` warten, dann `/media_publish`; Container-IDs werden für Retries gespeichert; vorher `content_publishing_limit` prüfen | 60 Tage, per API verlängerbar |
| X (API) | OAuth 2.0 mit PKCE (S256); `tweet.read tweet.write users.read media.write offline.access` | Media Upload v2, Alt-Text per Metadata-Endpunkt, `POST /2/tweets` | 2 h Access; rotierender Refresh Token, nur einmal gültig (Refresh unter Lock) |
| X (Browser) | interaktiver Login, nur verschlüsselter `storageState` | Playwright im Composer; Ergebnis aus der JSON-Antwort der Web-App | Session-Cookies |

LinkedIn verlangt für die Community Management API möglicherweise eine eigene App. Der Adapter akzeptiert deshalb zwei Credential-Sets.

**Token-Monitor** (`tick.tokens`, stündlich, [ADR 0025](adr/0025-benachrichtigungen-und-token-monitor.md)): Er sieht die Verbindungen, deren Zugang in 14 Tagen endet (mit dem Refresh Token, wenn es eines gibt, sonst mit dem Access Token).
- Eine aktive Verbindung bekommt den Job `token.refresh`, der unter `lock:conn:{id}` erneuert. Wo die Plattform keinen Refresh bietet, wird sie `EXPIRING`.
- Owner und Admins einer `EXPIRING`-Verbindung bekommen 14, 7 und 1 Tag vorher eine Erinnerung, je Stufe höchstens eine.
- Nach dem Ablauf wird die Verbindung `NEEDS_REAUTH`, und ihre geplanten Varianten werden markiert.

### 4.3 X-Browser-Adapter (optional, Feature-Flag)

- **Aktivierung**: nur durch Owner/Admin pro Workspace, nach ausdrücklicher Risikobestätigung (Verstoß gegen die X-Nutzungsbedingungen, mögliche Sperre). Die Bestätigung wird versioniert gespeichert (`RiskAcknowledgement`: Text-Version, Hash, Zeit, IP) und im Audit-Log festgehalten. Zusätzlich gibt es einen Tarif-Gate und einen globalen Kill-Switch.
- **Keine Passwörter speichern**: Das Login läuft interaktiv.
  1. Der browser-worker füllt die Zugangsdaten aus, die der Nutzer einmalig eingibt.
  2. Fragt X nach einem 2FA-Code, geht der Status auf `AWAITING_2FA`, und die UI reicht den Code über Redis an den browser-worker durch.
  3. Gespeichert wird danach nur der `storageState`, verschlüsselt mit einem eigenen Keyring (`SESSION_KEKS`), getrennt von den Token-Schlüsseln. Die API nutzt ihn nur zum Verschlüsseln der eingegebenen Zugangsdaten, der Worker nur für den Re-Wrap bei der Schlüsselrotation; entschlüsselt wird ausschließlich im browser-worker. Das Web bekommt ihn nie.
- **Keine Umgehung von Schutzmechanismen**: Bei Captcha, verdächtigem Login oder einer Sperrseite bricht der Job ab, der Account geht auf `NEEDS_REAUTH`, und der Nutzer wird benachrichtigt. Kein Stealth- oder Fingerprint-Spoofing, keine Captcha-Löser, keine automatischen Retries.
- **Robust statt Regex auf HTML**:
  - Playwright-Locators über Rolle, ARIA und `data-testid` aus versionierten Selector-Maps (`selectors/v1.ts`).
  - Post-ID und Metriken werden aus den JSON-Netzwerkantworten der X-Web-App gelesen (`page.on('response')`, z.B. `CreateTweet`), nicht aus geparstem HTML.
  - Ändert X die Oberfläche, wird nur die Selector-Map angepasst.
- **Überwachung**: Ein täglicher Canary-Job gegen einen internen Test-Account erkennt UI-Änderungen. Bei wiederholtem `SELECTOR_DRIFT` öffnet ein automatischer Circuit Breaker und pausiert alle Browser-Jobs. Bei Fehlern wird ein Screenshot gespeichert (sensible Bereiche geschwärzt, kurze Aufbewahrung).
- **Niedrige Frequenz**: höchstens ein Task pro Account gleichzeitig (Redis-Lock), Concurrency 1 bis 2 pro Container, Metriken nur bei +24h und +7d.

---

## 5. KI-Generierung (Claude API)

### 5.1 Port und Modell

- **Port** `AiProvider` mit vier Methoden:
  - `generateVariants()` und `refineVariant()`: Streaming als `AsyncIterable` mit Partial- und Completed-Events,
  - `suggestTopics()`,
  - `suggestAltText()`: Vision, beschreibt hochgeladene Bilder; keine Bildgenerierung.

  Die Implementierungen sind `AnthropicAiProvider` und `MockAiProvider` (deterministisch, simuliertes Streaming), Auswahl per `AI_PROVIDER=anthropic|mock`. Der Mock streamt das JSON seiner Antwort in Häppchen wie die Claude API und erreicht die Fehlerpfade über Marker im Briefing (`[mock:refusal]`, `[mock:truncated]`, `[mock:retry]`, `[mock:invalid]`, `[mock:error]`, `[mock:fallback]`, `[mock:slow]`, `[mock:too-long]`). Seine Berichte nennen das konfigurierte Modell mit geschätzten Tokens, damit Quote und Kosten wie in Produktion laufen. In Produktion verweigern die Env-Prüfung und die Factory den Mock.
- **Modell**: `claude-opus-5-5`, über `AI_MODEL` konfigurierbar.
  - Effort ist pro Anwendungsfall fest (Generieren `medium`, Refine `low`, Ideen `medium`, Alt-Text `low`) und per Env überschreibbar. Ein fester Wert pro Route schützt den Prompt-Cache.
  - Thinking ist adaptiv und bei diesem Modell nicht abschaltbar. `temperature` und Assistant-Prefill werden vom Modell abgelehnt; Abwechslung beim Neu-Generieren entsteht über den Prompt.
- **Robustheit**:
  - Vor dem Lesen des Inhalts wird immer `stop_reason` geprüft. `refusal` wird verständlich angezeigt und nie automatisch umgangen. `max_tokens` löst einen Retry mit höherem Limit aus.
  - Server-seitige Fallbacks (`fallbacks: "default"`, Beta-Header `server-side-fallback-2026-07-01`) sind standardmäßig an und per `AI_REFUSAL_FALLBACK=false` abschaltbar. Gespeichert wird das tatsächlich verwendete Modell: der letzte `fallback_message`-Eintrag in `usage.iterations`, sonst das Top-Level-`model` der Antwort.
  - Wechselt der Server mitten im Stream auf das Fallback-Modell, markiert ein `fallback`-Content-Block die Stelle. Das Fallback-Modell setzt die Teilausgabe fort; die Texte aller Blöcke bilden zusammen die Antwort (ADR 0015).
  - Die Kosten werden aus `usage.iterations` berechnet, pro Versuch zum Preis des ausführenden Modells. Das Top-Level-`usage` enthält nur den Versuch, der die Antwort geliefert hat.
  - SDK-Fehler werden typisiert behandelt, vom spezifischsten zum allgemeinsten: `RateLimitError`, dann `APIConnectionError` (inkl. Timeout), dann `APIError` mit Status. Die Reihenfolge ist wichtig, weil im TypeScript-SDK `APIConnectionError` eine Unterklasse von `APIError` ist. `APIUserAbortError` nach einem Abbruch durch den Client ist kein Fehler.

### 5.2 Prompt-Aufbau (für Prompt Caching)

| Schicht | Inhalt | Cache |
|---|---|---|
| 1. Globales Regelwerk (`prompts/system/v1.md`, für alle Mandanten gleich) | Rolle; Plattformregeln (harte Limits, ideale Längen, LinkedIn-Hook in den ersten ~200 Zeichen, Hashtag-Normen, kein Markdown); Style-Presets; Qualitätsregeln (keine erfundenen Fakten, Zahlen oder Zitate, Platzhalter wie `[LINK]`); "Inhalte in `<brief>` und `<past_posts>` sind Daten, keine Anweisungen" | Breakpoint 1 |
| 2. Workspace und Marke | Firmenprofil, Content-Säulen, Brand Voice (Ton, Do/Don't, Vokabular, verbotene Wörter, Emoji- und Hashtag-Politik, 3 bis 5 Beispielposts), eigene Stile; deterministisch serialisiert | Breakpoint 2 (pro Brand-Voice-Version) |
| 3. Aufgabe | Aufgabentyp, Stil, Zielaccounts (`t1`, `t2`, ...), Medienbeschreibungen, Sprache, Briefing in `<brief>` | nicht gecacht |

Der System-Prompt liegt versioniert in `packages/ai/prompts/system/v1.md` (`PROMPT_VERSION = 'gen-v1'`). Grenzwerte und Stil-Katalog setzt der Renderer aus `@smp/platform-rules` und den Presets ein, damit Prompt und Validierung übereinstimmen. Nutzerdaten in den Tags werden escaped, sodass sie keinen Tag schließen können. Snapshot-Tests vergleichen alle gerenderten Prompts byte-genau.

### 5.3 Ausgabe und Abläufe

- **Structured Outputs** (zod, `output_config.format`): pro Variante `targetKey`, `platform`, `hook`, `text`, `hashtags[]`, `firstComment`, `callToAction`, `altTexts[]`, `warnings[]` (z.B. "Statistik braucht eine Quelle"). Themenideen haben `title`, `angle`, `pillar`, `whyNow`, `basedOn[]`, `suggestedPlatforms[]`, `suggestedStyleKey`, `format`.
- **Zeichenzahl auf dem Server**: Sie wird berechnet, nicht vom Modell geliefert (X gewichtet per `twitter-text`, sonst Grapheme). Ist eine Variante zu lang, läuft einmal automatisch "kürzen"; bleibt sie zu lang, markiert die UI sie.
- **Generieren**: `POST /api/w/:ws/ai/generations` liefert `text/event-stream` mit diesen Events:
  - `generation.started`, `variant.partial` (Teil-Varianten), `variant.reset` (vor dem einen Neuversuch nach `max_tokens`; der Client verwirft die Teilausgabe), `generation.completed` (Varianten inkl. Zeichenzahl, Validierungsfehlern und verbotenen Wörtern), `generation.failed` (REFUSED, TRUNCATED, INVALID_OUTPUT, PROVIDER_ERROR, CANCELED),
  - Fehler vor dem ersten Event (unbekannter Post 404, leeres Briefing 422, erschöpfte Quote 402 `QUOTA_EXCEEDED`) kommen als Problem-Dokument, weil Laden und Quoten-Reservierung vor dem Senden der Header laufen (ADR 0016),
  - einen Heartbeat alle 15 s.

  Der Server parst das partielle JSON (`partial-json`) und sendet Teil-Varianten; das Endergebnis validiert zod auf dem Server (ADR 0015).
- **Speichern**: Die KI schreibt nie selbst in Varianten. Der Editor übernimmt Ergebnisse in unbearbeitete Varianten und speichert sie mit Optimistic Locking (ADR 0016).
- **Refine**: Schnellaktionen "kürzer", "länger", "formeller", "lockerer", "stärkerer Hook", "CTA ergänzen", "weniger Emojis", "DE/EN übersetzen", "für Plattform X umschreiben" sowie eigene Anweisungen. Jede Aktion ist ein eigener zustandsloser Aufruf mit demselben gecachten Präfix. Die UI zeigt einen Diff mit Übernehmen und Verwerfen.
- **Themenvorschläge**:
  - Kontext: Workspace-Profil, Content-Säulen, die letzten 30 Posts, die Top-5-Performer der letzten 90 Tage mit Metriken, verworfene Ideen (als Negativbeispiele) und anstehende Termine (Feiertage, eigene Daten).
  - Es entstehen 10 Ideen, Dubletten gegen bestehende Ideen werden per `pg_trgm` entfernt.
  - Aktionen: speichern, verwerfen, "Post erstellen" (füllt den Composer vor).
  - Optional ein wöchentlicher Auto-Lauf sowie aktuelle Themen über das Claude-Tool `web_search` (eigener Schalter, kostet zusätzlich).
- **Leitplanken**:
  - Briefing höchstens 4.000 Zeichen.
  - Rate-Limits pro Nutzer (10/min, 2 parallele Streams) und pro Workspace (60/h), als feste Zeitfenster in Redis; Überschreitung 429 `AI_RATE_LIMITED` (ADR 0016).
  - Prüfung auf verbotene Wörter der Brand Voice.
  - Die KI veröffentlicht nie selbst; Planen ist immer eine bewusste Nutzeraktion.
- **Kosten**:
  - Jeder Aufruf wird in `AiGeneration` gespeichert: Prompt-Version, Modell angefragt und geliefert, Effort, Input-Snapshot, Output, Ergebnis, Tokens inkl. Cache, Kosten, Latenz, Time-to-first-token.
  - Die Preise stehen versioniert in einem `PriceBook` (keine fest einprogrammierten Zahlen), auch für die Modelle, auf die der Server-Fallback ausweichen kann.
  - Vor dem Aufruf wird eine Quote reserviert und danach abgerechnet. Ohne Guthaben antwortet die API mit 402.
  - Die Reservierung ist ein bedingtes `UPDATE` auf dem Monatszähler der Organisation (UTC-Kalendermonat bis zur Abrechnung in Phase 7), parallel sicher. `finalize` bucht danach im `finally` den tatsächlichen Betrag: einen Ledger-Eintrag pro Quelle und die Differenz zur Reservierung am Zähler, nie unter null. Bricht ein Prozess dazwischen ab, bleibt die Reservierung stehen, bis ein Abgleich mit dem Ledger sie korrigiert.
  - Fehlt im PriceBook der Preis eines Modells, gilt der Preis des angefragten Modells, sonst der höchste bekannte Preis je Token-Art; ein fehlender Preis macht einen Aufruf nie billiger.
  - Grobe Schätzung: wenige US-Cent pro Generierung mit 4 Varianten. Die Eval-Suite (`pnpm eval:ai`, ADR 0018) misst die echten Kosten; ihre obere Schätzung aus dem PriceBook liegt bei 0,17 USD pro Generierung, die gemessene Baseline steht noch aus.

---

## 6. Datenmodell (Prisma)

### 6.1 Konventionen

- **IDs und Zeiten**: `uuid(7)`, zeitlich sortierbar und damit gut für Indizes; Tabellennamen in snake_case; Zeitstempel als `timestamptz`.
- **Geld**: als Integer in Micro-USD (`BigInt`), nie als Float.
- **Mandanten-Schlüssel**: Inhaltstabellen tragen `workspaceId`, Billing-, Mitglieds- und Audit-Tabellen `organizationId`. Jede dieser Tabellen bekommt eine RLS-Policy.
- **Verschlüsselte Secrets**: ein selbstbeschreibender `Bytes`-Umschlag aus Version, KEK-ID, gewrapptem DEK, IV, Tag und Ciphertext.

### 6.2 Entitäten

- **Identity und Tenancy**:
  - `User` (E-Mail, Sprache, Zeitzone; Tabelle `users`) sowie die Tabellen von Better Auth (`Session`, `Account` als Tabelle `auth_account`, `Verification`, `TwoFactor`).
  - `Organization` (Mandant, Billing).
  - `Workspace` (Marke oder Kunde innerhalb einer Organisation, z.B. für Agenturen; mit Zeitzone, Content-Sprache, Branche, Zielgruppe, Zielen, Content-Säulen). Der Slug ist global eindeutig, weil die Routen `/w/:ws` den Workspace allein darüber adressieren (ADR 0010).
  - `Membership` (Rolle OWNER, ADMIN, EDITOR oder VIEWER, optional über `MembershipWorkspace` auf bestimmte Workspaces beschränkt) und `Invitation` (Token nur als Hash gespeichert).
- **Channels**:
  - `SocialConnection`: ein OAuth-Grant oder eine Browser-Session (verschlüsselte Tokens oder Session, Ablaufzeiten, Scopes, Status ACTIVE, EXPIRING, NEEDS_REAUTH, PAUSED oder REVOKED).
  - `SocialAccount`: ein Veröffentlichungsziel, z.B. eine Person, eine Company Page, eine Facebook-Seite oder ein IG-Konto. Eine Verbindung kann mehrere Accounts haben, z.B. mehrere Pages.
- **Content**:
  - `PostStyle`: System-Presets (Professionell, Storytelling, Locker, Lehrreich, Thought Leadership, Werblich) ohne Workspace, für alle Mandanten lesbar und per Migration ausgeliefert, sowie eigene Stile pro Workspace (ADR 0014).
  - `BrandVoice` mit `BrandVoiceVersion` (unveränderliche Snapshots): Die Version dient als Cache-Key, und `AiGeneration` verweist auf sie.
  - `Idea`, `Post` (Master-Inhalt: Briefing, Stil, Brand Voice) und `PostVariant` (ein Eintrag pro Zielaccount).
- **Media**: `MediaAsset` (Status PENDING_UPLOAD, PROCESSING, READY oder REJECTED; Maße, sha256, Alt-Text), `MediaRendition` (Profil pro Plattform plus Zuschnitt), `PostMedia` (Reihenfolge, Zuschnitt und Alt-Text pro Variante).
- **Publishing**: `PublishAttempt` (Protokoll jedes Versuchs inkl. Fehlercode und IG-Container-IDs), `OutboxEvent`, `WebhookEvent` (idempotent).
- **Analytics**: `MetricSnapshot` (append-only, kumulative Zähler plus Rohdaten und Mapping-Version), `PostMetricLatest` (für schnelle Listen und Top-Posts), `AccountMetricSnapshot` (täglich: Follower, Reichweite, Profilaufrufe), `AnalyticsDaily` (Rollup-Tabelle).
- **KI und Kosten**: `AiGeneration`, `UsageRecord` (Ledger, idempotent pro Quelle), `UsageCounter` (atomare Quoten-Zähler), `ApiCostRecord` (X-Kosten pro Operation), `PriceBook`.
- **Billing**: `Plan` (Limits als zod-validiertes JSON: Workspaces, Accounts, Mitglieder, KI-Guthaben, Posts pro Monat, Speicher, Analytics-Historie, X-Browser erlaubt, X-Ausgabenlimit), `Subscription`.
- **Querschnitt**: `FeatureFlag` (global, pro Organisation oder pro Workspace, inkl. Kill-Switches), `RiskAcknowledgement`, `AuditLog` (append-only), `Notification` und `NotificationPreference`, `WorkspaceSettings` (Dry-Run, Verhalten bei verpasstem Zeitfenster, Effort-Overrides), `GdprRequest`.

**Kernfelder von `PostVariant`**:
- Inhalt und Zuordnung: `socialAccountId`, `platform`, `text`, `hashtags`, `firstComment`, `linkUrl`.
- Status und Zeitplan: `status`, `scheduledAt` (UTC), `scheduledTimezone` (IANA).
- Steuerung: `scheduleVersion` (wird bei jedem Umplanen erhöht und ist Teil der Job-ID), `version` (Optimistic Locking), `queuedAt` (für den Sweeper), `leaseOwner` und `leaseUntil`.
- Ergebnis: `publishedAt`, `externalPostId`, `externalUrl`, `failureCode`, `lastError`, `isDryRun`.
- Sonstiges: `contentHash` (für den Abgleich), `metricsNextAt` und `metricsStep`.

Partial Indexes beschleunigen den Scheduler: auf `scheduled_at` für `status='SCHEDULED'` und auf `metrics_next_at` für `status='PUBLISHED'`.

### 6.3 Mandantentrennung (RLS)

- **DB-Rollen**:
  - `app_migrator` (Owner der Tabellen),
  - `app_user` (für API und Worker, ohne BYPASSRLS),
  - `app_system` (BYPASSRLS, nur für wenige mandantenübergreifende Scans: Scheduler-Tick, Analytics-Planer, Token-Ablauf, Outbox-Relay, DSGVO-Jobs; diese liefern nur IDs plus `workspaceId`).
- **Policies**: `ENABLE` und `FORCE ROW LEVEL SECURITY` mit `USING/WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)`, für Tabellen mit `organization_id` analog über `app.organization_id`. Für `audit_log` hat `app_user` kein UPDATE und kein DELETE.
- **Nutzerbezogene Lese-Policies** (nur `app.user_id` gesetzt): eigene Mitgliedschaften, die Organisationen dazu, die Workspaces, die der Nutzer öffnen darf (Owner und Admins alle, sonst gemäß `MembershipWorkspace`), und Einladungen an die eigene E-Mail-Adresse. Darüber löst der Workspace-Guard `/w/:ws` auf, bevor ein Mandanten-Kontext existiert. Eine Einladung ist zusätzlich über `app.invitation_token_hash` lesbar, also nur für den Inhaber des Links. `Notification` und `NotificationPreference` sind pro Nutzer, `FeatureFlag` ist zur Laufzeit nur lesbar (global plus eigene Organisation und eigener Workspace).
- **`NULLIF` ist Pflicht**: Nach dem ersten transaktionslokalen `set_config` liefert dieselbe (gepoolte) Verbindung für die Einstellung einen Leerstring statt NULL. Ohne `NULLIF` bricht dann jede Abfrage ohne Kontext mit `invalid input syntax for type uuid` ab; mit `NULLIF` liefert sie 0 Zeilen.
- **Prisma-Extension**: Sie liest den Mandanten aus CLS (AsyncLocalStorage) und setzt `set_config('app.workspace_id', id, true)` transaktionslokal. Das ist PgBouncer-tauglich.
- **Explizite Filter**: Repositories filtern zusätzlich ausdrücklich nach `workspaceId` (Defense in Depth). In Dev und Test prüft eine Assertion, dass der Filter vorhanden ist und auf den Mandanten des Kontexts zeigt (`TENANT_FILTERS` in `packages/db`). Ohne Organisation im Kontext entfällt die Prüfung, dann greifen nur die nutzerbezogenen Lese-Policies.
- **System-Client**: Jede Operation des `app_system`-Clients wirft außerhalb einer mit `@SystemScope()` markierten Methode (Laufzeitprüfung über AsyncLocalStorage). ESLint erlaubt den Import von `createSystemPrismaClient` nur unter `src/infrastructure`.
- **CI-Prüfung**: Jede Tabelle mit Mandanten-Spalte (und `organization`) hat RLS aktiv und erzwungen, mindestens eine Policy, und jede Policy liest den Kontext über `NULLIF`. Die Prüfung (`findRlsViolations` in `packages/db`) läuft im Integrationstest gegen die migrierte Datenbank und lokal mit `pnpm check:rls`. Integrationstests mit zwei Mandanten zeigen, dass mandantenübergreifende Lesezugriffe 0 Zeilen liefern.
- **Unveränderliche und globale Tabellen**: `brand_voice_version`, `ai_generation` und `usage_record` sind für `app_user` append-only (kein UPDATE, kein DELETE). Das `price_book` ist zur Laufzeit nur lesbar; Preise und Stil-Presets kommen als Referenzdaten mit den Migrationen (ADR 0014).
- **Keine Materialized Views für Mandantendaten**, weil RLS dort nicht greift. Rollups sind normale Tabellen.

---

## 7. Scheduling und Publishing

**Postgres ist die Quelle der Wahrheit, nicht Redis.** Reine Delayed Jobs in BullMQ werden aus drei Gründen nicht verwendet: Redis ist nicht dauerhaft verlässlich, DB und Redis können ohne Outbox auseinanderlaufen, und Umplanen oder Abbrechen würde Job-Jonglage bedeuten.

1. **Planen** (Use Case `ScheduleVariant`):
   - Prüfen: `validatePost`, Account aktiv, Token bis `scheduledAt` gültig (sonst Warnung, etwa bei LinkedIn), Quote.
   - In einer Transaktion: `status=SCHEDULED`, `scheduleVersion++`, `OutboxEvent` und Audit-Eintrag.
2. **Scheduler-Tick** (alle 15 s):
   ```sql
   WITH due AS (SELECT id FROM post_variant
     WHERE status='SCHEDULED' AND scheduled_at <= now() + interval '30 seconds'
     ORDER BY scheduled_at LIMIT 500 FOR UPDATE SKIP LOCKED)
   UPDATE post_variant v SET status='QUEUED', queued_at=now(), version=v.version+1
   FROM due WHERE v.id = due.id RETURNING ...;
   ```
   - Danach wird der Job `publish.variant` mit `jobId = pub.{variantId}.{scheduleVersion}` (dedupliziert) und einem Delay bis zur exakten Uhrzeit eingereiht.
   - **Verpasstes Zeitfenster**: Varianten, die mehr als 6 h überfällig sind, gehen auf `FAILED(MISSED_WINDOW)` und lösen eine Benachrichtigung aus, außer der Workspace ist auf "trotzdem posten" eingestellt.
   - **Sweeper**: findet Varianten, die seit mehr als 2 min auf `QUEUED` stehen und keinen laufenden Job haben, sowie Varianten auf `PUBLISHING` mit abgelaufenem Lease (z.B. nach einem Worker-Absturz), und stößt den Job erneut an. Das ist dank derselben jobId und der Statusprüfung im Job gefahrlos; nach abgelaufenem Lease beginnt der Job immer mit dem Reconcile (Schritt 4).
3. **Publish-Job**:
   1. Passt der Status oder die `scheduleVersion` nicht, ist der Job veraltet und endet ohne Aktion.
   2. Lease per Compare-and-Swap: `PUBLISHING` mit `leaseUntil = now()+5min`. Dauert ein Schritt länger (z.B. das Warten auf einen Instagram-Container), wird der Lease vorher verlängert. Inhaber ist das Lock-Token des Laufs in BullMQ; ein Job, der auf den lebenden Lease eines anderen Laufs trifft, wartet bis zu dessen Ende.
   3. `PublishAttempt(STARTED)` anlegen.
   4. Gibt es einen offenen oder unklaren früheren Versuch, wird zuerst `adapter.reconcile()` aufgerufen. Es sucht über `contentHash` und Text nach einem bereits erschienenen Post. So entsteht nie ein doppelter Post. Das Token wird dafür vorher erneuert (Schritt 5). Findet der Reconcile nichts, wird nur gesendet, wenn der offene Versuch noch nichts gesendet hatte (`STARTED`) oder zu einer früheren `scheduleVersion` gehört, auf die der Nutzer schon geantwortet hat; sonst `NEEDS_ATTENTION` ([ADR 0024](adr/0024-publish-job-schreibmarke-und-lease.md)).
   5. Token erneuern, falls nötig: unter dem Redis-Lock `lock:conn:{id}` und mit erneutem Lesen nach dem Lock. Das ist wichtig für die rotierenden, nur einmal gültigen Refresh Tokens von X.
   6. Erneut validieren und signierte Medien-URLs (1 h) erzeugen.
   7. Im Dry-Run wird statt des Sendens nur der Payload-Snapshot gespeichert und die Variante mit Dry-Run-Kennzeichnung als veröffentlicht markiert. Ein Reconcile entfällt, das Token wird wie sonst erneuert.
   8. Lease verlängern, den Versuch auf `UNKNOWN` setzen (Schreibmarke: ein Absturz ab hier gilt als "vielleicht gesendet") und `adapter.publish()` aufrufen. Bei Erfolg schreibt eine Transaktion `PUBLISHED`, `externalPostId`, `metricsNextAt`, die Kostensätze und ein `OutboxEvent`.
   9. Für den X-Browser-Adapter: `xb.publish` einreihen; die Variante bleibt mit verlängertem Lease auf `PUBLISHING`, bis `xb-results` sie abschließt.

### 7.1 Fehlerbehandlung

| Fehler | Reaktion |
|---|---|
| `TRANSIENT` (5xx, Netzwerkfehler vor dem Senden) | `RETRYING`, Backoff 30 s, 2 min, 8 min, 30 min, 2 h mit Jitter, höchstens 6 Versuche |
| `RATE_LIMITED` mit Retry-After | Job verschieben, ohne einen Versuch zu verbrauchen; der Plattform-Limiter wird gefüttert |
| `AUTH_EXPIRED` | einmal Refresh; schlägt das fehl: Verbindung `NEEDS_REAUTH`, Variante `FAILED(REAUTH_REQUIRED)`, Benachrichtigung |
| `VALIDATION_REJECTED`, `PERMISSION_DENIED`, `DUPLICATE` | sofort `FAILED` mit übersetztem Grund |
| `OUTCOME_UNKNOWN` (Timeout nach dem Senden) | Reconcile; bleibt es unklar: `NEEDS_ATTENTION`, der Nutzer wählt "erneut prüfen", "trotzdem posten" oder "verwerfen" |
| `CHALLENGE_REQUIRED`, `SELECTOR_DRIFT` (Browser) | Account `NEEDS_REAUTH` bzw. Circuit Breaker; Variante `NEEDS_ATTENTION`; nie automatisch erneut |
| `SPEND_CAP_REACHED` (X) | `FAILED(SPEND_CAP)`, der Admin wird benachrichtigt |

Sind alle Versuche erschöpft, geht eine Kopie in die Dead-Letter-Queue (einsehbar in Bull Board) und es wird alarmiert.

**Benachrichtigungen** ([ADR 0025](adr/0025-benachrichtigungen-und-token-monitor.md)): Endet eine Variante auf `FAILED` oder `NEEDS_ATTENTION`, schreibt dieselbe Transaktion das Outbox-Ereignis `notification.requested`. Die Rolle `notify` benachrichtigt die Person, die den Post erstellt hat (ist sie kein Mitglied mehr oder darf den Workspace nicht öffnen: Owner und Admins), in der App und per E-Mail, wie sie es eingestellt hat. Muss eine Verbindung neu verbunden werden, hören Owner und Admins davon, und die geplanten Varianten ihrer Accounts tragen bis zum neuen Grant den Fehlercode `REAUTH_REQUIRED` als Markierung; ihr Status bleibt `SCHEDULED`.

### 7.2 Zustandsautomat einer PostVariant

```
DRAFT --planen--> SCHEDULED --fällig--> QUEUED --Job übernimmt--> PUBLISHING --ok--> PUBLISHED --löschen--> DELETED
  ^                |  |  ^                 |                        |  |  |
  |   zurück ------'  |  '-- umplanen -----' (scheduleVersion++)    |  |  '--unklar--> NEEDS_ATTENTION
  |                   '--abbrechen--> CANCELED                      |  |                (Reconcile ok -> PUBLISHED)
  |                                                                 |  '--temporär--> RETRYING --Backoff--> PUBLISHING
  '--- bearbeiten / erneut planen <--- FAILED <--endgültig / erschöpft / Zeitfenster verpasst
                                       (FAILED, NEEDS_ATTENTION --"erneut"--> SCHEDULED)
```

- **Durchsetzung**: Der Automat ist eine reine Übergangstabelle in `packages/core/src/publishing/domain/variant-state-machine.ts`. Jeder Übergang wird mit Versionsprüfung gespeichert und schreibt ein Outbox-Ereignis `variant.status`; verbotene Übergänge werfen Domain-Fehler.
- **Über das Diagramm hinaus** ([ADR 0023](adr/0023-planen-zeitzonen-und-zustandsautomat.md)): "Jetzt posten" direkt nach `QUEUED`; Abbrechen auch aus `QUEUED` und `RETRYING`; aus `NEEDS_ATTENTION` "erneut prüfen" und "trotzdem posten" nach `QUEUED`, "verwerfen" nach `CANCELED`; `PUBLISHING` nach `PUBLISHING`, wenn ein Job eine Variante mit abgelaufenem Lease übernimmt.
- **Bearbeiten**: in `DRAFT` und `SCHEDULED` erlaubt, aus `FAILED` und `CANCELED` zurück nach `DRAFT`. Gesperrt in `QUEUED`, `PUBLISHING`, `RETRYING` und `NEEDS_ATTENTION`, weil der Reconcile einen unveränderten `contentHash` braucht.
- **Status des Master-Posts**: wird abgeleitet (DRAFT, SCHEDULED, PARTIAL, PUBLISHED, FAILED).
- **Später**: ein Freigabe-Workflow (`PENDING_APPROVAL`).

### 7.3 Zeitzonen

- Die Server laufen in UTC. Die API nimmt `{ localDateTime, timeZone }` entgegen; der Core rechnet mit `Intl` um (`resolveLocalTime`, [ADR 0023](adr/0023-planen-zeitzonen-und-zustandsautomat.md)). Gespeichert werden der UTC-Zeitpunkt und die IANA-Zone.
- Zeiten in einer Zeitumstellungslücke ergeben einen 422-Fehler mit Vorschlag (die erste gültige Minute nach der Lücke, im Problem-Dokument unter `params`). Bei doppelten Zeiten wird der frühere Offset verwendet.
- Der Kalender zeigt standardmäßig die Workspace-Zeitzone und lässt sich auf die eigene Zeitzone umschalten.

### 7.4 Queues (`packages/queue`, Payloads beim Einreihen und Verarbeiten per zod validiert)

| Queue | Jobs | Dedupe (Job-ID) | Verarbeitet von (`WORKER_ROLES`) |
|---|---|---|---|
| `scheduler` | `tick.publish` (15 s), `tick.sweep-queued` (60 s), `tick.outbox-relay` (1 s), `tick.analytics` (5 min), `tick.tokens` (1 h), `tick.account-metrics` (täglich, gestaffelt), `tick.maintenance` (nachts) | Job-Scheduler-ID | `scheduler` |
| `publish` | `publish.variant { workspaceId, variantId, scheduleVersion, trigger, traceparent }` | `pub.{variantId}.{scheduleVersion}` | `publisher` |
| `publish-dead` | `publish.dead` (Kopie eines endgültig gescheiterten Publish-Jobs, nur zum Ansehen in Bull Board) | `dead.pub.{variantId}.{scheduleVersion}` | - |
| `xb-commands` / `xb-results` | `xb.publish`, `xb.metrics`, `xb.verify-session`, `xb.delete`, `xb.login.start`, `xb.canary` / `xb.result` | `xb.{op}.{id}.{v}` | browser-worker / `publisher` |
| `media` | `media.process`, `media.render` | `media.{assetId}`, `rend.{assetId}.{profile}.{cropHash}` | `media` |
| `analytics` | `metrics.post` (gebatcht pro Account), `metrics.account`, `metrics.rollup` | `mp.{accountId}.{bucket}` | `analytics` |
| `tokens` | `token.refresh` | `tok.{connectionId}` | `publisher` |
| `ai` | `ai.topic-ideas`, `ai.alt-text` (für Vorschläge im Hintergrund; auf Knopfdruck laufen beide synchron, ADR 0016 und 0021) | - | `ai` |
| `notifications` | `notify.dispatch`: ein Outbox-Ereignis (in der App und per E-Mail an seine Empfänger) oder eine E-Mail an eine Adresse | `ntf.{outboxId}` für das Ereignis, `ntf.{outboxId}.{userId}` für seine E-Mails | `notify` |
| `billing` | `stripe.webhook`, `usage.report` | `stripe.{eventId}` | `billing` |
| `gdpr` | `gdpr.export`, `gdpr.erase` | `gdpr.{requestId}` | `gdpr` |

- **Job-IDs ohne Doppelpunkt**: BullMQ lehnt eigene Job-IDs mit `:` ab (`Custom Id cannot contain :`; geduldet wird nur eine Altform mit genau drei Segmenten). Deshalb trennt der Punkt die Bestandteile. Redis-Schlüssel für Locks und Pub/Sub (`lock:conn:{id}`, `ws:{workspaceId}:events`) sind davon nicht betroffen.
- **Payloads**: enthalten nur IDs und werden im Job neu aus der DB gelesen. Ausnahmen sind die `xb-*`-Queues, weil der browser-worker keinen DB-Zugriff hat, und die E-Mails in `notifications`, die Adresse und Text tragen. E-Mails mit Link (Verifizierung, Passwort-Reset, Einladung) tragen den Link, weil nur der Hash des Tokens gespeichert ist; sie verlassen Redis direkt nach dem Versand, fehlgeschlagene nach einem Tag (ADR 0012). Die Jobs eines Outbox-Ereignisses und seine E-Mails bleiben nach dem Lauf einen Tag, damit ihre Job-ID einen zweiten Versand verhindert (ADR 0025).
- **Redis-Betrieb**: `maxmemory-policy noeviction` (Voraussetzung für BullMQ) und AOF-Persistenz.
- **Outbox-Relay**: läuft als `tick.outbox-relay` im 1-s-Takt mit `FOR UPDATE SKIP LOCKED`.
- **`tick.maintenance`**: bündelt die nächtlichen Aufgaben: Rollup-Komplettlauf (Abschnitt 8), Aufräumen der Medien (Abschnitt 9) und Aufbewahrungsfristen (Leitfaden, Schritt 8.3).

---

## 8. Analytics und KPIs

**Polling-Kaskade pro Post** (`metricsNextAt`/`metricsStep`, gebatcht pro Account):

| Zeitpunkt | LinkedIn | Facebook / Instagram | X (API, kostenpflichtig) | X (Browser) |
|---|---|---|---|---|
| +1 h | ja | ja | nein | nein |
| +24 h | ja | ja | ja | ja |
| +72 h | ja | ja | ja | nein |
| +7 d | ja | ja | ja | ja |
| +30 d | ja | ja | optional je Tarif | nein |

- **Nach dem letzten Zeitpunkt**: Schluss. Ein manueller Aktualisieren-Button ist auf einmal pro Stunde begrenzt und zeigt bei X die Kosten an.
- **Konfiguration**: global, pro Tarif und pro Workspace. Batch-Abrufe wo möglich: X bis 100 IDs, Meta Batch bis 50, LinkedIn Share-Listen.
- **Account-Metriken**: täglich um ca. 03:00 Workspace-Zeit, gestaffelt (Follower, Reichweite, Profil- bzw. Seitenaufrufe).

**Normalisierung** (versionierte Mappings pro Adapter; die Rohdaten bleiben erhalten, damit bei geänderten Mappings neu berechnet werden kann):

| Normalisiert | LinkedIn Organisation | LinkedIn Person | Facebook | Instagram | X |
|---|---|---|---|---|---|
| impressions | impressionCount | IMPRESSION | - (durch views ersetzt) | - (durch views ersetzt) | impression_count |
| reach | uniqueImpressionsCount | MEMBERS_REACHED | Unique-Views-Metrik | reach | - |
| views | - | - | Views-Metrik | views | - |
| likes / comments / shares | like/comment/shareCount | REACTION / COMMENT / RESHARE | reactions / comments / shares | likes / comments / shares | like / reply / retweet+quote |
| saves / clicks | - / clickCount | - / Link-Klicks | - / Klicks | saved / - | bookmark / url_link_clicks |

- **Abgeleitete Kennzahlen**: `engagements` ist die Summe der Interaktionen. `engagementRate = engagements / (impressions ?? views ?? reach)`; fehlt eine Basis, zeigt die UI "n. v." mit Tooltip.
- **Reichweite**: ist über Posts nicht addierbar. Das Dashboard benennt das ehrlich und nutzt Account-Reichweite, wo vorhanden.
- **Speicherung**: Snapshots (append-only), ein Upsert in `PostMetricLatest` und ein Rollup in `AnalyticsDaily` (zeitnah plus nächtlicher Komplettlauf). Ab ca. 50 Mio. Zeilen werden die Snapshots monatlich partitioniert.
- **Dashboard**:
  - KPI-Kacheln mit Vergleich zum Vorzeitraum: Impressions, Reach, Engagements, Engagement-Rate, Follower-Wachstum, Anzahl Posts.
  - Zeitreihen pro Tag, Plattform und Account.
  - Top-Posts (mit Mindest-Impressions) und Plattformvergleich.
  - Performance nach Post-Stil.
  - "Nächste geplante Posts".
  - CSV-Export.
  - Später eine Heatmap der besten Posting-Zeiten.
- **Rückkopplung**: Die Top-Performer fließen in die KI-Themenvorschläge ein.

---

## 9. Medien-Pipeline

1. **Upload anfordern**: `POST /api/w/:ws/media/uploads` prüft Speicher-Quote, Größe (max. 20 MB) und MIME-Whitelist (JPEG, PNG, WebP, statisches GIF; kein SVG). Die API legt `MediaAsset(PENDING_UPLOAD)` an und liefert eine Presigned-PUT-URL (5 min gültig, Content-Type signiert). Die Quote gilt bis Phase 7 pro Workspace (`MEDIA_STORAGE_LIMIT_BYTES`, Standard 5 GiB) und wird unter einer Advisory-Sperre pro Workspace geprüft ([ADR 0019](adr/0019-medien-upload-und-verarbeitung.md)).
2. **Upload**: Der Browser lädt direkt in den S3-Speicher hoch, mit Fortschrittsanzeige, und meldet dann `complete`. Die API prüft dabei per `HeadObject` die tatsächliche Größe und den Content-Type und löscht Objekte, die gegen die Regeln verstoßen.
3. **`media.process`**:
   - Magic-Byte-Prüfung mit eigener Signaturprüfung (`sniffImageType` in `@smp/core`; `file-type` ist nur ESM, ADR 0019). HEIC wird mit eigenem Grund abgelehnt.
   - `sharp` mit Pixel-Limit (50 MP), `failOn: 'error'`, Auto-Rotate, sRGB und entfernten EXIF/GPS-Daten (Datenschutz); ohne Cache, ein Thread pro Bild, zwei Bilder gleichzeitig pro Worker.
   - Maße, sha256 und Thumbnails (320/640 px WebP).
   - Optional ein ClamAV-Scan. Die Neukodierung ist der Hauptschutz, das Original wird nie ausgeliefert.
4. **Renditions** pro Plattform, erzeugt beim Anhängen und vor dem Posten sichergestellt:

| Profil | Format | Größe | Geometrie | Anzahl |
|---|---|---|---|---|
| `instagram_feed` | JPEG, sRGB | max. 8 MB | Breite 320 bis 1440 (Ziel 1080), Verhältnis 4:5 bis 1.91:1, Carousel einheitlich | 1 bis 10 |
| `facebook_photo` | JPEG/PNG | ca. 4 MB | längste Seite max. 2048 | 1 bis 10 |
| `linkedin_image` | JPEG/PNG | ca. 5 MB | 1200x627 oder 1080x1080 empfohlen | 1 bzw. 2 bis 20 |
| `x_image` | JPEG/PNG/WebP | max. 5 MB | max. 4096 px | max. 4 |

   - Die Werte liegen zentral in `packages/platform-rules` und werden pro Adapter-Phase gegen die Doku geprüft. Umgesetzt sind JPEG-Renditions (Qualität 85, Instagram 1080 x 1350 als Box, Facebook und LinkedIn 2048, X 4096) mit Qualitäts- und Größenstufen bis zum Byte-Limit; Stand der Prüfung je Wert in [ADR 0020](adr/0020-renditions-und-zuschnitt.md).
   - Liegt ein Seitenverhältnis außerhalb des Erlaubten, schneidet der Nutzer pro Plattform zu (`react-easy-crop`) oder wählt Letterbox (weiße Ränder). Der Zuschnitt wird in Pixeln des angezeigten Originals an `PostMedia` gespeichert; `PUT /api/w/:ws/variants/:variantId/media` setzt die Medien einer Variante mit ihrer `version` und reiht `media.render` ein.
5. **Öffentliche URLs für Meta**: Presigned GET mit 1 h Laufzeit und `.jpg`-Key. Als Fallback gibt es einen HMAC-signierten Medien-Proxy der API. Lokal laufen Tests über einen `cloudflared`-Tunnel oder den Mock-Adapter.
6. **Aufräumen** (in `tick.maintenance`): Assets, die nach 24 h noch auf `PENDING_UPLOAD` stehen, und S3-Objekte ohne zugehöriges `MediaAsset` nach 24 h; gelöschte Assets nach 30 Tagen. Unbenutzte, aber fertige Assets bleiben in der Bibliothek, und Thumbnails veröffentlichter Posts bleiben für die Historie erhalten.

---

## 10. Sicherheit, Auth, DSGVO

- **Authentifizierung**: Better Auth unter `/api/auth/*`.
  - E-Mail/Passwort mit Verifizierung und Reset, optional Google- oder Microsoft-Login.
  - TOTP-2FA mit Backup-Codes, für Owner erzwingbar. Passkeys später.
  - Cookie mit `httpOnly; Secure; SameSite=Lax`. Alles läuft same-origin, also kein CORS.
  - Rate-Limits pro Client-Adresse aus `X-Real-IP`, das der Reverse Proxy setzt. Details und Spike-Ergebnis in ADR 0006.
- **Request-Pipeline** (globale Guards in dieser Reihenfolge, registriert im `AccessModule`):
  1. `AuthGuard`: prüft die Session.
  2. `WorkspaceGuard`: löst den Workspace-Slug (`@WorkspaceScope()`, Routen `/api/w/:ws`) bzw. die Organisation (`@OrgScope()`, Routen `/api/org/:org`) zu Mitgliedschaft und Rolle auf (60 s in Redis gecacht, bei Rollenwechsel, Entfernen und Austritt sofort invalidiert; gecacht wird nur gewährter Zugriff). Fremde und unbekannte Mandanten liefern 404.
  3. `PermissionGuard`: z.B. `@RequirePermission('post.schedule')`; fehlt das Recht, kommt 403 `NOT_PERMITTED`.
  4. Der CLS-Kontext wird gesetzt, die Prisma-Extension nutzt ihn.
- **Deny by default**: Jede Route trägt genau eine Regel: `@Public()`, `@UserScope()` (Session genügt, z.B. Onboarding) oder `@RequirePermission()` (nur mit Mandanten-Scope). Ein Startup-Check bricht sonst den Start ab. Der Organisations-Kontext in einer Transaktion ist eine Berechtigung: Ihn setzt nur der Guard nach gefundener Mitgliedschaft, die Datenbank prüft die Mitgliedschaft nicht erneut.
- **Rechte-Matrix** (liegt in `packages/contracts`, damit die UI Aktionen ausblenden kann):

| Rechte | Owner | Admin | Editor | Viewer |
|---|---|---|---|---|
| Billing, Organisation löschen, Ownership übertragen | x | | | |
| Mitglieder, Workspaces, Einstellungen, Accounts verbinden, Brand Voices, X-Browser aktivieren, Audit-Log | x | x | | |
| Posts erstellen, bearbeiten, planen, veröffentlichen, löschen; Medien, KI, Ideen | x | x | x | |
| Kalender, Posts, Analytics, Ideen lesen | x | x | x | x |

- **Social OAuth**:
  - Der `state` (32 zufällige Bytes) liegt in Redis (10 min), gebunden an Nutzer, Workspace und Plattform und nur einmal verwendbar. PKCE bei X.
  - Der Code-Tausch läuft serverseitig. Danach wählt der Nutzer aus, was verbunden werden soll: die LinkedIn-Person oder Company Pages, Facebook-Seiten bzw. IG-Konten.
- **Token-Verschlüsselung** (`packages/crypto`):
  - Envelope-Encryption mit AES-256-GCM und einem zufälligen DEK pro Secret.
  - Als AAD dient `workspaceId:connectionId:feld`; so lassen sich Ciphertexte nicht zwischen Zeilen vertauschen.
  - Der KEK kommt über einen `KmsPort`: lokal ein Keyring aus der Env, in der Cloud AWS KMS oder Vault.
  - Rotation über Schlüsselversionen und einen Re-Wrap-Job. Browser-Sessions nutzen einen eigenen Keyring.
- **Härtung**:
  - zod-Validierung aller Eingaben, Jobs, Adapter-Antworten und der Env-Konfiguration beim Start.
  - Rate Limiting eingehend (`@nestjs/throttler` mit Redis) und ausgehend pro Plattform, App und Account (`rate-limiter-flexible`, wertet die Rate-Header der Plattformen aus).
  - Origin-Check gegen CSRF für alle schreibenden Anfragen unter `/api`, auch für `/api/auth` (Login-CSRF), dazu CSP mit Nonces (der Objektspeicher nur in `img-src` und `connect-src`, ADR 0022), HSTS, helmet.
  - Webhook-Signaturen prüfen: Stripe `constructEvent`; Meta `X-Hub-Signature-256` plus Deauthorize- und Data-Deletion-Callbacks (Pflicht für das App-Review).
  - Log-Redaction für Tokens, Cookies und Sessions.
- **Lieferkette**: Renovate (3 Tage Wartezeit, Digest-Pinning), pnpm-Gates (`minimumReleaseAge`, `trustPolicy: no-downgrade`, `strictDepBuilds`), `pnpm audit`, CodeQL, Dependency Review, gitleaks, Trivy-Image-Scans, SBOM. Die ersten Punkte gelten seit Phase 0 (ADR 0009).
- **DSGVO**:
  - Hosting in der EU, AV-Verträge und Liste der Unterauftragsverarbeiter (Anthropic, Stripe, E-Mail-Provider, Hosting) sowie ein Hinweis auf die Datenübermittlung an LinkedIn, Meta und X.
  - Datenexport (ZIP) und Löschung (30 Tage Soft-Delete, dann endgültig) als asynchrone Jobs.
  - Beim Trennen eines Accounts werden die Tokens bei der Plattform widerrufen.
  - Aufbewahrungsfristen, nur essenzielle Cookies, eine DSFA für die Browser-Automation (Session-Cookies sind faktisch Zugangsdaten).

---

## 11. Frontend (apps/web)

**Routen**: Die App ist hinter dem Login, deshalb gibt es kein Sprachpräfix. Die Sprache kommt aus dem Profil oder einem Cookie, Standard ist Deutsch.

```
(auth)/login | signup | verify-email | forgot-password | reset-password | invite/[token]
onboarding/                      Organisation, Workspace, Profil (Branche, Zielgruppe, Sprache, Zeitzone), erster Account
(app)/w/[ws]/dashboard           KPI-Kacheln, Charts, Top-Posts, nächste geplante Posts, Account-Status
(app)/w/[ws]/compose             neuer Post; /posts/[postId] zum Bearbeiten
(app)/w/[ws]/calendar            Monat/Woche/Liste, Filter über URL-Parameter
(app)/w/[ws]/posts               Tabelle mit Filtern nach Status, Plattform, Account, Datum; Massenaktionen
(app)/w/[ws]/analytics           Übersicht; Post- und Account-Details; CSV-Export
(app)/w/[ws]/ideas               KI-Themenvorschläge, eigene Ideen, "Post erstellen"
(app)/w/[ws]/media               Medienbibliothek
(app)/w/[ws]/accounts            verbinden/trennen, Status (z.B. "Token läuft in 5 Tagen ab"), X-Methode und Kosten
(app)/w/[ws]/brand-voices        Brand Voices (versioniert) und eigene Stile, "Stimme testen"
(app)/w/[ws]/settings            Profil, Zeitzone, Sprache, Publishing-Defaults, Dry-Run, X-Browser (Risikobestätigung)
(app)/org/[org]/members | workspaces | billing | audit-log | settings
(app)/account                    Profil, Sprache, Zeitzone, Sicherheit (2FA, Sessions), Benachrichtigungen
admin/                           Plattform-Admins: Feature-Flags, Kill-Switches, Link zu Bull Board
```

- **Composer**:
  - Links: Briefing, **Dropdown für den Post-Stil** (Presets und eigene), Brand Voice, Zielaccounts.
  - KI-Panel: streamt die Varianten als Tabs pro Ziel. Jede Variante ist editierbar, mit Live-Zeichenzähler aus `platform-rules`, Hashtag-Chips, erstem Kommentar und Refine-Schnellaktionen mit Diff.
  - Medien: Drag & Drop (mit Schaltflächen als Alternative zum Ziehen), Zuschnitt pro Plattform, Alt-Text mit KI-Vorschlag. Die Vorschau zeigt den Zuschnitt auf dem Thumbnail, die Datei für die Plattform rendert der Worker nach dem Speichern ([ADR 0022](adr/0022-medien-im-web.md)).
  - Vorschau: Mockups für LinkedIn, Instagram, Facebook und X, inklusive "...mehr"-Kürzung.
  - Planen: Datum und Uhrzeit in der Workspace-Zeitzone, "Jetzt posten", Zeitpunkt pro Variante überschreibbar, Kostenhinweis bei X.
  - Entwürfe werden automatisch gespeichert: 800 ms nach der letzten Änderung, nacheinander und mit Optimistic Locking; ein neuer Beitrag entsteht, sobald Briefing und eine Plattform da sind ([ADR 0017](adr/0017-composer-zustand-und-auto-speichern.md)).
- **Kalender**: FullCalendar mit Varianten in Plattformfarben und Status-Icon. Umplanen per Drag & Drop mit optimistischem Update und Rollback. Vergangene Zeitpunkte sind gesperrt. Für Tastaturnutzer gibt es einen Umplanen-Dialog.
- **Bibliotheken**: TanStack Query (Orval-Hooks), react-hook-form + zodResolver (dieselben Schemas wie die API), nuqs für den URL-State, der Composer-State als getesteter Reducer unter `useReducer` (Zustand-Stores nur für State, den mehrere Seiten teilen; ADR 0017), shadcn/ui + Tailwind 4, lucide, sonner, TanStack Table, Recharts, date-fns v4.
- **i18n**: next-intl mit ICU-Nachrichten, eine Datei pro Namespace und Sprache (`apps/web/messages/{de,en}/<namespace>.json`), typisierte Keys. Deutsch ist die Referenz; `pnpm check:i18n` prüft in der CI, dass jede Sprache dieselben Keys mit denselben Argumenten hat und jede Nachricht gültiges ICU ist. Plural über ICU (`{count, plural, one {...} other {...}}`), Datum und Zahlen über `useFormatter`. API-Fehlercodes werden im Client unter `errors.codes.<CODE>` übersetzt.
- **Live-Updates**: SSE `/api/w/:ws/events` invalidiert Query-Keys; als Fallback wird alle 30 s gepollt.
- **Ziel**: WCAG 2.2 AA.

---

## 12. Observability, CI/CD, Umgebungen

- **Logging**: pino (JSON) mit `requestId`, `traceId`, `workspaceId` und `jobId`; Secrets geschwärzt.
- **Tracing**: OpenTelemetry über HTTP, Prisma, Redis und BullMQ, `traceparent` in den Job-Payloads. Fehler gehen an Sentry.
- **Health und Queues**: Health-Checks (`/health/live`, `/health/ready`) für alle Dienste. Bull Board nur für Plattform-Admins.
- **Metriken**: Erfolgsquote pro Plattform, Verzögerung beim Veröffentlichen, Queue-Tiefe, Verzögerung des Scheduler-Ticks, KI-Tokens, Kosten und Cache-Trefferquote, Refusals, X-Ausgaben pro Workspace, Fehler beim Token-Refresh, Browser-Challenges.
- **Alarme**: Fehlerquote, Tick-Verzögerung über 60 s, Dead-Letter-Queue nicht leer, hängende QUEUED-Varianten, eine Welle von NEEDS_REAUTH, ausgelöster Kill-Switch.
- **CI** (GitHub Actions, pnpm + Turbo-Cache):
  1. lint (ESLint, Prettier, dependency-cruiser, Emoji-Check, Prüfung der i18n-Keys, commitlint)
  2. typecheck
  3. Unit-Tests
  4. Integrationstests mit Testcontainers (inkl. RLS)
  5. Adapter-Contract-Tests
  6. OpenAPI-Drift-Check (Integrationstest gegen `packages/api-client/openapi.json`, ADR 0013)
  7. Prisma-Migrationsprüfung (`migrate diff`, squawk)
  8. E2E mit Playwright gegen den gestarteten Stack (Compose-Infrastruktur, API, Worker, Web)
  9. Docker-Build (`turbo prune`, Trivy, Push nach GHCR auf main)

  Nächtlich laufen optionale Live-Smoke-Tests gegen Test-Accounts und die KI-Eval-Suite mit Budget-Limit. Ein eigener Workflow `security.yml` führt CodeQL, Dependency Review, `pnpm audit` und gitleaks aus (ADR 0009).
- **Umgebungen**: lokal (Mock-Modus), CI, Staging (echte Plattform-Apps im Dev-Modus, Stripe-Testmodus, Anthropic mit niedrigem Ausgabenlimit) und Produktion (EU).
- **Migrationen**: `prisma migrate deploy` als eigener Schritt vor dem Rollout, nach dem Expand/Contract-Prinzip. RLS, Partial Indexes und Trigger stehen als SQL-Migrationen.
- **Betrieb**: Postgres mit Point-in-Time-Recovery, Images non-root und schlank.

---

## 13. Teststrategie

| Ebene | Inhalt | Werkzeuge |
|---|---|---|
| Unit (Domain) | Zustandsautomat vollständig, Scheduling-, Zeitumstellungs- und Zeitfenster-Regeln (Property-Tests), `validatePost`, Zeichenzählung, Metrik-Normalisierung, Kosten, Quoten | Vitest, fast-check |
| Unit (Application) | Use Cases mit In-Memory-Fakes für die Ports | Vitest |
| Prompts | Snapshot-Tests der gerenderten Prompts (byte-stabil wegen Caching), Schema-Konformität | Vitest |
| Adapter-Contract | eine gemeinsame Suite, die jeder Adapter inkl. Mock bestehen muss: Fehler-Mapping 401/403/429/5xx, Normalisierung, Reconcile; aufgezeichnete und bereinigte Fixtures pro API-Version | msw v2 |
| Integration | RLS-Isolation (zwei Mandanten), Scheduler-Tick mit 2 parallelen Workern (kein doppeltes Einreihen), Absturz während des Publishings führt zu Reconcile ohne Duplikat, Outbox, Token-Refresh-Lock, Medien mit SeaweedFS | Testcontainers |
| API-E2E | Auth-Flows, Rechte-Matrix (Rolle x Endpunkt), Quoten, Webhook-Signaturen | supertest |
| Web-E2E | Registrieren, Onboarding, Mock-Account verbinden, KI-Post (Mock), Bild hochladen, für +1 min planen, veröffentlicht, Analytics gefüllt; Kalender-Drag & Drop; Einladung; Viewer nur lesend | Playwright |
| Browser-Adapter | lokale, bereinigte DOM-Fixtures von Login, Composer und Challenge-Seite plus aufgezeichnete JSON-Antworten; Challenge führt zur Pause; Drift-Fehlerpfad | Playwright |
| KI-Eval (optional) | Golden Briefs (DE/EN x Stile x Plattformen): Schema, Längen, verbotene Wörter, Sprache, Refusal-Quote, Kosten; Pflicht vor Prompt- oder Modellwechseln | Vitest + echte API mit Budget |
| Last | 10.000 fällige Varianten in derselben Minute, Durchsatz der Analytics-Batches | k6 |

In automatisierten Tests läuft immer der `MockAiProvider`, außer in der optionalen Eval-Suite.

---

## 14. Roadmap (jede Phase einzeln lauffähig, getestet und deploybar)

| Phase | Inhalt | Abnahmekriterium |
|---|---|---|
| **0 Fundament** | Monorepo, Configs, App-Gerüste mit Health-Endpunkten, alle Packages angelegt, Docker Compose (Postgres 17, Redis mit noeviction und AOF, SeaweedFS-S3 inkl. Bucket, Mailpit), Env-Validierung, Logging, OTel, Sentry, Prisma 7 + DB-Rollen + RLS-Grundlage, Seed-Gerüst, CI, `docs/ARCHITECTURE.md` + ADRs. Spikes: Claude Structured Outputs/Streaming/Caching/Fallbacks, RLS mit Prisma, zod 4, Better Auth in NestJS, S3-Upload mit CORS | `docker compose up` + `pnpm dev` startet alles; CI grün; Spike-Ergebnisse als ADRs dokumentiert |
| **1 Auth + Mandanten** | Better Auth (Registrierung, Verifizierung, Reset, 2FA), App-Shell mit i18n DE/EN, Onboarding, Organisationen, Workspaces, Mitglieder, Einladungen (Mailpit), Rechte-Matrix + Guards, RLS auf allen Tabellen, Audit-Log, Benachrichtigungs-Grundgerüst, Workspace-Wechsler | Rechte-Matrix-E2E grün; Mandanten-Isolationstests grün |
| **2 Composer + KI + Stile** | Posts und Varianten (Entwürfe), Brand Voices, Stil-Presets und eigene Stile, `AiProvider` (Anthropic + Mock), SSE-Generierung, Composer mit Textvorschau und Zählern, Refine, Ideen-Seite, `AiGeneration`-Audit, Kostenerfassung + Limit | echte und Mock-Generierung funktionieren; Cache-Treffer bei wiederholten Aufrufen; Refusal- und Truncation-Pfade getestet |
| **3 Medien** | Presigned Uploads, Bibliothek, Verarbeitung, Renditions + Zuschnitt, Alt-Text (manuell + KI), Anhängen an Varianten mit Plattformprüfung, Bildvorschau | 10-MB-Bild in unter 5 s bereit; Plattformfehler im Composer sichtbar |
| **4 Kanäle + Publishing + Scheduling** | Token-Tresor, OAuth-Framework, Accounts-UI, Adapter-Registry, zuerst `MockPlatformAdapter`, Scheduler, Publisher, Zustandsautomat, Retries, Reconcile, Dead-Letter-Queue, Benachrichtigungen (Fehler, Reconnect, Ablauf), Kalender mit Drag & Drop, Post-Liste, "Nächster Post", Jetzt posten, Dry-Run, Token-Ablauf-Monitor, Bull Board. **4a** LinkedIn Person, dann Organisation. **4b** Facebook + Instagram, danach Meta-App-Review einreichen. **4c** X-API (PKCE, Medien, Kosten-Ledger, Ausgabenlimit, Kostenvorschau) | CI-E2E mit Mocks; Staging postet auf echte Test-Accounts aller 4 Plattformen; Chaos-Test (Worker mitten im Publishing beenden) erzeugt keine Duplikate |
| **5 Analytics** | Planer, Collector, Normalisierung, tägliche Account-Metriken, Rollups, Dashboard, Post- und Account-Details, CSV-Export, Top-Performer fließen in die Ideen ein, X-Lesekosten | Zahlen stimmen im Rahmen der Toleranz mit den nativen Plattform-UIs überein |
| **6 X-Browser-Adapter** (Feature-Flag) | browser-worker-Container (gepinntes Playwright-Image, Egress-Allowlist, Redis-ACL), interaktiver Login, verschlüsselter storageState, Selector-Map v1 + Canary, Posten über die UI mit Auswertung der JSON-Antwort, Metriken, Challenge-Erkennung führt zu NEEDS_REAUTH, Kill-Switch + Circuit Breaker, UI für die Risikobestätigung, Tarif-Gate | funktioniert mit internen Test-Accounts; Challenge-Fixtures pausieren korrekt; Kill-Switch geprüft; rechtliche Freigabe |
| **7 Billing + Quoten** | Pläne, Stripe Checkout + Kundenportal, Webhooks, Limits überall durchgesetzt, nutzungsbasierte Abrechnung (KI-Mehrverbrauch, X-Kosten) über Stripe Billing Meters, Verbrauchsanzeige, Testphase, Mahnwesen (past_due führt nach einer Kulanzfrist zu Nur-Lesen) | Stripe-Test-Clock-E2E: Upgrade, Downgrade, Kündigung, past_due |
| **8 Härtung / DSGVO / Betrieb** | Export und Löschung, Aufbewahrungsjobs, AV-Verträge, Pentest + Fixes, Lasttests, Backup-/Restore-Probe, SLOs, Alarme, Runbooks, Barrierefreiheit, optional Freigabe-Workflow | Launch-Checkliste abgehakt |

Sinnvolle Release-Punkte: interne Alpha nach 4b, geschlossene Beta nach 5, allgemeine Verfügbarkeit nach 7 und 8.

### Externe Voraussetzungen (früh anstoßen, da die Reviews den kritischen Pfad bestimmen)

- **Rechtliches**: Firma, Domain, Datenschutzerklärung, AGB, Impressum, Data-Deletion-URL, AV-Vertragsvorlage. Alle App-Reviews brauchen das.
- **LinkedIn**:
  - Developer App, verifiziert über eine Company Page.
  - Self-Serve-Produkte "Sign In with LinkedIn using OpenID Connect" und "Share on LinkedIn".
  - Antrag auf die Community Management API und auf Member Post Analytics.
- **Meta**: Business-App, Business Verification, die Produkte Facebook Login for Business und Instagram API mit Instagram Login, App-Review mit Screencast pro Berechtigung. Bis zur Freigabe läuft alles im Dev-Modus mit Testern.
- **X**: Developer-Account, Projekt und App, OAuth 2.0, Pay-per-Use-Guthaben, Ausgabenlimit und Alarme.
- **Anthropic**: API-Keys pro Umgebung, Ausgabenlimits, AV-Vertrag.
- **Sonstiges**: Stripe (mit Stripe Tax für die EU-Umsatzsteuer), ein E-Mail-Provider (SPF, DKIM, DMARC), ein EU-Cloud-Account.

---

## 15. Risiken und Gegenmaßnahmen

| Risiko | Gegenmaßnahme |
|---|---|
| App-Reviews bei LinkedIn und Meta dauern lange oder werden abgelehnt | früh beantragen; Rechtstexte bereit; saubere Screencasts; bis dahin Dev-Modus mit Testern; LinkedIn-Personen-Posting (Self-Serve) zuerst |
| API-Änderungen und Abkündigungen (Meta-Versionen, Metrik-Umbenennungen, monatliche LinkedIn-Versionen, X-Preise) | gepinnte Versionen, versionierte Mappings mit Rohdaten, Contract-Tests, nächtliche Live-Smoke-Tests, Capabilities zentral in `platform-rules` |
| Token-Ablauf (LinkedIn 60 Tage ohne Refresh, Meta 60 bzw. 90 Tage, rotierende X-Refresh-Tokens) | Erinnerungen 14, 7 und 1 Tag vorher plus Banner; Warnung beim Planen über den Ablauf hinaus; Refresh unter Lock; Reconnect mit einem Klick |
| Doppelte Posts (At-least-once-Verarbeitung) | Lease per Compare-and-Swap, Versuchsprotokoll, Reconcile vor jedem Retry nach unklarem Ausgang, NEEDS_ATTENTION statt Raten, Wiederverwendung der IG-Container |
| Instagram braucht öffentliche JPEG-URLs und hat Tageslimits | signierte URLs mit `.jpg`-Key, Proxy-Fallback, JPEG-Renditions, Prüfung von `content_publishing_limit`, lokal Tunnel oder Mock |
| X-Kosten | PriceBook, Ausgabenlimit pro Workspace, Kostenvorschau im Composer, reduzierte Metrik-Kaskade, gebatchte Abrufe, Weiterberechnung; optional "eigene X-App" für Enterprise |
| X-Browser: Nutzungsbedingungen, Sperre, Fragilität | standardmäßig aus; Flag, Tarif-Gate und versionierte Risikobestätigung; Kill-Switch und Circuit Breaker; Canary; keine Umgehung von Schutzmechanismen; niedrige Frequenz; isolierter Container; rechtliche Prüfung |
| KI-Qualität, Refusals, Kostenspitzen, Modellwechsel | Port-Abstraktion; Modell und Effort per Env; Eval-Suite als Gate; Refusal-UX + Fallback; Quoten mit Reservierung; Prompt Caching |
| Datenleck zwischen Mandanten | RLS, explizite Filter, Assertion in Dev, CI-Policy-Check, Isolationstests |
| Rate-Limits (LinkedIn Development-Tier, Meta Business-Use-Case-Limits) | Token-Buckets pro App und Account in Redis, Auswertung der Header, Backoff ohne Verbrauch von Versuchen |
| Redis-Ausfall | Postgres ist die Wahrheit, Scheduler und Sweeper stellen den Queue-Zustand wieder her, AOF |
| Datenübermittlung außerhalb der EU (Anthropic, X, Meta) | AV-Verträge/SCCs, Transparenz über Unterauftragsverarbeiter, Datenminimierung in Prompts, Aufbewahrungsfristen |

---

## 16. Verifikation (End-to-End lokal)

```bash
pnpm install
cp .env.example .env          # AI_PROVIDER=mock, PLATFORM_MODE_*=mock
docker compose up -d          # postgres, redis, seaweedfs (+ Bucket), mailpit
pnpm db:migrate && pnpm db:seed
pnpm dev                      # web :3000, api :3001, worker (Health :3002); browser-worker über --profile xb
# Alternativ komplett in Containern (App über den Proxy unter http://localhost:8080):
docker compose --profile app up --build
```

- **Seed**:
  - Demo-Organisation mit Nutzern pro Rolle (`owner@demo.local`, `admin@`, `editor@`, `viewer@`).
  - Brand Voice und Stil-Presets, Mock-Accounts für alle 4 Plattformen.
  - Posts in jedem Status und 90 Tage synthetische Metriken.
- **MockPlatformAdapter**: nutzt die echten Capability-Tabellen und eine Fake-OAuth-Seite (so werden state und PKCE mitgetestet). Er simuliert Latenz, liefert deterministisch wachsende Metriken und injiziert Fehler pro Account: `failMode = rate_limit_once | auth_expired | unknown_outcome | permanent | slow`.
- **Dry-Run**: per `PUBLISH_DRY_RUN=true` oder pro Workspace. Echte Adapter erneuern Tokens und validieren, senden aber nicht, und speichern den Payload-Snapshot. So lassen sich echte Verbindungen ohne Posts und ohne X-Kosten prüfen.
- **Zeitraffer**: `SCHEDULER_TICK_MS=2000` und `ANALYTICS_CADENCE_SCALE=60` (1 Minute entspricht 1 Stunde).
- **Manueller Abnahmetest**:
  1. Als Owner einloggen (UI auf Deutsch) und im Profil auf Englisch umstellen.
  2. Briefing eingeben, Stil "Storytelling" wählen, per KI generieren (Mock oder echt mit `ANTHROPIC_API_KEY`) und mit "kürzer" verfeinern.
  3. Bild hochladen (Instagram braucht eins, X maximal 4) und für Instagram auf 4:5 zuschneiden.
  4. Für +2 Minuten planen. Im Kalender und in Bull Board den Ablauf SCHEDULED, QUEUED, PUBLISHING, PUBLISHED beobachten.
  5. Einen anderen Post per Drag & Drop umplanen; der alte Job endet ohne Aktion.
  6. `failMode=unknown_outcome` setzen. Erwartet: Reconcile, dann NEEDS_ATTENTION und eine E-Mail in Mailpit (:8025).
  7. Die Metrik-Snapshots kommen an und das Dashboard füllt sich.
  8. Als Viewer einloggen: Die UI ist nur lesend.
- **Automatisiert**: `pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration && pnpm test:e2e`, alles auch in der CI.
- **Echte Plattformen**: Staging oder lokal per `cloudflared`-Tunnel mit Dev-Mode-Apps und Test-Accounts. Zuerst im Dry-Run, dann ein echter Test-Post.


---

## 17. Nächste Schritte

1. Umsetzung nach [`IMPLEMENTATION_GUIDE.md`](./IMPLEMENTATION_GUIDE.md), beginnend mit Schritt 0.1 (Phase 0: Fundament).
2. Phase für Phase vorgehen, jeweils mit eigenen Commits, sodass nach jeder Phase ein Review möglich ist.
3. Parallel zu Phase 0 die externen Anträge stellen (Rechtstexte, LinkedIn, Meta, X, Stripe, Anthropic), weil die App-Reviews Wochen dauern können.
