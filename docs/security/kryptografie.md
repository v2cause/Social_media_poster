# Kryptografie: Inventar und Schlüsselverwaltung

- **Stand**: 2026-10-19
- **Bezug**: Umsetzungsleitfaden, Schritte 8.4 und 8.9; ASVS V11.1.1, V11.1.2 und V11.2.2; [ADR 0039](../adr/0039-security-review-und-haertung.md), [Runbook Secret-Rotation](../runbooks/secret-rotation.md), [ASVS-Checkliste](asvs-l2.md)

Das Inventar nennt jedes kryptografische Verfahren der Plattform mit Parametern, Schlüssel und Ort im Code. Die Richtlinie danach regelt den Lebenszyklus der Schlüssel. Beides wird mit jeder Änderung an Schlüsseln oder Verfahren nachgeführt und jährlich mit der ASVS-Checkliste geprüft, das nächste Mal im Oktober 2027. Werte von Schlüsseln stehen nie in diesem Dokument.

## Schlüssel

| Schlüssel | Format und Erzeugung | Darf schützen | Darf nicht schützen | Halter |
| --- | --- | --- | --- | --- |
| `BETTER_AUTH_SECRET`, `BETTER_AUTH_SECRETS` | Mindestens 32 Zeichen, `pnpm gen:keys` liefert 32 Byte in base64. Versionen als `<version>:<secret>`, die aktuelle zuerst. | Signaturen der Cookies und Bestätigungslinks von Better Auth, TOTP-Geheimnisse und Backup-Codes | Tokens, E-Mails, Sitzungen von X, Daten der Mandanten | API |
| `TOKEN_KEKS`, `TOKEN_KEK_ACTIVE` | `<key-id>:<base64 32 Byte>`, durch Kommas getrennt; `TOKEN_KEK_ACTIVE` nennt den Schlüssel für neue Daten | Datenschlüssel der Plattform-Tokens | E-Mails, Sitzungen und Logins von X, 2FA, Passwörter, Inhalte der Mandanten | API, Worker (siehe Verteilung) |
| `NOTIFY_KEKS`, `NOTIFY_KEK_ACTIVE` | wie `TOKEN_KEKS` | Datenschlüssel der E-Mails in der Queue `notifications` (seit Schritt 8.9) | Tokens, Sitzungen und Logins von X, 2FA | API, Worker `scheduler`, `publisher`, `gdpr`, `notify` und `billing` |
| `SESSION_KEKS`, `SESSION_KEK_ACTIVE` | wie `TOKEN_KEKS` | Datenschlüssel des `storageState` von X sowie der Zugangsdaten und Codes eines Logins | Tokens, E-Mails, 2FA | browser-worker, API, Worker `scheduler` |
| `STRIPE_WEBHOOK_SECRET` | aus dem Stripe-Dashboard | Signaturen der Webhooks von Stripe | alles andere | API |
| `S3_SECRET_ACCESS_KEY` | vom Anbieter des Speichers | Signaturen der Anfragen an den Speicher und der signierten URLs | alles andere | API, Worker |

Mit `BETTER_AUTH_SECRETS` signiert und verschlüsselt Better Auth mit der aktuellen Version; `BETTER_AUTH_SECRET` öffnet dann nur noch Ciphertexte ohne Version (`apps/api/src/modules/identity/auth-secrets.ts`). Die übrigen Secrets des Runbooks (Passwörter von Datenbank, Redis und SMTP, API-Schlüssel, Client-Secrets der Plattformen) sind Zugangsdaten zu anderen Diensten; die App nutzt sie nicht als Schlüssel.

## Verfahren

