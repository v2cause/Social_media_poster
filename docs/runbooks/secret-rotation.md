# Runbook: Secrets rotieren

Schritte 8.4 und 8.9 des Leitfadens, [ADR 0039](../adr/0039-security-review-und-haertung.md). Dieses Runbook beschreibt für jedes Secret der Plattform, wo es liegt, wer es nutzt, wie es rotiert wird und woran man den Erfolg erkennt.

## Wann rotieren

- **Sofort**: bei Verdacht auf Kompromittierung (Leck in Logs, Repository, Ticket oder Chat; verlorenes Gerät mit Zugriff).
- **Beim Ausscheiden** einer Person mit Zugriff auf die Produktionsumgebung.
- **Planmäßig**: einmal im Jahr, Schlüssel der Verschlüsselung (`TOKEN_KEKS`, `SESSION_KEKS`, `NOTIFY_KEKS`, `BETTER_AUTH_SECRETS`) ebenfalls jährlich.

## Grundregeln

- Secrets stehen nur in der Umgebung der Container (lokal `.env`) oder in einer Datei je Secret, deren Pfad `<NAME>_FILE` nennt (seit Schritt 8.9). Nie im Repository, in Logs, in Fehlermeldungen, in Audit-Metadaten oder in `NEXT_PUBLIC_*`-Variablen.
- **Als Datei** lesen API, Worker und browser-worker die Secrets der Liste `SECRET_FILE_VARIABLES` (`packages/observability/src/secret-files.ts`): die Schlüssel dieses Runbooks, die URLs mit Passwort (`DATABASE_URL`, `DATABASE_SYSTEM_URL`, `REDIS_URL`, `SMTP_URL`), die Schlüssel von S3 und Stripe, `ANTHROPIC_API_KEY`, `SENTRY_DSN` und die Client-Secrets der Plattform-Apps. Die Datei enthält nur den Wert, ein Zeilenumbruch am Ende wird entfernt. Die Dienste lesen sie beim Start: Für eine Rotation die Datei ersetzen und den Dienst neu starten. Ein Wert und eine Datei für denselben Namen brechen den Start ab.
- Neue Werte: `pnpm gen:keys` für `BETTER_AUTH_SECRET`, `TOKEN_KEKS`, `SESSION_KEKS` und `NOTIFY_KEKS`; für Passwörter `openssl rand -base64 32`.
- Nach jeder Rotation: betroffene Dienste neu starten, `GET /api/health/ready` und `GET :3002/health/ready` des Workers prüfen, Logs auf `level >= 50` durchsehen.
- Alte Werte erst entfernen, wenn die Prüfung der jeweiligen Zeile unten bestanden ist.

## In der Produktions-Vorlage

Seit Schritt 8.9 ([ADR 0045](../adr/0045-produktions-vorlage.md), [Runbook Deployment](deployment.md)) ist jedes Secret eine Datei in `deploy/secrets/`: `0440`, Eigentümer root, Gruppe 10001 der Container, das Verzeichnis `0750`. `deploy/.env` enthält kein Secret. Die Abschnitte unten gelten weiter; nur Ort und Neustart sind anders:

