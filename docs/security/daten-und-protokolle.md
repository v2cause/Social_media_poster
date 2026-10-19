# Daten und Protokolle: Klassifizierung, Logging und Security-Events

- **Stand**: 2026-10-18
- **Bezug**: Umsetzungsleitfaden, Schritt 8.4; ASVS 5.0.0 V14.1.1, V14.1.2, V16.1.1 und V16.3.1 bis V16.3.4; [ADR 0039](../adr/0039-security-review-und-haertung.md), [ADR 0038](../adr/0038-aufbewahrungsfristen.md), [ASVS-Checkliste](asvs-l2.md)

Das Inventar beschreibt den Stand des Codes. Die Fristen stehen in ADR 0038, Algorithmen und Schlüssel in [Kryptografie](kryptografie.md).

## Schutzstufen (V14.1.1)

| Stufe | Bedeutung |
|---|---|
| Geheim | Wer den Wert kennt, handelt als Person, Konto oder Dienst: Passwörter, zweite Faktoren, Sessions, Tokens und Schlüssel. |
| Vertraulich | Personenbezogene Daten und Inhalte der Kunden. Zugriff haben die Mitglieder des Mandanten nach ihrer Rolle und der Betrieb. |
| Intern | Betriebsdaten ohne Inhalte: IDs, Status, Zähler, Sperren, Tarife und Flags. |
| Öffentlich | Was ohnehin öffentlich ist: veröffentlichte Posts und Profile auf den Plattformen, die Texte der Oberfläche. Ihre Kopien in der Datenbank gelten als Vertraulich, weil sie mit Entwürfen, Plänen und Metriken verbunden sind. |

## Datenarten (V14.1.1)