| Zweck | Verfahren und Parameter | Schlüssel | Code | Schutzziel |
| --- | --- | --- | --- | --- |
| Plattform-Tokens im Ruhezustand | Envelope-Verschlüsselung: AES-256-GCM mit einem zufälligen Datenschlüssel (DEK, 256 bit) je Secret, IV 96 bit zufällig, Tag 128 bit. AAD `workspaceId:connectionId:access_token` bzw. `:refresh_token`, für Accounts `...:account.<id>.access_token`, für wartende Zustimmungen in Redis `workspaceId:pending.<id>:token_set` | DEK, gewrappt mit `TOKEN_KEKS` | `packages/crypto/src/envelope.ts`, `packages/core/src/channels/domain/secrets.ts` | Vertraulichkeit und Integrität; ein Umschlag öffnet nur in seiner Zeile und Spalte |
| Wrap der Datenschlüssel | AES-256-GCM mit dem KEK, IV 96 bit zufällig, AAD `smp-kek:<key-id>`. Der Umschlag trägt Version, Key-ID, gewrappten DEK, IV, Tag und Ciphertext. | `TOKEN_KEKS`, `SESSION_KEKS`, `NOTIFY_KEKS` | `LocalKeyring` in `packages/crypto/src/local-keyring.ts` hinter `KmsPort` (`packages/crypto/src/kms.ts`) | Schutz der DEKs, Bindung an die Key-ID |
| E-Mails der Queue `notifications` | Envelope wie oben über Adresse und Inhalt, AAD `notify.email` (seit Schritt 8.4) | `NOTIFY_KEKS` (seit Schritt 8.9, davor `TOKEN_KEKS`) | `packages/queue/src/notifications.ts`, `notifySealerFromEnv` in `packages/crypto/src/envelope-sealer.ts` | Keine Adressen und Links im Klartext in Redis, AOF und Backups |
| Sitzung und Login von X | Envelope wie oben, AAD `workspaceId:x-browser.<X-Nutzer-ID>:session` bzw. `workspaceId:xb-login.<id>:credentials` und `...:code` | `SESSION_KEKS` | `packages/x-browser/src/protocol.ts`, `apps/browser-worker/src/login-runner.ts`, `apps/browser-worker/src/command-runner.ts` | Öffnen nur im browser-worker; Zugangsdaten werden nie gespeichert |
| TOTP-Geheimnisse und Backup-Codes | XChaCha20-Poly1305 (`@noble/ciphers`), Nonce 192 bit zufällig, Schlüssel ist der SHA-256 des Secrets, ohne AAD; mit Versionen im Format `$ba$<version>$<hex>` | `BETTER_AUTH_SECRETS`, für Altbestand `BETTER_AUTH_SECRET` | `symmetricEncrypt` von Better Auth 1.7.9, Tabelle `two_factor` | Vertraulichkeit und Integrität |
| Signierte Cookies | HMAC-SHA-256 (Web Crypto) über den Wert: `session_token`, `two_factor` (Zwischenschritt der 2FA, 10 min) und `device` (Gerät eines Kontos, 180 Tage); über https mit dem Präfix `__Host-smp.` | aktuelles Secret von Better Auth | Better Auth (`better-call`), `device` in `apps/api/src/modules/identity/auth-hooks.ts` | Integrität; ein Session-Token aus der Datenbank ergibt ohne Signatur keinen gültigen Cookie |
| Bestätigungslinks | JWT mit HS256 (`jose`), gültig 1 h | aktuelles Secret von Better Auth | Better Auth, `emailVerification` in `apps/api/src/modules/identity/auth.ts` | Integrität und Ablauf |
| Passwörter | scrypt mit N=2^15, r=8, p=3 (32 MiB, eine der Einstellungen des OWASP Password Storage Cheat Sheet), Salt 128 bit zufällig, Schlüssel 512 bit, Passwort nach NFKC; Format `scrypt$N$r$p$<salt>$<key>`; Vergleich mit `timingSafeEqual`. Hashes im Format von Better Auth (N=2^14, r=16, p=1) werden weiter geprüft. | keiner | `packages/crypto/src/password-hash.ts`, eingebunden in `auth.ts` | Erschwert das Raten der Passwörter nach einem Lesezugriff auf `auth_account` |
| TOTP | RFC 6238 mit HMAC-SHA-1, 6 Ziffern, 30 s, ein Schritt davor und danach (bis 90 s), Vergleich in konstanter Zeit; jeder Code gilt einmal je Konto (Redis `SET NX`, 120 s) | TOTP-Geheimnis je Konto, 32 Zeichen (192 bit) | `@better-auth/utils/otp`, `auth-hooks.ts` | Zweiter Faktor |
| Hashes von Tokens | SHA-256 der Einladungs-Tokens (hex) und der Kennungen von Better Auth, darunter die Reset-Tokens (`verification.storeIdentifier: 'hashed'`, base64url) | keiner | `packages/crypto/src/secret-tokens.ts`, `auth.ts` | Ein Lesezugriff auf die Tabellen löst keinen Link ein |
| PKCE | S256: SHA-256 eines Verifiers mit 256 bit, base64url | keiner | `packages/crypto/src/oauth-random.ts` | Bindet den Code-Tausch an den Start der Autorisierung |
| Digest einer Adresse | SHA-256 der Adresse nach Trim und Kleinschreibung, die ersten 16 Hex-Zeichen, ohne Salz | keiner | `accountDigest` in `auth-hooks.ts` | Pseudonym in Logs, Redis-Schlüsseln und Gerätecookie; wer die Adresse kennt, kann ihn berechnen |
| Leck-Prüfung | SHA-1 des Passworts; nur die ersten 5 Hex-Zeichen gehen an die Range-API (k-Anonymität), die Antwort ist gepolstert | keiner | `apps/api/src/modules/identity/breached-passwords.ts` | Das Passwort verlässt die API nicht; SHA-1 gibt die API von Have I Been Pwned vor |
| Prüfsummen ohne Geheimnis | SHA-256 der Original-Medien (`MediaAsset.sha256`), des Inhalts einer Variante für den Reconcile, der Brand-Voice-Versionen, des Risikotexts des X-Browsers, der Cache-Schlüssel der Analytics und der Idempotenz-Schlüssel bei Stripe | keiner | `packages/media/src/sharp-image-processor.ts`, `packages/core/src/publishing/application/publish-run.ts`, `packages/db/src/content/prisma-content-store.ts`, `packages/contracts/src/legal.ts`, `apps/api/src/modules/analytics/analytics.service.ts`, `packages/billing/src/stripe-gateway.ts` | Wiedererkennen und Integrität, keine Geheimhaltung |
| Webhooks von Stripe | HMAC-SHA-256 (Schema `v1`) über Zeitstempel und Raw Body, Toleranz 300 s, Vergleich in konstanter Zeit (`constructEvent` des SDK) | `STRIPE_WEBHOOK_SECRET` | `packages/billing/src/webhook-verifier.ts` | Echtheit, Schutz vor Wiederholung |
| Signierte URLs des Speichers | SigV4 (`AWS4-HMAC-SHA256`) des AWS SDK: Upload per PUT 5 min mit signiertem `Content-Type` und `Content-Length`, Lesen 1 h (Thumbnails, Renditions für die Plattformen), Download eines Datenexports 5 min | `S3_SECRET_ACCESS_KEY` | `packages/media/src/s3-storage.ts`; Laufzeiten in `packages/core/src/media/domain/rules.ts` und `packages/core/src/gdpr/domain/request.ts` | Befristeter Zugriff auf genau ein Objekt |

