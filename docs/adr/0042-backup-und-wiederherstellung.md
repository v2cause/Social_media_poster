# ADR 0042: Backup und Wiederherstellung

- **Status**: Akzeptiert
- **Datum**: 2026-10-19
- **Bezug**: Umsetzungsleitfaden, Schritt 8.6; `docs/ARCHITECTURE.md`, Abschnitte 6.3, 7, 12, 13 und 15; [Runbook](../runbooks/backup-restore.md); [ADR 0024](0024-publish-job-schreibmarke-und-lease.md), [ADR 0037](0037-loeschung-von-organisationen.md), [ADR 0038](0038-aufbewahrungsfristen.md), [ADR 0039](0039-security-review-und-haertung.md)

## Kontext

Schritt 8.6 verlangt Point-in-Time-Recovery (PITR), eine Restore-Probe und ein dokumentiertes RPO von 15 Minuten und RTO von 4 Stunden. Fertig ist er, wenn ein Restore erfolgreich geübt ist. Die Architektur nennt für den Betrieb "Postgres mit Point-in-Time-Recovery". ADR 0037 und ADR 0038 verweisen für die Fristen der Sicherungen und den Restore auf diesen Schritt.

Wie die Plattform betrieben wird, entscheidet erst Schritt 8.9. Bis dahin ist `compose.yaml` die einzige Umgebung, in der alles zusammen läuft.

Seit Schritt 8.9 steht das fest: Compose auf einer VM mit selbst betriebenem Postgres und dem Profil `backup` ([ADR 0045](0045-produktions-vorlage.md)). Die Produktions-Vorlage in `deploy/` nutzt die Skripte dieses ADR. Die Base-Backups holt dort der eigene Login `svc_backup` über TLS, und die Kopie verlangt die Verschlüsselung durch den Bucket (Nachweis, Verschlüsselung).

## Entscheidung

### Werkzeuge

PITR mit den Mitteln von PostgreSQL 17 selbst: `archive_command`, `pg_basebackup`, `pg_verifybackup` und `pg_archivecleanup` aus dem Image `postgres:17.11-alpine`, das auch die Datenbank nutzt. Die Kopie in den Objektspeicher übernimmt die AWS CLI (`amazon/aws-cli:2.38.1`, wie `s3-init`). Kein weiteres Werkzeug, kein eigenes Image. Alles läuft im Compose-Profil `backup` mit Skripten unter `infra/docker/postgres/backup/`.

### WAL-Archiv

- `PG_ARCHIVE_MODE=on` schaltet `archive_mode` ein; ohne die Variable bleibt es aus, wie in der Entwicklung.
- `archive-wal.sh` legt jedes fertige Segment komprimiert in das Volume `postgres-archive`:
  - zuerst unter einem vorläufigen Namen, auf den Datenträger geschrieben, dann umbenannt, so liegt nie eine halbe Datei im Archiv;
  - eine Datei, die schon im Archiv liegt, gilt nur bei gleichem Inhalt als archiviert;
  - scheitert etwas, behält Postgres das Segment und versucht es erneut.
- `archive_timeout=60` schließt ein Segment spätestens nach einer Minute, wenn geschrieben wurde.

### Base-Backups

- Der Dienst `postgres-backup` zieht beim Start und dann alle `BACKUP_INTERVAL_HOURS` (24) ein Base-Backup: `pg_basebackup` im tar-Format mit gzip, das WAL im Stream, ein Manifest mit SHA-256.
- Ein Backup entsteht unter einem vorläufigen Namen und heißt erst nach dem Ende nach seiner Startzeit in UTC.
- Die neuesten `BACKUP_KEEP` (7) bleiben. `pg_archivecleanup` löscht das WAL vor dem Start des ältesten.
- Der Dienst teilt sich das Netz mit `postgres`: Die `pg_hba.conf` von initdb erlaubt Replikation nur über 127.0.0.1, mit Passwort.

### Kopie in den Objektspeicher

- Der Dienst `backup-sync` kopiert alle `BACKUP_SYNC_SECONDS` (300) die fertigen Base-Backups und das Archiv nach `s3://<BACKUP_S3_BUCKET>/postgres/` und schreibt die Uhrzeit nach `postgres/last-sync`. `aws s3 sync` löscht nie.
- Für Produktion gilt für den Bucket:
  - eigener Bucket in der EU, getrennt von dem der Medien;
  - eigenes Schlüsselpaar ohne Recht zum Löschen;
  - Versionierung, Ablauf nach 14 Tagen und alte Versionen nach einem Tag;
  - Verschlüsselung at rest, optional Object Lock.
  Die Ablaufregel muss länger sein als die lokale Aufbewahrung.