| Datenart | Beispiele | Stufe | Schutzmaßnahmen |
|---|---|---|---|
| Passwörter | `auth_account.password` | Geheim | scrypt mit N=2^15, r=8, p=3 und 16 Byte Salt (`packages/crypto/src/password-hash.ts`). Den Klartext sieht nur die Anfrage; die Leck-Prüfung sendet fünf Zeichen seines SHA-1 (`breached-passwords.ts`). |
| Zweiter Faktor | `two_factor.secret`, `two_factor.backup_codes` | Geheim | XChaCha20-Poly1305 von Better Auth mit einem Schlüssel aus `BETTER_AUTH_SECRET` bzw. `BETTER_AUTH_SECRETS`, nach einer Rotation per Skript neu verschlüsselt (`reencrypt-two-factor.ts`). Benutzte TOTP-Codes sperrt Redis 120 s (`auth:totp-used:*`). |
| Sessions | `session.token`; über https die Cookies `__Host-smp.session_token` und `__Host-smp.device` | Geheim | Das Token steht im Klartext in der Tabelle (Vorgabe von Better Auth) und signiert im Cookie, mit `HttpOnly`, `Secure` und `SameSite=Lax`. Höchstens sieben Tage ohne Verlängerung; die Zeile geht 30 Tage nach dem Ablauf. Das Geräte-Cookie (signiert, 180 Tage) trägt den Digest der Adresse und eine zufällige ID. |
| Tokens der Plattformen | `social_connection.access_token_sealed` und `refresh_token_sealed`, `social_account.access_token_sealed`; in Redis `oauth:pending:*` (15 min) und `oauth:state:*` mit dem PKCE-Verifier (10 min, einmal lesbar) | Geheim | Umschlag mit AES-256-GCM, eigenem Datenschlüssel und KEK aus `TOKEN_KEKS`; die AAD (bei Verbindungen `workspaceId:connectionId:feld`) bindet ihn an Zeile und Feld. Nächtlicher Re-Wrap nach einer Rotation. RLS über `workspace_id`, nie im Datenexport. Beim Trennen des letzten Accounts einer Verbindung gehen die Tokens, der Grant wird bei der Plattform widerrufen. |
| X-Browser | `social_connection.session_sealed` (storageState), Zugangsdaten im Job `login.start` von `xb-commands`, Codes unter `xb:login:<id>:input` | Geheim | Umschlag mit KEK aus `SESSION_KEKS`. Geöffnet wird er nur im browser-worker; die API versiegelt damit Zugangsdaten und Codes und behält nichts, der Worker nutzt den Keyring nur für den Re-Wrap. Ein Login endet nach fünf Minuten, sein Job verlässt Redis mit dem Ende. |
| Links mit Token | `verification.identifier` (Passwort-Reset), `invitation.token_hash`, Link zur Bestätigung der Adresse | Geheim | Reset und Einladung nur als SHA-256 (`storeIdentifier: 'hashed'` in `auth.ts`, `secret-tokens.ts`). Der Bestätigungslink ist ein signiertes JWT von einer Stunde und wird nicht gespeichert. Die Links reisen in versiegelten E-Mail-Jobs; in der API steht der Token einer Einladung im Body, nie im Pfad. |
| Secrets des Betriebs | `TOKEN_KEKS`, `SESSION_KEKS`, `BETTER_AUTH_SECRET(S)`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, Passwörter in `DATABASE_URL` und `REDIS_URL`, für S3 und SMTP | Geheim | Nur in der Umgebung der Container; jeder Dienst bekommt nur seine Variablen (`compose.yaml`), der browser-worker keine für Datenbank und Speicher. Produktion startet nicht mit Beispielwerten (`checkProductionEnv`). Es gibt keine `NEXT_PUBLIC_*`-Variablen. Rotation nach dem [Runbook](../runbooks/secret-rotation.md). |
| Kontaktdaten | `users.email`, `users.name`, `invitation.email` | Vertraulich | Die Tabellen der Identität sind global und ohne RLS; Better Auth liest sie mit einem Client ohne Mandanten-Erweiterung. Mitglieder sehen Name und Adresse der anderen Mitglieder ihrer Organisation (`memberSchema`). In E-Mail-Jobs versiegelt, in Logs nur als Digest `account`. Unbestätigte Konten gehen nach einem Tag. |
| Verbindungsdaten | `session.ip_address` und `user_agent`, `audit_log.ip_address` und `user_agent` (höchstens 300 Zeichen), `rate_limit.key`, `risk_acknowledgement.ip_address` | Vertraulich | Geleert oder gelöscht 30 Tage nach dem Eintrag, dem Ablauf der Session bzw. der letzten Anfrage (ADR 0038); die IP-Adresse einer Risikobestätigung bleibt als Nachweis. In Logs steht die Client-Adresse nur in Sicherheitsereignissen. Request-Zeilen und Spans tragen weder Adresse noch User-Agent, Fehlerberichte an Sentry den User-Agent. |
| Inhalte | `post.brief`, `post_variant.text`, `hashtags` und `first_comment`, `idea`, `brand_voice_version.content`, `post_style.instructions`, das Profil des Workspace, `publish_attempt.meta` (Payload eines Dry Runs) | Vertraulich | RLS über `workspace_id`. Sie gehen zur Generierung an den KI-Anbieter. Bodies stehen weder in Logs noch in Spans oder Fehlerberichten. |
| KI-Ein- und Ausgaben | `ai_generation.input`, `ai_generation.output` | Vertraulich | RLS; `app_user` darf nur einfügen und lesen. Nach 180 Tagen geleert; Sentry sammelt keine KI-Daten. |
| Medien | Objekte unter `ws/<workspaceId>/assets/<assetId>/`, `media_asset.file_name` und `alt_text` | Vertraulich | Schlüssel ohne Dateinamen. Die Upload-URL gilt fünf Minuten und signiert Typ und Länge. Antworten der API nennen keine Storage-Keys, Thumbnails kommen über signierte Links von einer Stunde (`media.mappers.ts`). Die Anwendung verschlüsselt Objekte nicht selbst. Entfernte Medien gehen mit dem nächsten stündlichen Lauf. |
| Analytics | `metric_snapshot` mit der Rohantwort `raw`, `post_metric_latest`, `account_metric_snapshot`, `analytics_daily` | Vertraulich | RLS; `metric_snapshot` ohne UPDATE und DELETE für `app_user`. Frist nach Tarif, mindestens 36 Tage. |
| Abrechnung | `subscription.stripe_customer_id` und `stripe_subscription_id`, `usage_record`, `api_cost_record`, `webhook_event` | Vertraulich | Zahlungsdaten bleiben bei Stripe (Checkout und Kundenportal, `stripe-gateway.ts`). RLS über `organization_id`. `webhook_event` ist global, hält nur Typ und IDs, nie das Ereignis, und geht 30 Tage nach der Verarbeitung. |
| Audit-Log | `audit_log` | Vertraulich | RLS; `app_user` ohne UPDATE und DELETE. Lesen dürfen Owner und Admins (`audit.read`). Metadaten mit Schlüsseln wie `token`, `secret`, `password` oder `hash` lehnt `assertSafeAuditMetadata` ab. |
| Datenexporte | `exports/<organizationId>/<requestId>.zip` | Vertraulich | Ohne versiegelte Spalten und Hashes (`prisma-organization-data-source.ts`). Das Archiv liegt 24 Stunden, ein Download-Link gilt fünf Minuten, jeder Download steht im Audit-Log. |
| Logs und Traces | stdout der Dienste, OTLP | Vertraulich | IDs, Codes und die Client-Adressen der Sicherheitsereignisse, keine Inhalte (Abschnitte unten); Logs 30 Tage. |
| Caches in Redis | `smp:access:<userId>` (60 s), `analytics:overview:*` (5 min) | Vertraulich | Der Zugriffs-Cache hält nur gewährten Zugriff; Änderungen der Mitgliedschaft verwerfen ihn sofort. |
| Job-Payloads | BullMQ in Redis | Intern | Nur IDs und Steuerwerte (`packages/queue/src`). Ausnahmen: E-Mail-Jobs, versiegelt mit `TOKEN_KEKS` und der AAD `notify.email`, und Befehle des X-Browsers mit Text, signierten Medien-URLs und versiegelter Session. Gescheiterte Jobs bleiben meist einen Tag, bei Veröffentlichung, Abrechnung und Datenexport sieben Tage. Die Kopien endgültig gescheiterter Veröffentlichungen in der Dead-Letter-Queue (`publish-dead`: IDs, Zahl der Versuche und der Code des Fehlers) bleiben, bis der Betrieb sie bearbeitet. |
| Zähler und Sperren in Redis | `throttle:*`, `auth:sign-in-failures:<digest>`, `auth:device-failures:*`, `auth:password-failures:<userId>`, `password-check:*`, `auth-mail:<digest>`, `invitation-mail:<digest>`, `auth:second-factor-confirmed:<sessionId>`, `lock:*`, `xb:lock:*` | Intern | Alle laufen ab: Rate-Limits mit ihrem Fenster, Fehlversuche nach 15 Minuten, die Zähler der E-Mails nach einer Stunde, die Bestätigung des Faktors nach fünf Minuten. Adressen nur als Digest; `throttle:address:*` trägt die Client-Adresse für ein Fenster. Redis-ACL: `app` ohne gefährliche Befehle, `browser-worker` nur mit den Schlüsseln des X-Browsers. |

