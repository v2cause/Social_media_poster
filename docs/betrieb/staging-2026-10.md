# Staging aus der Produktions-Vorlage, Oktober 2026

Protokoll zu Schritt 8.9 des Leitfadens, [ADR 0045](../adr/0045-produktions-vorlage.md), [Runbook Deployment](../runbooks/deployment.md). Das Kriterium "Staging aus der Vorlage deployt" ist am 2026-10-19 erfüllt.

## Rahmen

- **Datum**: 2026-10-19, etwa 11:30 bis 13:12 UTC.
- **Maschine**: der Linux-Container dieser Entwicklung mit Docker Engine 29.8.2 und Compose 5.6.0, ohne öffentliche Namen und ohne direkten Weg ins Internet.
- **Vorlage**: `deploy/` auf dem Stand der Commits 7753133 bis fbe1a94, mit `compose.yaml`, `compose.billing.yaml` und `compose.staging.yaml` und den Profilen `backup` und `monitoring`. Das Profil `xb` lief nicht.
- **Images**: api, web, worker, egress-proxy und migrate aus den Dockerfiles der CI, auf der Maschine gebaut (`SMP_REGISTRY=smp-staging`, `SMP_VERSION=staging`, `SMP_VERIFY_IMAGES=false`). Die fremden Images in den Versionen der Vorlage: `caddy:2.11.4-alpine`, `postgres:17.11-alpine`, `redis:7.4.11-alpine`, `chrislusf/seaweedfs:4.48`, `amazon/aws-cli:2.38.1`, `prom/prometheus:v3.13.4`, `prom/alertmanager:v0.34.1`, `prom/pushgateway:v1.11.3`, `prom/blackbox-exporter:v0.28.0` und `axllent/mailpit:v1.31.6`.
- **Einstellungen**: `app.smp-staging.test` und `media.smp-staging.test` mit Caddys eigener CA, Abrechnung an mit Platzhaltern für Stripe, Claude mit einem Platzhalter, Mailpit für App und Alarme, die Backups in einen Bucket des lokalen Speichers mit SSE-S3, `SMP_LOG_DRIVER=local`, `SMP_DISK_ENCRYPTION=staging`.
- **Ablauf**: `init-secrets.sh --staging`, dann `deploy.sh`, nach jeder Korrektur erneut. Insgesamt liefen 20 Container.

## Prüfungen

| Bereich | Vorgehen | Ergebnis |
|---|---|---|
| Deploy | `deploy.sh` mit Preflight, Prüfung der Konfiguration des Monitorings, Start mit `--wait` und den Prüfungen von außen | Bestanden, auch nach jeder Korrektur. Der Preflight warnte wie erwartet vor der ungeprüften Uhr und Platte des Stagings |
| TLS am Rand | `openssl s_client` mit jeder Version und einzelnen Suites | TLS 1.3 und 1.2 mit ECDHE und AES-GCM oder ChaCha20. TLS 1.0 und 1.1 lehnt Caddy mit "protocol version" ab, CBC-Suites und RSA ohne ECDHE mit "handshake failure" |
| Header | `curl` auf beide Namen | HSTS mit einem Jahr und `includeSubDomains` auf App und Speicher, kein `Server`, CSP der Web-App |
| http | Anfragen über Port 80 | Seiten leiten mit 308 auf https um, mit Pfad und Query. `/api/*` und der Speicher antworten mit 403 |
| Rand | Readiness und Methoden | `/api/health/ready` und Varianten wie `/ready/` oder `%72eady` liefern 404. TRACE, PROPFIND und DELETE auf dem Speicher liefern 405 |
| Netze | Verbindungen aus den Containern | Nur Caddy veröffentlicht Ports, dazu im Staging Mailpit auf 127.0.0.1:8025. Worker in `data` und `monitoring` erreichen die API nicht (`ECONNREFUSED`), die Web-App in `edge` schon. Der Worker `media` hat keinen Weg nach außen |
| Client-Adresse | Anmeldung mit gefälschten `X-Real-IP`, `X-Forwarded-For` und `Forwarded` | Die API loggte die echte Adresse des Peers |
| Container | `docker inspect` aller 20 Container | Alle nur lesbar, ohne Capabilities außer den nötigen beim Start der Datenspeicher, `no-new-privileges`. Kein Wert aus `deploy/secrets` in Umgebung oder Konfiguration der Container (153 Werte geprüft) |
| Postgres | Anmeldung je Dienst mit `node-postgres` aus den Containern, `pg_stat_activity` | TLS 1.3 mit `verify-full`. Jeder Dienst mit eigener Rolle, Timeouts wie geplant, RLS greift für `svc_*`. Klartext lehnt `pg_hba.conf` ab, ein falscher Hostname scheitert an der Prüfung des Zertifikats, fremde Logins an der Anmeldung |
| Redis | Anmeldung je Nutzer über TLS | Jeder Dienst ist sein eigener Nutzer, `FLUSHALL` und `CONFIG` scheitern mit `NOPERM`, Klartext wird abgelehnt. Der Integrationstest prüft dieselben Nutzer samt AOF über einen Neustart |
| Speicher | Ports und Anmeldung | Von außen nur das Gateway auf 8333 mit TLS; der gRPC-Port 18333 verlangt ein Client-Zertifikat |
| Egress | Anfragen aus API und Worker | `example.com` lehnt der Egress-Proxy ab (`egress.refused`), direkte Verbindungen scheitern mit `ENETUNREACH`. Erlaubte Hosts sind in diesem Container nicht erreichbar; der Proxy loggt das als `egress.upstream_failed` mit `ENOTFOUND` |
| App | Rauchtest `playwright.staging.config.ts` | Bestanden: Registrierung, Bestätigung über die Mail in Mailpit, Anmeldung, Onboarding, Upload über `media.smp-staging.test`, Prüfung durch den Worker und Vorschaubild von dort |
| Zeitgrenzen | Live-Events 150 s offen; `read_body` kurz auf 5 s gesetzt | Der Stream blieb mit Pings alle 15 s offen. Mit 5 s brach Caddy langsame Uploads an API und Speicher nach 5 s ab; die API sah "request aborted" und verarbeitete nichts. Live-Events über HTTP/1.1 und HTTP/2 liefen weiter. Danach wieder 15 min |
| Monitoring | Prometheus, Alertmanager, Mailpit | Alle zehn Ziele `up`. Der Ablauf von Caddys eigenen Zertifikaten feuerte und kam per STARTTLS als Mail an; danach ging er an den stillen Empfänger, und keine Mail mehr kam |
| Backups | Base-Backup, Kopie, Pushgateway | Base-Backups und WAL lagen mit `ServerSideEncryption: AES256` im Bucket, beide Jobs meldeten Erfolg, `BackupHeartbeatMissing` endete |
| Logs | Treiber der Container | `local`, wie im Staging eingestellt. journald prüft der Preflight nur in Produktion |

