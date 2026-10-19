# ADR 0043: SLOs, Metriken und Alarme

- **Status**: Akzeptiert
- **Datum**: 2026-10-19
- **Bezug**: Umsetzungsleitfaden, Schritt 8.7; `docs/ARCHITECTURE.md`, Abschnitt 12; [Übersicht der Alarme](../runbooks/alarme.md) und die Runbooks unter `docs/runbooks/`; [ADR 0039](0039-security-review-und-haertung.md), [ADR 0041](0041-lasttest.md), [ADR 0042](0042-backup-und-wiederherstellung.md)

## Kontext

Schritt 8.7 verlangt SLOs, Alarme und Runbooks für Plattform-Ausfall, massenhaften Token-Ablauf, X-Drift, Redis-Verlust und eine hängende Queue. Fertig ist er, wenn die Runbooks durchgespielt sind. Die Architektur nennt in Abschnitt 12 die Metriken und Alarme. Logs und Traces gibt es seit Phase 0, Metriken gab es noch nicht. ADR 0039 und ADR 0042 verweisen für Alarme auf Sicherheitsereignisse, auf die Kopie der Backups und auf das WAL-Archiv auf diesen Schritt.

Wie die Plattform betrieben wird, entscheidet erst Schritt 8.9. Bis dahin läuft alles in `compose.yaml`.

## Entscheidung

### SLOs

Über 30 Tage, mit Recording Rules in `infra/observability/rules/slo.yml`:

| SLO | Ziel | Messung |
|---|---|---|
| Pünktlich | 99 % der veröffentlichten Varianten gehen höchstens 2 Minuten nach ihrer Zeit hinaus | `smp_publish_delay_seconds`, der Bucket bis 120 s geteilt durch alle; Testläufe zählen nicht |
| Verfügbarkeit | 99,5 % der Anfragen an die API enden ohne 5xx | `smp_http_request_duration_seconds_count`, ohne Health-Checks und Streams |
| Latenz | p95 der Lesezugriffe der API unter 300 ms (Schritt 8.5) | `histogram_quantile` über die GET-Anfragen in 5 Minuten |

Varianten, die gar nicht hinausgehen, misst nicht das SLO, sondern der Alarm auf die Fehlerquote je Plattform.

Die Alarme auf das Fehlerbudget folgen dem Muster mit zwei Fenstern und zwei Raten:
- schnell: 14,4-fache Rate über 1 Stunde, bestätigt über 5 Minuten, `page`;
- langsam: 6-fache Rate über 6 Stunden, bestätigt über 30 Minuten, `ticket`.

Für Pünktlichkeit gilt zusätzlich: mindestens 10 Veröffentlichungen im Fenster. Ohne Verkehr ist eine Quote nicht definiert, und kein Alarm schlägt an.

### Metriken

- **Bibliothek**: `prom-client` in API und Worker.
  - Die API liefert `/metrics` auf einem eigenen Port, `API_METRICS_PORT` (9464); der Reverse Proxy erreicht ihn nicht.
  - Der Worker liefert `/metrics` auf seinem Health-Port.
- **Labels**: Queues, Plattformen, Ergebnisse, Fehlercodes, Methode und Statusklasse, Ticks und Ereignisse. Nie eine Organisation, ein Workspace, eine Person oder eine Route mit IDs. Deshalb sind die X-Ausgaben eine Summe über alle Organisationen. Die Ausgaben pro Workspace stehen in der App, mit ihrem Limit je Tarif (Schritt 7.4); das weicht von Abschnitt 12 der Architektur ab.
- **Zähler seltener Ereignisse**: Sie beginnen bei 0, ohne Labels oder mit jedem Label einmal auf 0. Dazu gehören Drifts, fehlgeschlagene Canaries, Challenges, Token-Refreshes und Sicherheitsereignisse. Eine Zeitreihe, die erst mit ihrem ersten Ereignis entsteht, sieht `increase()` nicht.
- **Werte der Datenbank und der Queues**:
  - Gelesen werden sie, wenn Prometheus abfragt, und nur in der Rolle `scheduler`. Dazu zählen:
    - hängende QUEUED-Varianten;
    - Verbindungen mit NEEDS_REAUTH je Plattform, auch mit 0;
    - Kill-Switches;
    - Kosten, Tokens und Refusals der KI über 24 Stunden;
    - X-Ausgaben über 24 Stunden;
    - der WAL-Archiver;
    - die Größe der Mediathek;
    - Jobs je Queue und Zustand.
  - Eine Lesung gilt 15 Sekunden bis 5 Minuten, so belasten Replikas und Abfragen die Datenbank nicht.
  - Die Gauges entstehen nur in dieser Rolle. Kein anderer Prozess meldet einen Wert, den er nicht misst.
  - `smp_operations_counts_up` und `smp_queue_counts_up` sagen, ob die Lesung gelingt. Bei einem Fehler bleiben die Gauges mit Labels leer, sie melden keine Null.
  - Migration `0028_operations_metrics` legt die Indizes für die Summen über 24 Stunden an.
