# Alarme: Übersicht

Schritt 8.7 des Leitfadens, [ADR 0043](../adr/0043-slos-metriken-und-alarme.md). Jeder Alarm aus `infra/observability/rules/alerts.yml` mit seiner Bedeutung und dem Runbook, das ihn behandelt. Alarme ohne eigenes Runbook behandelt der letzte Teil dieser Seite.

## Wo die Alarme stehen

- **Prometheus** sammelt die Metriken von API (`/metrics` auf `API_METRICS_PORT`, 9464), Worker (`/metrics` auf dem Health-Port, 3002) und Pushgateway alle 30 Sekunden. Er wertet die Regeln aus und gibt die Alarme an Alertmanager. Lokal läuft er auf <http://127.0.0.1:9090>; die Seite "Alerts" zeigt, was anschlägt (`pending`) und was feuert (`firing`).
- **Alertmanager** fasst Alarme gleicher Art zusammen und schickt sie per E-Mail, lokal an Mailpit (<http://127.0.0.1:8025>, Absender `alerts@smp.test`). Er wiederholt `page` jede Stunde und `ticket` alle 12 Stunden und meldet auch, wenn ein Alarm endet (`[RESOLVED]`). Lokal läuft er auf <http://127.0.0.1:9093>.
- **Schwere**:
  - `page`: jemand handelt jetzt, auch nachts. Kunden merken es oder werden es gleich merken.
  - `ticket`: innerhalb eines Arbeitstags.
- **Folgealarme**: Solange `SchedulerMissing` feuert, schweigen die Alarme auf Ticks und hängende Varianten. Bei `QueuesUnreadable` schweigen die auf Queues. Ein überschrittenes Budget unterdrückt den Alarm "Budget fast erreicht".

Lokal:

```bash
docker compose --profile observability up -d prometheus alertmanager pushgateway
# API und Worker als Dienste des Profils app, oder mit pnpm dev auf dem Host:
docker compose -f compose.yaml -f tools/observability/host-targets.compose.yaml \
  --profile observability up -d prometheus alertmanager pushgateway
```

Die Backups melden sich beim Pushgateway, wenn in `.env` `BACKUP_PUSHGATEWAY_URL=http://pushgateway:9091` steht und die Profile `backup` und `observability` laufen.

Eine geänderte Regel lädt Prometheus mit `docker compose kill -s HUP prometheus` neu, ohne Neustart.

## Stummschalten

Während einer Wartung oder wenn ein Alarm bekannt ist, legt man in Alertmanager unter "Silences" eine Stummschaltung an. Sie gilt nur für die Labels des Alarms, zum Beispiel `alertname="PlatformFailureRateHigh"` und `platform="LINKEDIN"`, für eine feste Zeit und mit einem Kommentar mit Ticket. Einen Alarm durch eine geänderte Schwelle zum Schweigen zu bringen, braucht eine Änderung an den Regeln mit Test (`pnpm check:alerts`).

## Alle Alarme

| Alarm | Schwere | Bedeutung | Runbook |
|---|---|---|---|
| `PublishOnTimeBudgetBurnFast` | page | Mehr als 14,4 % der Veröffentlichungen der letzten Stunde kamen über 2 Minuten zu spät (SLO 99 %) | [Hängende Queue](haengende-queue.md), [Plattform-Ausfall](plattform-ausfall.md) |
| `PublishOnTimeBudgetBurnSlow` | ticket | Dasselbe mit 6 % über 6 Stunden | wie oben |
| `PlatformFailureRateHigh` | page | Mehr als ein Fünftel der Läufe einer Plattform scheitert oder wartet auf eine Wiederholung, über 15 Minuten | [Plattform-Ausfall](plattform-ausfall.md) |
| `DeadLetterQueueNotEmpty` | ticket | Publish-Jobs sind endgültig gescheitert und liegen in `publish-dead` | [Hängende Queue](haengende-queue.md) |
| `QueuedVariantsStuck` | page | Varianten stehen über 10 Minuten auf QUEUED, ohne dass ihr Job startet | [Hängende Queue](haengende-queue.md) |
| `QueueStalled` | page | Jobs warten in einer Queue, und kein Worker hat dort seit 10 Minuten einen beendet | [Hängende Queue](haengende-queue.md) |
| `QueueJobsOverdue` | page | Verzögerte Jobs einer Queue sind über 2 Minuten überfällig; kein Worker der Queue nimmt sie | [Hängende Queue](haengende-queue.md) |
| `QueueJobsFailing` | ticket | Mehr als die Hälfte der Jobs einer Queue scheitert, über 30 Minuten | [Hängende Queue](haengende-queue.md) |
| `SchedulerTickLagging` | page | `tick.publish`, `tick.sweep-queued` oder `tick.outbox-relay` startet über 60 s nach seiner Zeit | [Hängende Queue](haengende-queue.md) |
| `SchedulerTickStalled` | page | `tick.publish` oder `tick.outbox-relay` endete seit über 3 Minuten nicht ohne Fehler | [Redis-Verlust](redis-verlust.md) |
| `SchedulerTickFailed` | ticket | Der letzte Lauf eines Ticks scheiterte; er läuft erst zu seiner nächsten Zeit wieder | [Hängende Queue](haengende-queue.md) |
| `SchedulerMissing` | page | Kein Worker mit der Rolle `scheduler` meldet sich | [Hängende Queue](haengende-queue.md) |
| `OperationsCountsFailing` | ticket | Der Worker kann die Zahlen der Datenbank nicht lesen; die Alarme darauf sind blind | unten |
| `QueuesUnreadable` | page | Der Worker kann die Queues nicht lesen | [Redis-Verlust](redis-verlust.md) |
| `ReauthWave` | page | Mindestens 5 Verbindungen einer Plattform brauchen innerhalb einer Stunde eine neue Anmeldung | [Token-Ablauf](token-ablauf.md) |
| `TokenRefreshFailing` | ticket | Mindestens 10 Token-Refreshes in einer Stunde scheiterten oder endeten in einer neuen Anmeldung | [Token-Ablauf](token-ablauf.md) |
| `KillSwitchActive` | ticket | Ein globaler Kill-Switch ist an | [X-Drift](x-drift.md) |
| `XBrowserDrift` | ticket | Der Browser-Worker meldete eine Drift der Selektoren von X, in den letzten 30 Minuten | [X-Drift](x-drift.md) |
| `XBrowserCanaryFailed` | ticket | Der tägliche Canary des X-Browsers fand Selektoren nicht, in den letzten 26 Stunden | [X-Drift](x-drift.md) |
| `PlatformChallenges` | ticket | Eine Plattform verlangte eine Bestätigung, bei einem Post oder einer Anmeldung des X-Browsers, in der letzten Stunde | [X-Drift](x-drift.md) |
| `ApiErrorBudgetBurnFast` | page | Die API antwortet so oft mit 5xx, dass das Budget eines Monats (99,5 %) in zwei Tagen verbraucht ist | unten |
| `ApiErrorBudgetBurnSlow` | ticket | Dasselbe für fünf Tage | unten |
| `ApiReadLatencyHigh` | ticket | Das p95 der Lesezugriffe liegt seit 15 Minuten über 300 ms | unten |
| `TargetDown` | page | Prometheus erreicht API oder Worker nicht | unten |
| `SecurityEventsSpike` | ticket | Mehr als 100 Sicherheitsereignisse einer Art in 10 Minuten | unten |
| `SignInFailuresSpike` | page | Mehr als 200 fehlgeschlagene Anmeldungen in 10 Minuten | unten |
| `AccessCacheInvalidationFailed` | ticket | Ein Zugriff im Cache ließ sich nicht verwerfen; eine alte Rolle gilt bis zu 60 s weiter | [Redis-Verlust](redis-verlust.md) |
| `AiDailyBudgetExceeded`, `AiDailyBudgetNear` | page, ticket | Die KI kostete in 24 Stunden mehr als ihr Budget, oder mehr als 80 % davon | unten |
| `AiRefusalsHigh` | ticket | Mehr als ein Fünftel der KI-Generierungen von 24 Stunden wurde abgelehnt | unten |
| `XSpendDailyBudgetExceeded`, `XSpendDailyBudgetNear` | page, ticket | Die X-API kostete in 24 Stunden mehr als ihr Budget, oder mehr als 80 % davon | unten |
| `StorageGrowthHigh` | ticket | Die Mediathek wuchs in 24 Stunden um mehr als ihr Budget | unten |
| `BackupCopyStale` | page | Die letzte Kopie von WAL und Base-Backups in den Bucket ist über 15 Minuten alt (RPO) | [Backup](backup-restore.md) |
| `BaseBackupStale` | ticket | Das letzte Base-Backup ist über 25 Stunden alt | [Backup](backup-restore.md) |
| `WalArchivingFailing` | page | PostgreSQL konnte WAL nicht archivieren; `pg_wal` wächst | [Backup](backup-restore.md) |
| `BackupHeartbeatMissing` | page | Das WAL-Archiv ist an, aber die Kopie in den Bucket meldete nie einen Erfolg | [Backup](backup-restore.md) |

Die Budgets stehen in `infra/observability/rules/budgets.yml`: KI 100 USD, X 50 USD und Speicher 20 GB am Tag, als Startwerte. Eine Änderung dort braucht keinen neuen Test, eine andere Schwelle in `alerts.yml` schon.

## Proben

`pnpm drill <szenario>` spielt Fehler auf einem lokalen Stack oder in Staging ein, nie in Produktion. Die Szenarien sind:

| Szenario | Fehler | Runbook |
|---|---|---|
| `platform-outage --platform <P> [--status 503] [--minutes 20]` | Eigene Organisationen mit fälligen Beiträgen; die Mock-Konten von P antworten so lange mit dem Status | [Plattform-Ausfall](plattform-ausfall.md) |
| `token-wave --platform <P> [--minutes 20]` | Dasselbe, aber P lehnt die Tokens ab | [Token-Ablauf](token-ablauf.md) |
| `xb-drift [--count 3]`, `xb-canary` | Berichte eines Browser-Workers über eine Drift und einen fehlgeschlagenen Canary | [X-Drift](x-drift.md) |

Redis-Verlust und eine hängende Queue übt man mit Compose und den Rollen des Workers, wie in den Runbooks beschrieben. Die Organisationen der Proben bleiben wie die von `pnpm load:fixture`. Sie heißen `load-d…` und lassen sich am Lauf in den Logs (`drill.injected`) wiederfinden. Selector und Version `drill` kennzeichnen die Berichte des X-Browsers. Die Ergebnisse stehen im Protokoll des jeweiligen Runbooks. Die Proben laufen nach jeder Änderung an Alarmen oder Runbooks und einmal im Quartal.

## Alarme ohne eigenes Runbook

### API: Fehler, Latenz und Erreichbarkeit

- **`ApiErrorBudgetBurnFast`, `ApiErrorBudgetBurnSlow`**:
  1. Welche Anfragen scheitern? `sum by (method) (rate(smp_http_request_duration_seconds_count{status_class="5xx"}[5m]))`.
  2. Die Logs der API mit Pegel `error` zeigen Pfad, `requestId` und den Fehler. Sentry fasst gleiche Fehler zusammen.
  3. Häufige Ursachen sind eine nicht erreichbare Datenbank oder Redis (Health-Check `/api/health/ready`), eine Migration, die fehlt, oder ein fehlerhaftes Deployment. Ein fehlerhaftes Deployment rollt man zurück.
- **`ApiReadLatencyHigh`**:
  1. `histogram_quantile(0.95, sum by (le) (rate(smp_http_request_duration_seconds_bucket{method="GET"}[5m])))` zeigt den Verlauf.
  2. Langsame Abfragen zeigen die Traces.
  3. Ein Schub von Veröffentlichungen bremst die Lesezugriffe, wenn API und Publisher sich CPU teilen ([ADR 0041](../adr/0041-lasttest.md)). Dann hilft es, den Publisher zu begrenzen oder die API zu skalieren.
- **`TargetDown`**:
  1. Läuft der Prozess? `docker compose ps`, die Health-Checks.
  2. Antwortet `/metrics`? Die API liefert ihn auf `API_METRICS_PORT`, den der Reverse Proxy nicht erreicht. Ein Wert 0 schaltet ihn aus.
  3. Ein Neustart des Dienstes behebt einen hängenden Prozess. Seine Logs vor dem Neustart sichern.

### Sicherheit

- **`SecurityEventsSpike`**:
  1. Das Label `event` nennt die Art, etwa `security.rate_limited` oder `security.tenant_denied` ([Inventar der Logs](../security/daten-und-protokolle.md)).
  2. Die Logzeilen mit diesem Ereignis nennen Pfad, Person und Adresse des Clients.
  3. Kommt ein Schub von wenigen Adressen, sperrt man sie vor der API. Kommt er von einer eigenen Integration, korrigiert man sie.
  4. `security.tenant_denied` und `security.permission_denied` in großer Zahl von einer Person sprechen für ein Ausprobieren fremder IDs. Dann die Sitzungen der Person beenden (`pnpm auth:revoke-sessions`, [Runbook](secret-rotation.md)) und den Vorfall dokumentieren.
- **`SignInFailuresSpike`**:
  1. Mehr als 200 fehlgeschlagene Anmeldungen in 10 Minuten sprechen für Passwortlisten gegen viele Konten.
  2. Die Grenzen je Konto und je Adresse (Schritt 8.4) bremsen das schon; der Alarm sagt, dass jemand es versucht.
  3. Die Logzeilen `auth.event` mit `path: /sign-in/email` und `outcome: failed` nennen in `clientAddress` die Adressen der Clients. Sie sperrt man vor der API.
  4. Betrifft es wenige Konten, informiert man deren Personen und empfiehlt den zweiten Faktor.

### Kosten

- **`AiDailyBudgetExceeded`, `AiDailyBudgetNear`**:
  1. `smp_ai_tokens_24h` zeigt die Tokens nach Art. Viele Tokens ohne Treffer im Cache sprechen für einen gebrochenen Prompt-Cache.
  2. Welche Organisationen viel verbrauchen, zeigt die Datenbank (`ai_generation` nach `workspace_id` der letzten 24 Stunden, als `app_system`).
  3. Die Limits je Tarif greifen schon. Ein einzelner Ausreißer ist eher ein Fehler in einer Integration oder Missbrauch.
  4. Im Notfall das Ausgabenlimit des API-Schlüssels in der Konsole von Anthropic senken. Danach scheitern die Generierungen für alle Kunden, bis das Limit wieder steigt; das braucht eine Ankündigung. Den Mock lehnt die App in Produktion ab.
- **`AiRefusalsHigh`**: Viele Ablehnungen nach einer Änderung an Prompts oder Modell sprechen für die Änderung. Die Eval-Suite (`pnpm eval:ai`) prüft das, bevor man zurückrollt.
- **`XSpendDailyBudgetExceeded`, `XSpendDailyBudgetNear`**: Das Ausgabenlimit je Organisation (Schritt 7.4) stoppt einzelne Organisationen. Der Alarm gilt für die Summe. Welche Organisationen viel ausgeben, zeigt `api_cost_record` der letzten 24 Stunden. Das Guthaben und das Limit des Kontos bei X prüft man in der Konsole von X.
- **`StorageGrowthHigh`**: Große Uploads einer Organisation oder eine Schleife in einer Integration. `media_asset` nach `workspace_id` und `created_at` zeigt sie. Die Tariflimits für Speicher greifen je Organisation.

### Lesungen der Datenbank

- **`OperationsCountsFailing`**:
  1. Die Logzeile `metrics.operations_failed` des Workers nennt die Lesung (`counts`, `storage` oder `queues`) und den Fehler.
  2. Meist ist die Datenbank für `app_system` nicht erreichbar, oder eine Migration fehlt (`pnpm db:migrate`, in Produktion `migrate deploy`).
  3. Solange der Alarm feuert, sind diese Alarme blind: `QueuedVariantsStuck`, `ReauthWave`, `KillSwitchActive`, die Kosten und der WAL-Archiver.

### Pushgateway

Ein Backup-Dienst, den es nicht mehr gibt, meldet sich nicht mehr, aber sein letzter Wert bleibt im Pushgateway und löst `BackupCopyStale` aus. Den Wert entfernt man so:

```bash
curl -X DELETE http://127.0.0.1:9091/metrics/job/backup-sync
```

Für das Base-Backup heißt der Job `postgres-backup`.

## Protokoll der Proben

| Datum | Umgebung | Ablauf | Ergebnis |
| --- | --- | --- | --- |
| 2026-10-19 | Lokal: Compose mit den Profilen `observability` und Infrastruktur, API und Worker mit allen Rollen aus `dist` | Regeln und Konfiguration geladen, alle Ziele abgefragt, Testmeldungen der Backups an das Pushgateway, danach die Proben der Runbooks | Alle 48 Regeln werten ohne Fehler aus (mit `QueueJobsOverdue` aus der Probe der hängenden Queue sind es 49), API, Worker und Pushgateway sind erreichbar. Die Testmeldung der Backups löste nach 15 Minuten `BackupCopyStale` aus, mit Mail an Mailpit; nach dem Entfernen aus dem Pushgateway endete der Alarm mit `[RESOLVED]`. Vor der ersten Probe meldete `SchedulerTickLagging` für `tick.sweep-queued` einen Verzug, den es nicht gab (siehe [ADR 0043](../adr/0043-slos-metriken-und-alarme.md), Befunde). |