- **Neuer Wert**: `deploy/scripts/init-secrets.sh` legt jede Datei nur einmal an und überschreibt nie. Für einen neuen Wert die Datei selbst schreiben, zum Beispiel mit `install -m 0440 -o root -g 10001 /dev/stdin deploy/secrets/<name>` (Wert einfügen, mit Strg-D abschließen, so landet er nicht in der Shell-Historie). Oder die Datei löschen und das Skript erneut ausführen; es erzeugt dann einen neuen Wert und alles, was davon abhängt und ebenfalls fehlt.
- **Wirksam** wird ein neuer Wert mit `deploy/scripts/deploy.sh`. Das Skript bildet Prüfsummen über die Dateien je Gruppe von Diensten (Caddy, Datenspeicher, App, Monitoring) und setzt sie als Label. Ändert sich eine Datei, startet Compose die Dienste dieser Gruppe neu; ein Secret in `deploy/secrets/` startet alle Dienste der App neu.
- **Passwörter der Datenbankrollen**: `pg_password_<rolle>` und die Datei mit der URL, die es enthält (`database_url_<dienst>`, `database_system_url_<dienst>` oder `migration_database_url`), löschen, dann `init-secrets.sh` und `deploy.sh` ausführen. Der Job `db-roles` setzt bei jedem Deploy die Passwörter aller Rollen aus den Dateien (`deploy/postgres/roles.sh`); danach starten die Dienste mit der neuen URL.
- **`postgres_password`** übernimmt Postgres nur beim ersten Start, und `db-roles` meldet sich damit an. Deshalb zuerst das Passwort in Postgres ändern: im Verzeichnis `deploy/` mit `docker compose exec postgres psql -U postgres` (fragt nach dem bisherigen Passwort), darin `\password postgres` (fragt ohne Anzeige). Dann die Datei ersetzen und `deploy.sh` ausführen.
- **Redis**: `redis_password_<nutzer>`, die passende URL (`redis_url_<dienst>`, beim browser-worker `redis_url_browser_worker`) und `redis_users_acl` löschen, dann `init-secrets.sh` und `deploy.sh` ausführen. Das Skript schreibt die ACL mit dem SHA-256 der Passwörter neu, Redis und die Dienste starten neu, die Queues überstehen das im AOF.
- **KEKs** (`token_keks`, `session_keks`, `notify_keks`): in zwei Deploys wie unten beschrieben. Erst einen Eintrag `<key-id>:<base64 32 Byte>` mit einer neuen ID an die Datei anhängen und `deploy.sh` ausführen. Dann in `deploy/generated/keyring.env` den Wert `*_KEK_ACTIVE` auf die neue ID setzen und `deploy.sh` erneut ausführen.
- **`better_auth_secret` und `better_auth_secrets`**: Die Vorlage liest beide über `BETTER_AUTH_SECRET_FILE` und `BETTER_AUTH_SECRETS_FILE`. `init-secrets.sh` legt `better_auth_secrets` als Version 1 des Schlüssels an (`1:<schlüssel>`). Die erste Rotation nach dem Abschnitt unten beginnt deshalb mit Version 2: `2:<neu>,1:<bisher>` in `better_auth_secrets`, dann `deploy.sh`, Neuverschlüsselung, und erst danach die alte Version entfernen und `better_auth_secret` ersetzen.
- **Objektspeicher**: Das Schlüsselpaar der App steht auch in `s3_config`, der Liste der Identitäten von SeaweedFS. `s3_access_key_id`, `s3_secret_access_key` und `s3_config` löschen, dann `init-secrets.sh` und `deploy.sh` ausführen. Signierte URLs mit dem alten Paar verfallen.
- **Interne TLS-Zertifikate** (Postgres, Redis, S3, im Staging Mailpit): `init-secrets.sh --renew-tls` stellt neue Zertifikate der privaten CA aus, `deploy.sh` startet die Dienste neu. Der Preflight warnt 60 Tage vor dem Ende ([Runbook Deployment](deployment.md), Abschnitt "Zertifikate").
- **Kopie**: Nach jeder Rotation die getrennte Kopie von `deploy/secrets/` und `deploy/generated/keyring.env` erneuern. Alte KEKs und Schlüssel bleiben darin, solange eine Sicherung sie braucht ([Backup und Wiederherstellung](backup-restore.md)).

## Sitzungen sofort beenden

Bei Verdacht auf ein übernommenes Konto oder eine gestohlene Sitzung, auch ohne Rotation. Die Sitzungen liegen nur in der Datenbank, ohne Cookie-Cache: Die nächste Anfrage einer beendeten Sitzung bekommt 401, und der Browser meldet sich neu an.

