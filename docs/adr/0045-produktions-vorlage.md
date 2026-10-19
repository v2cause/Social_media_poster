# ADR 0045: Produktions-Vorlage mit Compose und Caddy auf einer VM

- **Status**: Akzeptiert
- **Datum**: 2026-10-19
- **Bezug**: Umsetzungsleitfaden, Schritt 8.9; `docs/ARCHITECTURE.md`, Abschnitte 2, 10 und 12; [Runbook Deployment](../runbooks/deployment.md); [Staging-Protokoll](../betrieb/staging-2026-10.md); [ADR 0039](0039-security-review-und-haertung.md) (verschobene Punkte), [ADR 0041](0041-lasttest.md) (zwei Replikas der API), [ADR 0042](0042-backup-und-wiederherstellung.md), [ADR 0043](0043-slos-metriken-und-alarme.md)

## Kontext

Schritt 8.9 verlangt eine Produktions-Vorlage, etwa Compose für eine VM mit Caddy und TLS oder ein Helm-Chart. Fertig ist er, wenn ein Staging aus der Vorlage deployt ist.

Die Sicherheitsprüfung hat die Härtung von Transport und Betrieb auf diesen Schritt verschoben (ADR 0039, Verschoben): TLS mit öffentlicher CA und Überwachung des Ablaufs, TLS nach innen, nur der Proxy vor API und Web, eine Allowlist für ausgehende Verbindungen, Secrets ohne Umgebung, Identitäten je Dienst, Readiness nur intern, eine Grenze für die Dauer von Uploads, Logs mit Frist, verschlüsselte Datenträger und signierte Images.

Bis hierhin lief alles nur in `compose.yaml`, gebaut für die Entwicklung: Ports auf 127.0.0.1, ein Datenbanknutzer je Art, Passwörter in `.env`.

## Entscheidung

Die Vorlage ist Docker Compose auf einer VM hinter Caddy, in `deploy/`. Die Wahl ist am 2026-10-19 so abgestimmt worden, wie der Leitfaden es verlangt; ein Helm-Chart lohnt sich erst mit mehreren Hosts.

### Aufbau

- `compose.yaml` mit allen Diensten, `compose.billing.yaml` für Stripe, `compose.xb.yaml` für den Browser von X (Profil `xb`), `compose.staging.yaml` für ein Staging auf einer Maschine.
- `scripts/init-secrets.sh` legt Secrets und interne Zertifikate an, `scripts/preflight.sh` prüft VM und Einstellungen, `scripts/deploy.sh` startet ein Release, `scripts/render-monitoring.sh` schreibt die Konfiguration von Blackbox-Exporter und Alertmanager aus `deploy/.env`.
- Ein Release ist ein Tag `v*`. Seine sechs Images (api, web, worker, egress-proxy, migrate, browser-worker) baut `.github/workflows/release.yml`.

### Netze

Alle Netze außer `public` und `outbound` sind `internal`: Docker gibt ihnen keinen Weg nach außen.

| Netz | Wer darin hängt | Zweck |
|---|---|---|
| `public` | caddy | Die einzigen veröffentlichten Ports: 80, 443 und 443/udp |
| `edge` | caddy, web, api-1, api-2, blackbox | Der Weg vom Proxy zur App. Die Replikas der API haben feste Adressen (`.11`, `.12`) |
| `media` | caddy, s3, blackbox | Der Name des Speichers für Browser und Plattformen |
| `data` | api, worker, postgres, redis, s3, Jobs | Datenbank, Redis und Speicher |
| `egress` | api, worker außer media, egress-app | Der einzige Weg nach außen, über den Egress-Proxy |
| `monitoring` | api, worker, postgres (für die Backups), prometheus, alertmanager, pushgateway, blackbox | Metriken und Alarme |
| `xb` | redis, browser-worker, egress-xb | Der Browser von X (ADR 0030) |
| `outbound` | egress-app, egress-xb, alertmanager, backup-sync | Netz mit Weg ins Internet |

- **Nur der Proxy vor API und Web**: Die API bindet über `API_HOST` nur an ihre Adresse im Netz `edge`. Ein Worker im Netz `data` bekommt `ECONNREFUSED`, auch wenn er die Adresse kennt. Darauf beruht das Vertrauen in `X-Real-IP`, das Caddy immer überschreibt (ADR 0006).
- **Readiness intern**: Caddy antwortet auf `/api/health/ready*` mit 404. Docker und das Monitoring fragen die Dienste direkt im Netz.

### TLS