**Nur kodiert, nicht verschlüsselt**: Der Bestätigungslink ist ein JWT, die Adresse steht lesbar in seinem Payload. Die Cookies von Session und Gerät tragen ihren Wert lesbar mit Signatur. Der Cursor des Audit-Logs ist base64url aus Zeit und ID. Base64 in Jobs und unter `oauth:pending:*` ist dagegen ein versiegelter Umschlag.

## Schutzanforderungen je Stufe (V14.1.2)

| Anforderung | Geheim | Vertraulich | Intern |
|---|---|---|---|
| Ruhezustand | Versiegelt oder als Hash. Ausnahmen: `session.token` (Better Auth), der PKCE-Verifier in `oauth:state:*` (10 min) und die Secrets des Betriebs in der Umgebung; Secret-Store oder KMS folgen mit Schritt 8.9 (ADR 0039). | Klartext in PostgreSQL, Redis und Objektspeicher, ohne Verschlüsselung auf Feldebene; Schutz über RLS, Rollen und den Zugang zu den Diensten. E-Mails in Jobs sind versiegelt. | Klartext |
| Übertragung | Tokens der Plattformen, Sessions und Zugangsdaten von X und E-Mail-Links gehen nur versiegelt durch Datenbank und Redis; geöffnet wird erst im Prozess, der sie braucht. | In Produktion https für alle Adressen, die der Browser erreicht (`checkProductionEnv`), E-Mails nur über TLS (`smtp-mailer.ts`). TLS für PostgreSQL, Redis und interne Verbindungen folgt mit Schritt 8.9 (ADR 0039). | wie Vertraulich |
| Integrität | Authentifizierte Verschlüsselung (GCM, Poly1305); die AAD bindet einen Umschlag an Zeile und Feld. Cookies sind signiert. | Audit-Log, Snapshots der Metriken, Versionen der Brand Voice, KI-Generierungen und Nutzungsbuchungen ohne UPDATE und DELETE für `app_user`. Stripe-Ereignisse nur mit gültiger Signatur. | zod prüft jede Job-Payload beim Einreihen und beim Verarbeiten. |
| Zugriff | Öffnet nur der Dienst, der es braucht. Antworten der Routen von Nest laufen durch das Schema ihres DTO (`ZodSerializerInterceptor`), die Schemas in `packages/contracts` enthalten keine Tokens. Better Auth gibt TOTP-Secret und Backup-Codes nur an die eigene Session heraus, mit Passwort und bei aktiver 2FA mit einem Code; sein JSON enthält das Session-Token (akzeptiert, ADR 0039). | `app_user` ohne `BYPASSRLS`, RLS mit `FORCE ROW LEVEL SECURITY` (`pnpm check:rls`), `app_system` nur in Methoden mit `@SystemScope()`. Rechte nach Rolle (`packages/contracts/src/permissions.ts`); fremde Mandanten ergeben 404. | Dienste und Betrieb |
| Aufbewahrung | So kurz wie der Zweck: OAuth-State 10 min, geparkte Zustimmung 15 min, Login von X 5 min, Session höchstens 7 Tage, Tokens bis zum Trennen. | Nach ADR 0038; das Audit-Log so lange wie die Organisation (ADR 0037). | Nach ADR 0038 |
| Logs | Nie, auch nicht gekürzt oder als Hash. | IDs, Codes und der Digest `account`; die Client-Adresse nur in Sicherheitsereignissen; nie Bodies. | erlaubt |
| Datenschutz | | Export und Löschung je Organisation (ADR 0036, ADR 0037); Digests statt Adressen in Logs und Redis; die KI-Eingabe ohne gerenderten Prompt. | |

