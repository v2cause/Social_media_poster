# Autorisierung, Grenzen und Quellen

- **Stand**: 2026-10-18
- **Bezug**: Umsetzungsleitfaden, Schritt 8.4; ASVS V8.1.2, V8.2.3, V15.1.2, V15.1.3 und V2.4.1; [ADR 0039](../adr/0039-security-review-und-haertung.md); [ASVS-Checkliste](asvs-l2.md); Rechte-Matrix in `packages/contracts/src/permissions.ts` und [Architektur](../ARCHITECTURE.md), Abschnitt 10; Rechte für Stile, Brand Voices und Ideen in [ADR 0016](../adr/0016-content-und-ki-api.md); Limits der Tarife in [ADR 0035](../adr/0035-nutzungsabrechnung-und-durchsetzung-der-limits.md); Lieferkette in [ADR 0009](../adr/0009-sicherheits-baseline.md)

Das Dokument legt fest, wer welche Felder lesen und ändern darf und wie die API das durchsetzt. Es nennt die teuren Funktionen mit ihren Grenzen und die freigegebenen Quellen der Komponenten. Die Angaben nennen ihre Stelle im Code.

## Rollen und Rechte

Die Rechte-Matrix ist `ROLE_PERMISSIONS` in `packages/contracts/src/permissions.ts`. Die API prüft sie bei jeder Anfrage an eine Mandanten-Route mit `@RequirePermission()` (`apps/api/src/common/guards/permission.guard.ts`, sonst 403 `NOT_PERMITTED`). Die Web-App blendet mit `can()` nur Aktionen aus.

| Rechte | `OWNER` | `ADMIN` | `EDITOR` | `VIEWER` |
| --- | --- | --- | --- | --- |
| `org.read`, `member.read`, `workspace.read`, `post.read`, `analytics.read`, `idea.read` | x | x | x | x |
| `post.write`, `post.schedule`, `post.publish`, `post.delete`, `media.write`, `ai.use`, `idea.write` | x | x | x | |
| `member.manage`, `workspace.manage`, `settings.manage`, `account.manage`, `brand_voice.manage`, `x_browser.enable`, `audit.read` | x | x | | |
| `billing.manage`, `org.export`, `org.delete`, `ownership.transfer`, `org.security` | x | | | |

- **Plattform-Admins** sind keine Rolle der Matrix. Das Feld `isPlatformAdmin` setzt nur der Betrieb, nie die Person selbst (`input: false` in `apps/api/src/modules/identity/auth.ts`). Der `PlatformAdminGuard` (`apps/api/src/modules/identity/platform-admin.guard.ts`) verlangt das Feld und einen zweiten Faktor. Die einzigen Routen liegen unter `/api/admin/x-browser`: der Kill-Switch und die freigeschalteten Organisationen mit ID und Namen.
- **Guards** in dieser Reihenfolge (`apps/api/src/common/guards/access.module.ts`): Limit pro Adresse, Session, Limits pro Person und Route, Mandant (fremde Mandanten 404), gelöschte Organisation (409), 2FA-Pflicht der Organisation (403 `TWO_FACTOR_REQUIRED`), Recht (403), Nur-Lesen (402). Jede Route trägt genau eine Regel (`@Public()`, `@UserScope()` oder `@RequirePermission()`), sonst startet die API nicht (`apps/api/src/common/guards/route-access.check.ts`).
- **Workspaces**: `OWNER` und `ADMIN` sehen alle Workspaces der Organisation. `EDITOR` und `VIEWER` sehen die Workspaces ihrer Einschränkung (`MembershipWorkspace`), ohne Einschränkung alle (`seesAllWorkspaces` in `packages/core/src/tenancy/domain/roles.ts`, Policy `member_read` in der Migration `0002_rls_tenancy`).
- **Test**: `apps/api/test/permission-matrix.integration.test.ts` ruft jede Mandanten-Route mit jeder Rolle auf.

### Regeln pro Feld (V8.1.2)

Die Spalten nennen das nötige Recht; welche Rollen es haben, zeigt die Matrix.

