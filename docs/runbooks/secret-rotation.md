# Runbook: Secrets rotieren

Schritt 8.4 des Leitfadens, [ADR 0039](../adr/0039-security-review-und-haertung.md). Dieses Runbook beschreibt für jedes Secret der Plattform, wo es liegt, wer es nutzt, wie es rotiert wird und woran man den Erfolg erkennt.

## Wann rotieren

- **Sofort**: bei Verdacht auf Kompromittierung (Leck in Logs, Repository, Ticket oder Chat; verlorenes Gerät mit Zugriff).
- **Beim Ausscheiden** einer Person mit Zugriff auf die Produktionsumgebung.
- **Planmäßig**: einmal im Jahr, Schlüssel der Verschlüsselung (`TOKEN_KEKS`, `SESSION_KEKS`, `BETTER_AUTH_SECRETS`) ebenfalls jährlich.

## Grundregeln

- Secrets stehen nur in der Umgebung der Container (lokal `.env`, in Produktion im Secret-Store des Deployments, Schritt 8.9). Nie im Repository, in Logs, in Fehlermeldungen, in Audit-Metadaten oder in `NEXT_PUBLIC_*`-Variablen.
- Neue Werte: `pnpm gen:keys` für `BETTER_AUTH_SECRET`, `TOKEN_KEKS` und `SESSION_KEKS`; für Passwörter `openssl rand -base64 32`.
- Nach jeder Rotation: betroffene Dienste neu starten, `GET /api/health/ready` und `GET :3002/health/ready` des Workers prüfen, Logs auf `level >= 50` durchsehen.
- Alte Werte erst entfernen, wenn die Prüfung der jeweiligen Zeile unten bestanden ist.

## Übersicht

| Secret | Genutzt von | Auswirkung der Rotation |
| --- | --- | --- |
| `BETTER_AUTH_SECRET`, `BETTER_AUTH_SECRETS` | API | Alle Sitzungen enden, offene Bestätigungslinks verfallen |
| `TOKEN_KEKS`, `TOKEN_KEK_ACTIVE` | API, Worker | Keine |
| `SESSION_KEKS`, `SESSION_KEK_ACTIVE` | API, Worker, browser-worker | Keine |
| Passwörter der Datenbankrollen | Postgres, API, Worker, Migrationen | Kurzer Neustart |
| `REDIS_APP_PASSWORD`, `XB_REDIS_PASSWORD` | Redis, API, Worker, browser-worker | Kurzer Neustart |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | API, Worker | Ausgestellte signierte URLs verfallen |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | API, Worker | Keine bei Überlappung |
| `SMTP_URL` (Zugangsdaten) | Worker (Rolle `notify`) | Keine |
| `ANTHROPIC_API_KEY` | API, Worker (Rolle `ai`) | Keine |
| Client-Secrets der Plattform-Apps | API, Worker | Keine, Meta: Webhook-Signaturen |
| `SENTRY_DSN` | alle Dienste | Keine |

## BETTER_AUTH_SECRET und BETTER_AUTH_SECRETS

Better Auth signiert damit die Session-Cookies und die Bestätigungslinks und verschlüsselt die TOTP-Geheimnisse und Backup-Codes des zweiten Faktors. `BETTER_AUTH_SECRETS` enthält versionierte Schlüssel im Format `<version>:<secret>`, durch Kommas getrennt, der aktuelle zuerst. `BETTER_AUTH_SECRET` bleibt Pflicht und öffnet, was vor den Versionen verschlüsselt wurde.

1. Neuen Schlüssel mit `pnpm gen:keys` erzeugen (die Zeile `BETTER_AUTH_SECRET` übernehmen, mindestens 32 Zeichen).
2. `BETTER_AUTH_SECRETS` setzen, die neue Version zuerst: beim ersten Mal `1:<neu>`, später `2:<neu>,1:<bisher>`.
3. API neu starten. Alle Sitzungen enden, weil die Cookies mit dem aktuellen Schlüssel signiert sind; Nutzer melden sich neu an. Offene Bestätigungslinks verfallen, laufende Anmeldungen mit zweitem Faktor beginnen neu.
4. TOTP-Geheimnisse und Backup-Codes neu verschlüsseln, im Container der API: `docker compose exec api node dist/scripts/reencrypt-two-factor.js` (lokal nach `pnpm build`: `pnpm auth:reencrypt`). Das Log `auth.reencrypt_done` nennt nur Zahlen. Erfolg: Exit-Code 0, `failed` und `changedMeanwhile` sind 0. Sonst den Lauf wiederholen; `changedMeanwhile` entsteht, wenn jemand währenddessen einen Backup-Code benutzt.
5. Ältere Versionen aus `BETTER_AUTH_SECRETS` entfernen und `BETTER_AUTH_SECRET` auf den aktuellen Schlüssel setzen, dann die API erneut starten.
6. Prüfen: Anmeldung mit zweitem Faktor eines Testkontos, `auth.event` mit `outcome: ok` im Log.

Den Ablauf deckt `apps/api/test/auth-rotation.integration.test.ts` ab.

## TOKEN_KEKS und SESSION_KEKS

Envelope-Verschlüsselung (`packages/crypto`): `TOKEN_KEKS` schützt die Tokens der Plattformen und die E-Mails in der Queue `notifications`, `SESSION_KEKS` die versiegelten Logins und Sitzungen des X-Browsers. Format: `<key-id>:<base64 32 Byte>`, durch Kommas getrennt; `*_KEK_ACTIVE` nennt den Schlüssel für neue Daten.

Die Rotation läuft in zwei Neustarts, damit jeder Dienst den neuen Schlüssel kennt, bevor ein anderer damit versiegelt:

