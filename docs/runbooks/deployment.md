# Deployment mit der Produktions-Vorlage

Schritt 8.9 des Leitfadens, [ADR 0045](../adr/0045-produktions-vorlage.md). Die Vorlage in `deploy/` betreibt die Plattform mit Docker Compose auf einer VM hinter Caddy. Dieses Runbook beschreibt die erste Installation, Updates, Zertifikate, Secrets, Logs, das Monitoring und die Prüfungen nach einem Deploy. Ein Staging auf einer Maschine ohne öffentliche Namen steht am Ende; das Protokoll des ersten Stagings liegt unter [Staging 2026-10](../betrieb/staging-2026-10.md).

## Überblick

- **Von außen erreichbar** ist nur Caddy auf 80 und 443 (auch UDP für HTTP/3). Caddy bedient zwei Namen: `SMP_DOMAIN` für Web-App und API, `SMP_MEDIA_DOMAIN` für den Objektspeicher.
- **Dienste**: zwei Replikas der API, die Web-App, je ein Worker für `scheduler`, `publisher` mit `analytics`, `media`, `notify` und `gdpr` (mit Abrechnung `billing,gdpr`), Postgres, Redis, SeaweedFS und der Egress-Proxy. Die Rolle `ai` hat noch keine Jobs und läuft nicht.
- **Jobs vor dem Start**: `db-roles` legt die Rollen der Datenbank an und setzt ihre Passwörter, `migrate` führt die Migrationen aus, `s3-init` legt den Bucket an.
- **Profile** in `SMP_PROFILES`: `backup` (die Kopie außerhalb der VM, für Produktion Pflicht), `monitoring` (Prometheus, Alertmanager, Pushgateway, Blackbox-Exporter) und `xb` (der Browser von X mit `compose.xb.yaml`). `SMP_BILLING=true` nimmt Stripe dazu (`compose.billing.yaml`).

Alle Befehle unten laufen im Verzeichnis `deploy/` des Repositorys, als root. Für die Kommandos von Compose:

```bash
cd deploy && set -a && . ./.env && set +a
# Dieselben Dateien und Profile, die deploy.sh nimmt (hier Abrechnung, Backup und Monitoring):
dc() { docker compose -f compose.yaml -f compose.billing.yaml --profile backup --profile monitoring "$@"; }
```

## Voraussetzungen der VM

- **Software**: Docker Engine mit dem Compose-Plugin, `openssl`, `curl` und `cosign` 3.1.3 (dieselbe Version wie im Release-Workflow).
- **Netz**: 80 und 443 aus dem Internet, SSH nur aus dem Netz des Betriebs, sonst kein offener Port. Port 80 braucht Caddy für die ACME-Challenges.
- **Namen**: Einträge A und AAAA für beide Namen zeigen vor dem ersten Deploy auf die VM.
- **Uhr**: NTP synchronisiert (`timedatectl` zeigt `NTPSynchronized=yes`); TOTP-Codes und Links hängen daran.
- **Platte**: Das Verzeichnis von Docker (meist `/var/lib/docker`) liegt auf LUKS (`SMP_DISK_ENCRYPTION=luks`), oder der Anbieter der VM verschlüsselt die Platten (`provider`, in dessen Doku nachweisen).
- **journald**: Die Logs der Container gehen nach journald und bleiben 30 Tage.

  ```bash
  install -D -m 0644 host/journald.conf /etc/systemd/journald.conf.d/smp.conf
  systemctl restart systemd-journald
  ```

- **Größe**: Im Staging brauchten die 20 Container im Leerlauf zusammen rund 2 GB Speicher. Die beiden Replikas der API und der Publisher dürfen zusammen 4,5 CPUs nutzen; vier vCPUs und 8 GB Speicher sind das Minimum für Produktion.
- **Platz für Medien**: SeaweedFS legt Volumes von bis zu 30 GiB an. Unter 1 % freiem Platz setzt es alle Volumes auf nur lesen, und Uploads scheitern.

## Erste Installation

1. **Release auschecken**: Das Repository auf dem Tag des Releases, damit `deploy/` zu den Images passt.

   ```bash
   git clone https://github.com/v2cause/Social_media_poster.git /opt/smp && cd /opt/smp
   git checkout v1.2.3
   ```