- Lokal ist es der Bucket `smp-backups` in SeaweedFS, den `s3-init` anlegt.

### Härtung der Dienste

- Beide Dienste laufen mit `no-new-privileges`, ohne Capabilities außer den nötigen, mit schreibgeschütztem Dateisystem und mit einem Init-Prozess.
- `postgres-backup` braucht als root nur CHOWN, FOWNER, SETUID und SETGID: Er übergibt das Volume der Backups an `postgres` und wechselt mit `gosu` zu diesem Nutzer.
- `backup-sync` läuft als uid 70, der Nutzer `postgres` des Alpine-Images, dem Backups und Archiv gehören.

### Wiederherstellung

- **`restore.sh`**:
  - entpackt ein Base-Backup in ein leeres Datenverzeichnis;
  - prüft es mit `pg_verifybackup` gegen sein Manifest, also jede Datei mit Größe und Prüfsumme und das WAL vom Start bis zum Ende des Backups;
  - schreibt `restore_command`, die Zielzeit mit `recovery_target_action = 'promote'` und `recovery.signal`.
  Die Zielzeit steht in ISO 8601 mit numerischem Offset: Postgres nimmt `Z` in `recovery_target_time` beim Start nicht an, `restore.sh` weist es deshalb gleich ab.
- **Erster Start ohne Archivierung**: Die neue Timeline kommt erst ins Archiv, wenn die Prüfung bestanden ist. Sonst würde ein zweiter Versuch mit einer anderen Zielzeit womöglich der Timeline des ersten folgen (`recovery_target_timeline = 'latest'`).
- **Danach**: Archivierung an, die Historie der Timeline von Hand ins Archiv, die Einstellungen der Recovery entfernen, sofort ein neues Base-Backup ziehen. Das Runbook beschreibt beide Fälle: einen Zeitpunkt bei intaktem Host und einen neuen Host aus dem Bucket.

### Keine doppelten Posts nach einem Restore

- **Das Problem**: Nach einem Restore auf T kennt die Datenbank nicht, was zwischen T und dem Ausfall veröffentlicht wurde. Eine Variante, die zu T noch geplant war, hat keinen offenen Versuch. Der Publish-Job würde sie ohne Reconcile noch einmal senden, denn das Zeitfenster gilt erst nach 6 Stunden als verpasst.
- **Die Lösung**: `restore:mark-attempts --since <T>` (im Image des Workers `node dist/scripts/mark-open-attempts.js`, `markOpenAttemptsAfterRestore` in `packages/db`):
  - Jede Variante auf `SCHEDULED`, `QUEUED`, `PUBLISHING` oder `RETRYING` bekommt einen offenen Versuch (`STARTED`, Auslöser `restore`), der zu T begann, wie ihn ein abgestürzter Lauf hinterlässt.
  - Ihr nächster Lauf sucht dann auf der Plattform nach einem Post seit T (Architektur 7, Schritt 4) und sendet nur, wenn er keinen findet.
  - Eine Variante mit einem offenen Versuch von T oder früher bleibt unverändert, ein zweiter Lauf fügt nichts hinzu.
- **Ausführung**: Das Skript läuft als `app_system` über alle Workspaces, bevor die Publisher wieder starten. Das ist ein weiterer mandantenübergreifender Zugriff wie die Scans der Architektur 6.3; er schreibt nur Versuche zu Varianten, deren Workspace er mitschreibt.

### Restore-Probe

- `pnpm backup:drill` übt den Ablauf in einem eigenen Compose-Projekt bis zur Markierung der Varianten (Runbook, "Restore-Probe").
- Die Probe läuft in der CI bei jeder Änderung und wöchentlich. Ein neues Image von Postgres oder der AWS CLI fällt so auf, bevor eine Sicherung gebraucht wird.
- In Produktion übt der Betrieb einmal im Quartal mit der echten Sicherung auf einem Testhost.

### Fristen

- Lokal bleiben 7 Base-Backups mit dem WAL dazwischen, im Bucket alles 14 Tage.
- Daten, die die Plattform löscht (ADR 0037, ADR 0038), liegen damit höchstens 14 Tage weiter in Sicherungen. Danach ist eine Wiederherstellung vor diesen Zeitpunkt nicht mehr möglich.
- Eine Löschung, die nach T lief und vor T angefordert war, wiederholt die `gdpr.sweep` nach einem Restore von selbst. Eine Anfrage nach T ist verloren; das Runbook beschreibt, wie sie sich in den Logs der API finden lässt.

