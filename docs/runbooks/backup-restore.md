# Runbook: Backup und Wiederherstellung

Schritt 8.6 des Leitfadens, [ADR 0042](../adr/0042-backup-und-wiederherstellung.md). Dieses Runbook beschreibt, was gesichert wird, wie die Sicherung läuft und überwacht wird, wie die Restore-Probe läuft und wie eine Wiederherstellung abläuft: auf einen Zeitpunkt vor einem Fehler oder nach dem Verlust des Hosts.

## Ziele

- **RPO 15 min**: Bei einem Ausfall gehen höchstens die Daten der letzten 15 Minuten verloren.
- **RTO 4 h**: Spätestens vier Stunden nach der Entscheidung, wiederherzustellen, läuft die Plattform wieder.

Wie die Sicherung beide Ziele erreicht und was die Restore-Probe gemessen hat, steht in ADR 0042, Abschnitt "Nachweis".

## Was gesichert wird

| Daten | Sicherung | Aufbewahrung |
|---|---|---|
| Postgres | WAL-Archiv laufend, Base-Backup täglich, beides alle 5 Minuten in den Bucket der Backups kopiert | Lokal die neuesten 7 Base-Backups und das WAL seit dem ältesten, im Bucket 14 Tage |
| Redis | Keine eigene; AOF übersteht Neustarts | Postgres ist die Quelle der Wahrheit: Scheduler und Sweeper stellen die Queues wieder her, Caches und Zähler füllen sich neu |
| Medien und Exporte im Objektspeicher | Keine eigene; der Anbieter speichert redundant | Ohne Versionierung, weil gelöschte Medien innerhalb einer Stunde endgültig weg sind ([ADR 0038](../adr/0038-aufbewahrungsfristen.md)) |
| Secrets (`.env`, KEKs, Passwörter) | Im Secret-Store des Deployments (Schritt 8.9), nie im Bucket der Backups | Alte KEKs und alte Schlüssel aus `BETTER_AUTH_SECRETS` bleiben dort, bis die letzte Sicherung mit ihnen abgelaufen ist |

Die Sicherungen enthalten auch Daten, die inzwischen gelöscht sind, bis zu ihrem eigenen Ablauf nach 14 Tagen ([ADR 0037](../adr/0037-loeschung-von-organisationen.md)).

## Einrichtung

1. In `.env` `PG_ARCHIVE_MODE=on` setzen und `docker compose up -d postgres` ausführen. Postgres startet dann mit Archivierung neu.
2. Den Bucket der Backups einrichten (in Produktion beim Anbieter, lokal legt ihn `s3-init` an):
   - ein eigener Bucket in der EU, nicht der der Medien;
   - ein eigenes Schlüsselpaar mit Lesen, Schreiben und Auflisten, ohne Löschen; die Kopie löscht nie;
   - Versionierung an, eine Ablaufregel für alles unter `postgres/` nach 14 Tagen und für alte Versionen nach einem Tag;
   - Verschlüsselung at rest ([ADR 0039](../adr/0039-security-review-und-haertung.md), Schritt 8.9);
   - wer sich auch gegen einen übernommenen Host schützen will, schaltet Object Lock im Modus Compliance für 14 Tage ein.
3. `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`, `BACKUP_S3_REGION`, `BACKUP_S3_ACCESS_KEY_ID` und `BACKUP_S3_SECRET_ACCESS_KEY` setzen. `BACKUP_KEEP` (7), `BACKUP_INTERVAL_HOURS` (24) und `BACKUP_SYNC_SECONDS` (300) haben passende Standardwerte. Die Ablaufregel des Buckets muss länger sein als die lokale Aufbewahrung, sonst lädt die Kopie abgelaufene Dateien erneut hoch.
4. `docker compose --profile backup up -d postgres-backup backup-sync` ausführen.

Danach läuft Folgendes:
- Postgres legt jedes fertige WAL-Segment komprimiert in das Volume `postgres-archive`, spätestens 60 s nach dem letzten (`archive_timeout`).
- `postgres-backup` zieht beim Start und danach alle 24 Stunden ein Base-Backup nach `postgres-backups/base/<UTC-Startzeit>`, behält die neuesten sieben und löscht das WAL vor dem ältesten.
- `backup-sync` kopiert alle 5 Minuten die fertigen Base-Backups und das Archiv nach `s3://<Bucket>/postgres/` und schreibt die Uhrzeit der Kopie nach `postgres/last-sync`.