Öffentliche Daten haben keine Anforderungen an die Vertraulichkeit. Für alle Stufen gilt beim Caching:
- Jede Antwort der API trägt `Cache-Control: no-store` (`noStore` in `apps/api/src/common/security/body-limits.middleware.ts`, vor allen Routen eingehängt in `apps/api/src/bootstrap.ts`). Nur die SSE-Streams setzen `no-cache, no-transform` (`apps/api/src/modules/content/sse.ts`, `apps/api/src/modules/live/live-events.controller.ts`).
- Das Abmelden antwortet mit `Clear-Site-Data: "cache", "storage"` (`auth-hooks.ts`).
- Signierte Medien-URLs laufen nicht durch den Bildoptimierer von Next.js (ADR 0022).

## Logging-Inventar (V16.1.1)

| Komponente | Was | Felder neben `level`, `time`, `service`, `env` und `msg` |
|---|---|---|
| API (`apps/api`) | Eine Request-Zeile je Anfrage außer `/api/health*`, auch für `/api/auth` (`http-logging.ts`); Sicherheits- und Auth-Ereignisse; Antworten 5xx als `request.failed`; Fachereignisse | `context` (Name des Loggers); aus dem Log-Kontext `requestId`, `clientRequestId`, `userId`, `organizationId` und `workspaceId`, sobald bekannt (`log-context.ts`). Die Request-Zeile nennt nur `req` (`id`, `method`, `path`), `res` (`statusCode`) und `responseTime`. |
| Worker (`apps/worker`) | Ergebnis, Fehler und ungültige Payloads der Jobs je Rolle; die Ticks des Schedulers mit ihren Berichten | `context`; aus dem Log-Kontext des Jobs `jobId`, `queue`, `job` (Name) und, wo die Payload sie als UUID nennt, `organizationId` und `workspaceId`, in jeder Zeile des Jobs, auch der Use Cases und Adapter (`runInJobContext` in `packages/observability/src/job-context.ts`, `@JobLogContext()` an jedem Prozessor) |
| browser-worker | Befehle und Logins von X | Log-Kontext des Jobs wie im Worker; dazu `commandId`, `operation`, `accountId`, `loginSessionId`, `durationMs` und Codes; Fehler nur als `errorName` |
| egress-proxy | Verbindungen außerhalb der Egress-Policy | `host`, `port`, `protocol` |
| Web (`apps/web`) | Serverfehler beim Rendern, in Route-Handlern, Server Actions und im Proxy als `request.failed` (`src/instrumentation.ts`, `src/lib/server/log.ts`); daneben die Meldungen von Next.js auf stderr, die der `digest` damit verbindet | `requestId` (vergibt der Proxy je Seitenanfrage neu, im Header `x-request-id` von Anfrage und Antwort; die Aufrufe der API geben sie weiter, die API loggt sie als `clientRequestId`), `method`, `path` ohne Query, `route`, `routeType`, `err` mit `type`, `digest` und dem `code` der Ursache wie `ECONNREFUSED`; keine Meldung, kein Stack und keine Header |
| Caddy | Im Compose-Profil `app` kein Access-Log: `infra/docker/caddy/Caddyfile` hat keine Direktive `log`. | |