## Zufall

- **`crypto.randomBytes`** (CSPRNG von Node): DEKs (256 bit) und IVs (96 bit); KEKs und `BETTER_AUTH_SECRET` in `tools/gen-keys.ts` (256 bit); Einladungs-Tokens, OAuth-`state`, IDs wartender Zustimmungen und PKCE-Verifier (je 256 bit); Salts der Passwörter, IDs der Geräte und Tokens der Redis-Sperren in `packages/queue/src/lock.ts` (je 128 bit).
- **`crypto.getRandomValues`** (Web Crypto): Nonce der CSP (128 bit, `apps/web/src/security/content-security-policy.ts`). Better Auth zieht damit Zeichen ohne Modulo-Verzerrung: Session-Tokens (32 Zeichen aus 62, rund 190 bit), Reset-Tokens (24 aus 62, rund 143 bit), TOTP-Geheimnisse (32 aus 64, 192 bit), Backup-Codes (10 aus 62, rund 59 bit, akzeptiert in ADR 0039) und die Kennung des 2FA-Zwischenschritts (20 aus 64, 120 bit; wirksam nur mit der HMAC-Signatur ihres Cookies und für 10 min).
- **IDs**: UUID v7 (Paket `uuidv7`, Zufall aus `crypto.getRandomValues`) und UUID v4 (`randomUUID`) sind Bezeichner, nie Geheimnisse (ASVS V11.5.1). `randomInt` wählt das Suffix eines Workspace-Slugs.
- **`Math.random`**: nur für den Jitter des Backoffs beim Veröffentlichen (`apps/worker/src/publisher/publish-backoff.ts`).