### Andere Speicher

- **Redis**: keine eigene Sicherung. Postgres ist die Quelle der Wahrheit (Architektur 7); Scheduler und Sweeper stellen die Queues wieder her. Ein veralteter Job endet ohne Aktion, ein schon erledigter startet der Sweeper neu.
- **Objektspeicher**: keine eigene Sicherung der Medien und Exporte. Der Anbieter speichert redundant. Eine Versionierung würde das Versprechen brechen, dass gelöschte Medien innerhalb einer Stunde endgültig weg sind (ADR 0038).
- **Secrets**: Sie liegen nie neben den Sicherungen. Seit Schritt 8.9 sind sie Dateien in `deploy/secrets/` auf der VM, nicht im Bucket; eine zweite Kopie bewahrt der Betrieb getrennt von VM und Bucket auf ([Runbook Deployment](../runbooks/deployment.md), ADR 0045). Ein Restore auf einen Zeitpunkt vor einer Rotation braucht die alten Schlüssel. Deshalb bleiben alte KEKs und alte Schlüssel aus `BETTER_AUTH_SECRETS` in `deploy/secrets/` und in dieser Kopie, bis die letzte Sicherung mit ihnen abgelaufen ist ([Runbook zur Rotation](../runbooks/secret-rotation.md)).

## Nachweis

### RPO

- **Host intakt**: Ein Segment liegt spätestens 60 s nach dem letzten Schreiben im lokalen Archiv. Was in `pg_wal` noch nicht archiviert ist, liegt im alten Datenverzeichnis.
- **Host verloren**: Es fehlen höchstens 60 s plus `BACKUP_SYNC_SECONDS` (300) plus die Dauer der letzten Kopie, also rund 6 bis 7 Minuten.
- Beides liegt unter 15 Minuten, solange die Kopie läuft. `postgres/last-sync` zeigt das. Seit Schritt 8.7 meldet die Kopie jede erfolgreiche Runde an das Pushgateway, und `BackupCopyStale` alarmiert ab 15 Minuten ohne Meldung ([ADR 0043](0043-slos-metriken-und-alarme.md)).

### RTO

Die Restore-Probe vom 2026-10-19 lief auf einer Maschine mit 4 vCPU, mit dem Objektspeicher auf derselben Maschine, mit `DRILL_FILLER_MB=500`:

| Teil | Menge | Dauer | Durchsatz |
|---|---|---|---|
| Base-Backup | Datenbank mit 489 MB | 30 s | 16 MB/s |
| Download | Base-Backup (247 MB) und Archiv (550 MB) | 8 s | 100 MB/s |
| Entpacken und Prüfen gegen das Manifest | 489 MB Datenbank | 11 s | 45 MB/s |
| Recovery bis T | 569 MB WAL | 20 s | 28 MB/s |

Hochgerechnet für eine Datenbank von 50 GB mit 5 GB WAL am Tag:
- Download des Base-Backups und von 14 Tagen Archiv, zusammen etwa 60 GB komprimiert: 10 Minuten.
- Entpacken und Prüfen: 19 Minuten.
- Replay von höchstens einem Tag WAL: 3 Minuten.

Zusammen sind das rund 35 Minuten. Mit Entscheidung, Prüfung und den Schritten des Runbooks bleibt das deutlich unter 4 Stunden. Mit gleich viel WAL im Verhältnis, einem Zehntel der Datenbank am Tag, reicht die Zeit auf vergleichbarer Hardware bis etwa 250 GB Datenbank.

Die Durchsätze hängen von der Maschine und der Anbindung des Buckets ab. Wächst die Datenbank über 100 GB, misst der Betrieb mit der Probe auf der Hardware der Produktion neu.

### Befunde der Probe

Die ersten Läufe scheiterten, jeweils an einer Annahme, die erst der Ablauf widerlegte:

- **`su-exec`**: Das Alpine-Image von Postgres bringt nicht `su-exec` mit, sondern `gosu`; der Backup-Dienst startete in einer Schleife neu.
- **Root ohne Rechte**: `docker compose exec` läuft als root. Ohne Capabilities darf root die Verzeichnisse von `postgres` mit Modus 0700 nicht lesen, und ein Base-Backup als root hätte Dateien angelegt, die die Aufbewahrung nicht löschen darf. Befehle im Backup-Dienst laufen deshalb mit `-u postgres`.
- **Reihenfolge**: Die Kopie startete vor `s3-init`, und ihr erster Versuch fand den Bucket nicht. Sie wartet jetzt auf `s3-init`.
- **Langsames Stoppen**: Die Shell-Schleifen ignorierten SIGTERM als PID 1, jeder Stopp dauerte 10 s. Ein Init-Prozess beendet sie sofort.
- **`Z` in der Zielzeit**: Mit `Z` als Zone startete der wiederhergestellte Server nicht.