- **Format**: JSON-Zeilen von pino auf stdout (`createLogger` in `packages/observability/src/logger.ts`). `time` steht in ISO 8601 und UTC, `level` als Zahl (30 info, 40 warn, 50 error), `msg` nennt das Ereignis, `traceId` kommt dazu, wenn ein Span aktiv ist. JSON maskiert jeden Wert, ein Zeilenumbruch in einer Eingabe erzeugt keine neue Zeile; Werte aus Anfragen kürzt `clipped` auf 200 Zeichen. Den Pegel setzt `LOG_LEVEL` (Vorgabe `info`).
- **Schwärzung** (`packages/observability/src/redact.ts`), in jeder Zeile:
  - Schlüssel wie `authorization`, `cookie`, `set-cookie`, `x-api-key`, `token`, `accessToken`, `refreshToken`, `idToken`, `sessionState`, `apiKey` und `appsecret_proof`, jeder mit `password` oder `secret` im Namen und jeder auf `Enc` werden in jeder Tiefe zu `[REDACTED]`. Bei den Namen zählen Groß- und Kleinschreibung, `-` und `_` nicht.
  - Fehler (`serializeError`) behalten Typ, Meldung, Stack, die Felder `code`, `status`, `statusCode`, `errno` und `syscall` und bis zu drei Ursachen.
  - In Meldungen, Fehlertexten und Stacks ersetzt `scrubText` E-Mail-Adressen durch `[email]` und die Query von URLs durch `[REDACTED]`.
  - Request-Zeilen und Ereignisse nennen Pfade ohne Query und den Token des Reset-Links als `REDACTED` (`privatePath`, `apps/api/src/common/logging/http-log-serializers.ts`).
- **Traces** (`otel.ts` und `span-privacy.ts` in `packages/observability/src`):
  - Die Images von API, Worker, egress-proxy und browser-worker starten mit `@smp/observability/register`, die Web-App nicht.
  - Nur mit `OTEL_EXPORTER_OTLP_ENDPOINT` und nur Traces über OTLP/HTTP; Logs und Metriken gehen nicht über OTLP.
  - Spans ohne Query, Client- und Peer-Adresse und User-Agent; `PrivateUrlSpanProcessor` säubert `url.full`, `http.url` und `http.target` jedes Spans. Redis-Spans nennen nur den Befehl, Spans von PostgreSQL den SQL-Text ohne Parameter.
- **Fehlerberichte** (`packages/observability/src/sentry.ts`): nur mit `SENTRY_DSN`. Ohne Nutzerdaten, Cookies, Bodies, Query, Parameter der Datenbank, Job-Payloads, lokale Variablen und KI-Daten; von den Headern bleiben `content-type`, `user-agent` und `x-request-id`. `beforeSend` entfernt `authorization`, `cookie`, `set-cookie`, Cookies, Body und Query ein zweites Mal.
- **Verwendung**: `requestId` (Header `x-request-id` der Antwort) und `traceId` (in jedem Problem-Dokument, ohne Tracing die Request-ID) verbinden eine Meldung mit ihren Zeilen und Spans. Nach einer Rotation prüft der Betrieb die Zeilen ab `level` 50 ([Runbook](../runbooks/secret-rotation.md)). Alarme auf Sicherheitsereignisse folgen mit Schritt 8.7 (ADR 0039).
- **Ort und Zugriff**: stdout der Container. Keine Route der API liefert Logs aus. Bis zum Log-Backend mit Zugriffsschutz und zur Zeitsynchronisation der Hosts (Schritt 8.9, ADR 0039) liest sie, wer die Ausgabe der Container erreicht.
- **Aufbewahrung**: Logs 30 Tage im Log-Backend (ADR 0038). Fristen für Traces und Sentry legt das Repository nicht fest.

## Sicherheitsereignisse (V16.3)

Ein Ereignis ist eine Log-Zeile, `msg` ist sein Name. In der API kommen die Felder des Log-Kontexts dazu. Kein Ereignis enthält Bodies oder Tokens, und kein Wert, der das Schema nicht besteht, erscheint. Abgewiesene Werte nennen nur die Prüfungen von Origin, Mandant, Plattform und Weiterleitung, gekürzt auf 200 Zeichen.

### Anfragen der API (V16.3.2, V16.3.3)

`logSecurityEvent` (`apps/api/src/common/logging/security-events.ts`) schreibt jedes Ereignis auf `warn`, mit `method`, `route` (Muster der Route oder Pfad ohne Query) und `clientAddress` (`X-Real-IP`, IPv6 als /64-Netz). Die Codes der Fehlerantworten ordnet `ProblemDetailsFilter` zu (`problem-details.filter.ts`); er ergänzt `status`, `code` und, soweit bekannt, `role` und `tenant`.