## Transport

- **Heute**: In Produktion startet die App nur mit https für `APP_URL`, `BETTER_AUTH_URL` und den öffentlichen Endpunkt des Speichers (`checkProductionEnv` in `packages/observability/src/env.ts`, ausgenommen ein Build mit `APP_URL` auf localhost) sowie für `PWNED_PASSWORDS_API_URL`. Web-App (Produktions-Build) und API (helmet) senden HSTS mit `max-age=31536000; includeSubDomains`.
- **SMTP** (seit Schritt 8.4): In Produktion geht jede Mail über TLS, mit `smtps://` oder STARTTLS (`requireTLS`); ohne TLS scheitert der Versand (`packages/emails/src/smtp-mailer.ts`, `apps/worker/src/infrastructure/notify.providers.ts`). Ausgenommen ist ein Build mit `APP_URL` auf localhost (Mailpit).
- **Zertifikate**: Kein Code im Repository schaltet die Prüfung ab (`rejectUnauthorized`, `NODE_TLS_REJECT_UNAUTHORIZED`). Der Egress-Proxy des browser-workers tunnelt https per `CONNECT` und bricht TLS nicht auf (`apps/egress-proxy/src/proxy.ts`).
- **Schritt 8.9** (ADR 0039): TLS 1.2 und 1.3 am Proxy mit Zertifikaten einer öffentlichen CA, TLS für Postgres, Redis und interne Verbindungen.

## Schlüsselverwaltung

Richtlinie nach NIST SP 800-57 Teil 1, in Kurzform. Die Handgriffe stehen im [Runbook](../runbooks/secret-rotation.md).

### Erzeugung

- `pnpm gen:keys` (`tools/gen-keys.ts`) gibt `BETTER_AUTH_SECRET`, `TOKEN_KEKS`, `SESSION_KEKS` und `NOTIFY_KEKS` mit ihren aktiven Key-IDs aus: je 32 Byte aus `crypto.randomBytes` in base64, Key-IDs `kek-` mit acht Hex-Zeichen. Das Skript schreibt nichts auf die Platte und loggt nichts.
- Eine neue Version für `BETTER_AUTH_SECRETS` ist die Zeile `BETTER_AUTH_SECRET` einer neuen Ausgabe.
- Jede Umgebung hat eigene Schlüssel. `.env.example` enthält keine; die Werte in `.env.test` sind öffentlich und gelten nur für Tests.
- Ohne `NOTIFY_KEKS` versiegeln Entwicklung und Tests die E-Mails mit `TOKEN_KEKS`. In Produktion startet ohne ihn kein Dienst, der E-Mails einreiht oder versendet (`notifySealerFromEnv`).
- Beim Start prüft `LocalKeyring.fromEnv` jeden KEK: 32 Byte in kanonischem base64, Key-ID aus `[A-Za-z0-9._-]` mit 1 bis 64 Zeichen, keine doppelte Key-ID, der aktive Schlüssel in der Liste. Die API verlangt für Better Auth mindestens 32 Zeichen je Secret und eindeutige Versionen (`apps/api/src/config/api-env.ts`). Meldungen nennen Variablen und Key-IDs, nie Schlüssel.

### Speicherung

- Schlüssel stehen nur in der Umgebung der Container: lokal in `.env` (von git ignoriert); im Compose-Profil `app` bekommt jeder Dienst nur die Variablen, die er liest. gitleaks (Workflow `security`) und Trivy (Images) suchen nach Secrets.
- Nie in Logs, Fehlermeldungen, Audit-Metadaten, `NEXT_PUBLIC_*`-Variablen oder unversiegelt in Job-Payloads.
- Im Prozess hält `LocalKeyring` die KEKs im Speicher. DEKs werden nach Gebrauch mit Nullen überschrieben, ebenso der Klartext-Puffer nach dem Öffnen.
- Schritt 8.9: Secret-Store des Deployments und ein KMS-Adapter für `KmsPort` (AWS KMS oder Vault). Die KEKs verlassen dann den KMS nicht, die Dienste rufen nur `wrapKey` und `unwrapKey` auf.