- **Am Rand**: Caddy terminiert TLS 1.2 und 1.3 mit Zertifikaten einer öffentlichen CA über ACME und erneuert sie selbst (`SMP_TLS` ist die E-Mail des ACME-Kontos). Bei TLS 1.2 nimmt Caddy nur ECDHE mit AES-GCM oder ChaCha20 an. HSTS gilt ein Jahr mit `includeSubDomains`, auch für den Speicher.
- **http**: Nur die Seiten der App leiten mit 308 auf https um. `/api/*` und der Name des Speichers antworten über http mit 403 (ASVS 4.1.2): Wer eine Anfrage über http schickt, merkt es sofort, statt der Umleitung zu folgen.
- **Ablauf**: Der Blackbox-Exporter prüft beide Namen durch Caddy. `TlsCertificateExpiresSoon` (unter 14 Tagen, ticket), `TlsCertificateExpiresVerySoon` (unter drei Tagen, page) und `TlsProbeFailing` (page) stehen in `deploy/monitoring/rules/tls.yml`, mit Unit-Tests.
- **Nach innen**: Eine private CA aus `init-secrets.sh` (P-256, zehn Jahre) stellt Postgres, Redis und dem S3-Gateway Serverzertifikate für zwei Jahre aus.
  - Postgres nimmt nur TLS mit SCRAM an (`pg_hba.conf`), die Dienste prüfen mit `sslmode=verify-full`.
  - Redis hört nur auf TLS (`--port 0`).
  - Das S3-Gateway von SeaweedFS spricht TLS. Master, Volume und Filer hören nur auf 127.0.0.1, und gRPC verlangt Client-Zertifikate der privaten CA (`seaweedfs/security.toml`).
  - Node vertraut der privaten CA über `NODE_EXTRA_CA_CERTS`.
- **Klartext bleibt** zwischen Caddy, Web und API im Netz `edge` und für die Abfragen von Prometheus. Alle diese Verbindungen bleiben auf einem Host (siehe Restrisiken).

### Identitäten je Dienst

- **Postgres** (`postgres/roles.sh`, bei jedem Deploy): Jeder Dienst meldet sich mit eigenem Login an, `svc_<dienst>` in der Gruppe `app_user` mit Row-Level Security, und wo er `@SystemScope()` braucht, `svc_<dienst>_system` mit `BYPASSRLS`. Jeder Login hat eine Grenze für Verbindungen und Timeouts. `app_migrator` besitzt die Datenbank und führt nur die Migrationen aus; `svc_backup` darf nur replizieren.
- **Redis** (`redis/users.acl`): Ein Nutzer je Dienst ohne `@dangerous`, `health` darf nur `PING`, der browser-worker behält seine Schlüssel und Kanäle (ADR 0030). `default` ist aus und behält seine Regeln, damit Redis das AOF abspielen kann (ADR 0039).
- **Speicher**: Die App hat Lesen und Schreiben auf `smp-media`, nur der Job `s3-init` hat Admin.

### Secrets und Schlüssel

- Jedes Secret ist eine Datei in `deploy/secrets` (Eigentümer root, Gruppe 10001, Modus 0440), die Dienste lesen sie über `<NAME>_FILE`. Keines steht in `.env`, in der Umgebung eines Containers oder in `docker inspect`.
- Die Container laufen mit der zusätzlichen Gruppe 10001; der Preflight bricht ab, wenn eine Datei für andere lesbar ist oder die Gruppe fehlt.
- Die E-Mail-Jobs haben ihren eigenen Keyring `NOTIFY_KEKS` (Schritt 8.9c), die IDs der aktiven Schlüssel stehen in `generated/keyring.env`.
- **Kein KMS**: Die KEKs liegen als Dateien auf der VM, nicht in einem KMS oder Vault. Eine VM ohne Cloud-Konto hat keinen KMS, der stärker schützt als die Rechte der Dateien und die verschlüsselte Platte; ein Adapter für `KmsPort` bleibt möglich, sobald ein Anbieter feststeht.
- **Neue Werte wirken**: `deploy.sh` bildet je Gruppe von Diensten (Caddy, Datenspeicher, App, Monitoring) einen Hash über die Dateien hinter ihren Secrets und Konfigurationen und schreibt ihn in ein Label (`smp.files`). Ändert sich eine Datei, startet Compose die Dienste ihrer Gruppe neu; ein Secret in `deploy/secrets` startet alle Dienste der App.
- **Versionen des Auth-Schlüssels**: `better_auth_secrets` beginnt als Version 1 von `better_auth_secret`; eine Rotation stellt die nächste Version voran (ADR 0039, Runbook Secret-Rotation).

### Ausgehende Verbindungen