- **Ticks**:
  - Je Tick gibt es den Verzug, die letzte erfolgreiche und die letzte fehlgeschlagene Ausführung.
  - Den Verzug misst der Worker gegen die geplante Zeit aus der ID des Jobs (`repeat:<tick>:<ms>`). BullMQ setzt `delay` auf 0, wenn ein Job fällig wird.
- **Backups**: Base-Backup und Kopie in den Bucket melden ihre letzte erfolgreiche Ausführung an ein Pushgateway (`BACKUP_PUSHGATEWAY_URL`), weil Prometheus kurze Jobs nicht abfragen kann. Ein fehlgeschlagener Push bricht kein Backup ab und loggt die URL nicht.

### Alarme

- **Regeln**:
  - Sie liegen in `infra/observability/rules/`: `budgets.yml`, `slo.yml` und `alerts.yml`.
  - Jeder Alarm hat `severity` (`page`: sofort handeln, `ticket`: innerhalb eines Arbeitstags) und einen `runbook_url`.
  - Die Schwellen sind Startwerte.
  - Die Budgets für KI, X und Speicher stehen als Konstanten in `budgets.yml`, damit Tests und Betrieb sie an einer Stelle ändern.
- **Gruppen**:
  - Veröffentlichen: Fehlerbudget, Fehlerquote je Plattform, Dead-Letter-Queue, hängende Varianten und Queues, fehlschlagende Jobs.
  - Scheduler: Verzug, Stillstand, fehlgeschlagener Tick, fehlender Scheduler, Lesungen.
  - Verbindungen: Re-Auth-Welle, Token-Refresh, Kill-Switch.
  - X-Browser: Drift, Canary, Challenges.
  - API: Fehlerbudget, Latenz, Erreichbarkeit.
  - Sicherheit: Sicherheitsereignisse, fehlgeschlagene Anmeldungen, Zugriffs-Cache.
  - Kosten: KI, X, Speicherwachstum.
  - Backups: Kopie, Base-Backup, WAL-Archiv, fehlende Meldung.
  Die [Übersicht](../runbooks/alarme.md) erklärt jeden Alarm.
- **Tests**: `pnpm check:alerts` prüft die Konfiguration mit `promtool` und `amtool` und führt die Unit-Tests in `infra/observability/tests/alerts.test.yml` aus. Jeder Alarm hat dort einen Fall, der anschlägt, die Schwellen haben Fälle, die still bleiben. In der CI läuft das als Job "Monitoring rules".
- **Zustellung**:
  - Alertmanager schickt jeden Alarm per E-Mail, lokal an Mailpit.
  - `page` wiederholt sich stündlich, `ticket` alle 12 Stunden.
  - Folgealarme bleiben still, solange ihre Ursache feuert. Das gilt für `SchedulerMissing`, `QueuesUnreadable` und ein überschrittenes Budget.
  - Einen Pager für `page` richtet Schritt 8.9 mit dem Ziel der Produktion ein.

### Laufzeit

- Das Compose-Profil `observability` startet zu Grafana und OTLP diese Dienste:
  - Prometheus `v3.13.4`;
  - Alertmanager `v0.34.1`;
  - Pushgateway `v1.11.3`.