- Eine Person: `docker compose exec api node dist/scripts/revoke-sessions.js --user <E-Mail-Adresse>` (lokal nach `pnpm build`: `pnpm auth:revoke-sessions --user <E-Mail-Adresse>`).
- Alle Personen: dasselbe mit `--all`, zum Beispiel nach einem Leck der Datenbank.
- Das Log `auth.sessions_revoked` nennt nur die Zahl der beendeten Sitzungen, nie die Adresse. Exit-Code 1 heißt, dass zu der Adresse kein Konto gehört; Exit-Code 2, dass weder `--user <E-Mail-Adresse>` noch `--all` angegeben war.
- Ist das Passwort betroffen, setzt die Person es über "Passwort vergessen" neu; auch das beendet alle ihre Sitzungen.

## Übersicht

| Secret | Genutzt von | Auswirkung der Rotation |
| --- | --- | --- |
| `BETTER_AUTH_SECRET`, `BETTER_AUTH_SECRETS` | API | Alle Sitzungen enden, offene Bestätigungslinks verfallen |
| `TOKEN_KEKS`, `TOKEN_KEK_ACTIVE` | API, Worker | Keine |
| `SESSION_KEKS`, `SESSION_KEK_ACTIVE` | API, Worker, browser-worker | Keine |
| `NOTIFY_KEKS`, `NOTIFY_KEK_ACTIVE` | API, Worker | Keine |
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
5. Ältere Versionen aus `BETTER_AUTH_SECRETS` entfernen und `BETTER_AUTH_SECRET` auf den aktuellen Schlüssel setzen, dann die API erneut starten. Die älteren Schlüssel bleiben im Secret-Store, bis die letzte Sicherung von vor der Neuverschlüsselung abgelaufen ist (14 Tage); ein Restore auf einen Zeitpunkt davor braucht sie wieder.
6. Prüfen: Anmeldung mit zweitem Faktor eines Testkontos, `auth.event` mit `outcome: ok` im Log.

Den Ablauf deckt `apps/api/test/auth-rotation.integration.test.ts` ab.

## TOKEN_KEKS, SESSION_KEKS und NOTIFY_KEKS

Envelope-Verschlüsselung (`packages/crypto`): `TOKEN_KEKS` schützt die Tokens der Plattformen, `SESSION_KEKS` die versiegelten Logins und Sitzungen des X-Browsers, `NOTIFY_KEKS` seit Schritt 8.9 die E-Mails in der Queue `notifications`. Format: `<key-id>:<base64 32 Byte>`, durch Kommas getrennt; `*_KEK_ACTIVE` nennt den Schlüssel für neue Daten.

Die Rotation läuft in zwei Neustarts, damit jeder Dienst den neuen Schlüssel kennt, bevor ein anderer damit versiegelt:

1. Neuen KEK mit `pnpm gen:keys` erzeugen und an `TOKEN_KEKS` (bzw. `SESSION_KEKS`, `NOTIFY_KEKS`) anhängen. `*_KEK_ACTIVE` bleibt beim bisherigen Schlüssel. API, Worker und (bei `SESSION_KEKS`) browser-worker neu starten.
2. `*_KEK_ACTIVE` auf die neue Key-ID setzen und die Dienste erneut neu starten. Eine E-Mail mit einem Schlüssel, den die Rolle `notify` noch nicht kennt, wiederholt sie einige Minuten lang und meldet dabei `notify.unknown_key` mit der Key-ID.
3. Bei `TOKEN_KEKS` und `SESSION_KEKS` wrappt der nächste Lauf von `tick.maintenance` (03:41 UTC) alle Datenschlüssel mit dem aktiven KEK neu (`RewrapSecrets`), ohne etwas zu entschlüsseln. Im Ergebnis des Ticks: `rewrapped` größer 0 oder alles bereits aktuell, `failed` gleich 0. `NOTIFY_KEKS` hat keinen Re-Wrap: Eine E-Mail liegt höchstens einen Tag nach Versand oder Fehlschlag in Redis, danach löscht BullMQ den Job.
4. Den alten KEK aus der Liste entfernen und die Dienste neu starten, bei `NOTIFY_KEKS` einen Tag nach Schritt 2. Bei `TOKEN_KEKS` und `SESSION_KEKS` bleibt er im Secret-Store, bis die letzte Sicherung von vor dem Re-Wrap abgelaufen ist (14 Tage, [Backup und Wiederherstellung](backup-restore.md)); ein Restore auf einen Zeitpunkt davor braucht ihn wieder in der Liste. Ein alter Schlüssel von `NOTIFY_KEKS` braucht kein Archiv, denn Redis wird nicht gesichert und die Datenbank enthält keine E-Mails.