| Ressource | Lesen | Ändern |
| --- | --- | --- |
| Eigenes Konto | nur die Person selbst: `/api/me` mit ID, E-Mail, Name, Bestätigung, 2FA-Status, Sprache und Zeitzone | `locale` und `timezone` über Better Auth, mit zod geprüft; `isPlatformAdmin` nie |
| Organisation | `org.read`: Name, eigene Rolle und Rechte, Zustand des Abos, Löschung, `requireTwoFactor` | 2FA-Pflicht: `org.security`, einschalten nur mit eigenem zweitem Faktor (sonst 409 `TWO_FACTOR_SETUP_REQUIRED`); Löschen: `org.delete` mit dem Namen als Bestätigung |
| Mitglieder | `member.read`: Name, E-Mail, Rolle, Workspaces, Beitritt | Rolle und Entfernen: `member.manage`. Die Rolle `OWNER` vergeben, ändern und entfernen nur Owner; der letzte Owner bleibt (409 `LAST_OWNER`). Sich selbst entfernt niemand, der Austritt läuft über `leave`. `ownership.transfer` hat keine eigene Route. |
| Einladungen | `member.manage`, ohne Token; die Vorschau nur mit dem Link | `member.manage`. Einladungen mit der Rolle `OWNER` senden, erneuern und widerrufen nur Owner (`invite-member.ts`, `manage-invitation.ts`). Annehmen nur mit der eingeladenen, bestätigten Adresse (403 `INVITATION_EMAIL_MISMATCH`). |
| Workspace-Einstellungen (`dryRun`, `missedWindowBehavior`, `effortOverrides`) | `workspace.read` | `settings.manage` |
| Posts und Varianten | `post.read` | `post.write`: Briefing, Sprache, Stil, Brand Voice, Plattformen, Text, Hashtags, erster Kommentar, Link, KI-Warnungen. Zeitpunkt, Account und Status nur über Planen und Veröffentlichen (`post.schedule`, `post.publish`). `externalUrl`, `publishedAt` und `failureCode` stehen in keinem Request-Schema (`packages/contracts/src/content.ts`, `publishing.ts`). |
| Stile und Brand Voices | `post.read` | `brand_voice.manage` |
| Ideen | `idea.read` | `idea.write`; Generieren mit `ai.use` |
| Medien | `post.read`: Metadaten, Alt-Text, Nutzung, Thumbnails | `media.write`: Upload, Alt-Text, Löschen |
| Verbundene Accounts | `workspace.read`: Name, Handle, Status, Ablauf, fehlende Scopes, Kosten | `account.manage`: Verbinden, Auswahl nach der Zustimmung, Neu verbinden, Trennen |
| X-Browser | `workspace.read`: Status, Bestätigung mit Version, Zeit und Name | Freischalten mit Passwort und Abschalten: `x_browser.enable`; Login mit Zugangsdaten: `account.manage` |
| Abo | alle Mitglieder: Zugang, Status, Ende von Testphase und Kulanzfrist. Tarif, Limits, Verbrauch und Rechnungen: `billing.manage` | Checkout, Tarifwechsel, Kundenportal: `billing.manage`. Tarif und Status ändert nur die Worker-Rolle `billing` mit den Daten von Stripe ([ADR 0033](../adr/0033-tarife-abo-und-nur-lesen.md)). |
| Audit-Log | `audit.read`, mit IP-Adresse und User-Agent | niemand |
| Datenexport | `org.export`: Status und Größe; das Archiv nur über einen Link von 5 min | `org.export` |
| Benachrichtigungen | nur die Person selbst (`@UserScope()`, RLS pro Person) | nur die Person selbst |
| Live-Ereignisse | `workspace.read`: nur IDs und Status. Benachrichtigungen und Schritte des X-Logins nur an die Person selbst (`toLiveEventDto` in `apps/api/src/modules/live/live-events.controller.ts`) | keine |

### Durchsetzung (V8.2.3)

