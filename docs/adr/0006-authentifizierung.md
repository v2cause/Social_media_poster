# ADR 0006: Authentifizierung

- **Status**: Akzeptiert. Spike (d) ist mit Schritt 1.4 bestanden.
- **Datum**: 2026-10-15, Spike-Ergebnis 2026-10-16
- **Bezug**: Umsetzungsleitfaden, Schritte 1.1, 1.4 und Spike 0.14(d); `docs/ARCHITECTURE.md`, Abschnitte 1 und 10

## Kontext

Die API ist die einzige Auth-Instanz. Gebraucht werden E-Mail-Passwort, Verifizierung, 2FA mit TOTP und DB-Sessions in einem httpOnly-Cookie unter derselben Origin.

## Entscheidung

Better Auth (1.7), eingebunden in NestJS (Express 5). Mandanten und Rollen bleiben in der eigenen Domäne. Das Cookie ist same-origin. Der Auth-Handler hängt vor dem JSON-Parser, und `isPlatformAdmin` darf der Nutzer nie selbst setzen.

## Spike (d): bestanden

Geprüft mit `apps/api/test/auth.integration.test.ts` gegen die vollständige API (PostgreSQL, Redis und Mailpit über Testcontainers):

- Registrierung, Verifizierungs-Mail in Mailpit, Klick auf den Link, Session-Cookie, `getSession` im `AuthGuard` (`GET /api/me`), Logout und erneuter Login.
- Login vor der Verifizierung wird abgewiesen (403).
- 2FA: Aktivieren mit Passwort, Bestätigen per TOTP, beim nächsten Login `twoFactorRedirect` und erst nach dem TOTP-Code eine Session.
- "Passwort vergessen" antwortet für bekannte und unbekannte Adressen gleich.
- `isPlatformAdmin` bei der Registrierung wird ignoriert.
- Rate-Limit: wiederholte Login-Versuche von einer Adresse bekommen 429.
- Ein Login von fremder Origin wird abgewiesen (403).

Better Auth ist ein reines ESM-Paket. Die API wird als CommonJS gebaut; Node 24 lädt ESM per `require`, und TypeScript 5.9 löst das mit `module: NodeNext` auf. Eine Umstellung der API auf ESM ist nicht nötig.

## Umsetzung

- **Mount**: `server.all('/api/auth/*splat', toNodeHandler(auth))` vor `express.json()`, in `apps/api/src/bootstrap.ts`, das auch die Integrationstests verwenden.
- **Datenbank**: Prisma-Adapter mit dem Basis-Client als `app_user` ohne Tenant-Extension. Die Better-Auth-Modelle heißen in Prisma wie in Better Auth (`User`, `Session`, `Account`, `Verification`, `TwoFactor`, `RateLimit`); die Tabellen sind per `@@map` umbenannt (`users`, `auth_account`, ...). IDs erzeugt die App als UUID v7 (`advanced.database.generateId`). Die Schema-Prüfung von Better Auth (`validateSchema`, außerhalb von Produktion aktiv) meldet keine Abweichung.
- **Passwörter**: mindestens 12, höchstens 128 Zeichen. Beim Zurücksetzen werden alle Sessions beendet.
- **Verifizierung**: Pflicht vor der ersten Session; Organisationen setzen also eine verifizierte Adresse voraus. Nach dem Klick auf den Link ist der Nutzer angemeldet.
- **Zusatzfelder**: `locale` und `timezone` mit zod-Validierung (`@smp/contracts`), `isPlatformAdmin` mit `input: false`.
- **E-Mails** gehen im Hintergrund raus und werden nicht abgewartet, sonst verriete die Antwortzeit, ob eine Adresse existiert. Fehler werden ohne Adresse geloggt.
- **Rate-Limits**: Speicher `database` (Tabelle `rate_limit`), aktiv außer in der Entwicklung. Better Auth begrenzt Login und 2FA strenger als den Rest (3 Anfragen in 10 s).
- **Client-Adresse**: Better Auth liest nur `X-Real-IP`. Der Reverse Proxy überschreibt den Header mit der Adresse des Gegenübers (`Caddyfile`); eine `X-Forwarded-For`-Kette wird nicht ausgewertet, weil ihr erster Eintrag vom Client stammt. Jeder Proxy vor der API muss `X-Real-IP` so setzen.
- **CSRF**: Das Cookie ist `SameSite=Lax`. Zusätzlich weist eine Middleware vor dem Auth-Handler jede schreibende Anfrage ab, deren `Origin` nicht `APP_URL` ist oder deren `Sec-Fetch-Site` eine fremde Site meldet. Better Auth selbst lässt einen Login ohne Cookie von fremder Origin zu (Login-CSRF); die Middleware schließt das.
- **Logs**: Better-Auth-Meldungen ab `warn` gehen ohne Zusatzargumente in pino, damit keine Anfragedaten im Log landen. Telemetrie ist aus.

## Ausweichlösung (nicht benötigt)

Hätte Better Auth in Express 5 nicht getragen, hätte die API eine eigene Sitzungsschicht mit DB-Sessions (Token nur als Hash) und Argon2id für Passwörter gebaut. Das Schema wäre dasselbe geblieben.

## Alternativen

- **Auth.js**: die Bibliothek ist seit 2025 beim Better-Auth-Team. Auth.js ist vor allem auf Next.js zugeschnitten und passt nicht zur Entscheidung, die API zur einzigen Auth-Instanz zu machen.
- **Eigene Lösung ohne Bibliothek**: verworfen. Passwort-Reset, 2FA und Sitzungsverwaltung sind sicherheitskritisch.

## Konsequenzen

- Better Auth bekommt einen Prisma-Client als `app_user` ohne Tenant-Extension. Die Auth-Tabellen haben keine RLS, und die Extension würde ohne Mandanten-Kontext einen Fehler werfen.
- Rate-Limits auf den Auth-Routen sind aktiv, und die Antworten bei "Passwort vergessen" verraten nicht, ob eine Adresse existiert.
- Ein Reverse Proxy ohne `X-Real-IP` führt dazu, dass alle Clients einen gemeinsamen Rate-Limit-Topf teilen. Better Auth warnt dann im Log.