## Konsequenzen

- **Positiv**:
  - PITR auf jeden Zeitpunkt der letzten 7 Tage lokal und der letzten 14 Tage aus dem Bucket, mit geprüften Backups und einem geübten, in der CI wiederholten Ablauf.
  - Keine weitere Abhängigkeit über die Images hinaus, die das Projekt schon nutzt.
- **Negativ**:
  - Jedes Base-Backup ist voll, es gibt keine inkrementellen. Ein Base-Backup komprimiert mit einem Kern, mit 16 MB/s in der Probe.
  - Die Wiederherstellung lädt das ganze Archiv des Buckets.
  - Für Datenbanken von einigen hundert GB wäre pgBackRest besser (siehe Alternativen).
- **Verschlüsselung**: Die Sicherungen sind nur komprimiert, nicht von der Plattform verschlüsselt. Das übernimmt der Bucket: Seit Schritt 8.9 verlangt die Kopie mit `BACKUP_S3_SSE` (AES256 oder aws:kms) für jedes Objekt die Verschlüsselung durch den Speicher. Das Staging prüfte das mit SSE-S3 von SeaweedFS und einem eigenen Schlüssel ([Staging-Protokoll](../betrieb/staging-2026-10.md)). Auf der VM liegen Archiv und Base-Backups auf den verschlüsselten Datenträgern, die der Preflight verlangt (ADR 0045).
- **Kopie fällt aus**: Fällt die Kopie aus, wächst das RPO, bis `BackupCopyStale` nach 15 Minuten alarmiert. Fällt die Archivierung aus, wächst `pg_wal`, bis der Datenträger voll ist; `WalArchivingFailing` alarmiert auf `pg_stat_archiver`. Meldet sich die Kopie gar nicht, etwa weil `BACKUP_PUSHGATEWAY_URL` fehlt, alarmiert `BackupHeartbeatMissing` (ADR 0043).
- **Folgen eines Restores**: Ein Restore auf T setzt nur die Datenbank zurück, nicht die Welt draußen. Das Runbook zählt auf, was danach zu tun ist:
  - Webhooks von Stripe seit T erneut senden;
  - einen Nutzungsbericht nach T bei Stripe stornieren;
  - Verbindungen mit erneuertem Token neu verbinden;
  - Medien bereinigen, die nach T hochgeladen oder gelöscht wurden;
  - verlorene Löschanfragen melden.
- **Schritt 8.9**: Wählt das Deployment eine verwaltete Datenbank, ersetzt deren PITR Archiv, Base-Backups und Kopie. Ziele, Fristen, Restore-Probe und die Markierung nach einem Restore gelten weiter. Die Vorlage aus Schritt 8.9 wählt keine verwaltete Datenbank, sondern Postgres in Compose mit Archiv, Base-Backups und Kopie wie hier beschrieben (ADR 0045).

## Alternativen

- **pgBackRest oder WAL-G**: parallele und inkrementelle Backups, Verschlüsselung, direkte Ablage im Objektspeicher, eigene Aufbewahrung und Prüfung. Das ist die bessere Wahl für große Datenbanken. Es bringt aber ein eigenes Image oder eigene Pakete mit, und deren Konfiguration ist umfangreicher als die vier Skripte hier. Wiedervorlage bei 100 GB oder wenn die Probe das RTO nicht mehr hält.
- **Nur `pg_dump`**: einfach, aber ohne Zeitpunkt zwischen zwei Dumps. Ein RPO von 15 Minuten hieße ein Dump alle 15 Minuten.
- **Archiv direkt in den Bucket schreiben** (`archive_command` mit der AWS CLI): Das spart die Kopie und senkt das RPO auf `archive_timeout`. Aber jedes Segment hinge dann an der Verfügbarkeit des Buckets, und das Image von Postgres bräuchte die AWS CLI. Die lokale Kopie im Volume hält Postgres unabhängig vom Netz.
- **Redis oder den Objektspeicher mitsichern**: Postgres ist die Quelle der Wahrheit, und eine Versionierung der Medien widerspräche den Fristen der Löschung (ADR 0038).