- Alle drei laufen gehärtet wie die App und hören nur auf 127.0.0.1.
- Prometheus fragt die Dienste des Profils `app` ab.
- Für API und Worker auf dem Host (`pnpm dev`) zeigt `tools/observability/host-targets.compose.yaml` dieselben Namen auf den Host.

### Runbooks und Proben

- **Aufbau**: Jedes Runbook unter `docs/runbooks/` hat dieselben Teile: Alarme, Diagnose, Schritte, Prüfung, Nachbereitung und ein Protokoll der Proben.
- **Fehler einspielen**: `pnpm drill <szenario>` spielt die Fehler ein, nur außerhalb der Produktion und nur mit dem Mock der Plattform.
  - `platform-outage` und `token-wave` legen eigene Organisationen über die Daten des Lasttests an. Ihre Beiträge sind in zwei Minuten fällig, und die Mock-Konten einer Plattform scheitern einige Minuten lang, mit einem 5xx-Status oder mit abgelehnten Tokens (`failUntil`).
  - `xb-drift` und `xb-canary` senden die Berichte eines Browser-Workers auf `xb-results`.
  - Redis-Verlust und hängende Queue übt das Runbook mit Compose und den Rollen des Workers.
- **Wiederholung**: Die Proben laufen nach jeder Änderung an Alarmen oder Runbooks und einmal im Quartal.

### Werkzeug für die Queues statt Bull Board

- Die Architektur sieht Bull Board für Plattform-Admins vor. Es ist nicht umgesetzt, und nichts zeigte oder leerte bisher die Dead-Letter-Queue; ihr Alarm hätte nie geendet.
- An seine Stelle tritt `pnpm queues`, im Image des Workers `node dist/scripts/queues.js`:
  - die Zählungen jeder Queue nach Zustand;
  - die Dead Letters;
  - die gescheiterten Jobs einer Queue ohne ihre Daten;
  - das Entfernen geprüfter Dead Letters, das geloggt wird.
- Gründe gegen eine Oberfläche im Web:
  - Bull Board zeigt die Daten der Jobs und erlaubt Wiederholen und Löschen über das Netz.
  - Seine Oberfläche passt nicht zur strengen CSP.
  - Die übrigen Runbooks (Restore, zweiter Faktor, Rotation) brauchen ohnehin Zugang zur Shell.
- Das weicht von den Abschnitten 7.1 und 12 der Architektur ab, die angepasst sind.

### Grenzen

- Das Pushgateway hält seine Werte nur im Speicher. Nach einem Neustart fehlt die Meldung bis zum nächsten Backup; `BackupHeartbeatMissing` meldet das nach 30 Minuten, solange das WAL-Archiv eingeschaltet ist.
- Der Browser-Worker hat keine Metriken. Seine Berichte zählt die Rolle, die `xb-results` verarbeitet.
- Alarme auf Logs, etwa auf einzelne Fehlermeldungen, gibt es nicht; die Sicherheitsereignisse zählt die API als Metrik.
- **Zähler nach einem Neustart**: `rate()` erkennt einen Neustart nur daran, dass ein Zähler kleiner wird, und prüft das für jede Zeitreihe eines Histogramms einzeln.
  - Zählt ein neuer Prozess vor seiner ersten Abfrage so viel wie der alte zuletzt, oder ist seine Zeitreihe im Fenster neu, fehlt dieser Teil in den Raten.
  - In den Proben liefen die Prozesse nur Minuten mit wenigen Beiträgen, und jeder neu gestartete Publisher holte den Rückstand vor seiner ersten Abfrage auf. Im SLO fehlten so die verspäteten Beiträge der hängenden Queue und des Redis-Verlusts. Nach dem letzten Neustart sah es umgekehrt pünktliche Beiträge als verspätet, und `PublishOnTimeBudgetBurnFast` stand 90 Sekunden auf pending.
  - Bei Prozessen, die Tage laufen, ist der Zähler nach einem Neustart fast immer kleiner als vorher, und die Raten stimmen.
  - Die Alarme auf die hängende Queue schlagen davon unabhängig an. Für die Nachbereitung und für Proben zählt die Datenbank ([Hängende Queue](../runbooks/haengende-queue.md), Nachbereitung).