### Verteilung

Die Tabelle nennt die Schlüssel der Verschlüsselung und von Better Auth. `STRIPE_WEBHOOK_SECRET` hält nur die API, die Schlüssel des Speichers halten die API und die Worker-Rollen `media`, `publisher` und `gdpr`.

| Dienst oder Rolle | Schlüssel | Verwendung |
| --- | --- | --- |
| API | `BETTER_AUTH_SECRET(S)`, `TOKEN_KEKS`, `NOTIFY_KEKS`; `SESSION_KEKS` nur mit `FEATURE_X_BROWSER_GLOBAL` | Better Auth; versiegelt und öffnet Tokens im OAuth-Ablauf und beim Trennen; versiegelt E-Mails; versiegelt Zugangsdaten und Codes eines X-Logins und öffnet davon nichts |
| Worker `scheduler` | `TOKEN_KEKS`, `SESSION_KEKS`, `NOTIFY_KEKS` | Re-Wrap der Keyrings der Tokens und der Sitzungen in `tick.maintenance`, ohne Inhalte zu entschlüsseln; versiegelt die E-Mails zum Nur-Lesen-Zustand |
| Worker `publisher`, `analytics` | `TOKEN_KEKS`, `publisher` zudem `NOTIFY_KEKS` | öffnen Plattform-Tokens und versiegeln sie nach einem Refresh neu; `publisher` versiegelt zudem die Alarme des X-Browsers |
| Worker `gdpr` | `TOKEN_KEKS`, `NOTIFY_KEKS` | öffnet Tokens für den Widerruf bei der Löschung einer Organisation; versiegelt E-Mails |
| Worker `notify`, `billing` | `NOTIFY_KEKS` | nur E-Mails: `notify` öffnet und versiegelt, `billing` versiegelt |
| Worker `media` und `ai`, Web-App | keine | nichts |
| browser-worker | `SESSION_KEKS` | öffnet Zugangsdaten, Codes und Sitzungen; versiegelt neue und geänderte Sitzungen |

- Im Compose-Profil `app` bekommt der Container `worker` alle drei Keyrings für alle Rollen aus `WORKER_ROLES`. Wer Rollen in eigenen Containern betreibt, gibt jedem Container nur die Schlüssel seiner Rollen aus der Tabelle.
- ASVS V11.1.1 verlangt, Schlüssel nicht zu überteilen. Alle Halter sind Dienste einer Installation unter einem Betrieb, kein Schlüssel wird mit Dritten geteilt. Ein Dienst mit einem KEK kann jeden Umschlag dieses Keyrings öffnen, den er zu lesen bekommt; die Rollen trennt heute der Code, nicht der Schlüssel.

**Eigener Keyring für E-Mails** (seit Schritt 8.9, ADR 0039)

- API und Worker versiegeln die E-Mails mit `NOTIFY_KEKS`. Die Rollen `notify` und `billing` halten keinen Token-Keyring mehr: Wer E-Mails öffnet, öffnet damit keine Tokens.
- Von Schritt 8.4 bis 8.9 hielten `notify` und `billing` den Token-Keyring, und allein die AAD trennte E-Mails und Tokens (`notify.email` gegenüber `workspaceId:connectionId:feld`). ADR 0039 hatte das bis Schritt 8.9 akzeptiert.
- Die E-Mails liegen höchstens einen Tag nach Versand oder Fehlschlag in Redis. Der Keyring braucht deshalb keinen Re-Wrap und kein Archiv für Backups: Einen alten Schlüssel entfernt der Betrieb einen Tag nach dem Wechsel (Runbook).

### Rotation und Kryptoperioden