- **Antworten**: Alle Antwortschemas liegen in `packages/contracts`. Der `ZodSerializerInterceptor` (`apps/api/src/bootstrap.ts`) parst jede Antwort einer Route mit `@ZodResponse` durch ihr Schema; `z.object` entfernt dabei jedes andere Feld. Mapper wie `toMediaAssetDto` wählen die Felder zusätzlich einzeln aus. Die Ereignisse der Streams laufen durch `generationEventSchema` und `liveEventDtoSchema`.
- **Anfragen**: Der `ZodValidationPipe` parst Body und Query gegen ihr Schema. Felder außerhalb des Schemas erreichen keinen Use Case; ein `status` im PATCH einer Variante kommt so nicht an.
- **Use Cases** prüfen die Rolle ein zweites Mal, zum Beispiel `isManager`, `assertCanGrantRole` und `assertCanManageMember` (`packages/core/src/tenancy/domain/roles.ts`), `canWriteMedia`, `canPublish` und die Prüfung auf `OWNER` in Abrechnung und Datenschutz.

### Was die API nie ausgibt

- **Medien**: Objektschlüssel und Originale. Antworten tragen nur Thumbnails hinter signierten URLs, die eine Stunde gelten (`apps/api/src/modules/media/media.mappers.ts`); keine Route signiert ein Original. Die Originale stehen nur im Archiv des Datenexports.
- **Plattform-Tokens und Sessions des X-Browsers** liegen nur versiegelt in der Datenbank (`access_token_sealed`, `refresh_token_sealed`, `session_sealed`); kein Schema in `packages/contracts/src/channels.ts` kennt sie. Zugangsdaten und Codes des X-Logins gehen nur hinein (`packages/contracts/src/x-browser.ts`).
- **Token-Hashes**: Von Einladungen ist nur der Hash des Tokens gespeichert, von Reset-Tokens nur der SHA-256 (`verification: { storeIdentifier: 'hashed' }` in `auth.ts`). Keine Antwort enthält einen dieser Tokens oder seinen Hash.
- **Passwort-Hashes** (scrypt): Better Auth 1.7.9 gibt `password` und die OAuth-Tokens aus `auth_account` nicht aus (`returned: false`).
- **Zweiter Faktor**: Schlüssel und Backup-Codes gehen nur an die Person selbst, nach dem Passwort und bei aktivem Faktor nach einem bestätigten Code (`apps/api/src/modules/identity/auth-hooks.ts`).
- **Stripe**: `STRIPE_SECRET_KEY` bekommen nur API und Worker, `STRIPE_WEBHOOK_SECRET` nur die API (`compose.yaml`); die Web-App liest keines von beiden. Statt der Kunden-ID nennt die Antwort `hasCustomer` (`apps/api/src/modules/billing/billing.mappers.ts`).
- **Sessions anderer Personen**: Keine Route liefert sie. `/api/auth/list-sessions` listet nur die eigenen Sessions, mit Token, IP-Adresse und User-Agent; das Token der eigenen Sessions in Antworten von Better Auth ist ein akzeptiertes Risiko (ADR 0039).
- **IP-Adressen und User-Agents**: Außer in den eigenen Sessions (Antworten von Better Auth) stehen sie nur im Audit-Log (`audit.read`) und im Export. Der nächtliche Lauf leert sie im Audit-Log nach 30 Tagen ([ADR 0038](../adr/0038-aufbewahrungsfristen.md)). Die IP-Adresse einer Risikobestätigung zeigt die Statusantwort des X-Browsers nicht.
- **Plattform-Rolle und 2FA-Status anderer Personen**: weder in der Mitgliederliste noch im Export. `EXPORT_TABLES` in `packages/db/src/gdpr/prisma-organization-data-source.ts` lässt diese Spalten, Token-Hashes und versiegelte Spalten aus.

### Zweite Linie: Datenbank

- Row-Level Security mit `ENABLE` und `FORCE ROW LEVEL SECURITY` auf jeder Mandantentabelle (Migrationen `packages/db/prisma/migrations/*_rls_*`). Die Laufzeitrolle `app_user` hat kein `BYPASSRLS`; `app_system` umgeht RLS und ist nur für Methoden mit `@SystemScope()` gedacht (`infra/docker/postgres/init/01-roles.sql`). `pnpm check:rls` (`tools/check-rls.ts`) prüft Abdeckung und Policies. Die Tabellen von Better Auth sind global und ohne RLS.
- Spaltenrechte für `app_user`: das Audit-Log weder ändern noch löschen (`0002_rls_tenancy`); am Abo nur `stripe_customer_id` und `updated_at` (`0018_rls_billing`); an einer Risikobestätigung nur `revoked_at` (`0016_rls_x_browser`); an einer Datenschutz-Anfrage nur `status`, `completed_at` und `updated_at` (`0023_rls_organization_deletion`). `plan` und `price_book` sind nur lesbar.
- In Entwicklung und Tests verlangt `packages/db/src/assert-tenant-filter.extension.ts` in jeder Abfrage den Filter auf den Mandanten.