- API und Worker erreichen das Internet nur über `egress-app`, den Egress-Proxy aus Schritt 6.2 mit der Policy `hosts`: nur die Hosts aus `SMP_EGRESS_HOSTS`, auf 443 oder mit ausdrücklichem Port. Alles andere lehnt er vor dem Verbindungsaufbau mit 403 ab.
- Er loggt Ablehnungen (`egress.refused`) und Verbindungen zu erlaubten Hosts, die scheitern (`egress.upstream_failed`), mit Host, Port und Fehlercode, nie mit Pfad.
- Der Worker der Rolle `media` hat keinen Weg nach außen.

### Grenzen am Rand

- Caddy lässt nur die Methoden der App durch, die API nimmt höchstens 1 MB, der Speicher 21 MB je Anfrage.
- **Dauer der Uploads**: `read_body 15m` beendet jede Anfrage, deren Body nach 15 Minuten nicht gelesen ist. Der Link eines Uploads gilt fünf Minuten und der Job `media.drop-upload` läuft nach 65 Minuten; kein PUT überlebt ihn mehr (ADR 0039, Restrisiken). Server-Sent Events betrifft das nicht, ebenso wenig `idle 2m`.

### Logs, Zeit und Datenträger

- **Logs**: Docker schreibt die Logs der Container in journald auf dem Host. `host/journald.conf` hält sie 30 Tage, komprimiert und höchstens 8 GB; lesen dürfen sie root und die Gruppe `systemd-journal`. Ohne diese Datei bricht der Preflight ab.
- **Traces und Fehlerberichte** gehen nur, wenn `OTEL_EXPORTER_OTLP_ENDPOINT` oder `SENTRY_DSN` gesetzt sind. Die Frist von höchstens 30 Tagen stellt das Backend ein; die Vorlage kann sie nicht erzwingen.
- **Zeit**: Der Preflight verlangt eine synchronisierte Uhr (`timedatectl`, `NTPSynchronized=yes`).
- **Datenträger**: `SMP_DISK_ENCRYPTION=luks` lässt den Preflight prüfen, dass das Verzeichnis von Docker auf einem dm-crypt-Gerät liegt; `provider` verlässt sich auf den Anbieter der VM und warnt.
- **Backups**: Die Kopie in den Bucket außerhalb der VM verlangt mit `BACKUP_S3_SSE` die Verschlüsselung jedes Objekts (ADR 0042).

### Images und Lieferkette

- **Release**: Ein Tag `v*` baut die sechs Images, scannt sie wie die CI und schiebt sie nach `ghcr.io/v2cause/social_media_poster`. cosign signiert jeden Digest ohne eigenen Schlüssel über die OIDC-Identität des Workflows und hängt das SBOM (CycloneDX) als Attestierung an. Trivy und cosign sind über Prüfsummen gepinnt.
- **Prüfung beim Start**: `deploy.sh` prüft für jedes Image der Registry Signatur und Attestierung gegen genau diesen Workflow und Tags `v*`. Nur ein Staging mit Images, die auf der Maschine gebaut sind, setzt `SMP_VERIFY_IMAGES=false`.
- **Fremde Images** (ASVS 15.2.1): Der CI-Job `third-party-images` scannt jedes Image mit festem Namen aus `deploy/compose*.yaml` mit derselben Schwelle, auch wöchentlich. `deploy/trivyignore.yaml` nimmt Funde des Scans vom 2026-10-19 hin, je Binary oder Paket eines Images, mit Begründung und Ablauf nach den Fristen aus ADR 0039.

### Monitoring

- Das Profil `monitoring` startet Prometheus (30 Tage), Alertmanager, das Pushgateway und den Blackbox-Exporter, alle ohne veröffentlichte Ports.
- Alertmanager schickt die Alarme an das SMTP-Konto des Betriebs und verlangt TLS. Mit Caddys eigener CA (Staging) gehen die Alarme zum Ablauf an einen stillen Empfänger, weil Caddy diese Zertifikate alle 12 Stunden selbst erneuert; `TlsProbeFailing` meldet weiter.
- `tools/observability/check-rules.sh` prüft die Konfiguration, die Tests der Regeln und die Routen beider Varianten.

### Staging

`compose.staging.yaml` unterscheidet sich von Produktion nur in diesen Punkten:
- Caddys eigene CA statt einer öffentlichen (`SMP_TLS=internal`);
- Mailpit im Netz, mit STARTTLS und einem Zertifikat der privaten CA, statt eines SMTP-Anbieters;
- die Backups in einem Bucket des lokalen Speichers, den SeaweedFS mit einem eigenen Schlüssel verschlüsselt (SSE-S3);
- Logs mit dem Treiber `local` und Datenträger ohne Prüfung, wenn die Maschine kein journald und keine verschlüsselte Platte hat.