2. **Einstellungen**: `cp .env.example .env` und die Werte setzen, mindestens `SMP_DOMAIN`, `SMP_MEDIA_DOMAIN`, `SMP_TLS` (die E-Mail des ACME-Kontos), `SMP_VERSION` (der Tag), `MAIL_FROM`, `SMP_EGRESS_HOSTS`, `ALERT_*` und `BACKUP_*`. Die Kommentare in `.env.example` erklären jeden Wert. `.env` enthält keine Secrets.
3. **Secrets und interne CA**: `bash scripts/init-secrets.sh` legt alle Secrets an, die die Plattform selbst erzeugt: Passwörter der Rollen von Postgres und der Nutzer von Redis, die URLs der Dienste, die Schlüssel der App, die Zugangsdaten des Speichers und die private CA mit den Zertifikaten von Postgres, Redis und S3. Eine Datei, die schon existiert, bleibt unverändert.
4. **Secrets der Anbieter**: Das Skript nennt am Ende, was noch fehlt. Jede Datei bekommt genau einen Wert, ohne dass er in der Historie der Shell landet:

   ```bash
   read -rs value && printf '%s\n' "$value" | (umask 0337 && cat > secrets/anthropic_api_key) && unset value
   chown root:10001 secrets/anthropic_api_key
   ```

   | Datei | Inhalt |
   |---|---|
   | `anthropic_api_key` | Schlüssel der Claude API |
   | `smtp_url` | `smtps://nutzer:passwort@smtp.example.com:465` |
   | `alert_smtp_password` | Passwort des SMTP-Kontos von Alertmanager (Profil `monitoring`) |
   | `backup_s3_access_key_id`, `backup_s3_secret_access_key` | Zugang zum Bucket der Backups (Profil `backup`) |
   | `stripe_secret_key`, `stripe_webhook_secret` | nur mit `SMP_BILLING=true` |

5. **Kopie der Schlüssel**: `secrets/` und `generated/` gehören zusätzlich an einen sicheren Ort außerhalb der VM, getrennt von den Backups (etwa ein Passwort-Manager oder ein verschlüsseltes Archiv). Ein Restore braucht die alten Schlüssel ([Backup und Wiederherstellung](backup-restore.md)).
6. **Deploy**: `bash scripts/deploy.sh`. Das Skript
   - prüft mit `scripts/preflight.sh` Werkzeuge, Einstellungen, Secrets und ihre Rechte, Zertifikate, Uhr, Platte, journald und die Namen und bricht bei einem Fehler ab;
   - schreibt die Konfiguration von Blackbox-Exporter und Alertmanager;
   - prüft für jedes Image der Registry die Signatur und das attestierte SBOM des Release-Workflows und zieht die Images;
   - startet Compose mit den Jobs vor API und Worker und wartet, bis alle Dienste gesund sind;
   - prüft von außen: `/api/health/live` mit 200, HSTS, die Umleitung von http für Seiten, 403 der API über http und 404 der Readiness.
7. **Erster Plattform-Admin**: Die Person registriert sich über die Oberfläche, dann setzt der Betrieb das Flag einmal in der Datenbank. Plattform-Admins brauchen einen zweiten Faktor (ADR 0039).

   ```bash
   dc exec postgres sh -c 'PGPASSWORD=$(cat /run/secrets/postgres_password) psql -U postgres -d smp \
     -c "UPDATE users SET is_platform_admin = true WHERE email = '\''ops@example.com'\''"'
   ```