## Teure Funktionen und ihre Grenzen (V15.1.3, V2.4.1)

Die Limits zählen in Redis. Öffentliche Routen zählen pro Client-Adresse (`X-Real-IP`, von Caddy überschrieben; IPv6 nach /64). Jede Ablehnung mit 429 schreibt das Ereignis `security.rate_limited` (`apps/api/src/common/filters/problem-details.filter.ts`, für `/api/auth` `authRateLimitEvents`). Test: `apps/api/test/rate-limits.integration.test.ts`.

| Funktion | Kosten oder Risiko | Grenze und Ort | Antwort |
| --- | --- | --- | --- |
| Jede Route der API außer `/api/auth` | Last auf API, Datenbank und Redis | 3.000 Anfragen pro Adresse und Minute vor der Session, 600 pro Person und Minute über alle Routen (`DEFAULT_INBOUND_RATE_LIMITS` in `apps/api/src/common/throttling/throttling.ts`) | 429 `HTTP_429` mit `Retry-After` |
| `/api/auth` | Raten von Passwörtern und Codes | Better Auth 1.7.9 pro Adresse und Pfad: 100 in 60 s (`rateLimit` in `apps/api/src/modules/identity/auth.ts`, aus nur in der Entwicklung); nach seinen Standardregeln 3 in 10 s für `/sign-in`, `/sign-up`, `/change-password`, `/change-email` und `/two-factor/*`, 3 in 60 s für `/request-password-reset` und `/send-verification-email` | 429 |
| Fehlgeschlagene Anmeldung | Raten aus vielen Adressen | 10 pro Konto in 15 min ab dem ersten Fehler (`SIGN_IN_FAILURES_PER_ACCOUNT`). Danach hat ein Browser, der sich vorher angemeldet hat, 5 eigene (`SIGN_IN_FAILURES_PER_DEVICE`, Geräte-Cookie 180 Tage). Ein Passwort-Reset hebt die Sperre auf (`apps/api/src/modules/identity/auth-hooks.ts`). | 429 `TOO_MANY_ATTEMPTS` |
| Passwort einer Session | eine gestohlene Session rät das Passwort | 5 falsche Passwörter pro Person in 15 min an `/change-password` und den Routen des zweiten Faktors (`PASSWORD_FAILURES_PER_USER`); 5 Versuche in 15 min vor dem Freischalten des X-Browsers (`apps/api/src/modules/identity/password-check.ts`) | 429 `TOO_MANY_ATTEMPTS` |
| TOTP-Code | Wiederverwendung | jeder Code einmal pro Person (`TOTP_USED_SECONDS`, 120 s); eine Änderung des Faktors nur binnen 5 min nach einem bestätigten Code (`SECOND_FACTOR_CONFIRMED_SECONDS`) | 401 `CODE_ALREADY_USED`, 403 `SECOND_FACTOR_REQUIRED` |
| E-Mails der Auth-Flows | Versand an fremde Adressen | 5 pro Adresse und Stunde; weitere entfallen, die Antwort bleibt gleich (`AUTH_MAILS_PER_ADDRESS_AND_HOUR` in `apps/api/src/modules/identity/auth-mailer.ts`) | unverändert |
| Einladungs-Mails | Versand an fremde Adressen aus beliebig vielen Organisationen | 5 pro Adresse und Stunde aus allen Organisationen zusammen; weitere entfallen mit der Warnung `invitation.mail_dropped`, die Einladung bleibt gültig (`INVITATION_MAILS_PER_ADDRESS_AND_HOUR` in `apps/api/src/modules/tenancy/invitation-notifier.ts`) | unverändert |
| KI: Generieren, Überarbeiten, Alt-Text, Ideen, Test der Brand Voice | Kosten beim Anbieter | 10 Aufrufe pro Person und Minute, 2 gleichzeitig, 60 pro Workspace und Stunde (`DEFAULT_AI_RATE_LIMITS` in `apps/api/src/modules/content/ai-rate-limiter.ts`). Vor jedem Aufruf reserviert die Quote des Monats die geschätzten Kosten (`packages/core/src/usage/application/quota-service.ts`). Höchstens 16.000 Ausgabe-Tokens, eine Wiederholung mit 32.000, Timeout 120 s (`packages/ai/src/anthropic/anthropic-ai-provider.ts`). | 429 `AI_RATE_LIMITED`, 402 `QUOTA_EXCEEDED` |
| Upload anfordern | Speicher und Verarbeitung | 300 pro Person und Stunde (`apps/api/src/modules/media/media.controller.ts`); JPEG, PNG, WebP und statisches GIF bis 20 MB (`packages/core/src/media/domain/rules.ts`); Speicher des Tarifs über alle Workspaces, gezählt unter einer Sperre (`request-upload.ts`) | 422 `MEDIA_TYPE_NOT_ALLOWED` oder `MEDIA_TOO_LARGE`, 402 `STORAGE_QUOTA_EXCEEDED` |
| Upload in den Objektspeicher | späte oder fremde Objekte | PUT signiert für genau Typ und Länge, 5 min gültig (`UPLOAD_URL_SECONDS`); `media.drop-upload` löscht das Upload-Objekt eine Stunde nach Ablauf des Links (`UPLOAD_DROP_SECONDS`); eine abweichende Größe oder ein abweichender Typ lehnt das Asset ab (`complete-upload.ts`) | Asset `REJECTED` |
| Bildverarbeitung im Worker | Speicher und CPU | höchstens 50 MP, geprüft vor dem Dekodieren (`MAX_INPUT_PIXELS`, `limitInputPixels` in `packages/media/src/sharp-image-processor.ts`); 2 Bilder gleichzeitig pro Worker (`MEDIA_CONCURRENCY`), ein libvips-Thread, kein Cache | Asset `REJECTED` mit `DIMENSIONS_TOO_LARGE` |
| Request-Body | Speicher der Prozesse | Caddy 1 MB für `/api/*` und die Web-App (`infra/docker/caddy/Caddyfile`); API 1 MB für JSON und Webhooks (`apps/api/src/bootstrap.ts`), 64 KB für `/api/auth`; dort bekommt ein Body in Stücken ohne `Content-Length` 411 (`apps/api/src/common/security/body-limits.middleware.ts`) | 413, 411 |
| Live-Stream (`/api/w/:ws/events`) | offene Verbindungen | 10 pro Person über alle Workspaces, Lease 45 s (`apps/api/src/modules/live/live-stream-slots.ts`); jeder Stream endet nach 5 min, der Browser öffnet ihn neu durch die Guards (`STREAM_LIFETIME_MS`) | 429 |
| Organisation anlegen | Testphase mit KI-Guthaben und Speicher | 3 pro Person in 30 Tagen, gezählt unter einer Sperre (`packages/core/src/tenancy/application/create-organization.ts`); die Route 10 pro Stunde (`memberships.controller.ts`) | 429 `ORGANIZATION_LIMIT_REACHED` |
| Datenexport | Lauf über alle Tabellen und Medien | 5 Anforderungen pro Person und Tag, 30 Links pro Stunde (`apps/api/src/modules/gdpr/data-exports.controller.ts`); ein offener Export pro Organisation (`RequestDataExport`); die Rolle `gdpr` verarbeitet pro Worker einen Job zur Zeit (`apps/worker/src/processors/gdpr.processor.ts`); Link 5 min, Archiv 24 h | 429 |
| Weitere Routen mit `@LimitPerUser`, pro Stunde | E-Mails, Plattformen, Stripe | Einladen 30, erneut senden 10; Vorschau (pro Adresse) und Annehmen je 30; Account verbinden 30, OAuth-Callback 60 (pro Adresse); Checkout, Tarifwechsel und Kundenportal je 30; Löschen und Zurücknehmen der Organisation je 10; X-Login 10, Code 20; `/api/health/ready` 60 pro Adresse und Minute | 429 `HTTP_429` |
| Tarif | Kosten pro Organisation | Werte in der Tabelle unten; Prüfung und Zählung in ADR 0035; Nur-Lesen nach Ende der Testphase, der Kulanzfrist oder des Abos | 402 `PLAN_LIMIT_REACHED`, `SUBSCRIPTION_INACTIVE` |
| X-API | Kosten pro Aufruf | Deckel des Monats, geprüft vor jedem bezahlten Aufruf (`packages/platform-adapters/src/spend-capped-adapter.ts`) | Variante `FAILED` mit `SPEND_CAP` |
| X-Browser | Sperre des X-Kontos | ein Task pro Account, 2 min zwischen zwei Posts (`POST_SPACING_MS` in `apps/browser-worker/src/account-guard.ts`); 1 bis 2 Befehle gleichzeitig (`XB_CONCURRENCY`) | Task wartet, ohne einen Versuch zu zählen |
| Veröffentlichen und Aufrufe der Plattformen | Limits der Plattformen | `PUBLISH_CONCURRENCY` (Standard 5, höchstens 50, `apps/worker/src/worker-env.ts`); eigene Buckets pro App und Account, bei X 300 und 15 pro Minute, sonst 600 und 30 (`packages/platform-adapters/src/rate-limit/platform-rate-limiter.ts`) | Job wartet (`RATE_LIMITED`) |
| Analytics | lange Zeiträume | höchstens 366 Tage, nicht vor der Historie des Tarifs (`packages/contracts/src/analytics.ts`); der CSV-Export streamt in Stapeln | 400 `VALIDATION_FAILED`, 422 `ANALYTICS_HISTORY_EXCEEDED` |