1. Neuen KEK mit `pnpm gen:keys` erzeugen und an `TOKEN_KEKS` (bzw. `SESSION_KEKS`) anhängen. `TOKEN_KEK_ACTIVE` (bzw. `SESSION_KEK_ACTIVE`) bleibt beim bisherigen Schlüssel. API, Worker und (bei `SESSION_KEKS`) browser-worker neu starten.
2. `TOKEN_KEK_ACTIVE` (bzw. `SESSION_KEK_ACTIVE`) auf die neue Key-ID setzen und die Dienste erneut neu starten. Eine E-Mail mit einem Schlüssel, den die Rolle `notify` noch nicht kennt, wiederholt sie einige Minuten lang und meldet dabei `notify.unknown_key` mit der Key-ID.
3. Der nächste Lauf von `tick.maintenance` (03:41 UTC) wrappt alle Datenschlüssel mit dem aktiven KEK neu (`RewrapSecrets`), ohne etwas zu entschlüsseln. Im Ergebnis des Ticks: `rewrapped` größer 0 oder alles bereits aktuell, `failed` gleich 0. Die E-Mails in der Queue wrappt er nicht; sie sind bis dahin längst versendet, ihre Wiederholungen enden nach wenigen Minuten.
4. Den alten KEK aus der Liste entfernen und die Dienste neu starten.

## Passwörter der Datenbankrollen

`POSTGRES_PASSWORD`, `APP_MIGRATOR_PASSWORD`, `APP_USER_PASSWORD`, `APP_SYSTEM_PASSWORD`. Das Init-Skript `infra/docker/postgres/init/01-roles.sql` setzt sie nur beim ersten Start; später ändert sie `ALTER ROLE`.

1. Als Owner verbinden und das Passwort ändern, zum Beispiel `ALTER ROLE app_user PASSWORD '<neu>';` (im Wartungsfenster, die bestehenden Verbindungen laufen weiter).
2. Den Wert in der Umgebung ersetzen, ebenso in `DATABASE_URL`, `DATABASE_SYSTEM_URL` bzw. `MIGRATION_DATABASE_URL`.
3. API und Worker neu starten. Prüfen: `/api/health/ready` meldet die Datenbank als `up`.

## Redis

`REDIS_APP_PASSWORD` (API und Worker, Nutzer `app`) und `XB_REDIS_PASSWORD` (browser-worker). Redis liest die Nutzer beim Start aus seinem Befehl in `compose.yaml`; ein Nutzer ohne Passwort existiert nicht.

1. Neuen Wert setzen, bei `REDIS_APP_PASSWORD` auch in `REDIS_URL`.
2. `docker compose up -d redis api worker` (bzw. `browser-worker`). Die Queues liegen im AOF und überstehen den Neustart.
3. Prüfen: `/api/health/ready` meldet Redis als `up`, Jobs laufen weiter.

## Objektspeicher

`S3_ACCESS_KEY_ID` und `S3_SECRET_ACCESS_KEY`. Lokal stehen die Schlüssel in `infra/docker/seaweedfs/s3.json`, in Produktion beim Anbieter.

1. Ein zweites Schlüsselpaar mit denselben Rechten anlegen.
2. Die Umgebung umstellen, API und Worker neu starten. Signierte URLs mit dem alten Paar (Uploads, Vorschauen, Exporte) verfallen; die Oberfläche holt neue.
3. Das alte Paar beim Anbieter löschen. Prüfen: `/api/health/ready` meldet den Speicher als `up`, ein Upload in der Mediathek gelingt.

## Stripe

1. `STRIPE_SECRET_KEY`: im Stripe-Dashboard rollen (Stripe lässt den alten Schlüssel bis zu einem gewählten Zeitpunkt gelten), neuen Wert setzen, API und Worker neu starten.
2. `STRIPE_WEBHOOK_SECRET`: das Signing-Secret des Endpoints rollen; Stripe signiert in der Übergangszeit mit beiden. Neuen Wert setzen und die API neu starten.
3. Prüfen: die Abrechnungsseite lädt, ein Test-Webhook aus dem Dashboard wird mit 200 beantwortet.

## E-Mail, KI und Plattformen

- **SMTP**: neue Zugangsdaten beim Anbieter, `SMTP_URL` ersetzen, Worker neu starten. Prüfen: eine Passwort-vergessen-Mail an ein Testkonto kommt an.
- **`ANTHROPIC_API_KEY`**: neuen Schlüssel in der Anthropic Console anlegen, setzen, API und Worker neu starten, alten Schlüssel widerrufen. Prüfen: ein KI-Entwurf im Composer.
- **Plattform-Apps** (`LINKEDIN_CLIENT_SECRET`, `LINKEDIN_CM_CLIENT_SECRET`, `META_APP_SECRET`, `INSTAGRAM_APP_SECRET`, `X_CLIENT_SECRET`): im Entwicklerportal der Plattform ein neues Secret erzeugen, setzen, API und Worker neu starten. Die Tokens der Nutzer bleiben gültig; Erneuerungen laufen mit dem neuen Secret. `META_APP_SECRET` prüft auch die Signatur der Meta-Webhooks: neues Secret setzen, bevor Meta das alte verwirft. Prüfen: der Token-Monitor meldet keine neuen Fehler, ein Testbeitrag geht raus.
- **`SENTRY_DSN`**: bei einem Leck einen neuen DSN anlegen und den alten im Projekt deaktivieren.

`SEED_USER_PASSWORD` gilt nur lokal; das Seed-Skript verweigert die Arbeit mit `NODE_ENV=production`.