8. **Prüfungen**: wie unter [Prüfungen nach dem Deploy](#prüfungen-nach-dem-deploy).

## Updates

1. Die Notizen des Releases lesen, vor allem zu Migrationen und neuen Einstellungen in `.env.example`.
2. `git fetch --tags && git checkout v1.2.4`, in `.env` `SMP_VERSION=v1.2.4` setzen und neue Einstellungen übernehmen.
3. `bash scripts/deploy.sh`. Der Job `migrate` läuft vor API und Worker; die Migrationen folgen Expand/Contract (Architektur, Abschnitt 12).
4. Die Prüfungen nach dem Deploy.

- **Unterbrechung**: Compose startet geänderte Dienste neu, beide Replikas der API zugleich. Die App ist dabei einige Sekunden nicht erreichbar.
- **Zurück**: `SMP_VERSION` auf den vorigen Tag und `deploy.sh`. Das geht nur, wenn die Migrationen des neueren Releases nur erweitern. Sonst führt der Weg über die [Wiederherstellung](backup-restore.md).

## Zertifikate

### Öffentliche Namen

- Caddy holt die Zertifikate beider Namen über ACME und erneuert sie etwa 30 Tage vor dem Ende. Sie liegen im Volume `caddy-data`.
- **Alarme** (`deploy/monitoring/rules/tls.yml`, Prüfung durch den Blackbox-Exporter):

  | Alarm | Schwere | Bedeutung |
  |---|---|---|
  | `TlsCertificateExpiresSoon` | ticket | Ein Zertifikat endet in weniger als 14 Tagen, seit einer Stunde |
  | `TlsCertificateExpiresVerySoon` | page | Ein Zertifikat endet in weniger als drei Tagen |
  | `TlsProbeFailing` | page | Die Prüfung über https scheitert seit fünf Minuten: Zertifikat ungültig, Caddy aus oder der Name falsch |

- **Bei einem Alarm**:
  1. `dc logs --since 24h caddy | grep -i -E 'acme|certificate|tls'` zeigt, woran die Erneuerung scheitert.
  2. Beide Namen zeigen auf die VM (`dig +short app.example.com`), und 80 und 443 sind von außen erreichbar.
  3. Meldet die CA ein Rate-Limit, warten; bei Let's Encrypt dauert das bis zu eine Woche.
  4. `dc restart caddy` versucht es sofort neu.
  5. `TlsProbeFailing`: `curl -sv https://$SMP_DOMAIN/api/health/live -o /dev/null` von außen zeigt das Zertifikat und den Fehler.

### Interne CA

- `init-secrets.sh` stellt Postgres, Redis, S3 und im Staging Mailpit Zertifikate für zwei Jahre aus, die CA gilt zehn Jahre. Der Preflight warnt 60 Tage vor dem Ende eines Zertifikats.
- **Neue Zertifikate**, die CA bleibt: `bash scripts/init-secrets.sh --renew-tls && bash scripts/deploy.sh`. Die Hash-Labels starten die Dienste mit den neuen Dateien.
- **Neue CA**: `secrets/ca` und `generated/tls` beiseite legen, `init-secrets.sh` und `deploy.sh` ausführen. Alle Dienste starten neu, weil sich die CA ändert.

### Staging

Mit `SMP_TLS=internal` stellt Caddy selbst aus, für 12 Stunden. Die Alarme zum Ablauf gehen dort an einen stillen Empfänger; `TlsProbeFailing` meldet weiter.

## Secrets und Rotation

- Jedes Secret ist eine Datei in `secrets/`, Eigentümer root, Gruppe 10001, Modus 0440. Die Container lesen sie über `<NAME>_FILE`; keine steht in der Umgebung eines Containers.
- Die Rotation beschreibt das Runbook [Secret-Rotation](secret-rotation.md), Abschnitt zur Vorlage.
- `deploy.sh` bildet je Gruppe von Diensten (Caddy, Datenspeicher, App, Monitoring) einen Hash über die Dateien hinter Secrets und Konfigurationen. Ändert sich eine Datei, startet Compose die Dienste ihrer Gruppe neu; ein Secret in `secrets/` startet alle Dienste der App. Ein `docker compose up` an `deploy.sh` vorbei kennt diese Hashes nicht und startet nach einer Rotation nichts neu.
- Es gibt keinen KMS: Die Schlüssel liegen als Dateien auf der VM (ADR 0045).

## Logs

- Docker schreibt die Logs aller Container nach journald. Sie bleiben 30 Tage, höchstens 8 GB; ein Schub von Logs kann die Frist verkürzen.
- Lesen dürfen root und die Gruppe `systemd-journal`:

  ```bash
  journalctl CONTAINER_NAME=smp-api-1-1 --since '1 hour ago' -o cat
  dc logs --since 1h worker-publisher
  ```

- Traces und Fehlerberichte gehen nur an ein Backend, wenn `OTEL_EXPORTER_OTLP_ENDPOINT` oder `SENTRY_DSN` gesetzt ist. Dessen Frist von höchstens 30 Tagen stellt der Betrieb dort ein.

## Monitoring

- Prometheus (30 Tage), Alertmanager, Pushgateway und Blackbox-Exporter haben keine veröffentlichten Ports. Abfragen laufen über die Container:

  ```bash
  dc exec prometheus wget -qO- 'http://localhost:9090/api/v1/alerts'
  dc exec alertmanager amtool alert query --alertmanager.url=http://localhost:9093
  dc exec alertmanager amtool silence add alertname=TlsCertificateExpiresSoon \
    --comment='Ticket 123' --duration=2h --alertmanager.url=http://localhost:9093
  ```

- Alertmanager mailt jeden Alarm an `ALERT_TO` und verlangt dafür TLS. Einen Pager hat die Vorlage nicht.
- Die Alarme und ihre Runbooks stehen in der [Übersicht](alarme.md).

## Backups

- Das Profil `backup` archiviert das WAL, zieht täglich ein Base-Backup und kopiert beides alle `BACKUP_SYNC_SECONDS` Sekunden in `BACKUP_S3_BUCKET`.
- **Der Bucket** liegt außerhalb der VM, mit Versionierung und einer Regel zum Ablauf, die länger hält als `BACKUP_KEEP` Tage. Der Zugang darf nur schreiben, lesen und auflisten; die Kopie löscht nie.
- `BACKUP_S3_SSE` (AES256 oder aws:kms) lässt den Speicher jedes Objekt verschlüsseln; leer schickt keinen Header.
- Wiederherstellung und Probe: [Backup und Wiederherstellung](backup-restore.md).

## Prüfungen nach dem Deploy

1. `deploy.sh` endet mit `deploy: <Version> runs on https://...`; seine Prüfungen von außen sind bestanden.
2. `dc ps`: Alle Dienste sind `healthy` oder `running`, die Jobs `db-roles`, `migrate` und `s3-init` mit 0 beendet.
3. **Rollen der Worker** (`WORKER_ROLES`, siehe [Hängende Queue](haengende-queue.md)): Jeder Worker meldet seine Rollen beim Start.

   ```bash
   for worker in scheduler publisher media notify billing; do
     dc logs worker-$worker | grep -m1 worker.started
   done
   ```

4. **Monitoring**: Alle Ziele in Prometheus sind `up`, und es feuert kein unbekannter Alarm.

   ```bash
   dc exec prometheus wget -qO- 'http://localhost:9090/api/v1/query?query=up==0'
   ```

5. **Stichprobe** in der App: Anmeldung, ein Bild in die Mediathek, ein Entwurf.

## Staging auf einer Maschine

Ein Staging prüft die Vorlage ohne öffentliche Namen ([Protokoll vom 2026-10-19](../betrieb/staging-2026-10.md)).

- **Einstellungen** in `.env`: `SMP_STAGING=true`, `SMP_TLS=internal`, `SMP_DISK_ENCRYPTION=staging`, `SMP_LOG_DRIVER=local` ohne journald, `SMP_VERIFY_IMAGES=false` für Images, die auf der Maschine gebaut sind, `ALERT_SMTP_SMARTHOST=mailpit:1025`, `ALERT_SMTP_CA_FILE=/run/configs/internal-ca.crt`, `BACKUP_S3_ENDPOINT=https://s3:8333` und `BACKUP_S3_SSE=AES256`.
- **Secrets**: `bash scripts/init-secrets.sh --staging` legt dazu das Zertifikat von Mailpit und den Schlüssel an, mit dem SeaweedFS die Backups verschlüsselt. `smtp_url` ist `smtp://mailpit:1025`, die Zugangsdaten der Backups sind die von `s3_init`, und die Anbieter bekommen Platzhalter.
- **Images**: aus den Dockerfiles der CI bauen und als `$SMP_REGISTRY/<name>:$SMP_VERSION` taggen.
- **Zugriff**: Die Namen zeigen über `/etc/hosts` des Rechners auf die Maschine; die Oberfläche von Mailpit liegt auf 127.0.0.1:8025 (per SSH-Tunnel).
- **Rauchtest**: Registrierung mit der Mail aus Mailpit, Onboarding und ein Upload über den Namen des Speichers.

  ```bash
  STAGING_IP=203.0.113.10 pnpm --filter @smp/web exec playwright test -c playwright.staging.config.ts
  ```

## Grenzen

Was die Vorlage bewusst offen lässt, steht mit Wiedervorlage in ADR 0045, Restrisiken: Klartext zwischen Caddy, Web und API auf demselben Host, kein KMS, kein Pager, eine VM ohne Failover und die Updates der fremden Images.