| Ereignis | Auslöser | Weitere Felder |
|---|---|---|
| `security.origin_rejected` | Schreibende Anfrage mit fremdem `Origin` oder einem `Sec-Fetch-Site` außer `same-origin` und `none` (CSRF), auch an `/api/auth` | `origin`, `fetchSite` |
| `security.body_rejected` | Body ist kein JSON, zu groß oder anders kodiert (400, 413, 415) | `status`, `reason` (Typ des Parser-Fehlers) |
| `security.validation_failed` | Body, Query oder Parameter passen nicht zum Schema (400 `VALIDATION_FAILED`) | `issues`: höchstens zehn, je Pfad und Code, ohne Wert |
| `security.tenant_denied` | Workspace oder Organisation unbekannt oder ohne Mitgliedschaft (404) | `tenant` (Slug oder ID der Route) |
| `security.permission_denied` | Rolle ohne das Recht (403 `NOT_PERMITTED`), auch auf Admin-Routen; Einladung an eine andere Adresse (`INVITATION_EMAIL_MISMATCH`) | `role`, `tenant` |
| `security.two_factor_required` | Mitglied ohne zweiten Faktor in einer Organisation, die ihn verlangt; Plattform-Admin ohne zweiten Faktor (403) | `role`, `tenant` |
| `security.rate_limited` | Jede Antwort 429: Throttler, Limits einzelner Routen, offene Streams; an `/api/auth` die Limits von Better Auth und der Hooks | an `/api/auth` `limiter: auth` |
| `security.webhook_rejected` | Stripe-Webhook ohne Raw-Body, ohne Signatur oder mit ungültiger Signatur (`WEBHOOK_SIGNATURE_INVALID`) | |
| `security.oauth_rejected` | OAuth-Callback mit ungültiger Plattform oder Query oder mit unbekanntem, benutztem, abgelaufenem oder fremdem `state` | `platform`, `reason` (`STATE_INVALID`) |
| `security.redirect_rejected` | Better Auth weist Origin, `callbackURL` oder ein anderes Ziel ab (`auth.ts`) | `field`, `value`; ohne `method`, `route` und `clientAddress`, weil der Logger von Better Auth nur die Meldung bekommt |
| `security.password_rejected` | Falsches Passwort bei `PasswordCheck`, etwa beim Freischalten des X-Browsers (422 `INVALID_PASSWORD`); über dem Limit folgt `security.rate_limited` | `role`, `tenant` |

### Anmeldung (V16.3.1)

Die Hooks in `apps/api/src/modules/identity/auth-hooks.ts` schreiben `auth.event` für `/sign-in/email`, `/sign-up/email`, `/sign-out`, `/verify-email`, `/send-verification-email`, `/request-password-reset`, `/reset-password`, `/change-password`, die Pfade des zweiten Faktors (`/two-factor/enable`, `disable`, `get-totp-uri`, `generate-backup-codes`, `verify-totp`, `verify-backup-code`) sowie `/revoke-session`, `/revoke-sessions` und `/revoke-other-sessions`, dazu `/verify-password`, die erneute Abfrage des Passworts durch `PasswordCheck`. `path` nennt damit Verfahren und Faktor. Ein Ereignis nennt `userId` oder ohne Session `account` (die ersten 16 Hex-Zeichen des SHA-256 der Adresse in Kleinbuchstaben), nie die Adresse; bei `/sign-out` liest der Hook die Session vorher, damit das Ereignis den Nutzer nennt. Eine Weiterleitung wie die des Bestätigungslinks zählt nur als Fehlschlag, wenn ihr Ziel einen Fehler nennt (`?error=INVALID_TOKEN`). Der Test `apps/api/test/auth-events.integration.test.ts` prüft die Folge von Registrierung, Bestätigung, Anmeldung und Abmeldung.

| `outcome` | Pegel | Auslöser | Felder |
|---|---|---|---|
| `ok` | info | Ein Pfad der Liste gelingt | `path`, `userId` oder `account`, `clientAddress` (`X-Real-IP`) |
| `failed` | info | Ein Pfad der Liste scheitert, etwa mit falschem Passwort oder Code | wie `ok`, dazu `code` |
| `second_factor_required` | info | Passwort richtig, der zweite Faktor folgt | wie `ok` |
| `blocked` | warn | Anmeldung über dem Limit des Kontos ohne Gerät mit freiem Limit; Passwortprüfung über dem Limit des Kontos | `path`, `account` bzw. `userId` |
| `code_reused` | warn | TOTP-Code schon benutzt (401 `CODE_ALREADY_USED`) | `path`, `userId` |
| `unconfirmed` | warn | Änderung des zweiten Faktors ohne bestätigten Code (403 `SECOND_FACTOR_REQUIRED`) | `path`, `userId` |