Posts, Stile und Brand Voices anzulegen hat kein eigenes Limit; dafür gilt das Limit pro Person über alle Routen.

Limits der Tarife aus der Tabelle `plan` (Migration `0018_rls_billing`). Der Betrieb kann sie pro Organisation überschreiben (`effectiveLimits` in `packages/core/src/billing/domain/plan.ts`).

| Tarif | Workspaces | Accounts | Mitglieder und offene Einladungen | Posts pro Monat | Speicher | KI pro Monat (Guthaben + Mehrverbrauch) | X-API pro Monat | Analytics |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `trial` (14 Tage) | 1 | 3 | 3 | 30 | 1 GiB | 2 + 0 USD | 1 USD | 30 Tage |
| `starter` | 1 | 5 | 3 | 150 | 5 GiB | 10 + 10 USD | 10 USD | 90 Tage |
| `pro` | 3 | 15 | 10 | 600 | 25 GiB | 30 + 50 USD | 50 USD | 365 Tage |
| `agency` | 15 | 75 | 50 | 3.000 | 100 GiB | 100 + 200 USD | 200 USD | 730 Tage |

### Lange Antworten

- Generieren und Überarbeiten mit der KI streamen als Server-Sent Events mit einem Heartbeat alle 15 s (`HEARTBEAT_MS` in `apps/api/src/modules/content/sse.ts`); Caddy reicht sie ungepuffert weiter (`flush_interval -1`).
- Export, Bildverarbeitung, Veröffentlichen und endgültige Löschung laufen als Jobs im Worker; die API antwortet sofort, beim Export mit 202. Ein Export, der länger als 12 Stunden wartet oder läuft, wird aufgegeben (`EXPORT_TIMEOUT_HOURS` in `packages/core/src/gdpr/application/export.ts`).
- Der Webhook von Stripe antwortet vor der Verarbeitung (`apps/api/src/modules/billing/stripe-webhook.controller.ts`).
- Die Datenbank bricht Abfragen ab: `statement_timeout` 30 s für `app_user` und 5 min für `app_system`, offene Transaktionen nach 60 s (`infra/docker/postgres/init/01-roles.sql`).