- **Planmäßig** einmal im Jahr: `TOKEN_KEKS`, `SESSION_KEKS`, `NOTIFY_KEKS`, `BETTER_AUTH_SECRETS` und die übrigen Secrets des Runbooks.
- **Sofort** bei Verdacht auf Kompromittierung und beim Ausscheiden einer Person mit Zugriff auf die Produktion.
- **Grenze je KEK**: höchstens 2^32 Wraps, die Grenze für AES-GCM mit zufälligen IVs (NIST SP 800-38D). Wird sie absehbar erreicht, wird früher rotiert.
- **Ablauf**: KEKs in zwei Neustarts (anhängen, dann aktivieren), danach der Re-Wrap in `tick.maintenance` um 03:41 UTC, für `NOTIFY_KEKS` stattdessen ein Tag Wartezeit; Better Auth mit der neuen Version vorn und `pnpm auth:reencrypt`. Ein alter Schlüssel verlässt die Umgebung erst, wenn die Prüfung des Runbooks bestanden ist (etwa `failed` gleich 0).
- **Datenschlüssel**: Jeder DEK verschlüsselt genau einen Klartext. Neue DEKs entstehen nur beim Versiegeln, etwa bei einer neuen Verbindung, nach dem Refresh eines Tokens, bei einer geänderten Sitzung von X und für jede E-Mail. Der Re-Wrap behält DEK und Ciphertext.

### Widerruf und Vernichtung

- **KEK kompromittiert**: neuen KEK aktivieren, den Re-Wrap abwarten (bei `NOTIFY_KEKS` einen Tag), den alten KEK entfernen. Der Re-Wrap behält DEK und Ciphertext: Wer den alten KEK und eine Kopie der Umschläge hat, kann sie weiter öffnen. Lagen auch die Daten offen, sind deshalb die Inhalte selbst zu ersetzen: Accounts trennen (das widerruft den Grant bei der Plattform) und neu verbinden, Sitzungen von X bei X beenden und neu anmelden.
- **Secret von Better Auth kompromittiert**: Die Rotation beendet alle Sessions und offenen Bestätigungslinks. Die Neuverschlüsselung ändert die TOTP-Geheimnisse nicht; lag auch die Tabelle `two_factor` offen, richten alle Konten ihren zweiten Faktor neu ein.
- **Schlüssel anderer Anbieter** (Stripe, Speicher): beim Anbieter widerrufen, wie im Runbook beschrieben.
- **Vernichtung**: Mit der Rotation verlässt ein Schlüssel die Umgebungen, auch Kopien in `.env`-Dateien. Seine Archivkopie (siehe Wiederherstellung) wird gelöscht, sobald kein Backup ihn mehr braucht.

### Rollen

- **Betrieb** (Personen mit Zugriff auf die Produktionsumgebung): erzeugt, verteilt, rotiert und vernichtet die Schlüssel der Produktion nach dem Runbook und hält dieses Inventar aktuell.
- **Entwicklung**: nutzt nur eigene lokale Schlüssel aus `pnpm gen:keys` und die Testwerte. Schlüssel der Produktion gehören nie in Tickets, Chats, das Repository oder `.env`-Dateien auf Arbeitsrechnern.
- **Dienste**: bekommen nur ihre Zeile der Verteilung.

### Wiederherstellung

- Ein Backup der Datenbank enthält die Geheimnisse als Ciphertext oder Hash: Umschläge der Tokens und Sitzungen, die 2FA-Daten, scrypt-Hashes, SHA-256 der Einladungs- und Reset-Tokens. Ausnahme sind die Session-Tokens in `session`: Ohne das Secret von Better Auth ergeben sie keinen gültigen Cookie, und sie enden nach sieben Tagen. Redis (AOF) hält E-Mails und Zugangsdaten nur versiegelt.
- Schlüssel werden getrennt von den Daten gesichert, nie im selben Backup (Backup in Schritt 8.6, Secret-Store in Schritt 8.9).
- Ein Restore braucht die Schlüssel, die zur Zeit des Backups galten. Ein ausgemusterter KEK und eine alte Version von `BETTER_AUTH_SECRETS` bleiben deshalb archiviert, bis das letzte Backup abläuft, das sie braucht. Nach einem Restore kommen sie als nicht aktive Schlüssel zurück, Re-Wrap und `pnpm auth:reencrypt` laufen, danach werden sie wieder entfernt.
- Ohne Schlüssel sind die Daten verloren: Accounts neu verbinden, X neu anmelden, 2FA neu einrichten.

## Wechsel eines Verfahrens (ASVS V11.2.2)