**Umstieg auf `NOTIFY_KEKS`** (Installation von vor Schritt 8.9, in der `TOKEN_KEKS` die E-Mails versiegelt): `NOTIFY_KEKS` auf einen neuen Schlüssel aus `pnpm gen:keys` setzen, den aktiven Eintrag aus `TOKEN_KEKS` dahinter anhängen (`NOTIFY_KEKS=<neu>,<Token-KEK>`) und `NOTIFY_KEK_ACTIVE` auf die neue Key-ID setzen. API und Worker neu starten; die Rolle `notify` öffnet so auch die E-Mails, die noch mit dem Token-Keyring versiegelt sind. Nach einem Tag den Token-KEK aus `NOTIFY_KEKS` entfernen und neu starten. Danach brauchen die Rollen `notify` und `billing` `TOKEN_KEKS` nicht mehr.

## Passwörter der Datenbankrollen

`POSTGRES_PASSWORD`, `APP_MIGRATOR_PASSWORD`, `APP_USER_PASSWORD`, `APP_SYSTEM_PASSWORD`. Das Init-Skript `infra/docker/postgres/init/01-roles.sql` setzt sie nur beim ersten Start; später ändert sie `ALTER ROLE`.

1. Als Owner verbinden und das Passwort ändern, zum Beispiel `ALTER ROLE app_user PASSWORD '<neu>';` (im Wartungsfenster, die bestehenden Verbindungen laufen weiter).
2. Den Wert in der Umgebung ersetzen, ebenso in `DATABASE_URL`, `DATABASE_SYSTEM_URL` bzw. `MIGRATION_DATABASE_URL`.
3. API und Worker neu starten. Prüfen: `/api/health/ready` meldet die Datenbank als `up`.

Die Passwörter liegen als Hash in der Datenbank und damit in jeder Sicherung. Nach einem Restore auf einen Zeitpunkt vor der Rotation gelten wieder die alten; dann Schritt 1 mit den Werten des Secret-Stores wiederholen ([Backup und Wiederherstellung](backup-restore.md)).

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
- **Plattform-Apps** (`LINKEDIN_CLIENT_SECRET`, `LINKEDIN_CM_CLIENT_SECRET`, `META_APP_SECRET`, `INSTAGRAM_APP_SECRET`, `X_CLIENT_SECRET`): im Entwicklerportal der Plattform ein neues Secret erzeugen, setzen, API und Worker neu starten. Die Tokens der Nutzer bleiben gültig; Erneuerungen laufen mit dem neuen Secret. Mit den Webhooks von Meta (Schritt 4.13, noch offen) prüft `META_APP_SECRET` auch deren Signatur; dann ist das neue Secret zu setzen, bevor Meta das alte verwirft. Prüfen: der Token-Monitor meldet keine neuen Fehler, ein Testbeitrag geht raus.
- **`SENTRY_DSN`**: bei einem Leck einen neuen DSN anlegen und den alten im Projekt deaktivieren.

`SEED_USER_PASSWORD` gilt nur lokal; das Seed-Skript verweigert die Arbeit mit `NODE_ENV=production`.