## Freigegebene Quellen (V15.1.2)

- **Pakete** kommen nur aus der npm-Registry über pnpm. `.npmrc` und `pnpm-workspace.yaml` nennen keine andere Registry. Außer den eigenen Paketen (`workspace:*`) bezieht kein Manifest Pakete aus Git, Dateien oder Tarballs, und jedes Paket im Lockfile trägt einen `integrity`-Hash.
- **pnpm** 10.34.7 ist mit seinem sha512 in `packageManager` (`package.json`) festgelegt; Corepack prüft den Hash beim Download. `.npmrc` setzt `engine-strict=true`.
- **Gates** in `pnpm-workspace.yaml` (ADR 0009):
  - `minimumReleaseAge: 1440`: Versionen erst einen Tag nach ihrer Veröffentlichung.
  - `trustPolicy: no-downgrade`: Abbruch, wenn ein Paket mit schwächerem Herkunftsnachweis erscheint; geprüfte Ausnahmen gelten für genau eine Version (`prisma@7.10.0`, `semver@6.3.1`) und sind begründet.
  - `blockExoticSubdeps: true`: auch transitive Abhängigkeiten nur aus der Registry.
  - `strictDepBuilds: true`: Install-Skripte laufen nur, wenn `allowBuilds` sie erlaubt (sharp, prisma, `@prisma/engines`, esbuild, `@swc/core`, unrs-resolver); die übrigen sind dort abgelehnt.
  - `overrides` heben `mysql2` und `js-yaml` 5 innerhalb ihrer Major-Version auf gepatchte Versionen; akzeptierte Advisories stehen mit Begründung in `auditConfig`.