### Weitere Ereignisse (V16.3.1, V16.3.3, V16.3.4)

| Ereignis | Pegel | Auslöser | Felder |
|---|---|---|---|
| `auth.mail_dropped`, `invitation.mail_dropped` | warn | Mehr als fünf E-Mails der Auth-Flows bzw. Einladungen je Adresse und Stunde | `template` bzw. `invitationId`, `account` |
| `auth.breach_check_unavailable` | warn | Leck-Prüfung antwortet nicht, mit einem Fehlerstatus oder im falschen Format; das Passwort gilt als nicht geleakt | `status` oder `reason` |
| `auth.verification_mail_failed`, `auth.reset_mail_failed`, `auth.existing_account_mail_failed` | error | E-Mail der Auth-Flows ließ sich nicht einreihen | `err` |
| `auth.error`, `auth.warning` | error, warn | Fehler von Better Auth selbst (ab Status 500 oder kein API-Fehler) und Meldungen seines Loggers | `err` bzw. `message` |
| `auth.sessions_revoked`, `auth.reencrypt_done` | info | Skripte des Betriebs: Sessions beenden, 2FA nach einer Rotation neu verschlüsseln | Ziel und Zähler, nie die Adresse |
| `x_browser.kill_switch`, `x_browser.organization_allowed`, `x_browser.organization_disallowed` | warn | Schalter der Plattform-Admins; sie gehören zu keiner Organisation und deshalb in kein Audit-Log | `adminId`, `active` und `changed` bzw. `organizationId` |
| `request.failed` | error | Antwort 5xx der API | `code`, `requestId`, `err` |
| `access_cache.read_failed`, `access_cache.write_failed`, `access_cache.invalidate_failed` | warn | Zugriffs-Cache in Redis gestört; beim Lesen fragt der Guard die Datenbank | `err` |
| `notify.unknown_key` | warn | E-Mail-Job mit einer Key-ID, die die Rolle nicht kennt; er wird wiederholt | `jobId`, `attempt`, `keyId` |
| `notify.unreadable_email` | error | Umschlag beschädigt, aus einem anderen Keyring oder keine E-Mail | `jobId` |
| `notify.send_failed` | warn | Zustellung gescheitert, etwa am SMTP-Server oder an TLS | `jobId`, `attempt`, `err` (beim SMTP-Versand nur Codes) |
| `xb.session.unreadable` | warn | Session eines X-Accounts lässt sich nicht öffnen | `commandId`, `operation`, `accountId` |
| `token.refresh_failed` | warn | Erneuern eines Tokens bei der Plattform gescheitert | `jobId`, `connectionId`, `attempt`, `err` |
| `oauth.exchange.failed`, `channel.revoke.failed` | warn | Code-Tausch beim Verbinden oder Widerruf beim Trennen gescheitert | `platform` bzw. `accountId`, `code` |
| `scheduler.tick_failed` | error | Ein Tick scheitert, etwa `tick.maintenance` mit Re-Wrap und Fristen; ein gelungener schreibt `scheduler.tick` mit seinen Zählern, darunter `failed` des Re-Wraps | `tick`, `err` |
| `analytics.invalid_payload`, `billing.invalid_payload`, `gdpr.invalid_payload`, `media.invalid_payload`, `notify.invalid_payload`, `token.invalid_payload`, `xb.report_invalid` | error | Job-Payload besteht die zod-Prüfung nicht; der Job endet ohne Wiederholung | `jobId`, meist `job` |
| `publish.invalid_payload` | warn | dasselbe für Veröffentlichungen | `jobId`, `job` |
| `live.invalid_event` | warn | Live-Ereignis aus Redis besteht die Prüfung nicht | `channel` |
| `publish.answer_unreadable` | warn | Antwort einer Plattform ist nicht lesbar | `variantId`, `err` |
| `ai.call_failed` | warn | KI-Aufruf gescheitert oder Antwort ungültig (`INVALID_OUTPUT`) | `code`, `status`, `detail` ohne Inhalte |
| `media.job_done` mit `outcome: REJECTED` | info | Upload ist kein zulässiges Bild; den Grund hält `media_asset.reject_reason` | `jobId`, `assetId` |
| `egress.refused` | warn | Der egress-proxy weist eine Verbindung außerhalb der Policy ab | `host`, `port`, `protocol` |
| `xb.egress.refused` | info | Der Browser wollte Hosts außerhalb der Policy erreichen | `commandId`, `durationMs`, `refusedHosts` |
| `xb.drift`, `xb.canary_failed` | warn | Die Selector-Map passt nicht mehr zu X | `selector` bzw. `missing`, `selectorsVersion` |
| `xb.breaker_opened` | error | Der Circuit Breaker schaltet den X-Browser global ab | `drifts` |
| `xb.login.failed` | warn | Ein Login von X endet ohne Session | `commandId`, `loginSessionId`, `failure` |