## Überwachung

Schritt 8.7 alarmiert auf diese Werte ([Übersicht der Alarme](alarme.md)). Dafür melden `postgres-backup` und `backup-sync` jede erfolgreiche Runde an das Pushgateway des Profils `observability` (`BACKUP_PUSHGATEWAY_URL=http://pushgateway:9091` in `.env`):

- **Archivierung** (`WalArchivingFailing`, page): In `pg_stat_archiver` ist `last_archived_time` bei Last höchstens 2 Minuten alt, und `failed_count` steigt nicht. Scheitert die Archivierung, wächst `pg_wal`, bis der Datenträger voll ist.
  ```bash
  docker compose exec postgres sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U postgres -d smp \
    -c "SELECT last_archived_wal, last_archived_time, failed_count, last_failed_time FROM pg_stat_archiver"'
  ```
- **Kopie** (`BackupCopyStale`, page; `BackupHeartbeatMissing`, page, wenn sich die Kopie bei eingeschaltetem Archiv nie meldet): `postgres/last-sync` im Bucket und die letzte Meldung sind höchstens 15 Minuten alt. Sonst wächst das RPO, falls der Host verloren geht.
- **Base-Backup** (`BaseBackupStale`, ticket): Das neueste ist höchstens 25 Stunden alt.
  ```bash
  docker compose exec -u postgres postgres-backup ls -1 /var/lib/postgresql/backups/base
  ```
- **Logs**: `backup-loop: the base backup failed` und `backup-sync: the copy failed`.
- **Platz**: die Volumes `postgres-archive` und `postgres-backups`.

Befehle in `postgres-backup` laufen mit `-u postgres`: Der Container hat nur die Rechte, die Volumes an `postgres` zu übergeben, und root darf deren Inhalt nicht lesen.

## Restore-Probe

`pnpm backup:drill` (nach `pnpm build`, mit `.env`) übt die Wiederherstellung in einem eigenen Compose-Projekt `smp-drill`, neben dem lokalen Stack:

1. Postgres mit Archivierung, Base-Backups und Kopie starten, Migrationen und Demo-Seed ausführen, ein zweites Base-Backup ziehen.
2. Eine Zeile schreiben, den Zeitpunkt T notieren, eine zweite Zeile schreiben, das WAL archivieren und kopieren.
3. Den Server anhalten und nicht mehr nutzen. Das neueste Base-Backup vor T und das Archiv aus dem Objektspeicher in neue Volumes laden, das Backup gegen sein Manifest prüfen und einen neuen Server bis T wiederherstellen.
4. Prüfen:
   - Die erste Zeile ist da, die zweite nicht.
   - Jede Tabelle hat so viele Zeilen wie zu T.
   - Die Rollen der App melden sich an.
   - `check:rls` findet die Row-Level Security intakt.
5. `restore:mark-attempts` ausführen und prüfen, dass jede Variante, die noch gesendet werden muss, einen offenen Versuch zu T hat.

Die Probe gibt die Dauer jedes Teils aus und endet nur mit Code 0, wenn alles bestanden ist. Optionen:
- `DRILL_FILLER_MB=500` schreibt vor und nach dem zweiten Base-Backup je etwa so viele Daten, damit die Zeiten Durchsätze zeigen.
- `DRILL_KEEP=1` behält Projekt und Volumes zum Nachsehen.

Die Probe braucht Docker Compose 2.36 oder neuer und läuft in der CI bei jeder Änderung und wöchentlich (Job "Restore drill"). In Produktion übt der Betrieb die Wiederherstellung zusätzlich einmal im Quartal und nach jeder Änderung an der Sicherung: mit der echten Sicherung aus dem Bucket auf einem Testhost, nach "Fall B" unten, und trägt das Ergebnis unten ins Protokoll ein.

## Wiederherstellung

### Entscheiden