- **Versionen**: Die Manifeste nennen Bereiche (`^`), `pnpm-lock.yaml` legt die genauen Versionen fest. CI und alle Dockerfiles installieren mit `--frozen-lockfile`. Exakt gepinnt ist Playwright (1.64.1 in `apps/browser-worker` und `packages/x-browser`), weil es zum Image passen muss.
- **Images** sind auf exakte Tags gepinnt: `node:24.21.0-trixie-slim` in `infra/docker/node-app.Dockerfile`, `infra/docker/web.Dockerfile` und `apps/browser-worker/Dockerfile`, `mcr.microsoft.com/playwright:v1.64.1-noble` als Laufzeit des browser-workers und die Dienste in `compose.yaml` (zum Beispiel `postgres:17.11-alpine`, `redis:7.4.11-alpine`, `caddy:2.11.6-alpine`). Der Build nutzt `turbo@2.11.8`. Die Runtime-Stages enthalten weder npm noch corepack oder yarn.
- **GitHub Actions** sind auf Commit-SHAs gepinnt, die Version steht als Kommentar daneben (`.github/workflows/*.yml`). Die Workflows erlauben standardmäßig nur `contents: read`, nur CodeQL darf zusätzlich Ergebnisse hochladen (`security-events: write`). Checkouts behalten keine Credentials (`persist-credentials: false`).
- **Werkzeuge in CI**: Trivy 0.75.0 und gitleaks 8.30.1 kommen aus den Releases auf GitHub und werden gegen eine SHA-256-Summe im Workflow geprüft.
- **Inventar und Scan**: Der Job `images` in `.github/workflows/ci.yml` baut die sechs Images, legt je ein SBOM im Format CycloneDX für 90 Tage ab und scannt sie mit Trivy auf Schwachstellen und Secrets. Er scheitert an jedem Befund HIGH oder CRITICAL, für den es einen Fix gibt. Der Workflow läuft auf Pull Requests, Pushes nach `main` und wöchentlich.
- **Workflow `Security`** (`.github/workflows/security.yml`, auf Pull Requests, Pushes nach `main` und wöchentlich): CodeQL `security-extended` für TypeScript und die Workflows, Dependency Review ab `high`, `pnpm audit --audit-level high` und gitleaks über die ganze Historie.
- **Renovate** (`renovate.json`): `config:recommended` mit `docker:pinDigests`, Digests auch für Actions, 3 Tage Wartezeit (`minimumReleaseAge`), Updates gegen Schwachstellen auch aus OSV und mit dem Label `security`. Playwright ist ausgenommen, weil Paket und Image-Tag zusammen wechseln. Dependabot ist nicht eingerichtet.

Grenzen:
- Die Images tragen noch keine Digests; Renovate ist dafür mit `docker:pinDigests` konfiguriert.
- `.nvmrc` nennt nur die Major-Version `24`, die CI an `actions/setup-node` gibt; die Images nutzen `24.21.0`.
- Die Syntax-Zeile der Dockerfiles nennt nur `docker/dockerfile:1`.
