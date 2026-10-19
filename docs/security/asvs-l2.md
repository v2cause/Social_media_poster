# ASVS 5.0, Level 2: Checkliste

- **Stand**: 2026-10-18. Bewertet am Commit `ea6a3ca`, Nachträge bis Commit `276fb27`. Zeilenangaben beziehen sich auf den Commit der Bewertung; Nachträge nennen ihren Commit.
- **Bezug**: Umsetzungsleitfaden, Schritt 8.4; [ADR 0039](../adr/0039-security-review-und-haertung.md); [Pentest](pentest-2026-10.md)
- **Grundlage**: [OWASP ASVS 5.0.0](https://github.com/OWASP/ASVS/tree/v5.0.0), alle Anforderungen der Level 1 und 2 (Lizenz CC BY-SA 4.0)

Jede Anforderung hat einen Status mit Nachweis im Code, in Tests oder in der Doku. "teilweise" und "offen" nennen die Lücke, ihre Schwere und den Plan. Offen ist keine Lücke der Schwere kritisch oder hoch.

## Übersicht

| Kapitel | Anforderungen | erfüllt | teilweise | offen | nicht anwendbar |
| --- | --- | --- | --- | --- | --- |
| V1 Kodierung und Bereinigung | 27 | 17 | 0 | 0 | 10 |
| V2 Validierung und Geschäftslogik | 11 | 10 | 1 | 0 | 0 |
| V3 Sicherheit des Web-Frontends | 19 | 15 | 3 | 0 | 1 |
| V4 API und Webdienste | 10 | 2 | 2 | 0 | 6 |
| V5 Umgang mit Dateien | 9 | 6 | 2 | 0 | 1 |
| V6 Authentifizierung | 35 | 25 | 2 | 1 | 7 |
| V7 Sitzungsverwaltung | 18 | 13 | 2 | 0 | 3 |
| V8 Autorisierung | 7 | 7 | 0 | 0 | 0 |
| V9 Eigenständige Tokens | 7 | 6 | 0 | 0 | 1 |
| V10 OAuth und OIDC | 29 | 4 | 0 | 0 | 25 |
| V11 Kryptografie | 14 | 9 | 3 | 0 | 2 |
| V12 Sichere Kommunikation | 9 | 1 | 4 | 3 | 1 |
| V13 Konfiguration | 13 | 7 | 6 | 0 | 0 |
| V14 Datenschutz | 9 | 8 | 1 | 0 | 0 |
| V15 Sichere Programmierung und Architektur | 13 | 10 | 3 | 0 | 0 |
| V16 Sicherheitslogging und Fehlerbehandlung | 16 | 11 | 4 | 1 | 0 |
| V17 WebRTC | 7 | 0 | 0 | 0 | 7 |
| **Summe** | **253** | **151** | **33** | **5** | **64** |

## V1 Kodierung und Bereinigung

### V1.1

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V1.1.1 | 2 | Eingaben nur einmal und vor der Validierung kanonisieren | erfüllt | Express parst Body und Query einmal, danach validiert zod (apps/api/src/bootstrap.ts:52-56); Cursor werden erst aus base64url und JSON gelesen und dann mit cursorSchema geprüft (packages/db/src/*/…-read-model.ts); apps/ und packages/ dekodieren nirgends selbst nach (kein decodeURIComponent). safeNext lehnt Steuerzeichen (U+0000 bis U+001F, U+007F) und Backslashes im Rohwert ab und löst das Ziel gegen eine feste Origin auf (apps/web/src/lib/safe-next.ts:7-27, Commit d5a5b99; Tests apps/web/src/lib/safe-next.test.ts:23-31). Seit 1c617ff prüft safeNext den aufgelösten Pfad erneut auf zwei führende Schrägstriche, sodass Dot-Segmente wie /..//evil.example auf / führen (Test safe-next.test.ts). |  |
| V1.1.2 | 2 | Kodierung als letzter Schritt vor dem Interpreter | erfüllt | React kodiert beim Rendern (Web, packages/emails), CSV beim Schreiben (analytics/csv.ts), Prompt-Daten beim Rendern (packages/ai/src/prompts/escape.ts), SQL über Prisma-Parameter. LinkedIn-Adapter fehlt noch (nur Mock). |  |

### V1.2

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V1.2.1 | 1 | Kontextgerechte Kodierung für HTML und HTTP-Header | erfüllt | Kein dangerouslySetInnerHTML; React escaped Web und E-Mails; Dev-Mockseite mit escapeHtml (apps/api/src/modules/dev/mock-oauth.page.ts); Header nur aus validierten Werten, x-request-id per Regex. |  |
| V1.2.2 | 1 | URL-Teile kodieren, nur sichere Protokolle zulassen | erfüllt | encodeURIComponent für Pfade (apps/web/src/lib/server/api.ts, notification-link.ts), new URL mit searchParams im OAuth-Callback, linkUrl und Mail-Links nur http(s) (contracts content.ts, emails render.tsx). |  |
| V1.2.3 | 1 | JSON und JavaScript nur strukturiert erzeugen | erfüllt | JSON nur per JSON.stringify bzw. Serializer; SSE-Zeilen mit Enum-Eventnamen und JSON.stringify (content/sse.ts, live-events.controller.ts); keine Inline-Skripte mit Daten im Web. |  |
| V1.2.4 | 1 | Parametrisierte Datenbankabfragen gegen SQL-Injection | erfüllt | Prisma und Tagged Templates, kein $queryRawUnsafe; Prisma.raw nur für Bezeichner aus fester Liste oder Katalog mit Regex (db/src/gdpr/prisma-organization-data-source.ts:97, prisma-organization-eraser.ts:31). |  |
| V1.2.5 | 1 | Schutz vor OS-Command-Injection | erfüllt | Laufzeitcode ruft keine OS-Befehle auf; nur Werkzeuge nutzen execFile mit Argumentliste ohne Shell (tools/check-no-emoji.ts, packages/testing/src/postgres.ts). |  |
| V1.2.6 | 2 | Schutz vor LDAP-Injection | nicht anwendbar | Kein LDAP im System; Anmeldung über Better Auth mit PostgreSQL. |  |
| V1.2.7 | 2 | Schutz vor XPath-Injection | nicht anwendbar | Keine XML- oder XPath-Verarbeitung; Playwright-Locator sind statisch (packages/x-browser/src/selectors/v1.ts). |  |
| V1.2.8 | 2 | Sichere Konfiguration von LaTeX-Prozessoren | nicht anwendbar | Kein LaTeX-Prozessor im System. |  |
| V1.2.9 | 2 | Sonderzeichen in regulären Ausdrücken escapen | erfüllt | Verbotene Wörter werden vor new RegExp escaped (packages/platform-rules/src/forbidden-words.ts:4, Test mit Regex-Zeichen in forbidden-words.test.ts); Mock-KI ebenso (packages/ai/src/mock/compose.ts:183). |  |

### V1.3

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V1.3.1 | 1 | HTML aus WYSIWYG-Editoren sanitisieren | nicht anwendbar | Kein WYSIWYG- oder HTML-Eingabefeld; Posts, Brand Voices und Ideen sind Klartext und werden von React als Text gerendert. |  |
| V1.3.2 | 1 | Kein eval und keine dynamische Codeausführung | erfüllt | Kein eval oder new Function im Code; unsafe-eval nur in der Dev-CSP (apps/web/src/security/content-security-policy.ts); Redis-Lua-Skripte statisch mit KEYS/ARGV (ai-rate-limiter.ts). |  |
| V1.3.3 | 2 | Daten für gefährliche Kontexte bereinigen und kürzen | erfüllt | displayFileName entfernt Steuerzeichen, kürzt auf 255 (core media/domain/rules.ts:47); archiveName für ZIP (gdpr/application/export.ts:43); CSV-Formeln entschärft (csv.ts:27); asciiFileName für Header. |  |
| V1.3.4 | 2 | SVG-Inhalte von Nutzern validieren oder abweisen | erfüllt | SVG nicht erlaubt: MIME-Allowlist (core media/domain/rules.ts) und Magic Bytes (file-signature.ts) lehnen es als NOT_AN_IMAGE ab; ausgeliefert werden nur neu kodierte WebP/JPEG. |  |
| V1.3.5 | 2 | Skriptfähige Vorlagensprachen von Nutzern entschärfen | nicht anwendbar | Keine Interpretation von Markdown, CSS, XSL oder BBCode aus Nutzerinhalten; keine Markdown-Bibliothek im Web, alle Texte werden als Klartext gerendert. |  |
| V1.3.6 | 2 | Schutz vor Server-Side Request Forgery | erfüllt | Server ruft nur feste Ziele (Plattformen, Anthropic, Stripe, S3 aus Env), keine Nutzer-URLs. Browser-Worker mit Egress-Allowlist in Route und Proxy (packages/x-browser/src/egress.ts, apps/egress-proxy). |  |
| V1.3.7 | 2 | Keine Vorlagen aus nicht vertrauenswürdigen Eingaben | erfüllt | Vorlagen statisch: React-E-Mails, format() mit einem Durchlauf (packages/emails/src/messages.ts:400), Prompts mit escapten Daten (packages/ai/src/prompts/render-task.ts). |  |
| V1.3.8 | 2 | Schutz vor JNDI-Injection | nicht anwendbar | Kein Java und kein JNDI; TypeScript auf Node.js. |  |
| V1.3.9 | 2 | Inhalte vor memcache bereinigen | nicht anwendbar | Kein memcache; Redis über ioredis (RESP mit Längenpräfix), Schlüssel aus UUIDs und geprüften Slugs. |  |
| V1.3.10 | 2 | Formatstrings vor der Verarbeitung entschärfen | erfüllt | Platzhalter in E-Mails per einmaligem Replace (messages.ts:400), UI-Texte über next-intl mit statischen Katalogen, Logs strukturiert mit pino ohne Formatstrings aus Eingaben. |  |
| V1.3.11 | 2 | Schutz vor SMTP- und IMAP-Injection | erfüllt | Empfänger per zod-E-Mail (contracts tenancy.ts), Vorlagenwerte per zod (emails/render.tsx); nodemailer ersetzt CR/LF in Headern wie Subject (mime-node), keine eigenen SMTP-Befehle. |  |

### V1.4

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V1.4.1 | 2 | Speichersichere Zeichenketten und Kopierfunktionen | nicht anwendbar | TypeScript auf Node.js mit verwaltetem Speicher; native Teile (sharp/libvips, Chromium) sind Drittkomponenten, mit Pixel-Limit bzw. isoliertem Worker. |  |
| V1.4.2 | 2 | Vorzeichen- und Bereichsprüfung gegen Integer-Overflow | erfüllt | zod 4 int() nimmt nur sichere Ganzzahlen, Bereiche per min/max (contracts); Summen auf INT_MAX gekappt (packages/db/src/analytics/prisma-analytics-store.ts:14); Zähler und Kosten als bigint. |  |
| V1.4.3 | 2 | Freigabe von Speicher, keine hängenden Zeiger | nicht anwendbar | Garbage Collection von Node.js, keine manuelle Speicherverwaltung; Ressourcen wie Redis-Slots und Streams werden in finally freigegeben. |  |

### V1.5

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V1.5.1 | 1 | Restriktive XML-Parser gegen XXE | nicht anwendbar | Kein XML-Parser im eigenen Code; SVG- und XML-Dateien scheitern an der Magic-Byte-Prüfung (zum Render-Pfad ersetzter Originale siehe Befund zu V5.2.2). |  |
| V1.5.2 | 2 | Sichere Deserialisierung nicht vertrauenswürdiger Daten | erfüllt | Nur JSON.parse mit zod-Prüfung: Jobs (packages/queue), Redis-Datensätze (redis-oauth-stores.ts, access-cache.ts), Browser-Befehle (x-browser/src/protocol.ts), Cursor; keine unsicheren Deserialisierer. |  |

## V2 Validierung und Geschäftslogik

### V2.1

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V2.1.1 | 1 | Dokumentierte Regeln zur Prüfung von Eingabeformaten | erfüllt | Eingaberegeln als zod-Schemas in packages/contracts, daraus OpenAPI (packages/api-client/openapi.json, ADR 0013); Architektur 10 fordert zod für Eingaben, Jobs, Env und Adapter. |  |
| V2.1.2 | 2 | Dokumentierte Regeln für kombinierte Datenelemente | erfüllt | Dokumentiert: Zeitzonenlücken und Zustandsautomat (ADR 0023), Zuschnitt gegen Bildgröße und Verhältnis (ADR 0020), Zeitraum bis 366 Tage (ADR 0027), Limits beim Planen (ADR 0035). |  |
| V2.1.3 | 2 | Geschäftslimits pro Nutzer und global dokumentiert | erfüllt | Dokumentiert sind die KI-Limits pro Nutzer und Workspace (docs/ARCHITECTURE.md:288, ADR 0016:19), die Tariflimits pro Organisation (ADR 0033:24, ADR 0035:28-37, seit 8.4 mit den Sperren für Posts und Accounts), die Speicher-Quote (ADR 0019:30-34), die Auth-Limits pro Adresse (ADR 0006:24, 37) und die ausgehenden Limits pro Plattform, App und Account (docs/ARCHITECTURE.md:570, 715). Die Werte des eingehenden Rate-Limits stehen im Code: 3.000 Anfragen pro Minute und Adresse, 600 pro Minute und Nutzer (apps/api/src/common/throttling/throttling.ts:37-42), dazu Routenlimits per @LimitPerUser (z.B. apps/api/src/modules/tenancy/organization.controller.ts:182, 199; media/media.controller.ts:68; gdpr/data-exports.controller.ts:51). Seit dem Ende von Schritt 8.4 stehen alle Werte mit Ort im Code in ADR 0039 (Eingehende Limits, Brute Force) und docs/security/autorisierung-und-grenzen.md (teure Funktionen und Tarife); Architektur 10 verweist darauf. Organisationen je Person sind begrenzt (aed468f), E-Mails je Adresse auch für Einladungen (276fb27). | Hinweis: Ein anwendungsweites Budget für KI-Kosten gibt es nicht, nur die Kontingente je Organisation. Seit Schritt 8.7 alarmiert `AiDailyBudgetExceeded` auf die Summe über 24 Stunden gegen ein globales Budget (infra/observability/rules/budgets.yml, ADR 0043). |

### V2.2

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V2.2.1 | 1 | Positive Validierung aller Eingaben gegen Regeln | erfüllt | Globale ZodValidationPipe mit DTOs aus packages/contracts für Body und Query (apps/api/src/bootstrap.ts:39), ParseUUIDPipe und Regex für Pfadparameter, Slug-Muster im WorkspaceGuard, Längengrenzen. |  |
| V2.2.2 | 1 | Validierung auf vertrauenswürdiger Serviceschicht | erfüllt | API prüft per zod-Pipe, die Use Cases im Core erneut (request-upload.ts Typ und Größe, set-variant-media.ts Anzahl und Dubletten); das Web nutzt dieselben Schemas nur für die Bedienung. |  |
| V2.2.3 | 2 | Kombinationen zusammengehöriger Daten plausibel prüfen | erfüllt | Zuschnitt gegen Bildmaße (set-variant-media.ts, cropFits), Account-Plattform gleich Variante (publishing/application/planning.ts), from vor to und max. 366 Tage (contracts analytics.ts), keine Zeit in Lücke. |  |

### V2.3

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V2.3.1 | 1 | Geschäftsabläufe nur in erwarteter Schrittfolge | erfüllt | Zustandsautomat VARIANT_TRANSITIONS mit Versionsprüfung (publishing/domain/variant-state-machine.ts, planning.ts:112); Upload-Zustände per bedingtem Update (ADR 0019); OAuth-State einmalig per GETDEL. |  |
| V2.3.2 | 2 | Geschäftslimits gemäß Dokumentation umgesetzt | teilweise | Das in Architektur 10 genannte eingehende Rate-Limiting ist umgesetzt: @nestjs/throttler mit Zählern in Redis (apps/api/src/common/throttling/throttling.ts:119-159, redis-throttler-storage.ts:10-42), Guards vor und nach der Sitzung (apps/api/src/common/guards/access.module.ts:27-29), Tests apps/api/test/rate-limits.integration.test.ts:39-92 (Commits b4e8793, 648cd4a). Die Tariflimits aus ADR 0035:28-37 gelten an allen genannten Stellen; Posts und Accounts zählen unter Advisory-Sperren (packages/core/src/publishing/application/planning.ts:193-203, channels/application/confirm-connection.ts:50-55, browser-login.ts:331-334; Commits 40c0ce9, 996fd23, 0bf968e), ADR 0035:49 ist korrigiert (5105d63). Dazu KI-Limits (apps/api/src/modules/content/ai-rate-limiter.ts:18-22), Speicher-Quote unter Sperre (packages/core/src/media/application/request-upload.ts:63-72) und Auth-Limits (auth.ts:138-143, auth-hooks.ts:25-28). Seit 5ececb4 reiht die API mit jedem Ticket media.drop-upload ein, das das Upload-Objekt eine Stunde nach Ablauf des Links löscht, außer das Asset wartet noch oder wird verarbeitet; seit 8269636 gehen entfernte Assets samt Dateien mit dem nächsten stündlichen Sweep (Tests apps/worker/test/media.integration.test.ts, media-cleanup.integration.test.ts, packages/core/test/media/upload.test.ts). | Ein PUT, den ein Client länger als eine Stunde nach Ablauf des Links offen hält, kann das Upload-Objekt nach dem Job noch einmal anlegen (höchstens 20 MB je Ticket, 300 Tickets je Stunde und Person). Schwere: niedrig. Plan: Schritt 8.9: die Dauer der Anfragen am Objektspeicher begrenzen (ADR 0039). |
| V2.3.3 | 2 | Transaktionen auf Ebene der Geschäftslogik | erfüllt | UnitOfWork je Use Case als eine interaktive Transaktion (packages/db/src/tenant-context.ts withTenantTx); Statuswechsel und Outbox-Ereignis in derselben Transaktion (ADR 0004, ADR 0023). |  |
| V2.3.4 | 2 | Sperren gegen Doppelbuchung begrenzter Ressourcen | erfüllt | Posts pro Monat zählen nach pg_advisory_xact_lock auf plan.posts.<org> in Planen, Umplanen, Jetzt posten und Erneut versuchen (packages/core/src/publishing/application/planning.ts:193-203, schedule-variant.ts:52, publish-now.ts:47, retry-variant.ts:53; packages/db/src/publishing/prisma-publishing-store.ts:39-43); Accounts nach plan.accounts.<org> beim Bestätigen und beim Abschluss des X-Logins (packages/core/src/channels/application/confirm-connection.ts:50-55, browser-login.ts:331-334; packages/db/src/channels/prisma-channel-store.ts:124-128); Workspaces und Mitglieder unter plan.<org> (packages/db/src/tenancy/prisma-tenancy-store.ts:31-34; invite-member.ts:41, accept-invitation.ts:57, create-workspace.ts:32); Speicher unter media.storage.<org> (request-upload.ts:63-72); KI-Quote per bedingtem UPDATE (packages/db/src/usage/prisma-quota-store.ts). Tests: packages/db/test/publishing-adapters.integration.test.ts:238 (5 parallele Planungen, Limit 2, ohne Sperre gingen alle 5 durch), channel-adapters.integration.test.ts:332 (3 parallele Bestätigungen, Platz für 1), core planning.test.ts, oauth-flow.test.ts, browser-login.test.ts; ADR 0035:49 beschreibt die Sperren. Der X-Kostendeckel ist kein Kontingent im Sinne der Anforderung und wird ohne Reservierung geprüft (packages/platform-adapters/src/spend-capped-adapter.ts:29-33); eine Überschreitung bleibt auf gleichzeitige Publish-Jobs (PUBLISH_CONCURRENCY, Standard 5) beschränkt. |  |

### V2.4

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V2.4.1 | 2 | Anti-Automation gegen übermäßige Aufrufe | erfüllt | Eingehend 3.000 Anfragen pro Minute und Adresse vor der Sitzung, 600 pro Minute und Nutzer danach (apps/api/src/common/throttling/throttling.ts:37-42, access.module.ts:27-29). Routenlimits für E-Mail- und kostenintensive Routen: Einladungen 30/h, Resend 10/h (organization.controller.ts:182, 199), Vorschau und Annahme 30/h (invitations.controller.ts:30, 55), Upload-Tickets 300/h (media.controller.ts:68), OAuth-Start 30/h und Callback 60/h (channels.controller.ts:68, oauth-callback.controller.ts:41), Exporte 5 pro Tag (data-exports.controller.ts:51), Readiness 60/min (health.controller.ts:37). Auth: Better Auth 100 pro 60 s je Adresse (auth.ts:138-143), 10 Fehlversuche pro Konto und 5 Passwortprüfungen pro Nutzer in 15 min (auth-hooks.ts:25-28), 5 Auth-Mails pro Adresse und Stunde (auth-mailer.ts:17), Body von /api/auth höchstens 64 KB (apps/api/src/common/security/body-limits.middleware.ts:14, 30-51), am Proxy 1 MB (infra/docker/caddy/Caddyfile:18-20). KI 10/min, 2 parallel, 60/h je Workspace (ai-rate-limiter.ts:18-22), Live-Streams 10 pro Nutzer (live-stream-slots.ts:21). Tests: rate-limits.integration.test.ts:39-92, auth.integration.test.ts:214, 240, 253, body-limits.middleware.test.ts:18-39, live-events.integration.test.ts:199, 231. Seit aed468f legt eine Person höchstens drei Organisationen in 30 Tagen an, gezählt unter einer Advisory-Sperre, bei 10 Anfragen je Stunde auf der Route (packages/core/src/tenancy/application/create-organization.ts, memberships.controller.ts; Tests create-organization.test.ts und tenancy.integration.test.ts mit parallelen Anfragen). Seit 276fb27 bekommt eine Adresse höchstens fünf Einladungs-Mails je Stunde aus allen Organisationen (apps/api/src/modules/tenancy/invitation-notifier.ts; Test invitation-notifier.test.ts). Alle Werte stehen in ADR 0039 und docs/security/autorisierung-und-grenzen.md. |  |

## V3 Sicherheit des Web-Frontends

### V3.2

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V3.2.1 | 1 | Antworten werden nicht im falschen Kontext gerendert | erfüllt | API liefert JSON mit nosniff und helmet-CSP; Exporte mit attachment (analytics.controller.ts:117, s3-storage.ts:112); Uploads nur Bildtypen, Magic-Bytes geprüft (process-asset.ts:49), Browser sieht nur Thumbnails | Antwort-Header des Objektspeichers setzt die App nicht; in 8.9 Speicher auf eigenem Host mit nosniff betreiben. |
| V3.2.2 | 1 | Textausgabe nur über React-Escaping, keine HTML-Senken | erfüllt | Kein dangerouslySetInnerHTML/innerHTML in apps/web, packages/ui, packages/emails; React 19 blockiert javascript:-URLs; Dev-Seite escaped selbst (mock-oauth.page.ts:66-74) |  |

### V3.3

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V3.3.1 | 1 | Cookies mit Secure und Präfix __Secure- oder __Host- | erfüllt | Über https, also in Produktion oder bei https in BETTER_AUTH_URL, heißen die Cookies von Better Auth __Host-smp.* und tragen Secure, Path=/ und keine Domain (apps/api/src/modules/identity/auth.ts:53-62, 146; Commit 603bbd2; Test auth-cookies.test.ts:10-32). Produktion verlangt https für APP_URL und BETTER_AUTH_URL, außer auf localhost (apps/api/src/config/api-env.ts:94-103, packages/observability/src/env.ts:41-60; Commit 5dffa88). Der Sprach-Cookie heißt seit 58de687 über https __Host-NEXT_LOCALE, mit Secure und Path=/ (apps/web/src/lib/locale-cookie.ts, apps/web/src/i18n/locale.ts; Test locale.test.ts). |  |
| V3.3.2 | 2 | SameSite=Lax für alle Cookies, zweckgebunden | erfüllt | Better-Auth-Cookies SameSite=Lax (Standard), NEXT_LOCALE samesite=lax (locale-cookie.ts:7); Lax nötig, da der OAuth-Callback per Top-Level-Navigation die Session liest (oauth-callback.controller.ts:45) |  |
| V3.3.3 | 2 | Cookies mit Präfix __Host-, sofern nicht für andere Hosts bestimmt | erfüllt | Session-, 2FA- und dont_remember-Cookie heißen über https __Host-smp.session_token, __Host-smp.two_factor und __Host-smp.dont_remember, mit Secure, Path=/ und ohne Domain (apps/api/src/modules/identity/auth.ts:53-62, Commit 603bbd2; Test auth-cookies.test.ts:10-24); die Weiterleitung zur Anmeldung kennt den neuen Namen (apps/web/src/proxy.ts:14). Der Geräte-Cookie der Kontosperre entsteht über createAuthCookie und trägt dasselbe Präfix (auth-hooks.ts, seit 23119ef); der Sprach-Cookie heißt über https __Host-NEXT_LOCALE (seit 58de687; Test locale.test.ts). Weitere Cookies setzt die App nicht (kein cookieCache, keine Social Provider). |  |
| V3.3.4 | 2 | HttpOnly gesetzt und Session-Token nur über Set-Cookie | teilweise | Die Cookies von Better Auth sind httpOnly (Test apps/api/src/modules/identity/auth-cookies.test.ts:21). Ohne Bearer-Plugin (auth.ts:156, nur twoFactor) und ohne eigene Auswertung eines Authorization-Headers in apps/api ist das rohe Token ohne HMAC-Signatur kein gültiger Sitzungsnachweis. | sign-in, get-session und list-sessions liefern das Session-Token im JSON-Body; die Sicherheitsseite liest die Tokens aller Sitzungen und widerruft darüber (apps/web/src/components/account/security-page.tsx:406-419, 500). Unverändert seit der ersten Bewertung (E-14). Schwere: niedrig. Plan: akzeptiert: Solange kein Bearer-Plugin aktiv ist, taugt das Token ohne Signatur nicht als Sitzungsnachweis und ein XSS hätte ohnehin die Rechte der Sitzung; bei einem Bearer- oder Multi-Session-Plugin neu bewerten. Festgehalten in ADR 0039. |

### V3.4

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V3.4.1 | 1 | HSTS mit mindestens einem Jahr und includeSubDomains auf allen Antworten | teilweise | Produktions-Builds der Web-App senden auf allen Pfaden Strict-Transport-Security: max-age=31536000; includeSubDomains (apps/web/next.config.ts:24-28, src/security/content-security-policy.ts:88-89; Commit 6dccefe); die API setzt denselben Wert über helmet 8.3.0 auf jeder Antwort, auch unter /api/auth (apps/api/src/bootstrap.ts:31-33). | Es gibt noch keine TLS-Terminierung: Der Caddyfile bedient nur HTTP auf :8080 (infra/docker/caddy/Caddyfile:8); Antworten des Proxys selbst (405, 413, 502) tragen kein HSTS; kein Test prüft den Header. Schwere: niedrig. Plan: Schritt 8.9 Deployment: HSTS am TLS-Proxy für alle Antworten setzen und am Staging prüfen. |
| V3.4.2 | 1 | Keine CORS-Freigaben, Bucket-CORS mit fester Origin-Liste | erfüllt | Kein enableCors und kein Access-Control-Allow-Origin in API, Web oder Better Auth, alles same-origin (Architektur 10); S3-CORS nur für feste Origins (compose.yaml:129-130) | CORS des Produktions-Buckets in 8.9 ebenso auf APP_URL festlegen. |
| V3.4.3 | 2 | CSP mit object-src 'none', base-uri 'none' und Nonce oder Allowlist | erfüllt | Jede Seite bekommt eine eigene Policy mit Nonce und 'strict-dynamic', object-src 'none', base-uri 'none' (seit 6dccefe), form-action 'self' und frame-ancestors 'none' (apps/web/src/security/content-security-policy.ts:41-68, apps/web/src/proxy.ts:31-44; Test content-security-policy.test.ts:24-42). Der Matcher nimmt nur /api/, statische Dateien und Prefetch-Anfragen aus, Pfade wie /api oder /apix erhalten die Policy (proxy.ts:47-58). Die API setzt über helmet default-src und script-src 'self', object-src 'none' und base-uri 'none' (apps/api/src/bootstrap.ts:30-33, Commit f953a9f). Ohne CSP bleiben nur Antworten, die keine Dokumente sind (JS, CSS, Bilder, RSC-Prefetch). Hinweis: Ein Test der API-Header fehlt. |  |
| V3.4.4 | 2 | nosniff auf allen Antworten von Web und API | erfüllt | X-Content-Type-Options: nosniff über next.config.ts:24-26 für /:path* und per helmet für alle API-Antworten inkl. /api/auth, da vor dem Auth-Handler registriert (bootstrap.ts:26-34) | Antworten des Objektspeichers und vom Proxy erzeugte Fehlerantworten setzt die App nicht; nur Unit-Test der Header-Liste, kein Test am Response. |
| V3.4.5 | 2 | Referrer-Policy begrenzt den Referer auf den Origin | erfüllt | Web: strict-origin-when-cross-origin für alle Antworten (content-security-policy.ts:76); API: helmet no-referrer; externe Links mit rel=noreferrer |  |
| V3.4.6 | 2 | frame-ancestors in der CSP jeder Antwort | teilweise | Seiten der Web-App: frame-ancestors 'none' (apps/web/src/security/content-security-policy.ts:63; Test content-security-policy.test.ts:35-41); API: frame-ancestors 'none' statt 'self' (apps/api/src/bootstrap.ts:30-33, Commit f953a9f); Web-Pfade mit Präfix api erhalten die Policy (apps/web/src/proxy.ts:52, 6dccefe). | Statische Dateien (_next/static, _next/image, favicon.ico) und Prefetch-Antworten haben keine CSP, nur X-Frame-Options DENY (proxy.ts:52-56, content-security-policy.ts:80, next.config.ts:27); kein Test prüft die Header der API. Schwere: niedrig. Plan: akzeptiert: Die ausgenommenen Antworten sind keine Dokumente mit Bedienelementen, und ein iframe kann die Prefetch-Header nicht setzen, Clickjacking ist dort nicht möglich. Festgehalten in ADR 0039. |

### V3.5

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V3.5.1 | 1 | Origin- und Sec-Fetch-Site-Prüfung für alle schreibenden Anfragen | erfüllt | Middleware vor dem Auth-Handler lehnt fremde Origin und cross-site Sec-Fetch-Site ab (origin-check.middleware.ts:14-37, Unit-Test, auth.integration.test.ts:174); Cookie SameSite=Lax | Anfragen ohne Origin und Sec-Fetch-Site gelten als Nicht-Browser und passieren; vertretbar, da Browser die Header senden. |
| V3.5.2 | 1 | Schutz hängt nicht vom CORS-Preflight ab | erfüllt | Origin-Check gilt für jede Methode außer GET/HEAD/OPTIONS, unabhängig vom Content-Type (origin-check.middleware.ts:15-23); express.json parst nur application/json (bootstrap.ts:37) |  |
| V3.5.3 | 1 | Zustandsänderungen nur über POST, PUT, PATCH und DELETE | erfüllt | GET-Handler der Controller lesen nur; Download-Link per POST (data-exports.controller.ts:57); OAuth-Callback-GET nur mit einmaligem, nutzergebundenem state (complete-authorization.ts:81-89) |  |
| V3.5.4 | 2 | Nutzerinhalte auf eigenem Origin, Web und API eine Anwendung | erfüllt | Web und API bilden eine Anwendung unter einem Origin (Architektur 2); Medien auf eigenem Speicher-Origin (S3_PUBLIC_ENDPOINT, compose.yaml:168); browser-worker ohne Web-Oberfläche | Keine Prüfung, dass S3_PUBLIC_ENDPOINT einen anderen Host als APP_URL nutzt; in 8.9 eigenen Hostnamen für den Speicher festlegen. |
| V3.5.5 | 2 | Kein postMessage-Empfänger in der Anwendung | nicht anwendbar | Keine Verwendung von postMessage, message-Listenern, onmessage oder window.opener in apps/ und packages/ (Suche über *.ts und *.tsx) |  |

### V3.7

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V3.7.1 | 2 | Nur aktuelle Client-Technologie ohne Plugins | erfüllt | Web-App mit React 19.3 und Next.js 16.4 (apps/web/package.json); keine Flash-, Java-, Silverlight-, ActiveX- oder NaCl-Inhalte im Code |  |
| V3.7.2 | 2 | Automatische Weiterleitung auf fremde Hosts nur per Allowlist | erfüllt | Better Auth prüft Origin, callbackURL und redirectTo gegen trustedOrigins (apps/api/src/modules/identity/auth.ts:88), seit ea6a3ca in allen Umgebungen (disableOriginCheck: false, auth.ts:150), und meldet Ablehnungen gekürzt als security.redirect_rejected (auth.ts:44-46, 171-175; Test apps/api/test/security-events.integration.test.ts:133-147, 403 für https://evil.example). Rücksprünge von OAuth und Stripe entstehen nur aus APP_URL (apps/api/src/modules/channels/oauth-callback.controller.ts:107-108, packages/core/src/billing/application/checkout.ts:91-92, 111). safeNext lehnt seit d5a5b99 Steuerzeichen und Backslashes ab und verlangt nach dem Auflösen die eigene Origin (apps/web/src/lib/safe-next.ts:7-27; Tests safe-next.test.ts:14-31). Seit 1c617ff gilt das auch für Pfade, die nach dem Auflösen von Dot-Segmenten mit zwei Schrägstrichen beginnen (Test safe-next.test.ts). |  |

## V4 API und Webdienste

### V4.1

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V4.1.1 | 1 | Content-Type mit charset für Text-Antworten | erfüllt | Express ergänzt charset=utf-8 bei String-Bodies (res.send, auch problem+json); SSE und CSV mit charset (sse.ts:28, analytics.controller.ts:116); Worker-Health mit charset (health-routes.ts:18) | Health-Antwort des Egress-Proxys ist text/plain ohne charset (apps/egress-proxy/src/proxy.ts:47), nur intern. |
| V4.1.2 | 2 | Nur Oberflächen leiten von HTTP auf HTTPS um, APIs nicht | teilweise | Weder API noch Web-App leiten selbst von HTTP auf HTTPS um (apps/api/src/bootstrap.ts, apps/web/next.config.ts ohne Umleitung); der lokale Caddy bedient nur HTTP auf :8080 ohne Umleitung (infra/docker/caddy/Caddyfile:8). Produktion verlangt https-URLs für App, Auth und Speicher (apps/api/src/config/api-env.ts:94-103, Commit 5dffa88). | Die Proxy-Konfiguration für Produktion fehlt: Umleitung von HTTP auf HTTPS nur für die Oberfläche, /api per HTTP abweisen statt umleiten. Schwere: niedrig. Plan: Schritt 8.9 Deployment: in der Produktionsvorlage festlegen und am Staging prüfen. |
| V4.1.3 | 2 | Vom Proxy gesetzte Header nicht durch Clients überschreibbar | teilweise | Caddy überschreibt X-Real-IP auf beiden Routen mit der Peer-Adresse und entfernt Forwarded (infra/docker/caddy/Caddyfile:26, 29, 43, 44; Commit fc22333); X-Forwarded-* setzt Caddy 2.11 selbst und verwirft die Werte von Clients. Better Auth liest nur x-real-ip (apps/api/src/modules/identity/auth.ts:153), ebenso Throttler und Security-Events (apps/api/src/common/throttling/throttling.ts:59-63); Express vertraut genau einem Hop (bootstrap.ts:27); die Web-App reicht die vom Proxy gesetzte Adresse an die API weiter (apps/web/src/lib/server/api.ts:50-57, d04546f). | API und Web vertrauen X-Real-IP von jedem Peer; geschützt ist das nur, solange beide ausschließlich über den Proxy erreichbar sind. Lokal sind die Ports nur an 127.0.0.1 gebunden (compose.yaml:188-189, 253-254); die Topologie der Produktion steht aus, ein Test fehlt. Schwere: niedrig. Plan: Schritt 8.9 Deployment: API und Web nur im internen Netz des Proxys erreichbar machen und am Staging prüfen, dass von Clients gesetzte X-Real-IP-Werte überschrieben werden. |

### V4.2

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V4.2.1 | 2 | Standardkonforme HTTP-Parser ohne Lockerungen | erfüllt | Keine eigene Ermittlung der Nachrichtengrenzen, kein insecureHTTPParser oder --insecure-http-parser im Repo; Caddy 2.11.4 rahmt Upstream-Anfragen neu, Node 24 (llhttp) parst strikt | Nicht durch Tests belegt; der Load Balancer der Produktion (8.9) muss ebenso standardkonform sein. |

### V4.3

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V4.3.1 | 2 | Kein GraphQL-Endpunkt | nicht anwendbar | Die API ist REST mit SSE (Architektur 2); GraphQL kommt nur als Operationen der X-Web-App in der Selector-Map des browser-workers vor (packages/x-browser/src/selectors/v1.ts) |  |
| V4.3.2 | 2 | Kein GraphQL-Endpunkt, daher keine Introspection | nicht anwendbar | Kein GraphQL-Server in apps/ oder packages/, keine graphql-Abhängigkeit in den Manifesten |  |

### V4.4

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V4.4.1 | 1 | Keine WebSockets, Live-Updates über SSE | nicht anwendbar | Keine WebSocket-Server oder -Clients in API und Web; Live-Events per SSE über die normale Session (live-events.controller.ts:48-82) |  |
| V4.4.2 | 2 | Kein WebSocket-Handshake vorhanden | nicht anwendbar | Keine WebSockets; der SSE-Stream ist ein GET mit Session-Cookie (SameSite=Lax) und Prüfung der Workspace-Mitgliedschaft |  |
| V4.4.3 | 2 | Keine eigenen WebSocket-Tokens | nicht anwendbar | Keine WebSockets; SSE nutzt die Standard-Session von Better Auth über AuthGuard und WorkspaceGuard |  |
| V4.4.4 | 2 | Kein Übergang von HTTPS-Session zu WebSocket | nicht anwendbar | Keine WebSockets im System; Live-Updates laufen als SSE innerhalb der bestehenden HTTPS-Session |  |

## V5 Umgang mit Dateien

### V5.1

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V5.1.1 | 2 | Dateitypen, Endungen, Größen und Schutzmaßnahmen je Upload dokumentiert | erfüllt | Einzige Upload-Funktion ist die Medienbibliothek. Architektur 9 (docs/ARCHITECTURE.md:513-532) und ADR 0019 legen fest: JPEG, PNG, WebP und statisches GIF, kein SVG, höchstens 20 MB und 50 Megapixel (entpackte Größe), Ablehnungsgründe, sofortiges Löschen abgelehnter Dateien, Neukodierung mit sharp, das Original wird nie ausgeliefert. Der Code setzt die erwarteten Endungen jpg, png, webp und gif aus dem erkannten Typ (packages/core/src/gdpr/application/export.ts:58-74). Seit dem Ende von Schritt 8.4 beschreiben Architektur 9 (Content-Type und Länge signiert, eigenes Upload-Objekt, media.drop-upload), ADR 0019 (Abschnitt Upload-Objekt und Original) und ADR 0036 (Export nur geprüfter Originale mit der Endung ihres Typs: jpg, png, webp, gif) den Stand nach 8.4. |  |

### V5.2

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V5.2.1 | 1 | Nur Dateien verarbeitbarer Größe annehmen | erfüllt | Angekündigte Größe 1 Byte bis 20 MB (packages/core/src/media/application/request-upload.ts:39-41, domain/rules.ts:13); die PUT-URL signiert content-type und content-length (packages/media/src/s3-storage.ts:82-100, Commit 0fb5624), längere oder kürzere Bodies scheitern mit 403 (packages/media/test/s3-storage.integration.test.ts:95); complete prüft per HeadObject Größe und Typ (complete-upload.ts:40-50); der Worker liest höchstens 20 MB und vergleicht die Länge (process-asset.ts:52-55, Test packages/core/test/media/upload.test.ts:219), sharp mit 50 MP und failOn (rules.ts:15, ADR 0019), zwei Bilder parallel je Worker. Offene Tickets zählen mit der angekündigten Größe zur Quote (packages/db/src/billing/prisma-plan-usage.ts:65-76), höchstens 300 Tickets pro Stunde und Nutzer (media.controller.ts:68). Der Export liest nur READY-Originale (höchstens 20 MB) unter der Exportgrenze von 25 MB (export.ts:20, packages/db/src/gdpr/prisma-organization-data-source.ts:212). Erneut hochgeladene Upload-Objekte sind kein Größen-, sondern ein Quotenproblem (V2.3.2, neue Befunde). |  |
| V5.2.2 | 1 | Endung und Inhalt jeder angenommenen Datei prüfen | teilweise | Der Inhalt jeder Datei wird geprüft: Magic Bytes (packages/core/src/media/domain/file-signature.ts, application/process-asset.ts:56-60) und vollständige Dekodierung mit sharp (process-asset.ts:62-66). Nur die Pipeline schreibt das Original, aus den geprüften Bytes; der Browser lädt in ein getrenntes Upload-Objekt (process-asset.ts:90-95, domain/storage-keys.ts:12-24, Commit ed9dc02). Renditions lesen nur dieses Original (render-rendition.ts:95), der Export nur READY-Assets (packages/db/src/gdpr/prisma-organization-data-source.ts:212, 691effd) mit der Endung des erkannten Typs (export.ts:70-74). Tests: file-signature.test.ts:11-25, upload.test.ts:195 (ein zweiter PUT ändert das Original nicht), apps/worker/test/media.integration.test.ts:237 (.jpg ohne Bild wird abgelehnt), packages/core/test/gdpr/export.test.ts:248, packages/db/test/gdpr-adapters.integration.test.ts:206. | Die Endung des Dateinamens wird nicht gegen den erkannten Typ geprüft; das ist bewusst so, der Name dient nur der Anzeige (ADR 0019: Dateiname und MIME-Typ des Browsers zählen nie). Schwere: niedrig. Plan: akzeptiert: Keine Verarbeitung und keine Auslieferung richtet sich nach der Endung der Nutzer, ausgeliefert werden Renditions mit eigener Endung und im Export Originale mit der Endung des erkannten Typs. Festgehalten in ADR 0039. |
| V5.2.3 | 2 | Archive vor dem Entpacken auf Größe und Anzahl prüfen | nicht anwendbar | Es werden keine Archive angenommen (nur JPEG, PNG, WebP, GIF per Allowlist und Magic Bytes); das Export-ZIP wird nur erzeugt, nie entpackt. Bild-Dekompression begrenzt das 50-MP-Limit. |  |

### V5.3

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V5.3.1 | 1 | Hochgeladene Dateien werden nicht serverseitig ausgeführt | erfüllt | Uploads liegen im privaten Objektspeicher (S3/SeaweedFS ohne anonyme Identität), nie im Dateisystem von Web oder API; ausgeliefert werden nur neu kodierte Thumbnails und Renditions per signierter URL. |  |
| V5.3.2 | 1 | Dateipfade aus internen Daten statt Nutzer-Dateinamen | erfüllt | Keys nur aus UUIDs, festen Profilen und Ganzzahl-Crop (core media/domain/storage-keys.ts, Test), Präfix-Löschen per Regex begrenzt (s3-storage.ts:44), ZIP-Namen bereinigt (archiveName, export.test.ts:231). |  |

### V5.4

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V5.4.1 | 2 | Nutzer-Dateinamen ignorieren, Dateinamen im Header setzen | erfüllt | Nutzer-Dateinamen nie für Pfade genutzt; Downloads setzen Content-Disposition mit Servernamen: CSV analytics-von-bis.csv (analytics.controller.ts:117), Export-ZIP (core gdpr/domain/request.ts:59). |  |
| V5.4.2 | 2 | Ausgelieferte Dateinamen kodieren oder bereinigen | erfüllt | asciiFileName lässt nur druckbares ASCII ohne Anführungszeichen und Backslash (packages/media/src/s3-storage.ts:63); CSV-Name aus geprüften ISO-Daten; ZIP-Einträge per archiveName ohne Pfadzeichen. |  |
| V5.4.3 | 2 | Dateien aus fremden Quellen auf Schadsoftware scannen | teilweise | An Browser und Plattformen gehen nur von sharp neu kodierte Thumbnails und Renditions (ADR 0019, docs/ARCHITECTURE.md:519). Originale verlassen das System nur im DSGVO-Export der Owner, seit 691effd nur nach Magic-Byte-Prüfung und vollständiger Dekodierung (READY), mit der Endung ihres Typs und ohne Format- und Steuerzeichen im Namen (packages/core/src/gdpr/application/export.ts:47-74; Tests export.test.ts:238-260). | Kein Virenscan: ClamAV existiert nur als Compose-Profil ohne Anbindung (compose.yaml:349-354); Architektur 9 nennt den Scan optional. Schwere: niedrig. Plan: akzeptiert: Die Neukodierung ist der Hauptschutz, und Originale erreichen nur die Owner der eigenen Organisation als geprüfte Bilder. Festgehalten in ADR 0039. |

## V6 Authentifizierung

### V6.1

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V6.1.1 | 1 | Dokumentation der Abwehr von Brute Force und Credential Stuffing | erfüllt | ADR 0039, Abschnitt Brute Force und Credential Stuffing: jede Kontrolle mit Wert und Ort (Better Auth je Adresse und Pfad samt Standardregeln, Konto, Gerät, Nutzer, TOTP, E-Mails je Adresse) und der Hinweis, dass der Nest-Throttler /api/auth nicht abdeckt; ADR 0006 verweist darauf. |  |
| V6.1.2 | 2 | Liste kontextspezifischer Wörter für Passwörter dokumentiert | erfüllt | ADR 0039, Abschnitt Passwortrichtlinie: die Kontextwörter (Produktname in drei Formen, Adresse, lokaler Teil, Labels der Domain ohne Top-Level-Domain, Name und Namensteile), die Normalisierung (NFKC, Kleinbuchstaben, nur Buchstaben und Ziffern), die Mindestlänge von vier Zeichen, die Liste der 10.000 häufigsten Passwörter und die Leck-Prüfung mit ihrem Verhalten bei einem Ausfall; im Code password-policy.ts und breached-passwords.ts. |  |
| V6.1.3 | 2 | Dokumentation aller Authentifizierungspfade | erfüllt | ADR 0039, Abschnitt Wege: Anmeldung, Registrierung, Bestätigung, Zurücksetzen, Ändern des Passworts, Änderungen am zweiten Faktor, Passwortabfrage der API und Betrieb, je mit ihren Kontrollen, dazu was es nicht gibt (Social Login, Passkeys, Magic Links, Einmalcodes per E-Mail oder SMS, API-Schlüssel). ADR 0006 und Architektur 10 sind angepasst. |  |

### V6.2

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V6.2.1 | 1 | Mindestlänge des Passworts | erfüllt | Mindestens 12 Zeichen (packages/contracts/src/auth.ts:6), serverseitig per minPasswordLength (auth.ts:52) bei Registrierung, Reset und Änderung; Test packages/contracts/src/auth.test.ts. |  |
| V6.2.2 | 1 | Nutzer können ihr Passwort ändern | erfüllt | Karte 'Passwort' der Sicherheitsseite mit aktuellem und bestätigtem neuem Passwort (apps/web/src/components/account/security-page.tsx:70-167, Schema changePasswordSchema in packages/contracts/src/auth.ts:31-40), Aufruf von /api/auth/change-password mit revokeOtherSessions (security-page.tsx:87-91), Texte in de und en (messages/*/account.json, 8cd3e10). Die API prüft das neue Passwort gegen die Richtlinie (auth-hooks.ts:44-49, 203-207) und zählt falsche aktuelle Passwörter je Nutzer (auth-hooks.ts:36-42, 241-243). Tests: apps/api/test/auth.integration.test.ts:449-456 und 253-271. |  |
| V6.2.3 | 1 | Passwortänderung verlangt aktuelles und neues Passwort | erfüllt | change-password verlangt currentPassword und newPassword und prüft das aktuelle Passwort vor dem Schreiben (better-auth dist/api/routes/update-user.mjs:84-172). |  |
| V6.2.4 | 1 | Abgleich mit den häufigsten Passwörtern | erfüllt | apps/api/src/modules/identity/common-passwords.txt enthält die 10.000 häufigsten Passwörter mit 12 bis 128 Zeichen aus SecLists (Quelle und Prüfsumme im Kopf); localPasswordProblem vergleicht ohne Rücksicht auf Groß- und Kleinschreibung (password-policy.ts:29-38, 68-71); der Hook prüft jedes neue Passwort bei Registrierung, Änderung und Reset (auth-hooks.ts:44-49, 170-185, 203-207). Tests: password-policy.test.ts:14-34, auth.integration.test.ts:418-425 (neue und bekannte Adresse antworten gleich). |  |
| V6.2.5 | 1 | Keine Kompositionsregeln für Passwörter | erfüllt | Nur Länge 12 bis 128 (zod passwordSchema, Better Auth min/max); keine Regeln zu Groß-, Kleinbuchstaben, Ziffern oder Sonderzeichen. |  |
| V6.2.6 | 1 | Passwortfelder maskiert | erfüllt | type=password in login-form.tsx:97, signup-form.tsx:87, reset-password-form.tsx:88 und 102, security-page.tsx:189 sowie in den X-Dialogen. |  |
| V6.2.7 | 1 | Einfügen und Passwortmanager erlaubt | erfüllt | Kein Paste-Blocker in Input (packages/ui) oder Formularen; autoComplete current-password bzw. new-password auf allen Passwortfeldern der App. |  |
| V6.2.8 | 1 | Passwort wird unverändert geprüft | erfüllt | Kein Trim oder Lowercase (signInSchema, Better Auth sign-in); scrypt prüft das volle Passwort nach NFKC-Normalisierung (@better-auth/utils password.node.mjs:11), wie NIST empfiehlt. |  |
| V6.2.9 | 2 | Passwörter mit mindestens 64 Zeichen erlaubt | erfüllt | maxPasswordLength 128 (auth.ts:53, contracts auth.ts:7); scrypt kürzt nicht; Test packages/contracts/src/auth.test.ts:14. |  |
| V6.2.10 | 2 | Kein periodischer Passwortwechsel | erfüllt | Weder Schema (auth_account) noch Code kennen ein Ablaufdatum oder einen Rotationszwang für Passwörter. |  |
| V6.2.11 | 2 | Kontextspezifische Wörter werden abgelehnt | erfüllt | contextWords und localPasswordProblem (password-policy.ts:40-77) weisen Passwörter mit Produktname, Adresse, deren Teilen oder dem Namen ab; den Kontext liefert bei der Registrierung der Body, bei der Änderung die Session und beim Reset das Konto des Tokens (auth-hooks.ts:106-123). Tests: password-policy.test.ts:36-58, auth.integration.test.ts:427-434 und 449-471 (Änderung und Reset). Die Dokumentation der Liste ist unter V6.1.2 offen. |  |
| V6.2.12 | 2 | Abgleich mit geleakten Passwörtern | erfüllt | Range-API von Have I Been Pwned mit k-Anonymität: nur 5 Hex-Zeichen des SHA-1 verlassen die API, mit Padding, die Antwort prüft zod (apps/api/src/modules/identity/breached-passwords.ts:30-66); aktiv bei Registrierung, Änderung und Reset (auth.ts:74-79, auth-hooks.ts:170-185); in Produktion verlangt die Env-Prüfung eine https-URL (apps/api/src/config/api-env.ts:62-64, 86-92). Ist der Dienst gestört, gilt das Passwort mit Warnung als nicht geleakt (breached-passwords.ts:46-63); das gehört in ADR 0039. Tests: breached-passwords.test.ts:34-62, auth.integration.test.ts:436-447 und 468. |  |

### V6.3

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V6.3.1 | 1 | Schutz gegen Credential Stuffing und Brute Force | erfüllt | Pro Client-Adresse und Pfad (Better Auth, auth.ts:138-144 und 151-153; Test auth.integration.test.ts:214-223); pro Konto 10 Fehlversuche in 15 min aus beliebigen Adressen (auth-hooks.ts:25-28, 188-194, 234-240; Test :240-251); pro Nutzer 5 falsche Passwörter in 15 min auf Passwortänderung und 2FA-Endpunkten (auth-hooks.ts:27, 36-42, 196-202, 241-243; Test :253-271); /verify-password über HTTP geschlossen (auth.ts:135-136; Test :413-416); 2FA mit 5 Versuchen je Challenge und Kontosperre (better-auth 1.7.9 dist/plugins/two-factor/verify-two-factor.mjs:70-98, 117-124); Passwortrichtlinie mit häufigen, kontextbezogenen und geleakten Passwörtern; Owner können 2FA verlangen (two-factor-requirement.guard.ts:13-23). Seit 23119ef sperrt das Limit pro Konto nur fremde Geräte: Ein Browser, der sich vollständig angemeldet hat, trägt 180 Tage einen signierten Geräte-Cookie und hat während der Sperre fünf eigene Fehlversuche, und ein gültiger Reset-Link hebt die Sperre auf (auth-hooks.ts; Test auth.integration.test.ts). Jede Kontrolle mit ihrem Wert steht in ADR 0039. |  |
| V6.3.2 | 1 | Keine Standardkonten | erfüllt | Migrationen legen keine Nutzer an; der Demo-Seed bricht bei NODE_ENV=production ab und verlangt SEED_USER_PASSWORD ab 12 Zeichen (packages/db/src/seed.ts:8-18); isPlatformAdmin nicht setzbar. |  |
| V6.3.3 | 2 | Mehrfaktor-Authentifizierung für den Zugang | teilweise | TOTP mit Backup-Codes (auth.ts:156), bei jeder Anmeldung verlangt, ohne vertrautes Gerät (auth-hooks.ts:208-216, 245-253; Test auth.integration.test.ts:273-294). Owner können den zweiten Faktor für alle Mitglieder verlangen, nur mit eigenem zweiten Faktor und mit Eintrag im Audit-Log (apps/api/src/modules/tenancy/organization.controller.ts:100-123, packages/core/src/tenancy/application/two-factor-requirement.ts:17-39); der Guard weist Mitglieder ohne zweiten Faktor auf allen Routen der Organisation ab (apps/api/src/common/guards/two-factor-requirement.guard.ts:13-23, access.module.ts:32). Tests: apps/api/test/two-factor-requirement.integration.test.ts:69-127; Oberfläche in team-page.tsx (c778529). Seit cfddd4f brauchen Plattform-Admins einen zweiten Faktor für die Admin-Seite und ihre Routen (platform-admin.guard.ts; Tests x-browser.integration.test.ts und apps/web/e2e/x-browser.spec.ts). Begründung und Ausgleich der freiwilligen 2FA stehen in ADR 0039. | Für Personen ohne Pflicht ihrer Organisation, auch für Owner, bleibt der zweite Faktor freiwillig; akzeptierte Abweichung (ADR 0039). Schwere: niedrig. Plan: Wiedervorlage mit Passkeys (ADR 0039). |
| V6.3.4 | 2 | Keine undokumentierten Pfade, gleiche Stärke auf allen Pfaden | erfüllt | Alle Anmeldungen laufen über /api/auth/sign-in/email; bei aktiver 2FA folgt immer der zweite Schritt, trustDevice wird verworfen (auth-hooks.ts:208-216; Test auth.integration.test.ts:273-294); der Bestätigungslink meldet nicht an (auth.ts:114-116; Test :89-113); der Reset beendet alle Sessions und lässt die 2FA bestehen (auth.ts:98); keine Social-Provider, OTP per E-Mail oder SMS nicht konfiguriert, /verify-password über HTTP geschlossen (auth.ts:135-136, better-auth 1.7.9 dist/api/index.mjs:166-168). Die Doku nennt die Wege seit dem Ende von Schritt 8.4 so, wie sie sind: ADR 0006 (Bestätigungslink ohne Anmeldung), Architektur 10 (kein Login über Google oder Microsoft) und ADR 0039 (Tabelle der Wege und was es nicht gibt). | Hinweis: Das Restrisiko einer fremden Registrierung bis zum Zurücksetzen des Passworts ist in ADR 0039 akzeptiert. |

### V6.4

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V6.4.1 | 1 | Aktivierungscodes zufällig, kurzlebig und einmalig | erfüllt | Keine generierten Initialpasswörter. Verifizierung: JWT HS256, 1 h (auth.ts:63, ADR 0012); Einladung: 32 Byte CSPRNG, nur SHA-256-Hash, 7 Tage, einmalig (packages/crypto secret-tokens.ts). |  |
| V6.4.2 | 1 | Keine Passworthinweise oder Sicherheitsfragen | erfüllt | Schema (users, auth_account) und Formulare enthalten weder Passworthinweise noch Sicherheitsfragen; 'passwordHint' nennt nur die Mindestlänge. |  |
| V6.4.3 | 2 | Sicherer Reset ohne Umgehung der 2FA | erfüllt | Token 24 Zeichen CSPRNG, 1 h, einmalig (password.mjs:74, 161); Reset erzeugt keine Session, der Login danach verlangt die 2FA; alle Sessions enden (auth.ts:54); gleiche Antwort (Test). |  |
| V6.4.4 | 2 | Identitätsprüfung bei Verlust eines Faktors | erfüllt | Bei Verlust der App ersetzen 10 Backup-Codes den zweiten Faktor, jeder einmal (better-auth 1.7.9 dist/plugins/two-factor/backup-codes/index.mjs:15, 215-227); der Reset hebt die 2FA bewusst nicht auf (auth.ts:98, ASVS 6.4.3). Fehlen App und Backup-Codes, entfernt pnpm auth:reset-two-factor --user <E-Mail> --ticket <Ticket> den Faktor nur nach einem Passwort-Reset über den Link an die Adresse in den letzten 24 Stunden, also mit dem Nachweis der Registrierung (apps/api/src/modules/identity/reset-two-factor.ts, recentReset und resetTwoFactor); es löscht Faktor und Backup-Codes, beendet alle Sessions, schreibt auth.two_factor_reset mit Ticket und informiert die Adresse per E-Mail (Vorlage two-factor-reset). --check nennt vorher die Organisationen mit weiteren Owners, deren Bestätigung das Runbook verlangt, bei Plattform-Admins die eines zweiten Admins (docs/runbooks/zweiter-faktor-verloren.md). Test apps/api/test/two-factor-reset.integration.test.ts; Probe am lokalen Stack im Runbook. |  |

### V6.5

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V6.5.1 | 2 | Einmalcodes sind nur einmal nutzbar | erfüllt | TOTP: Der Hook markiert jeden Code je Nutzer vor der Prüfung per Redis SET NX für 120 s und weist eine Wiederholung mit CODE_ALREADY_USED ab, auch über zwei Anmeldungen (auth-hooks.ts:29-33, 125-160, 208-212; Test auth.integration.test.ts:296-316). Backup-Codes entfernt Better Auth per Compare-and-Swap (better-auth 1.7.9 dist/plugins/two-factor/backup-codes/index.mjs:215-227), die 2FA-Challenge wird verbraucht (verify-two-factor.mjs:26-31), Reset-Tokens ebenso (better-auth 1.7.9 dist/api/routes/password.mjs:160-161). OOB-Codes per E-Mail oder SMS gibt es nicht. |  |
| V6.5.2 | 2 | Backup-Codes gehasht mit Salt gespeichert | offen | Unverändert: Backup-Codes aus 10 Zeichen eines Alphabets von 62 (ca. 59,5 Bit, better-auth 1.7.9 dist/plugins/two-factor/backup-codes/index.mjs:15) liegen per storeBackupCodes 'encrypted' (two-factor/index.mjs:25-28) mit XChaCha20-Poly1305 und dem Schlüssel aus BETTER_AUTH_SECRETS umkehrbar in two_factor.backup_codes; auth:reencrypt verschlüsselt sie nach einer Rotation neu (apps/api/src/modules/identity/reencrypt-two-factor.ts, f688fbf). | Kein Hash mit Salt; wer Datenbank und Schlüssel hat, liest alle Codes. Ein Hash bringt hier wenig: Wer beides hat, entschlüsselt auch das TOTP-Secret derselben Zeile, und ohne Schlüssel schützt die Verschlüsselung stärker als ein Hash von 59,5 Bit. Die Abweichung in ADR 0039 festhalten. Schwere: niedrig. Plan: akzeptiert: Wer Datenbank und BETTER_AUTH_SECRETS besitzt, entschlüsselt auch die TOTP-Secrets derselben Zeile, ein Hash der Backup-Codes verhindert also keinen Angriff. Festgehalten in ADR 0039. |
| V6.5.3 | 2 | Codes und TOTP-Seeds aus einem CSPRNG | erfüllt | Backup-Codes, TOTP-Secret (32 Zeichen, ca. 192 Bit) und Reset-Token über crypto.getRandomValues (@better-auth/utils random.mjs:31, two-factor/index.mjs:134). |  |
| V6.5.4 | 2 | Mindestentropie der Backup-Codes | erfüllt | 10 Backup-Codes zu je 10 Zeichen aus 62 Zeichen, ca. 59,5 Bit (backup-codes/index.mjs:15); OOB-Codes gibt es nicht. |  |
| V6.5.5 | 2 | Definierte Lebensdauer von TOTP und OOB-Tokens | teilweise | TOTP-Periode 30 s (better-auth 1.7.9 dist/plugins/two-factor/totp/index.mjs:24-28), die 2FA-Challenge gilt 10 min (two-factor/index.mjs:290), jeder TOTP-Code gilt nur einmal (auth-hooks.ts:29-33, 143-160). Der Bestätigungslink (1 h, auth.ts:117) meldet nicht mehr an und ist kein Anmeldefaktor; der Reset-Link (1 h, ADR 0012:18) dient der Wiederherstellung und meldet ebenfalls nicht an. OOB-Verfahren gibt es nicht. | verifyTOTP akzeptiert fest einen Zeitschritt davor und danach (@better-auth/utils 0.5.0 dist/otp.mjs:35, im Plugin nicht einstellbar, totp/index.mjs:188-194); ein Code gilt so bis zu 90 s statt höchstens 30 s. Die Abweichung mit Begründung in ADR 0039 festhalten. Schwere: niedrig. Plan: akzeptiert: Ein Zeitschritt Toleranz gleicht nach RFC 6238 Uhrabweichungen aus, und weil jeder Code nur einmal gilt, nützt das längere Fenster nur Echtzeit-Phishing, das auch 30 s nicht verhindern. Festgehalten in ADR 0039. |

### V6.6

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V6.6.1 | 2 | OTP per SMS oder Telefon | nicht anwendbar | Kein SMS- oder Telefon-OTP; die 2FA nutzt nur TOTP, das phoneNumber-Plugin ist nicht aktiv. |  |
| V6.6.2 | 2 | Bindung von OOB-Codes an die ursprüngliche Anfrage | nicht anwendbar | Kein OOB-Authentifikator: das E-Mail-OTP der 2FA ist ohne sendOTP nicht aktivierbar (two-factor/index.mjs:114), es gibt keinen Push. |  |
| V6.6.3 | 2 | Brute-Force-Schutz für OOB-Codes | nicht anwendbar | Keine codebasierten OOB-Verfahren im Einsatz (siehe V6.6.2). |  |

### V6.8

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V6.8.1 | 2 | Keine Identitätsfälschung über mehrere IdPs | nicht anwendbar | Kein Login über IdPs: keine socialProviders, kein OIDC oder SAML; Google/Microsoft nur als Option in Architektur 10. |  |
| V6.8.2 | 2 | Signaturprüfung von Authentifizierungs-Assertions | nicht anwendbar | Keine IdP-Assertions; die OAuth-Flows der Plattformen verbinden Social-Accounts und melden nicht an der App an. |  |
| V6.8.3 | 2 | Einmalige Verarbeitung von SAML-Assertions | nicht anwendbar | SAML wird nicht verwendet. |  |
| V6.8.4 | 2 | Prüfung von acr, amr und auth_time | nicht anwendbar | Kein externer IdP für die Anmeldung an der App. |  |

## V7 Sitzungsverwaltung

### V7.1

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V7.1.1 | 2 | Dokumentation von Inaktivitätszeit und Höchstdauer der Session | erfüllt | ADR 0039, Abschnitt Sessions: absolute Laufzeit von sieben Tagen ab der Anmeldung ohne Verlängerung, keine eigene Inaktivitätszeit, ein Tag mit rememberMe=false, mit Begründung, Vergleich mit NIST SP 800-63B-4 und Ausgleich. Code: auth.ts (session.expiresIn, disableSessionRefresh); Test auth.integration.test.ts. |  |
| V7.1.2 | 2 | Dokumentation paralleler Sessions je Konto | erfüllt | ADR 0039, Abschnitt Sessions: Die Zahl paralleler Sessions ist bewusst nicht begrenzt, mit Begründung; die Sicherheitsseite listet alle und beendet einzelne, alle anderen oder alle (security-page.tsx), eine neue Anmeldung beendet die alte Session desselben Browsers (auth-hooks.ts). |  |
| V7.1.3 | 2 | Dokumentation föderierter Sessions | nicht anwendbar | Kein SSO und keine föderierte Identität; Better Auth in der API ist die einzige Auth-Instanz (ADR 0006). |  |

### V7.2

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V7.2.1 | 1 | Session-Prüfung im vertrauenswürdigen Backend | erfüllt | Der globale AuthGuard prüft jede Route per auth.api.getSession gegen die DB (auth.guard.ts:40, access.module.ts:23); Web-Layouts fragen /api/me; proxy.ts ist ausdrücklich keine Grenze. |  |
| V7.2.2 | 1 | Dynamisch erzeugte Referenz-Tokens | erfüllt | DB-Sessions mit bei jedem Login neu erzeugtem Token im signierten httpOnly-Cookie; keine statischen API-Schlüssel für Nutzer. |  |
| V7.2.3 | 1 | Session-Token eindeutig, aus CSPRNG, mindestens 128 Bit | erfüllt | generateId(32) aus 62 Zeichen per crypto.getRandomValues, ca. 190 Bit (internal-adapter.mjs:285); token @unique (schema.prisma:57); Cookie mit HMAC-SHA256 signiert. |  |
| V7.2.4 | 1 | Neues Token bei Anmeldung und Re-Authentifizierung | erfüllt | Jede Anmeldung erzeugt eine neue Session (better-auth 1.7.9 dist/api/routes/sign-in.mjs:352), und der Hook beendet die Session, die das Cookie des Browsers vorher nannte (auth-hooks.ts:162-168, 249-253; Test auth.integration.test.ts:318-339). Vor dem zweiten Faktor löscht das Plugin die Session des Passwortschritts und erzeugt danach eine neue (plugins/two-factor/index.mjs:287-289, verify-two-factor.mjs:26-40); 2FA an und aus sowie die Passwortänderung mit Abmelden der anderen Geräte rotieren das Token (totp/index.mjs:205-214, two-factor/index.mjs:228-232, api/routes/update-user.mjs:174-177). Seit 5bd6475 beendet der Hook die alte Session des Browsers schon beim ersten Schritt einer Anmeldung, auf den der zweite Faktor folgt (auth-hooks.ts; Test 'ends the session the browser held also when the new sign-in asks for the second factor' in auth.integration.test.ts). |  |

### V7.3

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V7.3.1 | 2 | Inaktivitäts-Timeout der Session | teilweise | Ungenutzte Sessions enden spätestens 7 Tage nach der Anmeldung, weil keine Nutzung sie verlängert (auth.ts:131-132; better-auth 1.7.9 dist/api/routes/session.mjs:155, 181; Test auth.integration.test.ts:365-387). Die Entscheidung gegen eine eigene Inaktivitätszeit steht mit Begründung, Vergleich mit NIST SP 800-63B-4 und Ausgleich in ADR 0039 (Abschnitt Sessions). | Eine Inaktivitätszeit unterhalb der absoluten Laufzeit gibt es bewusst nicht; akzeptierte Abweichung (ADR 0039). Schwere: niedrig. Plan: Wiedervorlage bei Kunden mit höherem Schutzbedarf (ADR 0039). |
| V7.3.2 | 2 | Absolute Höchstdauer der Session | erfüllt | session.expiresIn 7 Tage mit disableSessionRefresh (auth.ts:131-132, 518e02a): Better Auth verlängert expiresAt nicht mehr (better-auth 1.7.9 dist/api/routes/session.mjs:181), abgelaufene Sessions werden abgewiesen und gelöscht (session.mjs:155-160); Test auth.integration.test.ts:365-387 (das Ende bleibt trotz Nutzung). Eine neue Laufzeit beginnt nur nach Passwort oder zweitem Faktor (Anmeldung, 2FA an und aus, Passwortänderung mit Abmelden der anderen). Begründung und Risikoanalyse der sieben Tage stehen in ADR 0039 (Abschnitt Sessions). |  |

### V7.4

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V7.4.1 | 1 | Beendete Sessions sind nicht mehr nutzbar | erfüllt | sign-out löscht die Session in der DB (sign-out.mjs:50); abgelaufene werden abgewiesen und gelöscht (session.mjs:155); kein Cookie-Cache; Test auth.integration.test.ts:108. |  |
| V7.4.2 | 1 | Sessions enden beim Sperren oder Löschen des Kontos | erfüllt | Löschen eines Nutzers entfernt seine Sessions per Cascade (schema.prisma:64); Entfernen aus einer Organisation invalidiert den Zugriff sofort (organization.controller.ts:120). | Eine Sperr- oder Löschfunktion für Konten gibt es noch nicht (ADR 0037: eigener Vorgang). |
| V7.4.3 | 2 | Andere Sessions nach Änderung eines Faktors beenden | erfüllt | Passwortänderung mit 'Andere Geräte abmelden', voreingestellt an (security-page.tsx:82, 87-91, 156-159; packages/contracts/src/auth.ts:37-38); der Reset beendet alle Sessions ohne Rückfrage (auth.ts:98; better-auth 1.7.9 dist/utils/password.mjs:31-35). Seit 5c4cafd bieten auch das Ein- und Ausschalten der 2FA an, die anderen Geräte abzumelden, vorbelegt mit ja; danach ruft die Seite revokeOtherSessions auf (security-page.tsx). |  |
| V7.4.4 | 2 | Sichtbares Abmelden auf allen geschützten Seiten | erfüllt | Alle geschützten Bereiche /w, /org, /account und /admin rendern die AppShell mit 'Abmelden' im Nutzermenü (apps/web/src/components/app-shell.tsx:373, 420; Layouts unter apps/web/src/app/(app)/*/layout.tsx); die Onboarding-Seite hat 'Abmelden' im Kopf (apps/web/src/app/onboarding/page.tsx:24-29, sign-out-button.tsx, 1baf411). Das Abmelden leert Cache und Speicher (apps/web/src/lib/use-sign-out.ts:14-25, Clear-Site-Data in auth-hooks.ts:254-257). /invite/[token] ist öffentlich und daher nicht erfasst. |  |
| V7.4.5 | 2 | Administratoren beenden Sessions von Nutzern | erfüllt | pnpm auth:revoke-sessions --user <E-Mail> oder --all löscht die Sessions in der Datenbank (apps/api/src/modules/identity/revoke-sessions.ts:15-30, apps/api/src/scripts/revoke-sessions.ts:10-29, debe620); ohne Cookie-Cache bekommt die nächste Anfrage 401. Test auth.integration.test.ts:341-363; Runbook docs/runbooks/secret-rotation.md:18-25 (afc4d79). Einschränkung: Offene Live-Streams laufen weiter (neuer Befund zu V7.4.1). |  |

### V7.5

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V7.5.1 | 2 | Re-Authentifizierung vor Änderung sensibler Kontodaten | erfüllt | Die Änderung der E-Mail ist nicht aktiviert (better-auth 1.7.9 dist/api/routes/update-user.mjs:430); 2FA an und aus, TOTP-URI und neue Backup-Codes verlangen das Passwort (plugins/two-factor/index.mjs:107-113, 210-216; totp/index.mjs:126-129; backup-codes/index.mjs:279-282) mit höchstens 5 Fehlversuchen je Nutzer in 15 min (auth-hooks.ts:27, 36-42, 196-202, 241-243; Test auth.integration.test.ts:253-271); /verify-password ist über HTTP geschlossen (auth.ts:135-136; Test :413-416). Seit 6fc1fb6 verlangen Abschalten, neues Einrichten, Abruf des Schlüssels und neue Backup-Codes bei aktiver 2FA zusätzlich einen Code des Faktors, bestätigt mit der Session und fünf Minuten für eine Änderung gültig, sonst 403 SECOND_FACTOR_REQUIRED (auth-hooks.ts; Test 'asks for a code of the second factor before it changes or hands out the second factor' in auth.integration.test.ts). |  |
| V7.5.2 | 2 | Aktive Sessions einsehen und beenden | teilweise | Die Sicherheitsseite listet Sessions mit Gerät, IP und Beginn und beendet einzelne oder alle anderen (security-page.tsx:396-519), meldet Fehler (security-page.tsx:417-436) und bietet eine neue Anmeldung an, wenn die Session älter als 24 h ist (security-page.tsx:393-415, 438, 450-455; freshAge in better-auth 1.7.9 dist/api/routes/session.mjs:331-350 und context/create-context.mjs:149). | Das Beenden verlangt keine erneute Authentifizierung: /revoke-session, /revoke-sessions und /revoke-other-sessions prüfen nur die Session, nicht einmal deren Frische (session.mjs:377-380, 420-422, 450-453). Die Abweichung in ADR 0039 festhalten. Schwere: niedrig. Plan: akzeptiert: Mit einer gestohlenen Session lassen sich nur andere Sessions desselben Kontos beenden; Betroffene melden sich neu an und beenden per Reset alle Sessions, Angreifer gewinnen dadurch keinen Zugriff. Festgehalten in ADR 0039. |

### V7.6

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V7.6.1 | 2 | Session-Lebensdauer zwischen Relying Party und IdP | nicht anwendbar | Keine Föderation: die App ist weder Relying Party noch IdP. |  |
| V7.6.2 | 2 | Session nur mit Zustimmung oder ausdrücklicher Aktion | nicht anwendbar | Der Abschnitt gilt für RP- und IdP-Code; ohne Föderation keine stillen Sessions. Sessions entstehen nur durch Login, 2FA-Code oder Klick auf den Verifizierungslink. |  |

## V8 Autorisierung

### V8.1

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V8.1.1 | 1 | Autorisierungsregeln für Funktionen und Daten dokumentiert | erfüllt | ARCHITECTURE 10: Rechte-Matrix, Guard-Reihenfolge, deny by default, 404 für fremde Mandanten; 6.3 und ADR 0003: RLS, Workspace-Beschränkung, Nutzer-Policies; Matrix als Code in permissions.ts. |  |
| V8.1.2 | 2 | Regeln für Felder je Rolle dokumentiert | erfüllt | docs/security/autorisierung-und-grenzen.md, Regeln pro Feld: je Ressource das Recht zum Lesen und Ändern der Felder, dazu die Durchsetzung (Antwort- und Anfrageschemas, zweite Prüfung in den Use Cases) und was die API nie ausgibt; Matrix in packages/contracts/src/permissions.ts. |  |

### V8.2

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V8.2.1 | 1 | Funktionszugriff nur mit expliziter Berechtigung, deny by default | erfüllt | Globale Guards (access.module.ts), PermissionGuard mit can(); RouteAccessCheck stoppt den Start ohne Regel; Matrix-Test 80 Routen x 4 Rollen; PlatformAdminGuard getestet; Use Cases prüfen erneut. |  |
| V8.2.2 | 1 | Objektzugriff durch Mandantenkontext, RLS und Nutzerbindung begrenzt | erfüllt | WorkspaceGuard prüft Mitgliedschaft (sonst 404); Repos filtern workspaceId, RLS FORCE als app_user; Referenzen (Stil, Account, Medien) im Workspace geprüft; Pending/Login an userId gebunden. |  |
| V8.2.3 | 2 | Feldzugriff über zod-DTOs für Ein- und Ausgabe beschränkt | erfüllt | zod-Objekte verwerfen fremde Felder (ZodValidationPipe); ZodSerializerInterceptor filtert Antworten; isPlatformAdmin input:false (Test); Tokens nie in contracts; Spalten-GRANT auf gdpr_request. |  |

### V8.3

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V8.3.1 | 1 | Autorisierung serverseitig in API, Use Cases und Datenbank | erfüllt | Guards in NestJS, Zweitprüfung in Use Cases, RLS in PostgreSQL; das Web nutzt can() nur zum Ausblenden (permissions.ts), proxy.ts ist laut Kommentar keine Grenze; Web ohne DB-Zugriff. |  |

### V8.4

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V8.4.1 | 2 | Mandantentrennung mehrschichtig über RLS und Kontext erzwungen | erfüllt | app_user ohne BYPASSRLS, set_config transaktionslokal mit NULLIF; findRlsViolations im CI-Integrationstest; app_system nur in @SystemScope; AAD bindet Secrets an den Workspace; RLS-Tests. |  |

## V9 Eigenständige Tokens

### V9.1

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V9.1.1 | 1 | Signierte Tokens werden vor der Nutzung per MAC geprüft | erfüllt | Einziges JWT: Verifizierungslink von Better Auth, jwtVerify vor Payload-Nutzung; Stripe constructEvent (HMAC, secureCompare); Presigned-URLs prüft der Speicher; Mock-Codes nicht in Prod. |  |
| V9.1.2 | 1 | Algorithmen-Allowlist HS256, kein none | erfüllt | email-verification.mjs: jwtVerify mit algorithms ['HS256']; jose unterstützt kein none für JWS; Stripe nur Schema v1 (HMAC-SHA256); nur symmetrische Verfahren, keine Schlüsselverwechslung. |  |
| V9.1.3 | 1 | Schlüssel nur aus vorkonfigurierten Quellen, keine Header-Schlüssel | erfüllt | HS256-Schlüssel ist BETTER_AUTH_SECRET aus der Env (zod, min. 32 Zeichen); jose bekommt einen festen Schlüssel, jku/x5u/jwk werden nicht ausgewertet; Stripe-Webhook-Secret aus der Env. |  |

### V9.2

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V9.2.1 | 1 | Gültigkeitszeitraum der Tokens wird geprüft | erfüllt | jose prüft exp und nbf (jwt_claims_set.js), Verifizierungslink mit expiresIn 3600 s (auth.ts); Stripe-Toleranz 300 s; abgelaufene Presigned-URLs lehnt der Speicher ab (ADR 0008). |  |
| V9.2.2 | 2 | Tokentyp eindeutig durch Schlüsselzweck und Payload-Schema | erfüllt | Mit BETTER_AUTH_SECRET wird nur der Verifizierungslink als JWT signiert (Cookie-Cache aus); verify-email prüft den Payload per zod; kein typ-Claim; Sessions sind opake DB-Tokens. |  |
| V9.2.3 | 2 | Tokens nur vom ausstellenden Dienst akzeptiert | erfüllt | Aussteller und einziger Empfänger des Verifizierungs-JWT ist die API (Better Auth); kein aud-Claim, die Bindung läuft über ihren HS256-Schlüssel; Worker und Web prüfen keine Tokens. |  |
| V9.2.4 | 2 | Kein Aussteller mit einem Schlüssel für mehrere Zielgruppen | nicht anwendbar | Die App stellt keine Tokens für fremde Dienste aus; BETTER_AUTH_SECRET signiert nur Tokens, die die API selbst wieder prüft. |  |

## V10 OAuth und OIDC

### V10.1

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V10.1.1 | 2 | Plattform-Tokens bleiben versiegelt im Backend | erfüllt | Tokens AES-GCM-versiegelt (confirm-connection.ts); geöffnet nur in API (Bestätigen, Widerruf) und Worker; contracts/channels.ts ohne Tokens; Job-Payloads verwerfen Tokens (payloads.test.ts). |  |
| V10.1.2 | 2 | state und PKCE unratbar, einmalig und an Nutzer gebunden | erfüllt | oauth-random.ts: 32 Byte randomBytes; Redis GETDEL, TTL 10 min; complete-authorization.ts prüft Plattform und Nutzer-ID der Session; Verifier nur serverseitig; channels.integration.test.ts. |  |

### V10.2

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V10.2.1 | 2 | CSRF-Schutz im Code-Flow durch state und PKCE | erfüllt | state wird vor dem Code-Tausch einmalig eingelöst und gegen Nutzer und Plattform geprüft (STATE_INVALID, USER_MISMATCH getestet); PKCE S256 für X, Verifier nie im Browser. |  |
| V10.2.2 | 2 | Mix-up-Abwehr über getrennte Redirect-URIs pro Plattform | erfüllt | Je Plattform eigener Callback /api/oauth/{platform}/callback; Plattform des state muss zum Pfad passen, Tausch mit Connector und redirectUri aus dem state; iss wird nicht ausgewertet. |  |

### V10.3

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V10.3.1 | 2 | Kein Resource Server, keine Audience-Prüfung nötig | nicht anwendbar | Die API akzeptiert keine OAuth-Access-Tokens; Anmeldung nur über opake Better-Auth-Session-Cookies, kein Bearer- oder JWT-Plugin (auth.ts: plugins nur twoFactor). |  |
| V10.3.2 | 2 | Kein Resource Server, keine Claims delegierter Rechte | nicht anwendbar | Die API akzeptiert keine OAuth-Access-Tokens; Anmeldung nur über opake Better-Auth-Session-Cookies, kein Bearer- oder JWT-Plugin (auth.ts: plugins nur twoFactor). |  |
| V10.3.3 | 2 | Kein Resource Server, keine Nutzerkennung aus Access Tokens | nicht anwendbar | Die API akzeptiert keine OAuth-Access-Tokens; Anmeldung nur über opake Better-Auth-Session-Cookies, kein Bearer- oder JWT-Plugin (auth.ts: plugins nur twoFactor). |  |
| V10.3.4 | 2 | Kein Resource Server, keine acr/amr-Prüfung | nicht anwendbar | Die API akzeptiert keine OAuth-Access-Tokens; Anmeldung nur über opake Better-Auth-Session-Cookies, kein Bearer- oder JWT-Plugin (auth.ts: plugins nur twoFactor). |  |

### V10.4

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V10.4.1 | 1 | Kein Authorization Server, keine Redirect-URI-Allowlist nötig | nicht anwendbar | Die App ist kein Authorization Server: Better Auth ohne OAuth-/OIDC-Provider-Plugin (auth.ts: nur twoFactor); sie ist nur OAuth-Client von LinkedIn, Meta und X. |  |
| V10.4.2 | 1 | Kein Authorization Server, keine Codes auszustellen | nicht anwendbar | Die App ist kein Authorization Server: Better Auth ohne OAuth-/OIDC-Provider-Plugin (auth.ts: nur twoFactor); sie ist nur OAuth-Client von LinkedIn, Meta und X. |  |
| V10.4.3 | 1 | Kein Authorization Server, keine Code-Lebensdauer | nicht anwendbar | Die App ist kein Authorization Server: Better Auth ohne OAuth-/OIDC-Provider-Plugin (auth.ts: nur twoFactor); sie ist nur OAuth-Client von LinkedIn, Meta und X. |  |
| V10.4.4 | 1 | Kein Authorization Server, keine Grant-Verwaltung | nicht anwendbar | Die App ist kein Authorization Server: Better Auth ohne OAuth-/OIDC-Provider-Plugin (auth.ts: nur twoFactor); sie ist nur OAuth-Client von LinkedIn, Meta und X. |  |
| V10.4.5 | 1 | Kein Authorization Server, kein Refresh-Replay-Schutz nötig | nicht anwendbar | Die App ist kein Authorization Server: Better Auth ohne OAuth-/OIDC-Provider-Plugin (auth.ts: nur twoFactor); sie ist nur OAuth-Client von LinkedIn, Meta und X. |  |
| V10.4.6 | 2 | Kein Authorization Server, PKCE-Pflicht liegt bei Plattformen | nicht anwendbar | Die App ist kein Authorization Server: Better Auth ohne OAuth-/OIDC-Provider-Plugin (auth.ts: nur twoFactor); sie ist nur OAuth-Client von LinkedIn, Meta und X. |  |
| V10.4.7 | 2 | Keine dynamische Client-Registrierung | nicht anwendbar | Die App ist kein Authorization Server: Better Auth ohne OAuth-/OIDC-Provider-Plugin (auth.ts: nur twoFactor); sie ist nur OAuth-Client von LinkedIn, Meta und X. |  |
| V10.4.8 | 2 | Kein Authorization Server, keine eigenen Refresh Tokens | nicht anwendbar | Die App ist kein Authorization Server: Better Auth ohne OAuth-/OIDC-Provider-Plugin (auth.ts: nur twoFactor); sie ist nur OAuth-Client von LinkedIn, Meta und X. |  |
| V10.4.9 | 2 | Kein Authorization Server, keine Widerrufsoberfläche | nicht anwendbar | Die App ist kein Authorization Server: Better Auth ohne OAuth-/OIDC-Provider-Plugin (auth.ts: nur twoFactor); sie ist nur OAuth-Client von LinkedIn, Meta und X. |  |
| V10.4.10 | 2 | Kein Authorization Server, keine Client-Authentifizierung | nicht anwendbar | Die App ist kein Authorization Server: Better Auth ohne OAuth-/OIDC-Provider-Plugin (auth.ts: nur twoFactor); sie ist nur OAuth-Client von LinkedIn, Meta und X. |  |
| V10.4.11 | 2 | Kein Authorization Server, keine Scope-Zuteilung | nicht anwendbar | Die App ist kein Authorization Server: Better Auth ohne OAuth-/OIDC-Provider-Plugin (auth.ts: nur twoFactor); sie ist nur OAuth-Client von LinkedIn, Meta und X. |  |

### V10.5

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V10.5.1 | 2 | Kein OIDC-Client, kein ID-Token-Replay-Schutz nötig | nicht anwendbar | Kein OIDC-Client im Code: Social Login in auth.ts nicht konfiguriert, LinkedIn-Adapter (Scope openid) ist offen (Leitfaden 4.12); der Mock-Connector verarbeitet keine ID Tokens. | Wird mit dem LinkedIn-Adapter (Schritt 4.12) anwendbar; dann nonce, aud und sub prüfen. |
| V10.5.2 | 2 | Kein OIDC-Client, keine Nutzerkennung aus ID Tokens | nicht anwendbar | Kein OIDC-Client im Code: Social Login in auth.ts nicht konfiguriert, LinkedIn-Adapter (Scope openid) ist offen (Leitfaden 4.12); der Mock-Connector verarbeitet keine ID Tokens. | Wird mit dem LinkedIn-Adapter (Schritt 4.12) anwendbar; dann nonce, aud und sub prüfen. |
| V10.5.3 | 2 | Kein OIDC-Client, keine Metadaten-Discovery | nicht anwendbar | Kein OIDC-Client im Code: Social Login in auth.ts nicht konfiguriert, LinkedIn-Adapter (Scope openid) ist offen (Leitfaden 4.12); der Mock-Connector verarbeitet keine ID Tokens. | Wird mit dem LinkedIn-Adapter (Schritt 4.12) anwendbar; dann nonce, aud und sub prüfen. |
| V10.5.4 | 2 | Kein OIDC-Client, keine aud-Prüfung von ID Tokens | nicht anwendbar | Kein OIDC-Client im Code: Social Login in auth.ts nicht konfiguriert, LinkedIn-Adapter (Scope openid) ist offen (Leitfaden 4.12); der Mock-Connector verarbeitet keine ID Tokens. | Wird mit dem LinkedIn-Adapter (Schritt 4.12) anwendbar; dann nonce, aud und sub prüfen. |
| V10.5.5 | 2 | Kein OIDC Back-Channel Logout | nicht anwendbar | Kein OIDC-Client im Code: Social Login in auth.ts nicht konfiguriert, LinkedIn-Adapter (Scope openid) ist offen (Leitfaden 4.12); der Mock-Connector verarbeitet keine ID Tokens. |  |

### V10.6

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V10.6.1 | 2 | Kein OpenID Provider, keine Response Modes | nicht anwendbar | Die App ist kein OpenID Provider; Better Auth läuft ohne oidcProvider-Plugin (auth.ts: nur twoFactor). |  |
| V10.6.2 | 2 | Kein OpenID Provider, kein RP-initiiertes Logout | nicht anwendbar | Die App ist kein OpenID Provider; Better Auth läuft ohne oidcProvider-Plugin (auth.ts: nur twoFactor). |  |

### V10.7

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V10.7.1 | 2 | Keine eigene Einwilligung, Zustimmung bei der Plattform | nicht anwendbar | Einwilligungen erteilt der Authorization Server der Plattform; die App ist keiner. Die Mock-Zustimmungsseite gibt es nur außerhalb der Produktion (app.module.ts). |  |
| V10.7.2 | 2 | Keine eigene Einwilligungsseite in Produktion | nicht anwendbar | Einwilligungen erteilt der Authorization Server der Plattform; die App ist keiner. Die Mock-Zustimmungsseite gibt es nur außerhalb der Produktion (app.module.ts). |  |
| V10.7.3 | 2 | Keine Einwilligungsverwaltung eines Authorization Servers | nicht anwendbar | Einwilligungen erteilt der Authorization Server der Plattform; die App ist keiner. Die Mock-Zustimmungsseite gibt es nur außerhalb der Produktion (app.module.ts). |  |

## V11 Kryptografie

### V11.1

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V11.1.1 | 2 | Richtlinie für den Lebenszyklus der Schlüssel nach SP 800-57 | teilweise | Runbook docs/runbooks/secret-rotation.md (Commits 9501f2a, 84065ba, afc4d79): Anlässe und jährliche Rotation auch der Schlüssel (Zeilen 5-9), Ablage und Nutzer je Secret (27-41), Rotation von BETTER_AUTH_SECRETS mit Neuverschlüsselung (43-54), KEK-Rotation in zwei Neustarts mit Re-Wrap (56-65), Sitzungen nach einer Kompromittierung beenden (18-25). ARCHITECTURE 10: KmsPort, Schlüsselversionen, eigener Keyring für Sessions; Erzeugung aus 32 Zufallsbytes (tools/gen-keys.ts:6-27). Die Richtlinie nach NIST SP 800-57 steht in docs/security/kryptografie.md (Erzeugung, Speicherung, Verteilung je Dienst und Rolle, Rotation und Kryptoperioden, Widerruf und Vernichtung, Rollen, Wiederherstellung). | TOKEN_KEKS halten die API und bis zu sechs Worker-Rollen, SESSION_KEKS die API, der Worker scheduler und der browser-worker; heute trennt der Code die Rollen, nicht der Schlüssel. Schwere: niedrig. Plan: Schritt 8.9: KMS mit getrennten Rechten je Dienst und ein eigener Keyring für die E-Mails (ADR 0039, docs/security/kryptografie.md). |
| V11.1.2 | 2 | Inventar der Schlüssel, Algorithmen und Zertifikate | erfüllt | docs/security/kryptografie.md: Inventar aller Schlüssel mit erlaubten und verbotenen Einsatzorten und Haltern sowie aller Verfahren mit Parametern, Schlüssel und Ort im Code (Envelope und KEK-Wrap, versiegelte E-Mails und Sessions, 2FA, signierte Cookies, Bestätigungslinks, scrypt, TOTP, Token-Hashes, PKCE, Digests, Leck-Prüfung, Stripe, SigV4), dazu Zufall, Transport und was nicht verwendet wird. | Hinweis: Die Zertifikate kommen mit Schritt 8.9 dazu. |

### V11.2

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V11.2.1 | 2 | Etablierte Kryptobibliotheken statt Eigenimplementierungen | erfüllt | node:crypto (AES-256-GCM, randomBytes, SHA-256, scrypt), WebCrypto-HMAC, jose, @noble/ciphers in Better Auth, Stripe- und AWS-SDK; envelope.ts setzt nur Primitive zusammen. |  |
| V11.2.2 | 2 | Krypto-Agilität: Verfahren und Schlüssel austauschbar | teilweise | Umschlag mit Versionsbyte und KEK-ID (packages/crypto/src/envelope.ts:9, 15, 53), austauschbarer KmsPort (packages/crypto/src/kms.ts:10-20), Re-Wrap in tick.maintenance (packages/core/src/channels/application/rewrap-secrets.ts:24-72) für Token- und Session-Keyring (apps/worker/src/infrastructure/scheduler.providers.ts:107, 142). Neu in 8.4: versionierte Schlüssel von Better Auth (apps/api/src/config/api-env.ts:16-37, apps/api/src/modules/identity/auth-secrets.ts:9-21, auth.ts:87) mit Neuverschlüsselung der TOTP-Secrets und Backup-Codes (apps/api/src/modules/identity/reencrypt-two-factor.ts:24-67; Test apps/api/test/auth-rotation.integration.test.ts:40; Commits 14872b8, f688fbf); Passwort-Hashes nennen ihre Parameter (packages/crypto/src/password-hash.ts:53-72); Rotation jedes Secrets im Runbook. Der Migrationsweg je Verfahren steht in docs/security/kryptografie.md (Wechsel eines Verfahrens). | Kein Re-Encrypt-Pfad für eine neue Umschlagversion oder einen neuen Algorithmus (rewrap tauscht nur den KEK, parse kennt nur Version 1); kein Rehash bei der Anmeldung, wenn die scrypt-Parameter steigen; die Verfahren von Better Auth legt die Bibliothek fest. Schwere: niedrig. Plan: akzeptiert: Die Formate tragen Version, Schlüssel-ID und Parameter; der Job zum Neuversiegeln und der Rehash bei der Anmeldung entstehen mit dem ersten Wechsel (docs/security/kryptografie.md). |
| V11.2.3 | 2 | Alle Primitive mit mindestens 128 Bit Sicherheit | erfüllt | AES-256-GCM für DEK und KEK, 256-Bit-Schlüssel aus gen:keys, HMAC-SHA256, SHA-256, XChaCha20-Poly1305 mit 256-Bit-Schlüssel, PKCE S256; kein RSA oder ECC im App-Code. |  |

### V11.3

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V11.3.1 | 1 | Kein ECB-Modus und kein PKCS#1 v1.5 | erfüllt | Verschlüsselung nur mit AES-256-GCM (envelope.ts, local-keyring.ts) und XChaCha20-Poly1305 (Better Auth); keine RSA-Verschlüsselung oder -Signatur im App-Code; JWT nur HS256. |  |
| V11.3.2 | 1 | Nur zugelassene AEAD-Verfahren im Einsatz | erfüllt | AES-256-GCM mit 12-Byte-Zufalls-IV und 16-Byte-Tag für Tokens und Sessions; Better Auth nutzt XChaCha20-Poly1305 für 2FA-Secrets; der JWE-Cookie-Cache (A256CBC-HS512) ist aus. |  |
| V11.3.3 | 2 | Authentifizierte Verschlüsselung mit AAD-Bindung an die Zeile | erfüllt | GCM-Tag und AAD workspaceId:connectionId:feld; DEK-Wrap mit Key-ID als AAD; Tests: jedes Byte manipuliert, falsche AAD und fremder DEK schlagen fehl (envelope.test.ts). |  |

### V11.4

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V11.4.1 | 1 | Nur zugelassene Hashfunktionen, kein MD5 | erfüllt | SHA-256 für Tokens, PKCE, Inhalte und HMAC; scrypt für Passwörter; kein MD5; SHA-1 nur als HMAC-SHA1 im TOTP nach RFC 6238 (Better Auth) und im Test-Helfer totp.ts. |  |
| V11.4.2 | 2 | scrypt mit OWASP-Parametern N=2^15, r=8, p=3 | erfüllt | scrypt mit N=2^15, r=8, p=3 (32 MiB), einer der gleichwertigen Einstellungen des OWASP Password Storage Cheat Sheets, 16 Byte Zufallssalz, 64-Byte-Schlüssel, NFKC und Vergleich in konstanter Zeit (packages/crypto/src/password-hash.ts:15-34, 53-78); Better Auth 1.7.9 nutzt es über emailAndPassword.password für alle Abläufe (apps/api/src/modules/identity/auth.ts:96-97), ebenso der Demo-Seed (packages/db/src/seed/demo.ts:1, 39); Hashes im alten Format von Better Auth werden weiter geprüft. Tests: packages/crypto/src/password-hash.test.ts:12-52; Commit 7866e6c. Die Dokumentation der Parameter folgt mit dem Kryptoinventar (V11.1.2). |  |
| V11.4.3 | 2 | Kollisionsresistente 256-Bit-Hashes für Integrität | erfüllt | SHA-256 für Integrität (Medien-sha256, contentHash, Brand-Voice-Version, Risikotext) und HMAC-SHA256 für Cookies, JWT und Stripe; keine kürzeren Hashes für Integritätszwecke. |  |
| V11.4.4 | 2 | Keine Schlüsselableitung aus Passwörtern | nicht anwendbar | KEKs und DEKs sind Zufallsschlüssel (gen:keys, randomBytes); Better Auth leitet den 2FA-Schlüssel per SHA-256 aus BETTER_AUTH_SECRET ab, einem Zufallsgeheimnis, keinem Passwort. | Hinweis: api-env.ts prüft bei BETTER_AUTH_SECRET nur die Länge; ein von Menschen gewähltes Geheimnis würde ohne Key-Stretching genutzt. |

### V11.5

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V11.5.1 | 2 | Zufallswerte aus CSPRNG mit mindestens 128 Bit | teilweise | randomBytes(32) für state, PKCE, Pending-ID und Einladungen; Session-Token ca. 190 Bit, Reset-Token ca. 143 Bit (getRandomValues); UUIDs nur als IDs, Zugriff stets an Nutzer oder Rolle gebunden. | Die Kennung des 2FA-Zwischenschritts von Better Auth hat 120 bit (20 Zeichen aus 64); Backup-Codes haben rund 59 bit (dafür gelten die Regeln aus V6.5). Schwere: niedrig. Plan: akzeptiert (ADR 0039): Die Kennung gilt zehn Minuten und nur im signierten Cookie; Wiedervorlage mit der nächsten Version von Better Auth. |

### V11.6

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V11.6.1 | 2 | Keine asymmetrische Kryptografie im Anwendungscode | nicht anwendbar | Die App erzeugt keine Schlüsselpaare und erstellt oder prüft keine Public-Key-Signaturen; JWT nur HS256, Webhooks per HMAC; TLS gehört nicht zu diesem Kapitel. |  |

## V12 Sichere Kommunikation

### V12.1

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V12.1.1 | 1 | Nur aktuelle TLS-Versionen, TLS 1.3 bevorzugt | teilweise | Ausgehend gelten die Node-Standards TLSv1.2 bis TLSv1.3 ohne Überschreibung (keine minVersion, secureProtocol oder ciphers im Repo, Suche ohne Treffer); TLS 1.3 wird bevorzugt ausgehandelt. Laufzeit node:24.21.0-trixie-slim (infra/docker/node-app.Dockerfile:13). Eingehend terminiert der Reverse Proxy; im Repo bedient dieser nur HTTP auf :8080 (infra/docker/caddy/Caddyfile:8). | Die TLS-Terminierung der Produktion fehlt und ist nur durch das Deployment erfüllbar: TLS 1.2 und 1.3 mit Vorrang für 1.3 festlegen und prüfen. Schwere: niedrig. Plan: Schritt 8.9 Deployment: Versionen an der Terminierung festlegen (der Caddy-Standard genügt) und per Scan, z.B. testssl.sh, prüfen. |
| V12.1.2 | 2 | Nur empfohlene Cipher-Suites, die stärksten zuerst | teilweise | Keine ciphers-Einstellung im Repo; ausgehende Verbindungen nutzen die OpenSSL-Standardliste von Node: zuerst die TLS-1.3-Suites, dann ECDHE mit AES-GCM, ohne aNULL, eNULL, RC4, DES und MD5. | Die Cipher-Liste der eingehenden TLS-Terminierung fehlt (nur durch das Deployment erfüllbar); die Node-Standardliste lässt ausgehend noch CBC-Suites zu, die nur ein Server ohne AEAD wählt. Schwere: niedrig. Plan: Schritt 8.9 Deployment: an der Terminierung nur AEAD-Suites mit Forward Secrecy, die stärksten zuerst, und per Scan prüfen. |
| V12.1.3 | 2 | Keine mTLS-Client-Zertifikate | nicht anwendbar | Keine Authentifizierung über Client-Zertifikate; Nutzer über Better-Auth-Session, Webhooks über Signaturen (stripe-webhook.controller.ts) |  |

### V12.2

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V12.2.1 | 1 | TLS für alle Verbindungen von außen, ohne Rückfall auf Klartext | teilweise | In Produktion verlangen API und Worker https für APP_URL, BETTER_AUTH_URL und die Speicheradresse des Browsers (apps/api/src/config/api-env.ts:94-103, apps/worker/src/worker-env.ts:59-62, packages/observability/src/env.ts:41-53; Tests api-env.test.ts:164-175, worker-env.test.ts:82-91; Commit 5dffa88). HSTS max-age=31536000; includeSubDomains auf allen Pfaden der Web-App in Produktions-Builds (apps/web/next.config.ts:24-28, apps/web/src/security/content-security-policy.ts:88-89; Commit 6dccefe) und auf der API (helmet-Standard, apps/api/src/bootstrap.ts:31-33); Auth-Cookies mit __Host- und Secure (apps/api/src/modules/identity/auth.ts:53-62). | Die TLS-Terminierung selbst fehlt im Repo (Caddyfile:8 nur HTTP) und ist nur durch das Deployment erfüllbar: TLS ohne Klartext-Fallback, Umleitung auf https nur für die Oberfläche, /api über http ablehnen, auch der Speicher-Host mit TLS. Kein Test prüft die HSTS-Header. Schwere: mittel. Plan: Schritt 8.9 Deployment: Produktions-Proxy mit TLS ohne Klartext-Fallback und Umleitung nur für die Oberfläche; HSTS-Header im Staging prüfen. |
| V12.2.2 | 1 | Öffentlich vertrauenswürdige Zertifikate erst mit dem Deployment | offen | Keine Produktionsvorlage mit TLS im Repo (Schritt 8.9 offen); der Proxy bedient nur :8080 ohne TLS (infra/docker/caddy/Caddyfile:8). Die Env-Regeln verlangen in Produktion https-URLs (apps/api/src/config/api-env.ts:94-103), ein Zertifikat stellt aber erst das Deployment. | Zertifikate einer öffentlichen CA für App- und Speicher-Host einrichten und ihren Ablauf überwachen; nur durch das Deployment erfüllbar. Schwere: mittel. Plan: Schritt 8.9 Deployment: Zertifikate per ACME (z.B. Caddy) für App- und Speicher-Host; Alarm zum Ablauf in Schritt 8.7 Betrieb. |

### V12.3

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V12.3.1 | 2 | Verschlüsselte Verbindungen zu allen Diensten, auch intern | teilweise | Extern über TLS: Stripe-SDK (STRIPE_API_BASE in Produktion abgelehnt, packages/billing/src/env.ts:31-37), Anthropic-SDK, Breach-Check nur mit https in Produktion (apps/api/src/config/api-env.ts:85-93), X nur über TLS-Tunnel (packages/x-browser/src/egress.ts:8-10, 39-43). SMTP in Produktion nur mit TLS: smtps oder Pflicht zu STARTTLS mit Zertifikatsprüfung (packages/emails/src/smtp-mailer.ts:18-20, apps/worker/src/infrastructure/notify.providers.ts:54-59; Test smtp-mailer.test.ts:65-70; Commit fa49fd0). | In Produktion weiter erlaubt: redis:// (api-env.ts:44, worker-env.ts:17, apps/browser-worker/src/env.ts:12), Postgres ohne sslmode (packages/db/src/env.ts:3), http für S3_ENDPOINT (packages/media/src/env.ts:13) und für OTEL_EXPORTER_OTLP_ENDPOINT (packages/observability/src/env.ts:10); lokal laufen DB, Redis und S3 im Klartext (compose.yaml:180-183, 219-226). Ob intern TLS nötig ist, entscheidet die Zielumgebung. Schwere: mittel. Plan: Schritt 8.9 Deployment: TLS zu DB, Redis, S3 und Telemetrie festlegen oder für ein privates Netz begründen; danach die Produktionsregeln um rediss://, sslmode=verify-full und https erweitern. |
| V12.3.2 | 2 | Zertifikatsprüfung nirgends abgeschaltet | erfüllt | Kein rejectUnauthorized:false, NODE_TLS_REJECT_UNAUTHORIZED, sslmode=no-verify oder ignoreHTTPSErrors im Repo; Node, ioredis, pg, nodemailer und Chromium prüfen standardmäßig | Beim Einführen von TLS für DB, Redis und SMTP verify-full beibehalten; kein Test. |
| V12.3.3 | 2 | Interne HTTP-Verbindungen ohne Transportverschlüsselung | offen | Interne HTTP-Verbindungen ohne TLS: Proxy zu api und web (infra/docker/caddy/Caddyfile:21, 40), web zu api über API_INTERNAL_URL http://api:3001 (compose.yaml:249), api und worker zu S3 (compose.yaml:183, 226), browser-worker über den Egress-Proxy zu S3 (compose.yaml:310-316). Zu X öffnet der Egress-Proxy nur TLS-Tunnel. | TLS oder ein Mesh mit mTLS für die internen HTTP-Verbindungen ist nicht festgelegt; das hängt an der Zielumgebung (eine VM oder ein Cluster) und ist nur durch das Deployment erfüllbar. Schwere: mittel. Plan: Schritt 8.9 Deployment: TLS oder Mesh mit mTLS für Proxy, web, api und Speicher passend zur Zielumgebung festlegen. |
| V12.3.4 | 2 | Kein Vertrauensanker für interne Zertifikate festgelegt | offen | Ohne internes TLS gibt es keine interne CA und keine Bindung an bestimmte Zertifikate; im Repo weder ca-Option noch NODE_EXTRA_CA_CERTS, aber auch keine Abschaltung der Zertifikatsprüfung (keine Treffer für rejectUnauthorized oder NODE_TLS_REJECT_UNAUTHORIZED). | Mit internem TLS (V12.3.3) je Verbindung nur der eigenen internen CA bzw. festgelegten Zertifikaten vertrauen, nicht zusätzlich dem öffentlichen Trust-Store. Schwere: niedrig. Plan: Schritt 8.9 Deployment: interne CA festlegen und je Client per ca-Option binden. |

## V13 Konfiguration

### V13.1

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V13.1.1 | 2 | Kommunikationsbeziehungen in Architektur und Env-Vorlage dokumentiert | erfüllt | Architektur 2: Proxy, web, api, worker, browser-worker, PostgreSQL, Redis, S3, Claude, Plattform-APIs, SMTP, Stripe; Sentry/OTel in 12; Egress in ADR 0030; Instagram-Abruf in .env.example:57 | Keine zentrale Matrix mit Protokoll, Port, TLS und Auth je Verbindung; web->api (API_INTERNAL_URL) fehlt im Diagramm. |

### V13.2

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V13.2.1 | 2 | Backend-Komponenten authentisieren sich ohne statische, geteilte Zugangsdaten | teilweise | Je DB-Rolle ein eigener Login mit scram-sha-256 (compose.yaml:37, infra/docker/postgres/init/01-roles.sql:14-16). Redis: Nutzer default aus (compose.yaml:68-70), API und Worker als app mit Passwort (compose.yaml:71-77, 182, 222), browser-worker mit eigenem ACL-Nutzer (83-97, 302), der Healthcheck als health ohne Passwort, aber nur mit PING (78-82, 105). Test: ohne Passwort NOAUTH, default mit beliebigem Passwort WRONGPASS, health nur PING (apps/browser-worker/test/redis-acl.integration.test.ts:174-197; Commit e97ba92). | Alle Zugangsdaten sind statische Passwörter bzw. Schlüssel ohne kurzlebige Tokens oder Zertifikate; api und worker teilen den Redis-Nutzer app, die DB-Rollen app_user und app_system (BYPASSRLS) und das S3-Schlüsselpaar mit Admin (infra/docker/seaweedfs/s3.json:7-11). Schwere: niedrig. Plan: Schritt 8.9 Deployment: eigene Identität je Dienst (auch getrennte Redis-Nutzer für api und worker) und, wo die Plattform es bietet, kurzlebige Zugangsdaten (z.B. IAM-Rollen für S3, Zertifikate für DB und Redis) aus dem Secret-Store. |
| V13.2.2 | 2 | Geringste Rechte für die Konten zwischen den Komponenten | teilweise | app_user ohne BYPASSRLS und nicht Owner, CONNECT nur für die Laufzeitrollen, Timeouts (infra/docker/postgres/init/01-roles.sql:14-18, 26-27, 31-34), REVOKE auf Append-only-Tabellen (z.B. packages/db/prisma/migrations/0002_rls_tenancy/migration.sql:105). Redis: Nutzer default aus, browser-worker nur mit den xb-Schlüsseln und ohne @dangerous (compose.yaml:83-97, packages/x-browser/src/protocol.ts:281; Tests redis-acl.integration.test.ts:82-84, 113-139), health nur PING. Container mit no-new-privileges, ohne Capabilities und read-only (compose.yaml:21-25), als non-root und ohne Paketmanager (infra/docker/node-app.Dockerfile:44-45, 51; apps/browser-worker/Dockerfile:41-42, 46; Commit adf7810). Seit a5dceea darf der Redis-Nutzer app keine Befehle aus @dangerous außer INFO (compose.yaml; Test redis-acl.integration.test.ts seit e7b5b68), seit 2db12ba bekommen API und Worker nur die Variablen, die sie lesen, also weder Superuser- noch Migrator-Passwort. | API und alle Worker-Rollen teilen den Redis-Nutzer app; API, Worker und s3-init teilen eine S3-Identität mit Admin-Rechten (infra/docker/seaweedfs/s3.json). Schwere: niedrig. Plan: Schritt 8.9: Identitäten je Dienst und Rolle in Redis, Datenbank und Objektspeicher (ADR 0039). |
| V13.2.3 | 2 | Keine Standard-Zugangsdaten für Dienste | erfüllt | compose.yaml verlangt alle Passwörter per ${...:?} (Zeilen 33, 38-40, 74, 86, 136-137, 180-182, 302); der Redis-Nutzer default ist aus (68-70). In Produktion lehnen API und Worker jeden Wert mit change-me ab, ohne den Wert zu nennen (packages/observability/src/env.ts:54-62; Tests api-env.test.ts:176-187, worker-env.test.ts:82-91, packages/observability/src/env.test.ts:46-64; Commit 5dffa88); der Demo-Seed verweigert Produktion (packages/db/src/seed.ts:8). Seit a399ff9 lehnt die Produktionsregel auch das Präfix smp-local- der S3-Beispielschlüssel ab (EXAMPLE_VALUES in packages/observability/src/env.ts; Test env.test.ts), und der browser-worker prüft seine Variablen, darunter XB_REDIS_PASSWORD, mit derselben Regel (apps/browser-worker/src/env.ts; Test env.test.ts). POSTGRES_PASSWORD und APP_MIGRATOR_PASSWORD bekommen API und Worker seit 2db12ba nicht mehr; sie gehören zum Datenbank-Container und zu den Migrationen. | Hinweis: Die Produktions-Vorlage aus Schritt 8.9 erzeugt alle Zugangsdaten, auch für Superuser und Migrator. |
| V13.2.4 | 2 | Egress-Allowlist nur für den browser-worker | teilweise | Der browser-worker hängt nur im internen Netz xb (compose.yaml:294, 356-360); Egress-Proxy und Browser-Kontext prüfen dieselbe Host-Liste (packages/x-browser/src/egress.ts:72-111, apps/egress-proxy/src/proxy.ts:59, 93, apps/browser-worker/src/browser-host.ts:76-84), ein unlesbarer Eintrag bricht den Start ab; Tests egress.test.ts und proxy.test.ts. API und Worker rufen nur konfigurierte Ziele auf, keine nutzergesteuerten URLs; der Plattform-Client folgt keinen Redirects (packages/platform-adapters/src/http/platform-http-client.ts:188). | Für api und worker gibt es keine durchgesetzte Allowlist auf App-, Proxy- oder Firewall-Ebene; beide hängen im Netz default mit freiem Internetzugang (compose.yaml:356-357). Schwere: niedrig. Plan: Schritt 8.9 Deployment: Egress von api und worker per Firewall oder Netzwerk-Policy auf DB, Redis, S3, SMTP, Stripe, Anthropic, Breach-Check, Telemetrie und Plattform-APIs begrenzen. |
| V13.2.5 | 2 | Server-Allowlist für ausgehende Anfragen nur im browser-worker | teilweise | Die Egress-Policy gilt im Egress-Proxy, der vor jedem Verbindungsaufbau mit 403 ablehnt (apps/egress-proxy/src/proxy.ts:59, 93), und im Browser-Kontext (apps/browser-worker/src/browser-host.ts:76-84); Einträge werden beim Start streng gelesen, ein unlesbarer bricht den Start ab (packages/x-browser/src/egress.ts:39-72, 120-132); Tests egress.test.ts und proxy.test.ts. | Für api und worker fehlt eine Allowlist auf Server-, Proxy- oder Netzebene. Schwere: niedrig. Plan: Schritt 8.9 Deployment: Allowlist für api und worker auf Netz- oder Proxy-Ebene festlegen, wie beim browser-worker. |

### V13.3

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V13.3.1 | 2 | Secrets in einem Secrets-Manager, nicht in Code oder Images | teilweise | .env ist ignoriert (.gitignore:21-24) und nicht im Build-Kontext (.dockerignore:14-17); gitleaks prüft die ganze Historie (.github/workflows/security.yml:76-95), Trivy jedes Image auch auf Secrets (.github/workflows/ci.yml:242-250; Commit 2a40b6a); Schlüssel aus 32 Zufallsbytes (tools/gen-keys.ts:6-27); das Runbook beschreibt Erzeugung, Rotation und Entfernung jedes Secrets (docs/runbooks/secret-rotation.md; Commits 9501f2a, 84065ba); KmsPort ist für ein KMS vorbereitet (packages/crypto/src/kms.ts:10-20). | Kein Secrets-Manager: alle Secrets als Umgebungsvariablen, nur LocalKeyring aus der Env (packages/crypto/src/local-keyring.ts:26) ohne Vault- oder KMS-Adapter; der Secret-Store folgt laut Runbook (Zeile 13) erst mit dem Deployment. Eingecheckt bleiben die lokalen S3-Schlüssel (infra/docker/seaweedfs/s3.json:7-8) und Testwerte (.env.test:10-15). Schwere: mittel. Plan: Schritt 8.9 Deployment: Secret-Store mit Zugriffskontrolle je Dienst, Audit und Vernichtung sowie ein KMS-Adapter für KmsPort. |
| V13.3.2 | 2 | Zugriff auf Secrets nach geringsten Rechten | teilweise | web, browser-worker und egress-proxy erhalten nur ausgewählte Variablen ohne env_file (compose.yaml:246-252, 300-318, 332-337); der browser-worker bekommt weder DB- noch S3-Zugangsdaten. Seit 2db12ba lädt compose.yaml für API und Worker kein env_file mehr, sondern reicht je Dienst nur die Variablen durch, die er liest (im Pentest-Profil geprüft: der API-Container hält kein Passwort der Datenbank außer dem seiner eigenen URL). Die Zuteilung der Schlüssel je Rolle steht in docs/security/kryptografie.md. | Im Compose-Profil hält der eine Container worker die Schlüssel aller Rollen aus WORKER_ROLES. Schwere: niedrig. Plan: Schritt 8.9: Rollen in eigenen Containern und Zuteilung je Dienst im Secret-Store (ADR 0039). |

### V13.4

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V13.4.1 | 1 | Kein .git im Build-Kontext und in den Images | erfüllt | .dockerignore schließt .git, .github, docs und .env aus (.dockerignore:11-15); Laufzeit-Stufen kopieren nur Build-Ausgaben (node-app.Dockerfile:45, web.Dockerfile:39-40) | Das Deployment (8.9) darf keinen Repository-Checkout ausliefern. |
| V13.4.2 | 2 | Debug-Funktionen in Produktion abgeschaltet | erfüllt | Images mit NODE_ENV=production; Swagger (bootstrap.ts:43-45) und DevModule (app.module.ts:71) nur außerhalb Produktion; Mock-KI und STRIPE_API_BASE in Produktion abgelehnt; Caddy admin off | LOG_LEVEL debug/trace wird in Produktion nicht abgewiesen; das Fehlen von /api/docs in Produktion ist nicht getestet. |
| V13.4.3 | 2 | Keine Verzeichnislisten in Proxy, Web und Speicher | erfüllt | Caddy nur reverse_proxy ohne file_server (Caddyfile:9-21); Next.js listet keine Verzeichnisse; SeaweedFS nur mit Identität smp-local, ohne anonyme Identität (s3.json:2-13) | Produktions-Bucket in 8.9 ohne öffentliches ListBucket konfigurieren. |
| V13.4.4 | 2 | TRACE wird von keinem Handler unterstützt | erfüllt | Keine TRACE-Routen; server.all (bootstrap.ts:34) reicht TRACE an Better Auth, dort scheitert new Request, da Fetch TRACE verbietet; kein Echo der Anfrage | Der Proxy filtert TRACE nicht; in 8.9 TRACE am Proxy mit 405 abweisen; kein Test. |
| V13.4.5 | 2 | API-Doku nur außerhalb Produktion, Monitoring intern | erfüllt | Swagger nur bei NODE_ENV!=production (bootstrap.ts:43-45); Worker-/metrics auf eigenem Health-Port (health.server.ts:61), compose bindet an 127.0.0.1; Health meldet nur up/down | /api/health/ready ist öffentlich über den Proxy und ohne Rate-Limit; Port 3002 mit /metrics muss in 8.9 intern bleiben. |

## V14 Datenschutz

### V14.1

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V14.1.1 | 2 | Sensible Daten identifiziert und in Schutzstufen klassifiziert | erfüllt | docs/security/daten-und-protokolle.md: vier Schutzstufen und ein Inventar von 20 Datenarten mit Feldern, Stufe und Schutzmaßnahmen, dazu die nur kodierten Werte. |  |
| V14.1.2 | 2 | Schutzanforderungen je Schutzstufe dokumentiert | erfüllt | docs/security/daten-und-protokolle.md: Schutzanforderungen je Stufe für Ruhezustand, Übertragung, Integrität, Zugriff, Aufbewahrung, Logs und Datenschutz, dazu die Regeln für Caches; die Client-Adresse in Sicherheitsereignissen ist dort und in ADR 0039 begründet. |  |

### V14.2

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V14.2.1 | 1 | Sensible Daten nur in Body oder Header, nicht in URL und Query | erfüllt | Session nur im httpOnly-Cookie; Einladungs-Token und Passwörter im Body (apps/api/src/modules/tenancy/invitations.controller.ts:34-35 und 60-66, apps/web/src/lib/server/api.ts:163-170); seit 4780f26 tragen alle Formulare method="post", eine Lint-Regel erzwingt das (packages/config/eslint.config.js:112-120); Request-Zeilen ohne Query (apps/api/src/common/logging/http-log-serializers.ts:16-21, Test apps/api/src/common/logging/http-logging.test.ts:12-48); Server-Spans ohne Query, Client-Adresse und User-Agent, Reset-Pfad maskiert (packages/observability/src/span-privacy.ts:10-37, Test span-privacy.test.ts:15-33); der Verifizierungslink meldet nicht an (apps/api/src/modules/identity/auth.ts:116), Reset-Token liegen nur als Hash in der Datenbank (auth.ts:134). Seit 071ac4c maskieren Request-Zeilen und Sicherheitsereignisse den Token des Reset-Links (privatePath; Tests http-log-serializers.test.ts, http-logging.test.ts), seit 48a8ccd säubert ein Span-Prozessor url.full, http.url und http.target jedes Spans (Test span-privacy.test.ts). |  |
| V14.2.2 | 2 | Kein Caching sensibler Daten in Serverkomponenten oder sicheres Löschen | erfüllt | Jede API-Antwort trägt Cache-Control: no-store (apps/api/src/bootstrap.ts:34, apps/api/src/common/security/body-limits.middleware.ts:98-101, Test body-limits.middleware.test.ts:113-120), also speichern weder Load Balancer noch CDN. Redis: OAuth-State per GETDEL, Zugriffs-Cache nur mit Rolle (60 s), E-Mails der notify-Jobs mit dem Token-Keyring versiegelt (packages/queue/src/notifications.ts:50-57 und 154-158; 0eb445b, 84065ba), erledigte Jobs sofort, fehlgeschlagene nach einem Tag gelöscht (notifications.ts:88-93), Redis ohne Default-Nutzer mit eigenen ACL-Nutzern (compose.yaml:62-97; e97ba92); der Next-Server holt mit cache: 'no-store' (apps/web/src/lib/server/api.ts:51-60). Test: apps/worker/test/notify.integration.test.ts:216 (Job-Hash ohne Adresse und Link). Seit 2f66782 wirft der SMTP-Mailer statt des Fehlers von nodemailer einen SmtpDeliveryError mit Code, Befehl und Antwortcode, ohne Adresse und ohne die Antwort des Servers (packages/emails/src/smtp-mailer.ts; Tests smtp-mailer.test.ts und apps/worker/test/notify.integration.test.ts mit einem Server, der Empfänger ablehnt). |  |
| V14.2.3 | 2 | Keine Tracker, Drittanbieter nur als Auftragsverarbeiter | erfüllt | Web ohne Analytics-Pakete (apps/web/package.json), CSP connect-src 'self' plus Speicher; Sentry dataCollection aus (sentry.ts:42); Better-Auth-Telemetrie aus (auth.ts:105); Unterauftragsverarbeiter in ARCH §10. |  |
| V14.2.4 | 2 | Schutzmaßnahmen wie für die Schutzstufe dokumentiert umgesetzt | teilweise | Die dokumentierten Einzelmaßnahmen sind umgesetzt und getestet: Envelope-Verschlüsselung (packages/crypto, envelope.test.ts), versiegelte notify-E-Mails (0eb445b, 84065ba; apps/worker/test/notify.integration.test.ts:216-282), Fristenjobs (retention.integration.test.ts), Fehler per Allowlist und Redaction auch in snake_case (0760387; packages/observability/src/redact.ts:4-35 und 60-81, redact.test.ts:40-88, logger.test.ts:47-65), Spans ohne Query, IP und User-Agent (f26046b; span-privacy.ts:25-37), Export ohne Geheimnisse (gdpr-export.integration.test.ts). Die Abweichungen der Bewertung sind behoben: Reset-Token in Request-Zeilen (071ac4c), url.full mit Query in Spans (48a8ccd), SMTP-Antworten in failedReason (2f66782). Die Schutzstufen beschreibt docs/security/daten-und-protokolle.md. | Zugriffsschutz und Frist der Logs hängen am Log-Backend, das es noch nicht gibt. Schwere: niedrig. Plan: Schritt 8.9: Log-Backend mit Zugriffsschutz und 30 Tagen (ADR 0039). |

### V14.3

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V14.3.1 | 1 | Authentifizierte Daten im Client nach Ende der Sitzung gelöscht | erfüllt | Der Sign-out antwortet mit Clear-Site-Data: "cache", "storage" (apps/api/src/modules/identity/auth-hooks.ts:254-257, Test apps/api/test/auth.integration.test.ts:318-339); useSignOut leert den TanStack-Query-Cache vor der Navigation (apps/web/src/lib/use-sign-out.ts:14-26), genutzt in App-Shell, Onboarding und Sicherheitsseite (952a2f6); localStorage hält nur ein UI-Flag (apps/web/src/lib/use-stored-flag.ts), der QueryClient hat keine Persistenz (apps/web/src/app/providers.tsx:9-14). Seit c5f8307 leert die Web-App ihre gecachten Abfragen auch, wenn die API beim Abmelden nicht erreichbar ist, und bei jeder Anmeldung, bevor das neue Konto lädt (use-sign-out.ts, login-form.tsx). Endet eine Session auf dem Server, bleiben die Daten des Kontos bis zur nächsten Anmeldung nur im Speicher dieses Tabs. |  |
| V14.3.2 | 2 | Ausreichende Anti-Caching-Header (Cache-Control: no-store) | erfüllt | Die globale Middleware noStore setzt Cache-Control: no-store für jede Antwort der API einschließlich /api/auth (apps/api/src/bootstrap.ts:34 vor dem Auth-Handler in 43-50; apps/api/src/common/security/body-limits.middleware.ts:98-101; Test body-limits.middleware.test.ts:113-120; ac6568b), der CSV-Export zusätzlich (apps/api/src/modules/analytics/analytics.controller.ts:118). Alle Seiten des Web rendern dynamisch (getLocale im Root-Layout, Nonce in apps/web/src/proxy.ts), Next.js sendet dafür 'private, no-cache, no-store'. Die beiden SSE-Endpunkte setzen 'no-cache, no-transform' (apps/api/src/modules/live/live-events.controller.ts:89, apps/api/src/modules/content/sse.ts:29): Der Live-Stream trägt nur IDs und Status (packages/queue/src/live-events.ts:13-34), der KI-Stream ist eine POST-Antwort ohne Freshness und damit nicht cachebar. |  |
| V14.3.3 | 2 | Browser-Speicher enthält nur Sidebar-Flag und Sprache | erfüllt | localStorage nur 'smp.sidebar-collapsed' (use-stored-flag.ts, app-shell.tsx:163), Cookie nur Sprache (locale-cookie.ts); kein sessionStorage oder IndexedDB; Session-Cookie httpOnly. |  |

## V15 Sichere Programmierung und Architektur

### V15.1

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V15.1.1 | 1 | Risikobasierte Behebungsfristen für Drittkomponenten dokumentiert | erfüllt | ADR 0039, Abschnitt Schwere und Fristen: Fristen je Schwere ab Bekanntwerden (kritisch 24 Stunden, hoch 7 Tage, mittel 30 Tage, niedrig 90 Tage), für Abhängigkeiten ab dem verfügbaren Fix; CI hält kritische und hohe Lücken mit pnpm audit und Trivy auf; allgemeine Updates mit Renovate nach drei Tagen; Ausnahmen mit Datum der Wiedervorlage. |  |
| V15.1.2 | 2 | Inventar (SBOM) der Drittkomponenten aus vertrauenswürdigen, gepflegten Quellen | teilweise | pnpm-lock.yaml als exaktes Inventar; Herkunft über blockExoticSubdeps, trustPolicy no-downgrade, minimumReleaseAge und strictDepBuilds (pnpm-workspace.yaml:9-22); seit 2a40b6a je Image ein CycloneDX-SBOM aus Trivy als CI-Artefakt für 90 Tage (.github/workflows/ci.yml:234-241), das Betriebssystem- und npm-Pakete der Runtime abdeckt; Basis-Images auf exakte Tags gepinnt (infra/docker/node-app.Dockerfile:13, infra/docker/web.Dockerfile:11, apps/browser-worker/Dockerfile:12 und 38). | SBOMs liegen nur 90 Tage als Artefakt und gehören zu keinem ausgelieferten Release; für die Fremd-Images aus compose.yaml (postgres, redis, caddy, seaweedfs) gibt es keine. Digests sind weder in den Dockerfiles noch in compose.yaml gepinnt, obwohl ADR 0009:35 das Renovate zuschreibt (docker:pinDigests hat noch nicht gegriffen). Es fehlen eine Liste der zugelassenen Quellen und ein Kriterium für 'gepflegt'; ungepflegte Pakete fallen nicht auf (z.B. twitter-text 3.1.0 mit core-js 2.6.12). Schwere: niedrig. Plan: Schritt 8.9: SBOM je Release in der Registry und Digests der Images (ADR 0039). |
| V15.1.3 | 2 | Zeit- und ressourcenintensive Funktionen mit Schutzmaßnahmen dokumentiert | erfüllt | docs/security/autorisierung-und-grenzen.md, Teure Funktionen: jede Funktion mit Kosten oder Risiko, Grenze mit Ort im Code und Antwort, dazu die Limits der Tarife und lange Antworten; die Werte der eingehenden Limits begründet ADR 0039. |  |

### V15.2

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V15.2.1 | 1 | Keine Komponente über den dokumentierten Behebungsfristen | teilweise | pnpm audit am 2026-10-18 auf HEAD ea6a3ca: kein offener Fund, zwei hohe begründet ignoriert (GHSA-ggr8-5vv4-36mx, GHSA-vfj7-8cjw-p6xm; pnpm-workspace.yaml:31-38). Seit adf7810 laufen die Images auf node:24.21.0-trixie-slim ohne npm, corepack und yarn; der Job images scannt alle fünf Images und scheitert an fixbaren HIGH- und CRITICAL-Funden (.github/workflows/ci.yml:176-250; 2a40b6a), laut ADR 0009:35-40 lokal ohne Befund. Seit dem Ende von Schritt 8.4 stehen die Fristen in ADR 0039, die Ausnahmen haben eine Wiedervorlage (Advisories spätestens 2027-01-16, der übersprungene npm-Cache des Playwright-Images bis zu dessen nächstem Update), und seit 00d7fa3 läuft CI mit dem Image-Scan auch wöchentlich. | Mittlere und niedrige Funde der Image-Scans und die Fremd-Images aus compose.yaml (postgres, redis, caddy, seaweedfs, mailpit) werden nicht bewertet. Schwere: niedrig. Plan: Schritt 8.9: Scan der Fremd-Images der Produktions-Vorlage (ADR 0039). |
| V15.2.2 | 2 | Schutz gegen Verfügbarkeitsverlust durch aufwendige Funktionen umgesetzt | erfüllt | Eingangslimits mit @nestjs/throttler in Redis je Client-Adresse vor der Session, je Konto und je Route (apps/api/src/common/throttling/throttling.ts:38-42 und 119-158; b4e8793), Test apps/api/test/rate-limits.integration.test.ts:39-86. Teure Routen mit @LimitPerUser (648cd4a), z.B. Einladungen 30/h und erneut senden 10/h (apps/api/src/modules/tenancy/organization.controller.ts:182 und 199), Export 5/Tag (apps/api/src/modules/gdpr/data-exports.controller.ts:51), Upload-Tickets 300/h (apps/api/src/modules/media/media.controller.ts:68). Höchstens 10 Live-Streams je Konto über alle Prozesse (apps/api/src/modules/live/live-stream-slots.ts:21, live-events.controller.ts:61-67; c09170a), Test apps/api/test/live-events.integration.test.ts:210-217. KI 10/min, 2 parallel, 60/h je Workspace (apps/api/src/modules/content/ai-rate-limiter.ts:18-22); Auth-Mails 5 je Adresse und Stunde (apps/api/src/modules/identity/auth-mailer.ts:17 und 58-64); Body 1 MB bzw. 64 KB für /api/auth (apps/api/src/bootstrap.ts:43-54, infra/docker/caddy/Caddyfile:18-20); statement_timeout (ADR 0009:46); ausgehende Timeouts (packages/platform-adapters/src/http/platform-http-client.ts:176 mit 30 s, Anthropic 120 s, Stripe 20 s, Breach-Check 3 s). |  |
| V15.2.3 | 2 | Test- und Entwicklungsfunktionen in Produktion abgeschaltet | erfüllt | Swagger nur außerhalb Produktion (bootstrap.ts:43), DevModule ausgeschlossen (app.module.ts:71); Mock-KI, Mock-Adapter und STRIPE_API_BASE in Produktion verweigert (Tests); pnpm deploy --prod. |  |

### V15.3

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V15.3.1 | 1 | Antworten laufen durch zod-DTOs, interne Felder entfallen | erfüllt | ZodSerializerInterceptor global (bootstrap.ts:41), @ZodResponse an allen Routen mit Body, zod entfernt Fremdfelder; Test: /api/me ohne isPlatformAdmin (auth.integration.test.ts:74). |  |
| V15.3.2 | 2 | Ausgehende HTTP-Aufrufe folgen keinen Weiterleitungen | erfüllt | PlatformHttpClient mit redirect:'error' (platform-http-client.ts:188); Medienabruf im browser-worker redirect:'error' mit Test (media.ts:33, media.test.ts:65); keine Abrufe nutzergesteuerter URLs. |  |
| V15.3.3 | 2 | Erlaubte Felder je Aktion per zod-Schema festgelegt | erfüllt | Eigenes Schema je Aktion (z.B. updatePostSchema, updateVariantSchema in contracts/src/content.ts), Fremdfelder entfernt; isPlatformAdmin input:false, Test auth.integration.test.ts:93. |  |
| V15.3.4 | 2 | Originale Client-IP über vertrauenswürdige Felder für Logs und Limits | teilweise | Caddy überschreibt X-Real-IP und entfernt Forwarded für API und Web (infra/docker/caddy/Caddyfile:26, 29, 43 und 44; f26046b, fc22333); der Next-Server reicht X-Real-IP an die API weiter (apps/web/src/lib/server/api.ts:50-57; d04546f); Throttler, security.* und Better Auth lesen X-Real-IP (apps/api/src/common/throttling/throttling.ts:59-63, apps/api/src/modules/identity/auth.ts:153, auth-hooks.ts:266); Spans verwerfen client.address und network.peer.address (packages/observability/src/span-privacy.ts:25-31). Tests setzen X-Real-IP (apps/api/test/rate-limits.integration.test.ts:39-57, apps/api/test/security-events.integration.test.ts:38-69). | API und Web vertrauen X-Real-IP jeder Gegenstelle (throttling.ts:60-61, apps/web/src/lib/server/api.ts:50); das trägt nur, solange ausschließlich Caddy beide erreicht, lokal über die Bindung an 127.0.0.1, in Produktion offen. Das Audit-Log nimmt dagegen req.ip über X-Forwarded-For und trust proxy 1 (apps/api/src/common/cls/request-context.module.ts:25, apps/api/src/bootstrap.ts:27). Mit einem vorgeschalteten Load Balancer liefern beide Quellen dessen Adresse, solange trusted_proxies und {client_ip} in Caddy fehlen; die Produktions-Proxykette ist nicht festgelegt. Schwere: niedrig. Plan: Schritt 8.9 Deployment. |
| V15.3.5 | 2 | Strikte Typen durch TypeScript, ESLint und zod | erfüllt | TS strict, typescript-eslint strictTypeChecked (packages/config/eslint.config.js), zod mit z.coerce für Query-Zahlen; im Code nur === bzw. zwei bewusste '!= null'. |  |
| V15.3.6 | 2 | Keine Prototype-Pollution-Pfade für Nutzereingaben gefunden | erfüllt | zod 4.6.7 übernimmt __proto__ nicht (v4/core/schemas.js:970), kein Deep-Merge von Eingaben, Object.fromEntries für Query (use-search-state.ts:18), Set/Map für Nachschlagen (redact.ts). |  |
| V15.3.7 | 2 | Quellen getrennt, doppelte Parameter scheitern an zod | erfüllt | Express 5 mit Query-Parser 'simple', Nest trennt @Body/@Query/@Param; zod erwartet Skalare, Arrays aus doppelten Parametern ergeben 400 bzw. STATE_INVALID (oauth-callback.controller.ts). |  |

## V16 Sicherheitslogging und Fehlerbehandlung

### V16.1

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V16.1.1 | 2 | Inventar des Loggings je Schicht mit Format, Ablage, Zugriff und Frist | erfüllt | docs/security/daten-und-protokolle.md, Logging-Inventar: je Komponente Ereignisse und Felder, Format, Schwärzung, Traces, Fehlerberichte, Verwendung, Ort und Zugriff sowie Fristen. | Hinweis: Fristen für Traces und Fehlerberichte und den Zugriffsschutz legt das Log-Backend aus Schritt 8.9 fest. |

### V16.2

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V16.2.1 | 2 | Jeder Logeintrag mit Metadaten zu wann, wo, wer und was | erfüllt | Jede Zeile trägt time (ISO 8601, UTC), service, env, das Ereignis als msg, requestId und traceId (packages/observability/src/logger.ts:17-24); die API ergänzt userId nach der Session sowie organizationId und workspaceId nach dem Mandanten (apps/api/src/modules/identity/auth.guard.ts:47, apps/api/src/common/guards/workspace.guard.ts:51-54, packages/observability/src/log-context.ts:24-31; 896f988, 8ad8688; Test logger.test.ts:80-95). Jede Anfrage hat eine eigene ID, eine Client-ID steht getrennt als clientRequestId (apps/api/src/common/request-id.middleware.ts:16-26; 4f4d276; Test request-id.middleware.test.ts:26-47). /api/auth hat eine Request-Zeile (apps/api/src/bootstrap.ts:44-49; 5edaf6e; Test http-logging.test.ts:12-48); security.* nennt Methode, Route, Client-Adresse, Rolle und Mandant (security-events.ts:54-63, problem-details.filter.ts:102-116). Seit Schritt 8.7 läuft jeder Job in Worker und browser-worker in seinem Log-Kontext mit jobId, queue, job und, wo die Payload sie als UUID nennt, organizationId und workspaceId, auch in den Zeilen der Use Cases und Adapter (packages/observability/src/job-context.ts, apps/worker/src/job-log-context.ts mit @JobLogContext() an allen neun Prozessoren, apps/browser-worker/src/main.ts; Test apps/worker/src/job-log-context.test.ts; 43dfd6e). Die Web-App schreibt Serverfehler als JSON-Zeile mit time und der requestId, die der Proxy jeder Seitenanfrage gibt (apps/web/src/instrumentation.ts, apps/web/src/proxy.ts; 1306f89). |  |
| V16.2.2 | 2 | Synchronisierte Zeitquellen und Zeitstempel in UTC | teilweise | pino.stdTimeFunctions.isoTime schreibt ISO 8601 mit Z (packages/observability/src/logger.ts:20, Test logger.test.ts:22-31); Zeitpunkte in der Datenbank als timestamptz (audit_log.created_at); Backend und Datenbank in UTC (Leitfaden B.1). | Die Zeitsynchronisation (NTP bzw. chrony) der Hosts, Container und des künftigen Log-Backends ist weder dokumentiert noch konfiguriert; die Ausgaben von Next.js tragen keinen eigenen Zeitstempel und bekommen ihn nur vom Docker-Log-Treiber. Schwere: niedrig. Plan: Schritt 8.9 Deployment. |
| V16.2.3 | 2 | Logs nur an dokumentierte Dateien und Dienste | erfüllt | Im Code: pino auf stdout (packages/observability/src/logger.ts:15-31), optional Sentry (packages/observability/src/sentry.ts:69-76) und OTLP-Traces (packages/observability/src/otel.ts:43-56), audit_log in Postgres; Request-Logs und Sentry beschreibt ADR 0009:21-26, Traces docs/ARCHITECTURE.md:631. Seit 48a8ccd gehen über OTLP nur Traces (disableLogSending, keine Log-Prozessoren in otel.ts); alle Ziele der Logs stehen im Logging-Inventar von docs/security/daten-und-protokolle.md. |  |
| V16.2.4 | 2 | Logs vom eingesetzten Log-Prozessor les- und korrelierbar | teilweise | API, Worker, browser-worker und Egress-Proxy schreiben über createLogger pino-JSON mit denselben Basisfeldern (apps/api/src/app.module.ts:34, apps/worker/src/worker.module.ts:135, apps/browser-worker/src/main.ts:33, apps/egress-proxy/src/main.ts:10; packages/observability/src/logger.ts:15-31); korreliert wird über requestId, traceId, userId, organizationId und workspaceId. Seit Schritt 8.7 schreibt auch das Web JSON-Zeilen mit denselben Basisfeldern (apps/web/src/lib/server/log.ts; 1306f89) und gibt seine requestId an die API weiter, die sie als clientRequestId loggt; im Worker ist jobId durchgängig (43dfd6e). | Log-Prozessor und Parser sind nicht festgelegt; die eigenen Meldungen von Next.js bleiben Text auf stderr, der digest verbindet sie mit request.failed. Schwere: niedrig. Plan: Log-Prozessor mit Schritt 8.9 (ADR 0039). |
| V16.2.5 | 2 | Logging sensibler Daten gemäß ihrer Schutzstufe erzwungen | erfüllt | Schlüssel-Redaction in jeder Tiefe unabhängig von der Schreibweise, auch access_token oder client_secret (packages/observability/src/redact.ts:4-35, Test redact.test.ts:40-52); Fehler nur mit type, message, stack, Codes und Ursachen, Adressen und URL-Querys in Texten ersetzt (redact.ts:45-81; 0760387; Tests redact.test.ts:65-112, logger.test.ts:47-65); Request-Zeile ohne Header, Query und IP (apps/api/src/common/logging/http-log-serializers.ts:16-22); auth.event mit Digest statt E-Mail-Adresse (apps/api/src/modules/identity/auth-hooks.ts:76-77 und 259-269); security.* ohne Body, Werte auf 200 Zeichen gekürzt (security-events.ts:7-12 und 40-45); Sentry ohne Nutzerdaten, Bodies und Query (packages/observability/src/sentry.ts:42-56). Seit 071ac4c ist der Token des Reset-Links in Request-Zeilen und im Feld route der Sicherheitsereignisse maskiert (Tests http-log-serializers.test.ts, http-logging.test.ts). Die Regeln je Schutzstufe und die Entscheidung zur Client-Adresse stehen in docs/security/daten-und-protokolle.md und ADR 0039. | Hinweis: Die Schlüsselliste der Schwärzung kennt weder sessionToken noch code_verifier oder state; kein Log-Aufruf schreibt sie heute. |

### V16.3

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V16.3.1 | 2 | Alle Authentifizierungsvorgänge mit Erfolg und Misserfolg geloggt | erfüllt | Der after-Hook schreibt auth.event mit path (Verfahren und Faktor, z.B. /sign-in/email, /two-factor/verify-totp, /two-factor/verify-backup-code), outcome (ok, failed, second_factor_required), Fehlercode, userId bzw. Digest der Adresse und Client-Adresse für Anmeldung, Registrierung, Abmeldung, Verifizierung, Reset, Passwortwechsel, Änderungen des zweiten Faktors und Widerruf von Sitzungen (apps/api/src/modules/identity/auth-hooks.ts:36-67 und 220-269; 0e6ae01); gesperrte Konten und wiederverwendete Codes ebenfalls (auth-hooks.ts:154, 191, 199); 429 von Better Auth als security.rate_limited (apps/api/src/common/logging/security-events.ts:69-78, Test apps/api/test/security-events.integration.test.ts:149-187); Request-Zeile für /api/auth (5edaf6e). Seit Schritt 8.7 prüft apps/api/test/auth-events.integration.test.ts die Folge von Registrierung, falschem und gültigem Bestätigungslink, falschem und richtigem Passwort und Abmeldung; der Test fand zwei Fehler: Eine gültige Bestätigung erschien als failed mit FOUND, und der Abmeldung fehlte userId (871c931). Falsche Passwörter bei PasswordCheck sind security.password_rejected, /verify-password steht in den Pfaden des Hooks (8ba9af4; Test x-browser.integration.test.ts). |  |
| V16.3.2 | 2 | Fehlgeschlagene Autorisierungsversuche geloggt | erfüllt | Der ProblemDetailsFilter loggt NOT_PERMITTED und INVITATION_EMAIL_MISMATCH als security.permission_denied mit Rolle und Mandant, WORKSPACE_NOT_FOUND und ORGANIZATION_NOT_FOUND als security.tenant_denied und TWO_FACTOR_REQUIRED als eigenes Ereignis (apps/api/src/common/filters/problem-details.filter.ts:44-52, 93-96 und 102-116; 7ae9303). Das handelnde Konto und der Mandant kommen aus dem Log-Kontext (apps/api/src/modules/identity/auth.guard.ts:47, apps/api/src/common/guards/workspace.guard.ts:51-54); auch der PlatformAdminGuard wirft NotPermittedError (platform-admin.guard.ts:15); Origin-Abweisungen erscheinen als security.origin_rejected (apps/api/src/common/security/origin-check.middleware.ts:26). Tests: apps/api/test/security-events.integration.test.ts:73-131, problem-details.filter.test.ts:149-201. |  |
| V16.3.3 | 2 | Dokumentierte Sicherheitsereignisse und Umgehungsversuche geloggt | erfüllt | Katalog SECURITY_EVENTS mit zehn Ereignissen (apps/api/src/common/logging/security-events.ts:14-35): origin_rejected, body_rejected (4cb9a37), validation_failed (nur Pfad und Code der Felder), tenant_denied, permission_denied, two_factor_required, rate_limited (jede 429, auch von Better Auth), webhook_rejected, oauth_rejected und redirect_rejected (ea6a3ca; apps/api/src/modules/identity/auth.ts:44-46 und 167-183, Wert auf 200 Zeichen gekürzt, Level warn). Dazu auth.event, Abweisungen des Egress-Proxys und ungültige Job-Payloads. Tests: apps/api/test/security-events.integration.test.ts:38-187, problem-details.filter.test.ts:149-201, body-limits.middleware.test.ts, origin-check.middleware.test.ts. Der Katalog mit Auslöser, Feldern und Pegel jedes Ereignisses, auch auth.event mit seinen outcome-Werten, steht in docs/security/daten-und-protokolle.md. |  |
| V16.3.4 | 2 | Unerwartete Fehler und Ausfälle von Sicherheitskontrollen geloggt | teilweise | 5xx mit Fehlerobjekt als request.failed (apps/api/src/common/filters/problem-details.filter.ts:90-92, Test problem-details.filter.test.ts:104-122); Jobfehler je Prozessor (apps/worker/src/processors/notify.processor.ts:111-114, publish.job_failed in apps/worker/src/publisher/publish-worker.ts, scheduler.tick_failed); Ausfall des Breach-Checks als auth.breach_check_unavailable (apps/api/src/modules/identity/breached-passwords.ts:47-60); nicht lesbare Umschläge als notify.unreadable_email bzw. notify.unknown_key (notify.processor.ts:89-108); Fehler von Better Auth ab 500 als auth.error (auth.ts:160-166); SMTP in Produktion nur mit TLS (packages/emails/src/smtp-mailer.ts:9-20; fa49fd0); TRACE und andere Methoden beantwortet Caddy mit 405, Next.js schreibt dafür keinen Stacktrace mehr (infra/docker/caddy/Caddyfile:11-15 und 34-35; 4e5de79). Seit Schritt 8.7 nennen Plattform-Client und KI-Adapter den Code der Ursache, etwa CERT_HAS_EXPIRED oder ECONNRESET, und Zertifikatsfehler zählen als nicht gesendet (packages/platform-adapters/src/http/platform-http-client.ts, packages/ai/src/anthropic/map-result.ts; 7b4f5d5); das Web loggt Serverfehler über onRequestError als request.failed mit dem Code der Ursache (1306f89). | Postgres und Redis erzwingen kein TLS (apps/api/src/config/api-env.ts:44, kein sslmode). Schwere: niedrig. Plan: Schritt 8.9 Deployment (ADR 0039). |

### V16.4

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V16.4.1 | 2 | JSON-Logs von pino verhindern Log-Injection | erfüllt | pino schreibt jede Zeile als JSON, Strings mit Steuerzeichen werden escaped; Ereignisnamen konstant; Request-ID nur mit /^[A-Za-z0-9._-]{8,128}$/ (request-id.middleware.ts:6). |  |
| V16.4.2 | 2 | Logs vor unbefugtem Zugriff und Veränderung geschützt | teilweise | audit_log darf app_user nur einfügen und lesen (packages/db/prisma/migrations/0002_rls_tenancy/migration.sql:101-105 mit REVOKE UPDATE, DELETE), Test packages/db/test/rls.integration.test.ts:262-265; Lesen nur mit audit.read für Owner und Admin (apps/api/src/modules/audit/audit.controller.ts:23); Änderungen durch app_system nur für Fristen und Löschung (ADR 0037, ADR 0038). | Anwendungslogs liegen nur auf stdout bzw. im Docker-Log des Hosts; Zugriffsschutz, Unveränderlichkeit und Frist eines Log-Backends sind nicht festgelegt, und für Traces, Sentry und den OTLP-Collector fehlen Zugriffsregeln. Schwere: mittel. Plan: Schritt 8.9 Deployment. |
| V16.4.3 | 2 | Logs sicher an ein logisch getrenntes System übertragen | offen | Nur Fehlerereignisse gehen optional an Sentry (packages/observability/src/sentry.ts:69-76) und Traces an OTLP (packages/observability/src/otel.ts:43-56). Bei gesetztem Endpunkt sendet das NodeSDK zwar auch die pino-Zeilen per OTLP, das ist aber weder bewusst konfiguriert noch dokumentiert, und der Endpunkt darf http sein (packages/observability/src/env.ts:10). | Es gibt kein logisch getrenntes, schreibgeschütztes Log-Backend mit TLS-Übertragung, Auswertung, Erkennung, Alarmierung und Eskalation; bei einer Kompromittierung des Hosts sind die Logs nicht geschützt. Schwere: mittel. Seit Schritt 8.7 gibt es Alarme auf Sicherheitsereignisse und fehlgeschlagene Anmeldungen, als Metriken der API mit Mail über Alertmanager (`SecurityEventsSpike`, `SignInFailuresSpike`, ADR 0043); die Logs selbst gehen noch an kein getrenntes System. Plan: Schritt 8.9 Deployment. |

### V16.5

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V16.5.1 | 2 | Generische Problem-Dokumente ohne Stacktraces | erfüllt | ProblemDetailsFilter: 5xx stets generisch, auch bei HttpException, Validierung ohne Details (problem-details.filter.test.ts:85/96/124); Health ohne Treibertexte; Web zeigt übersetzte Codes. |  |
| V16.5.2 | 2 | Rückfallebenen bei Ausfall von Redis, Plattformen und KI | erfüllt | Caches fallen auf DB zurück (access-cache.ts:38-41, analytics.service.ts:315), 30-s-Timeouts und Backoff für Plattformen, Circuit Breaker und Kill-Switch für X (ADR 0032), KI-Fallback (ADR 0015). |  |
| V16.5.3 | 2 | Fehler führen zur Ablehnung, nicht zum Durchlass | erfüllt | Deny by default mit Startabbruch (route-access.check.ts:46-48), zod für Eingaben und Jobs (UnrecoverableError), Env-Prüfung beim Start, nur gewährter Zugriff gecacht, Redis-Fehler im KI-Limit ergeben 5xx. |  |

## V17 WebRTC

### V17.1

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V17.1.1 | 2 | Kein TURN-Dienst, WebRTC wird nicht genutzt | nicht anwendbar | Keine RTCPeerConnection, kein TURN/STUN, kein Medien- oder Signaling-Server in Code und compose.yaml; Permissions-Policy sperrt Kamera und Mikrofon (content-security-policy.ts:82). |  |

### V17.2

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V17.2.1 | 2 | Kein Medienserver, keine DTLS-Zertifikate | nicht anwendbar | Keine RTCPeerConnection, kein TURN/STUN, kein Medien- oder Signaling-Server in Code und compose.yaml; Permissions-Policy sperrt Kamera und Mikrofon (content-security-policy.ts:82). |  |
| V17.2.2 | 2 | Kein Medienserver, kein DTLS-SRTP | nicht anwendbar | Keine RTCPeerConnection, kein TURN/STUN, kein Medien- oder Signaling-Server in Code und compose.yaml; Permissions-Policy sperrt Kamera und Mikrofon (content-security-policy.ts:82). |  |
| V17.2.3 | 2 | Kein Medienserver, keine SRTP-Authentifizierung nötig | nicht anwendbar | Keine RTCPeerConnection, kein TURN/STUN, kein Medien- oder Signaling-Server in Code und compose.yaml; Permissions-Policy sperrt Kamera und Mikrofon (content-security-policy.ts:82). |  |
| V17.2.4 | 2 | Kein Medienserver, keine SRTP-Pakete | nicht anwendbar | Keine RTCPeerConnection, kein TURN/STUN, kein Medien- oder Signaling-Server in Code und compose.yaml; Permissions-Policy sperrt Kamera und Mikrofon (content-security-policy.ts:82). |  |

### V17.3

| ID | L | Anforderung | Status | Nachweis | Lücke und Plan |
| --- | --- | --- | --- | --- | --- |
| V17.3.1 | 2 | Kein Signaling-Server vorhanden | nicht anwendbar | Keine RTCPeerConnection, kein TURN/STUN, kein Medien- oder Signaling-Server in Code und compose.yaml; SSE dient nur Live-Events und KI-Streams, nicht WebRTC. |  |
| V17.3.2 | 2 | Kein Signaling-Server vorhanden | nicht anwendbar | Keine RTCPeerConnection, kein TURN/STUN, kein Medien- oder Signaling-Server in Code und compose.yaml; SSE dient nur Live-Events und KI-Streams, nicht WebRTC. |  |