- **Fall A**, Fehler in den Daten bei intaktem Host, etwa versehentlich gelöschte Daten, eine fehlerhafte Migration oder ein Fehler im Code: Wiederherstellung auf einen Zeitpunkt T vor dem Fehler.
- **Fall B**, Host oder Datenträger verloren: Wiederherstellung auf einem neuen Host aus dem Bucket bis zum Ende des Archivs.

Ein paar Regeln gelten für beide Fälle:
- **T angeben**: in UTC, als ISO 8601 mit numerischem Offset, zum Beispiel `2026-10-19T01:57:53+00:00`. Postgres nimmt `Z` als Zielzeit nicht an.
- **Datenverlust**: Alles nach T geht verloren. Was danach zu tun ist, steht in "Nach der Wiederherstellung".
- **Namen der Volumes**: Das Compose-Projekt heißt `social-media-poster`. Die Volumes heißen deshalb `social-media-poster_postgres-data`, `social-media-poster_postgres-archive` und `social-media-poster_postgres-backups`.
- **Image**: Die Befehle nutzen dasselbe Image wie `compose.yaml`: `postgres:17.11-alpine`.
- **Befehle**: Sie laufen im Verzeichnis des Repositorys auf dem Host, nach `set -a; . ./.env; set +a`.

### Fall A: Wiederherstellung auf einen Zeitpunkt

1. **Anhalten**: zuerst die Backups, damit kein neues Base-Backup ein älteres verdrängt; dann alles, was schreibt.
   ```bash
   docker compose --profile backup stop postgres-backup backup-sync
   docker compose --profile app --profile xb stop api worker web browser-worker
   docker compose stop postgres
   ```
2. **Alten Stand beiseitelegen**: Er bleibt als Beleg und als Rückweg. Danach das Datenverzeichnis leeren.
   ```bash
   docker volume create social-media-poster_postgres-data-before-restore
   docker run --rm -v social-media-poster_postgres-data:/from:ro \
     -v social-media-poster_postgres-data-before-restore:/to postgres:17.11-alpine cp -a /from/. /to/
   docker run --rm -v social-media-poster_postgres-data:/data postgres:17.11-alpine find /data -mindepth 1 -delete
   ```
3. **Base-Backup wählen**: das neueste, das vor T fertig war. Der Name ist die Startzeit in UTC, das Ende zeigt die Zeit des Manifests.
   ```bash
   docker run --rm -v social-media-poster_postgres-backups:/b:ro postgres:17.11-alpine sh -c \
     'for d in /b/base/*; do echo "$(basename "$d") fertig $(date -u -r "$d/backup_manifest" +%FT%TZ)"; done'
   ```
4. **Datenverzeichnis vorbereiten**: `restore.sh` entpackt das Backup, prüft es gegen sein Manifest und schreibt die Einstellungen der Recovery. Scheitert die Prüfung, das nächstältere Backup nehmen und mit Schritt 2 (Leeren) neu beginnen.
   ```bash
   docker run --rm -v social-media-poster_postgres-data:/var/lib/postgresql/data \
     -v social-media-poster_postgres-backups:/var/lib/postgresql/backups:ro \
     -v "$PWD/infra/docker/postgres/backup:/backup:ro" --entrypoint sh postgres:17.11-alpine -c \
     'chown postgres:postgres /var/lib/postgresql/data && gosu postgres /backup/restore.sh \
        /var/lib/postgresql/backups/base/<Backup> /var/lib/postgresql/archive "<T>"'
   ```
5. **Recovery ohne Archivierung starten**: So landet die neue Timeline erst im Archiv, wenn die Prüfung bestanden ist. Ein zweiter Versuch mit einem anderen T folgt sonst womöglich dem ersten.
   ```bash
   PG_ARCHIVE_MODE=off docker compose up -d postgres
   docker compose logs -f postgres    # bis "archive recovery complete", dann Strg+C
   docker compose logs postgres | grep -E 'recovery stopping|last completed transaction|selected new timeline|archive recovery complete'
   docker compose exec postgres sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U postgres -d smp -tAc "SELECT pg_is_in_recovery()"'
   ```
   - "recovery stopping before commit" muss kurz nach T liegen. Erst wenn die letzte Abfrage `f` liefert, ist der Server fertig. Der Healthcheck meldet den Container schon während der Recovery als gesund, sobald er lesende Verbindungen annimmt.
   - Meldet das Log `recovery ended before configured recovery target was reached`, endet das Archiv vor T. Ein früheres T wählen oder die fehlenden Segmente aus `pg_wal` des alten Stands mit `gzip` ins Archiv legen.