## Befunde

Das Staging fand zwölf Fehler der Vorlage, die kein Test gezeigt hatte, der Abgleich mit dem Runbook der Rotation einen dreizehnten. Alle sind behoben; die Liste steht in ADR 0045, Befunde der Staging-Prüfung. Nach der letzten Korrektur (`better_auth_secrets` als Version 1) liefen Deploy und Rauchtest um 13:11 UTC erneut durch.

Daneben fielen auf:
- **Zu junge Versionen**: Mailpit v1.31.6 war in Phase 0 am Tag seines Erscheinens übernommen worden, `amazon/aws-cli:2.38.1` in Schritt 8.6 fünf Tage danach. Beide erfüllen heute die Wartezeit von Renovate (drei Tage); ältere Versionen von aws-cli hätten 23 bekannte Lücken zurückgebracht. Sie bleiben.
- **Eine Zeile außerhalb von pino**: Bricht ein Client mitten im Body ab, schreibt das Routing von Better Auth `# SERVER_ERROR: Error: aborted` direkt nach stderr, zusätzlich zum strukturierten Log. Die Zeile enthält keine Daten der Anfrage.

## Nachtrag: Caddy 2.11.6

Gegen 13:40 UTC ließen sich die neueren Images von Caddy prüfen. 2.11.4 hatte 22 Funde der Stufen HIGH und CRITICAL im Binary, 2.11.6 und 2.11.7 je vier aus Go 1.26.8 und `golang.org/x/net` 0.59.0. Die Vorlage nimmt seit `1707512` Version 2.11.6; 2.11.7 war noch keine zwei Wochen alt. Der Pull des Docker-Daemons scheiterte an Docker Hub noch mit 429. Das Image kam deshalb über `mirror.gcr.io`, mit demselben Digest wie auf Docker Hub (`sha256:d44355d3c214...`).

Um 13:45 UTC lief `deploy.sh` mit Caddy 2.11.6 durch. Danach bestanden:
- TLS 1.3 und 1.2 nur mit ECDHE und AES-GCM oder ChaCha20; CBC-Suites, RSA ohne ECDHE, TLS 1.0 und 1.1 lehnt Caddy ab;
- HSTS und `nosniff` auf beiden Namen, kein `Server`;
- über http 308 für Seiten, 403 für die API und den Speicher;
- 404 für die Readiness samt Varianten, 405 für TRACE, PROPFIND und DELETE;
- Live-Events 50 s lang über HTTP/2 mit Pings alle 15 s;
- der Rauchtest;
- alle zehn Ziele des Monitorings `up`, beide TLS-Proben mit TLS 1.3;
- der Scan aller zehn fremden Images mit `deploy/trivyignore.yaml`, wie im Job `third-party-images`.

## Grenzen

- Keine öffentlichen Namen und keine öffentliche CA: ACME, die Erneuerung und die Alarme mit echten Zertifikaten sind nur in der Vorlage geprüft.
- Kein Weg ins Internet: Claude, Stripe, die Prüfung auf geleakte Passwörter und SMTP-Anbieter waren nicht erreichbar. Die Prüfung auf geleakte Passwörter ließ die Registrierung wie vorgesehen durch.
- Signaturen und SBOM wurden nicht geprüft (`SMP_VERIFY_IMAGES=false`); der Release-Workflow ist noch nicht gelaufen.
- Uhr, Verschlüsselung der Platte und journald prüft der Preflight hier nicht, weil die Maschine sie nicht hat.
- Das Profil `xb` lief nicht; den Browser von X prüfen seine eigenen Tests (Schritt 6.6).
- Keine Last: Die Messungen stammen aus Schritt 8.5 (ADR 0041).