`apps/web/playwright.staging.config.ts` führt den Rauchtest `e2e/staging.smoke.ts` gegen ein Staging aus.

Das Staging dieses Schritts lief ohne Internet, mit Platzhaltern für Claude und Stripe und den Mocks der Plattformen. Das Staging der Architektur (Abschnitt 12, Umgebungen) mit echten Plattform-Apps im Dev-Modus, Stripe im Testmodus und Claude mit Ausgabenlimit nutzt dieselbe Vorlage mit echten Schlüsseln, sobald die Apps freigegeben sind.

## Befunde der Staging-Prüfung

Das Staging vom 2026-10-19 lief in diesem Container ([Protokoll](../betrieb/staging-2026-10.md)). Diese Fehler der Vorlage fanden erst das Staging und der Abgleich mit den Runbooks; alle sind behoben:

1. Container in den Netzen `data` und `monitoring` erreichten die API direkt, weil sie auf 0.0.0.0 hörte. Seitdem bindet sie über `API_HOST` an ihre Adresse im Netz `edge`.
2. Die zweite Replika verlor ihre ganze Umgebung, weil YAML-Merge flach ist und ihr `environment` die Liste der ersten ersetzte. Beide nutzen jetzt einen gemeinsamen Anker.
3. Caddy lief nach einer geänderten Konfiguration mit der alten weiter, weil Compose einen Dienst nur bei geänderter Definition neu startet. Seitdem gibt es die Hash-Labels, auch für das Monitoring.
4. Die Readiness war von außen erreichbar: Ein `respond` außerhalb von `handle` greift erst nach den `handle`-Blöcken.
5. Der gRPC-Port 18333 des S3-Gateways nahm Verbindungen ohne Anmeldung an und hätte die Identitäten ersetzen können. Seitdem verlangt er Client-Zertifikate; die Ports für Iceberg und Lance sind aus.
6. Die Kopie der Backups mit `--sse=AES256` scheiterte mit 500, weil SeaweedFS ohne Schlüssel kein SSE-S3 kann. Das Staging gibt ihm jetzt einen eigenen Schlüssel.
7. Die Alarme zum Ablauf der Zertifikate feuerten im Staging dauernd, weil Caddys eigene CA nur 12 Stunden ausstellt. Sie gehen dort an einen stillen Empfänger.
8. Mailpit veröffentlichte seine Oberfläche nicht: Docker veröffentlicht keine Ports eines Containers, der nur in internen Netzen hängt.
9. Der Egress-Proxy schwieg zu Verbindungen, die nach außen scheiterten; die Prüfung auf geleakte Passwörter fiel ohne Spur auf "nicht geleakt" zurück. Er loggt sie jetzt.
10. Die API leitete über http auf https um. Sie antwortet dort jetzt mit 403.
11. Der Hilfscode der E2E-Tests fand nur Links mit `http://` in den Mails.
12. Die fremden Images hatten bekannte Lücken der Stufen HIGH und CRITICAL, die niemand prüfte. Seitdem gibt es den Job `third-party-images`.
13. Beim Abgleich mit dem Runbook der Rotation fiel auf, dass die Vorlage nur `BETTER_AUTH_SECRET` an die API gab; eine Rotation mit Versionen hätte `compose.yaml` ändern müssen. Seitdem beginnt `better_auth_secrets` als Version 1, und der Rauchtest lief damit erneut durch.

## Restrisiken und Wiedervorlage