6. **Prüfen**:
   - Die Rollen der App melden sich an: `docker compose exec postgres sh -c 'PGPASSWORD="$APP_USER_PASSWORD" psql -h 127.0.0.1 -U app_user -d smp -tAc "SELECT 1"'`, ebenso `app_system` und `app_migrator`.
   - Die Passwörter der Rollen kommen im Stand von T zurück. Wurden sie nach T rotiert, sie mit `ALTER ROLE ... PASSWORD` auf die Werte des Secret-Stores setzen.
   - Stichproben der Daten kurz vor T. Wo Node auf dem Host ist, prüft `pnpm check:rls` die Row-Level Security.
7. **Varianten markieren, bevor die Publisher wieder laufen**: Eine Variante kann nach T veröffentlicht worden sein, ohne dass die Datenbank es noch weiß.
   - Das Skript gibt jeder Variante, die noch gesendet werden muss, einen offenen Versuch zu T. Ihr nächster Lauf sucht dann auf der Plattform nach ihrem Post seit T und sendet nur, wenn er keinen findet.
   - Das Log `restore.attempts_marked` nennt die Zahlen.
   ```bash
   docker compose --profile app run --rm --no-deps worker node dist/scripts/mark-open-attempts.js --since '<T>'
   ```
8. **Archivierung einschalten und die neue Timeline sichern**:
   - Die Historie der neuen Timeline ins Archiv legen.
   - Die Einstellungen der Recovery entfernen.
   - Sofort ein neues Base-Backup ziehen. `postgres-backup` zieht eines bei seinem Start.
   ```bash
   PG_ARCHIVE_MODE=on docker compose up -d --wait postgres
   docker compose exec -u postgres postgres sh -c \
     'cd "$PGDATA" && for f in pg_wal/*.history; do /backup/archive-wal.sh "$f" "${f#pg_wal/}"; done'
   docker compose exec postgres sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U postgres -d smp \
     -c "ALTER SYSTEM RESET restore_command" -c "ALTER SYSTEM RESET recovery_target_time" \
     -c "ALTER SYSTEM RESET recovery_target_action" -c "SELECT pg_reload_conf()"'
   docker compose --profile backup up -d postgres-backup backup-sync
   ```
9. **Dienste starten**: `docker compose --profile app up -d --wait`, und `xb`, wenn der browser-worker läuft. Danach `GET /api/health/ready` und `GET :3002/health/ready` des Workers prüfen.

Den alten Stand (`social-media-poster_postgres-data-before-restore`) erst löschen, wenn die Plattform einige Tage stabil läuft.

### Fall B: Neuer Host

1. **Neuen Host bereitstellen**: das Repository auf dem Stand des letzten Deployments und `.env` aus dem Secret-Store, mit allen KEKs.
2. **Sicherung laden**: das neueste Base-Backup und das Archiv aus dem Bucket in die Volumes laden.
   ```bash
   docker volume create social-media-poster_postgres-backups
   docker volume create social-media-poster_postgres-archive
   backup_aws() {
     docker run --rm -e AWS_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY_ID" -e AWS_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_ACCESS_KEY" \
       -e AWS_DEFAULT_REGION="$BACKUP_S3_REGION" -v social-media-poster_postgres-backups:/backups \
       -v social-media-poster_postgres-archive:/archive amazon/aws-cli:2.38.1 --endpoint-url "$BACKUP_S3_ENDPOINT" "$@"
   }
   backup_aws s3 cp "s3://$BACKUP_S3_BUCKET/postgres/last-sync" -
   backup_aws s3 ls "s3://$BACKUP_S3_BUCKET/postgres/base/"
   backup_aws s3 sync "s3://$BACKUP_S3_BUCKET/postgres/base/<Backup>" "/backups/base/<Backup>" --only-show-errors
   backup_aws s3 sync "s3://$BACKUP_S3_BUCKET/postgres/archive" /archive --only-show-errors
   docker run --rm -v social-media-poster_postgres-backups:/b -v social-media-poster_postgres-archive:/a \
     postgres:17.11-alpine chown -R postgres:postgres /b /a
   ```