## Befunde

Die Unit-Tests der Regeln fanden vor den Proben einen Fehler: Eine Lücke in den Re-Auth-Zahlen vor einer Stunde hätte als Null gezählt und eine Welle vorgetäuscht. Der Alarm vergleicht deshalb mit dem kleinsten Wert der letzten Stunde, und jede Plattform meldet auch ihre Null.

Die Proben vom 2026-10-19 fanden Fehler, die kein Test gezeigt hatte:

- **Verzug der Ticks**: Jeder Tick meldete sein Intervall als Verzug. Der Grund ist das zurückgesetzte `delay` von BullMQ. `tick.sweep-queued` mit 60 Sekunden löste deshalb `SchedulerTickLagging` aus, schon vor der eigentlichen Probe. Behoben mit der geplanten Zeit aus der Job-ID.
- **Bucket-Grenzen in Prometheus 3**: Prometheus 3 speichert die Grenze eines Buckets als `le="120.0"`. Die Regel des SLO suchte `le="120"`, ihre Quote blieb leer, und die Alarme auf das Fehlerbudget hätten nie angeschlagen. Die Unit-Tests hatten die Grenze so eingegeben, wie der Worker sie schreibt. Die Regel trifft jetzt beide Formen, und die Tests geben die gespeicherte ein.
- **Verzögerte Jobs ohne Worker**: Ohne die Rolle `publisher` blieben die Publish-Jobs nach ihrer Zeit `delayed`, denn BullMQ macht einen fälligen Job nur in einem Worker seiner Queue wartend. `QueueStalled` sah sie nie. Neu sind das Gauge `smp_queue_overdue_seconds` und der Alarm `QueueJobsOverdue`.
- **Ticks nach einem Datenverlust in Redis**: Die Job-Scheduler der Ticks legte nur der Start der Rolle `scheduler` an. Ohne Neustart stand nach einem Verlust der Daten jeder Tick still, der Sweeper eingeschlossen, während der Health-Check "bereit" meldete. Die Rolle prüft das jetzt jede Minute.
- **Liveness ohne Redis**: Ohne Redis antwortete auch `/api/health/live` mit 500, denn die Grenze je Adresse liegt in Redis. Ein Orchestrator hätte jede Instanz der API neu gestartet, was nicht hilft. Die Liveness zählt jetzt gegen keine Grenze. Die Readiness behält ihre Grenze, weil sie jede Abhängigkeit abfragt; ohne Redis antwortet sie deshalb mit 500 statt 503. Beides heißt "nicht bereit", der Unterschied bleibt.
- **Dead-Letter-Queue**: siehe oben.
- Die Einzelheiten stehen in den Protokollen der Runbooks.

## Konsequenzen

- **Positiv**:
  - Die Lagen der fünf Runbooks und die Ziele von Lasttest und Backup sind messbar und alarmiert.
  - Jede Regel ist getestet, und die Proben lassen sich mit einem Befehl wiederholen.
- **Negativ**:
  - Prometheus, Alertmanager und das Pushgateway sind drei Dienste mehr, die Schritt 8.9 in Produktion betreiben muss.
  - Die Schwellen müssen mit echtem Verkehr nachgestellt werden. Die Unit-Tests der Regeln folgen dann mit.
  - Ohne Labels für Mandanten zeigt keine Metrik, welche Organisation ein Problem hat. Das zeigen Logs und Datenbank.

## Alternativen

- **Metriken per OTLP an `grafana/otel-lgtm`**: Das Image ist für die Entwicklung gedacht und bringt keinen Alertmanager mit. Die Regeln brauchen ohnehin Prometheus, und ein Anbieter in Produktion kann dieselben Endpunkte abfragen.
- **Alarme in Grafana**: Ihre Regeln lassen sich nicht so einfach mit `promtool` testen und als Dateien prüfen.
- **Metriken mit Mandanten-Labels**: Die Zahl der Zeitreihen würde mit den Kunden wachsen, und Namen von Organisationen kämen in ein System ohne Row-Level Security.