### Audit-Log

Fachliche Änderungen schreibt die Anwendung in derselben Transaktion ins Audit-Log ihrer Organisation, mit Akteur, Aktion, Ziel, Metadaten, IP-Adresse und User-Agent (`packages/db/src/audit/prisma-audit-trail.ts`). Für die Sicherheit zählen vor allem:
- **Mitglieder**: `member.invite`, `member.invitation_resend`, `member.invitation_revoke`, `member.join`, `member.role_change`, `member.remove`, `member.leave`.
- **Organisation**: `organization.create`, `organization.two_factor_required`, `organization.two_factor_optional`, `organization.delete_requested`, `organization.delete_canceled`, `workspace.create`, `workspace.settings_update`.
- **Kanäle**: `channel.connect`, `channel.reconnect`, `channel.disconnect`, `x_browser.enable`, `x_browser.disable`.
- **Daten**: `gdpr.export_requested`, `gdpr.export_downloaded`, `post.delete`, `media.delete`.

Dazu kommen Änderungen an Varianten, Stilen und Brand Voices.

### Ohne eigenes Ereignis

- Anfragen an Routen von Nest ohne gültige Session (401) stehen nur als Request-Zeile im Log.
- Ebenso Bodies an `/api/auth` über 64 KB oder ohne Länge (413, 411; `authBodyLimit`).

## Bewusst nicht protokolliert

| Was | Warum | Wie |
|---|---|---|
| Bodies von Anfragen und Antworten | Passwörter, Entwürfe, Tokens | Die Request-Zeile kennt nur ID, Methode, Pfad und Status; Sentry sammelt keine Bodies. |
| Header wie `Cookie`, `Set-Cookie` und `Authorization` | Zugangsdaten | Request-Zeilen ohne Header; die Schwärzung greift in jeder Tiefe. |
| Query-Strings | OAuth-`code` und `state`, Callback-URLs, das JWT des Bestätigungslinks mit der Adresse | `privatePath` in Request-Zeilen, Ereignissen und Spans, `scrubText` in Meldungen |
| Token des Reset-Links im Pfad | Er setzt ein Passwort zurück. | `/api/auth/reset-password/REDACTED` |
| Client-Adresse und User-Agent in Request-Zeilen und Spans | Personenbezogen; zum Verfolgen genügt die Request-ID | `http-log-serializers.ts`, `span-privacy.ts`. Sicherheitsereignisse und `auth.event` nennen die Adresse, damit sich Angriffe erkennen und sperren lassen. |
| E-Mail-Adressen | Personenbezogen | Ereignisse nennen den Digest `account`. Die Schwärzung prüft nur die Namen der Felder: Eine Adresse in einem anders benannten Feld bliebe stehen, `scrubText` greift nur in Meldungen und Fehlern. |
| Werte, die das Schema nicht bestehen | Sie können Passwörter oder Tokens sein. | `issues` nur mit Pfad und Code |
| Weitere Felder von Fehlern | Bibliotheken hängen Empfänger oder Konfigurationen mit Headern an. | Allowlist in `serializeError`; `SmtpDeliveryError` nennt nur Codes. |
| Zusatzargumente des Loggers von Better Auth | Sie können Daten der Anfrage tragen. | Nur die Meldung (`auth.ts`) |
| Texte, Sessions, Zugangsdaten und Meldungen des Browsers im browser-worker | Inhalte und Zugangsdaten | Nur IDs, Codes, Hosts und `errorName` (`command-runner.ts`, `login-runner.ts`) |
| Pfade und Query im egress-proxy | Sie tragen die Signaturen der Medien-URLs. | Nur Host und Port (`apps/egress-proxy/src/proxy.ts`) |
| Argumente von Redis-Befehlen in Spans | Sie enthalten Payloads der Jobs. | `redisStatement` |
| Logs über OTLP | Logs gehen nur über stdout an das Log-Backend. | `disableLogSending`, keine Log-Prozessoren (`otel.ts`) |