3. **Wiederherstellen**: weiter mit Fall A ab Schritt 4, aber ohne `"<T>"`. Die Recovery läuft dann bis zum Ende des Archivs und schließt von selbst ab.
4. **T für die Markierung (Schritt 7)**: Als `--since` gilt die Zeit aus der Logzeile `last completed transaction was at log time ...`, als ISO 8601 mit `+00:00` und auf die Sekunde abgerundet. Ein früherer Wert schadet nicht, er kostet nur mehr Abfragen bei den Plattformen.
5. **Restlicher Aufbau**: DNS, TLS und alles Weitere des Deployments gehören zu Schritt 8.9.

Was in den letzten Minuten vor dem Verlust geschah, fehlt: höchstens 60 s plus `BACKUP_SYNC_SECONDS` plus die Dauer der letzten Kopie.

### Nach der Wiederherstellung

Was nach T geschah, kennt die Datenbank nicht mehr. Die Welt draußen aber schon:

- **Veröffentlichungen**: Schritt 7 verhindert doppelte Posts. Posts, die erst nach T angelegt wurden, fehlen in der App, können aber schon erschienen sein.
- **Verbindungen**: Ein nach T erneuertes Token kann ungültig sein, vor allem bei X mit seinen einmal gültigen Refresh-Tokens. Der Token-Monitor setzt solche Verbindungen auf `NEEDS_REAUTH` und benachrichtigt Owner und Admins.
- **Stripe, Abos**: Webhook-Ereignisse nach T fehlen. Sie bei Stripe erneut senden: `stripe events resend <evt_...> --webhook-endpoint <we_...>` oder in der Workbench, bis 30 Tage nach dem Ereignis. Die Verarbeitung ist idempotent.
- **Stripe, Nutzung**: Lief nach T ein Nutzungsbericht (Log `billing.job` mit `job: usage.report` und `sent` größer 0), meldet der nächste Bericht denselben Verbrauch mit neuen Identifiern noch einmal. Vor dem Start der Rolle `billing` die Meter-Events dieses Laufs bei Stripe stornieren (Meter Event Adjustment, `cancel` per `identifier`) oder den Kunden gutschreiben.
- **Datenschutz, bestehende Löschungen**: Eine Löschung, die nach T lief und vor T angefordert war, wiederholt die stündliche `gdpr.sweep` von selbst.
- **Datenschutz, neue Löschanfragen**: Eine Anfrage nach T ist verloren. Die Logs der API zeigen sie als `POST /api/org/<org>/deletion` mit Status 2xx. Die Owner informieren, damit sie die Löschung erneut anfordern.
- **Medien und Exporte**: Der Objektspeicher wird nicht zurückgesetzt.
  - Dateien, die nach T hochgeladen wurden, gehören zu keinem Asset mehr.
  - Assets, deren Dateien nach T gelöscht wurden, haben keine Datei mehr.
  - Exporte nach T liegen unter `exports/<organizationId>/` und werden nicht mehr automatisch gelöscht.
  - Alle drei Fälle am Erstellungs- bzw. Löschdatum der Objekte erkennen und von Hand bereinigen.
- **E-Mails und Benachrichtigungen**: Was nach T versendet wurde, ist versendet.
- **Kommunikation**: Allen Organisationen mitteilen, dass Änderungen zwischen T und der Wiederherstellung verloren sind.

## Protokoll der Proben

| Datum | Umgebung | Probe | Ergebnis |
|---|---|---|---|
| 2026-10-19 | Entwicklungsmaschine, 4 vCPU, lokaler Objektspeicher | `pnpm backup:drill`, Demo-Daten (10 MB) | bestanden in 40 s: Base-Backup 2 s, Download 4 s, Entpacken und Prüfen 2 s, Recovery 1 s; 5 Varianten markiert |
| 2026-10-19 | wie oben | `DRILL_FILLER_MB=500` (Datenbank 489 MB) | bestanden: Base-Backup 30 s, Download von 797 MB 8 s, Entpacken und Prüfen 11 s, Recovery mit 569 MB WAL 20 s |