| Thema | Entscheidung und Begründung | Ausgleich | Wiedervorlage |
|---|---|---|---|
| Klartext zwischen Caddy, Web und API sowie für Prometheus (ASVS 12.3.3) | Alle diese Verbindungen bleiben auf einem Host, in internen Netzen ohne Weg nach außen. | Nur Caddy, Web, API und der Blackbox-Exporter hängen in `edge` | Sobald die Vorlage mehr als einen Host hat |
| Kein KMS | Siehe Secrets und Schlüssel | Rechte der Dateien, verschlüsselte Platte, Rotation nach Runbook | Mit einem Cloud-Anbieter oder Vault |
| Öffentliche CA nur in der Vorlage geprüft | Das Staging hatte keine öffentlichen Namen und lief mit Caddys eigener CA. | Caddy holt Zertifikate seit Jahren selbst; der Blackbox-Exporter prüft sie | Beim ersten Deploy mit echten Namen |
| Release-Workflow noch nicht gelaufen | Ein Tag erzeugt dauerhafte Einträge im öffentlichen Transparenzlog von Sigstore und Pakete in GHCR; das erste Release wird deshalb eigens abgestimmt. | Der Workflow prüft Signatur und Attestierung wie `deploy.sh`; actionlint prüft ihn | Mit dem ersten Release |
| Lücken in fremden Images | Caddy 2.11.6 hat noch drei Funde der Stufe HIGH am öffentlichen Rand, aus Go 1.26.8 und `golang.org/x/net` 0.59.0; auch 2.11.7 hat sie, eine Version mit den Fixes gibt es noch nicht (2.11.4 hatte 22). Für Blackbox-Exporter und Pushgateway gibt es Versionen mit den Fixes. | Ausnahmen mit Ablauf in `deploy/trivyignore.yaml`; der wöchentliche Scan scheitert danach | Blackbox-Exporter und Pushgateway bis 2026-11-06, Caddy, SeaweedFS, Prometheus und Alertmanager bis 2026-11-18 |
| Tags statt Digests für fremde Images | Die offiziellen Images bauen ihre Tags neu, ein Scan kann ein anderes Image sehen als der Deploy. | Der wöchentliche Scan liest das aktuelle Image | Mit Renovate und Digest-Pinning (ADR 0009) |
| Speichergrenzen nur für API, Web, Media und Publisher | Für die übrigen Dienste fehlen Messungen unter Last. | Im Staging brauchen alle 20 Container zusammen rund 2 GB | Mit dem nächsten Lasttest |
| Eine VM | Kein zweiter Host, kein automatisches Failover. | Backups außerhalb der VM, RTO 4 h (ADR 0042) | Wenn die Verfügbarkeit mehr verlangt |
| Kein Pager | Alarme der Stufe `page` gehen wie alle anderen per E-Mail. | Wiederholung jede Stunde | Mit der Bereitschaft des Betriebs |
| Metriken im Netz `monitoring` lesbar | Die Worker hängen im selben Netz wie Prometheus und können die Metriken der API lesen. | Die Metriken enthalten keine Mandanten und keine Secrets (ADR 0043) | Bei Metriken mit vertraulichem Inhalt |
| Session-Keyring in der API ohne Browser von X | Die API bekommt `SESSION_KEKS` auch, wenn der Browser von X aus ist; sie braucht ihn nur mit `FEATURE_X_BROWSER_GLOBAL`. | Die Datei lesen nur root und die Gruppe 10001 | Mit dem nächsten Umbau der Vorlage nach `compose.xb.yaml` verschieben |
| TLS zu den Datenspeichern nur in der Vorlage erzwungen | Die Regeln der App für Produktion nehmen auch `redis://`, URLs ohne `sslmode` und http für S3; nur die Vorlage setzt TLS. | Vorlage und Preflight | Die Regeln verschärfen, sobald die E2E-Tests der CI mit TLS laufen |
| CBC-Suites ausgehend (ASVS 12.1.2) | Node lässt ausgehend noch CBC-Suites zu, die nur ein Server ohne AEAD wählt. | Die bekannten Gegenstellen handeln AEAD aus | `--tls-cipher-list` in den Images |

## Alternativen

- **Helm-Chart für Kubernetes**: Skaliert über Hosts, verlangt aber einen Cluster, den es noch nicht gibt. Die Trennung in Netze, Secrets als Dateien und signierte Images lassen sich übertragen.
- **Traefik statt Caddy**: Gleichwertig bei ACME. Caddy lief schon im Profil `app` der Entwicklung (Schritt 0) und braucht keine Labels an den Diensten.
- **Secrets in der Umgebung** wie in der Entwicklung: Sie stünden in `docker inspect` und in jedem Kindprozess. Dateien zeigen nur ihren Pfad.

## Konsequenzen

- **Positiv**:
  - Die verschobenen Punkte aus ADR 0039 sind umgesetzt, bis auf KMS und internes TLS für HTTP, die als Restrisiko stehen.
  - Ein Deploy ist ein Befehl, der vorher prüft und nachher von außen testet.
  - Jeder Dienst sieht nur die Netze, Secrets und Rechte, die er braucht.
- **Negativ**:
  - Die Vorlage hat mehr Teile als die Entwicklung: 20 Container im Staging, eine private CA, die nach zwei Jahren erneuert werden muss, und Hash-Labels, die nur `deploy.sh` setzt. Ein `docker compose up` an `deploy.sh` vorbei startet nach einer Rotation nichts neu.
  - Die Images fremder Anbieter brauchen regelmäßige Updates; die Ausnahmen laufen bewusst schnell ab.