- **Envelope**: Der Umschlag trägt Version (`ENVELOPE_VERSION = 1`) und Key-ID; `open` weist eine unbekannte Version als `MALFORMED` ab. Ein neues Verfahren bekäme Version 2: `open` liest beide, `seal` schreibt nur noch die neue. Weil der Re-Wrap nur den DEK neu wrappt, braucht es dazu einen Job, der jeden Umschlag der Version 1 öffnet und neu versiegelt, mit demselben Vergleich der gelesenen Bytes wie `RewrapSecrets` (`packages/core/src/channels/application/rewrap-secrets.ts`). Danach entfällt Version 1.
- **KEK und KMS**: Ein anderes Wrap-Verfahren betrifft nur die Implementierung von `KmsPort`. Der gewrappte DEK darf bis 65.535 Byte lang sein, und der vorhandene Re-Wrap zieht alle Umschläge auf den neuen Schlüssel, ohne Inhalte zu entschlüsseln. Für den Übergang zum KMS (Schritt 8.9) braucht es einen `KmsPort`, der alte Key-IDs mit dem lokalen Keyring öffnet und neue Datenschlüssel mit dem KMS wrappt.
- **Better Auth**: Versionierte Secrets und `pnpm auth:reencrypt` (`apps/api/src/modules/identity/reencrypt-two-factor.ts`) tauschen den Schlüssel; der Job schreibt nur Zeilen, die sich seit dem Lesen nicht geändert haben. Das Verfahren selbst legt Better Auth fest: Für Backup-Codes nähme es eigene Funktionen (`backupCodeOptions.storeBackupCodes`), für das TOTP-Geheimnis nicht. Ein Wechsel kommt dort mit einer Version von Better Auth, danach läuft der Job.
- **Passwörter**: Jeder Hash nennt Verfahren und Parameter. Für höhere Parameter genügt es, `CURRENT` in `packages/crypto/src/password-hash.ts` zu ändern; alte Hashes werden mit ihren eigenen Parametern geprüft (zulässig sind N von 2^10 bis 2^20, r bis 32, p bis 16). Ein neues Verfahren wie Argon2id bekommt ein eigenes Präfix in `verifyPassword`. Damit alte Hashes verschwinden, fehlt ein Rehash nach erfolgreicher Anmeldung (ADR 0039); bis dahin bleiben sie, bis das Passwort geändert oder zurückgesetzt wird.
- **Hashes und Signaturen**: Für den SHA-256 der Einladungs-Tokens gälte ein neues Verfahren für neue Einladungen, und die Annahme prüfte sieben Tage lang beide. HMAC und HS256 von Better Auth, SigV4 und die Signaturen von Stripe legen Bibliotheken und Anbieter fest.
- **Post-Quanten-Verfahren**: Asymmetrische Verfahren nutzt die App selbst nicht. Ein Umstieg betrifft TLS (Schritt 8.9) und den KMS-Anbieter.

## Nicht verwendet

- Keine eigenen kryptografischen Primitive: Verschlüsselung, Hashes, MACs und Zufall kommen aus `node:crypto`, Web Crypto und Bibliotheken (Better Auth mit `@noble/ciphers` und `jose`, die SDKs von AWS und Stripe). Eigener Code setzt sie nur zusammen, etwa zum Format des Umschlags (ASVS V11.2.1).
- Kein ECB und kein Modus ohne Authentisierung: Der eigene Code verschlüsselt nur mit AES-256-GCM. Den Cookie-Cache von Better Auth (JWE) nutzt die App nicht, die Sessions liegen in der Datenbank.
- Kein MD5 im eigenen Code. SHA-1 nur für die Range-API und in TOTP (HMAC-SHA-1 nach RFC 6238), nie als Passwort-Hash oder Signatur.
- Keine umkehrbar gespeicherten Passwörter. Die Zugangsdaten eines X-Logins liegen nur versiegelt im Job und werden nie gespeichert (ADR 0031).
- Keine eigenen asymmetrischen Schlüssel, keine Zertifikate und keine JWT außerhalb von Better Auth.
- Keine Verschlüsselung der Inhalte der Mandanten (Posts, Medien, Analytics) durch die App.
- Kein HMAC-signierter Medien-Proxy (Architektur, Abschnitt 9) und keine Prüfung von `X-Hub-Signature-256`: Beides ist nicht gebaut, und einen Webhook-Endpunkt für Meta gibt es nicht.
- `Math.random` und UUIDs nie für Geheimnisse.
