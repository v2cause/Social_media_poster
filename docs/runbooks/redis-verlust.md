# Runbook: Redis-Verlust

Schritt 8.7 des Leitfadens, [ADR 0043](../adr/0043-slos-metriken-und-alarme.md), [ADR 0042](../adr/0042-backup-und-wiederherstellung.md) (Abschnitt "Andere Speicher"). Für den Fall, dass Redis nicht erreichbar ist oder ohne seine Daten neu startet.

## Was in Redis liegt

Postgres ist die Quelle der Wahrheit (Architektur 7). Sitzungen, Varianten, Versuche, Outbox, globale Flags und Benachrichtigungen in der App liegen dort. Redis hält:

- **die Queues von BullMQ** mit allen wartenden und verzögerten Jobs und den Job-Schedulern der Ticks;
- **Zähler**: Grenzen der Anmeldung, des Throttlers, der KI und der E-Mails, den Drift-Zähler des Circuit Breakers;
- **kurzlebige Zustände**: den Zugriffs-Cache (60 s), den Cache der Analytics (5 Minuten), laufende OAuth-Verbindungen und Anmeldungen des X-Browsers, die Plätze der Live-Streams;
- **das Kill-Signal der Browser-Worker** (`xb:kill`) und den Pub/Sub-Kanal der Live-Ereignisse.

Redis schreibt ein Append-Only-File in das Volume `redis-data` und verdrängt nie Schlüssel (`noeviction`). Die Nutzer der ACL (`app`, `health`, `browser-worker` und `default`, der aus ist) stehen in den Argumenten von `redis-server` in `compose.yaml` und entstehen bei jedem Start neu, auch mit leerem Volume. `default` behält die Regeln `~* &* +@all`: Redis spielt das AOF beim Start als dieser Nutzer ab und prüft dessen Regeln für jede Transaktion.

## Alarme

- **`QueuesUnreadable`** (page): Der Worker kann die Queues nicht lesen, seit 2 Minuten.
- **`SchedulerTickStalled`** (page): `tick.publish` oder `tick.outbox-relay` endete seit über 3 Minuten nicht ohne Fehler, seit 2 Minuten. Solange `QueuesUnreadable` feuert, bleibt er still. Nach einem Datenverlust legt die Rolle `scheduler` die Ticks innerhalb einer Minute neu an (Schritte unten); feuert der Alarm danach trotzdem, hat das nicht geklappt.
- **`AccessCacheInvalidationFailed`** (ticket): Ein Zugriff im Cache ließ sich nicht verwerfen. Eine entzogene Rolle gilt dann bis zu 60 s weiter.
- Folgen: `QueueStalled`, `QueuedVariantsStuck` und auf der API `ApiErrorBudgetBurnFast`.
- **Health-Checks ohne Redis**:
  - Die API beantwortet jede Anfrage mit 500, denn die Grenzen je Adresse liegen in Redis, und ohne sie lässt sie nichts durch.
  - Ausgenommen ist `/api/health/live`, das weiter mit 200 antwortet. So startet ein Orchestrator die API nicht neu, was nicht helfen würde.
  - `/api/health/ready` antwortet aus demselben Grund mit 500 statt 503, `/health/ready` des Workers mit 503. Beides heißt "nicht bereit".

## Diagnose

1. **Läuft Redis?** `docker compose ps redis`, `docker compose logs --tail 100 redis`. Typisch sind ein voller Datenträger (Fehler beim Schreiben des AOF), zu wenig Speicher (`OOM command not allowed` bei `noeviction`) oder ein Neustart des Hosts.
   - Steht nach einem Start `NOPERM ACLs rules changed between the moment the transaction was accumulated and the EXEC call` im Log (`docker compose logs redis | grep -c NOPERM`), hat Redis beim Laden Transaktionen des AOF verworfen: `default` hat nicht mehr die Regeln aus `compose.yaml`. Die Queues sind dann unvollständig, und Zähler der Grenzen laufen nicht mehr ab. `compose.yaml` korrigieren, Redis mit leerem Volume starten (`docker compose rm -sf redis`, `docker volume rm <Projekt>_redis-data`, `docker compose up -d redis`) und weiter wie unter "Daten verloren".
2. **Antwortet Redis?** Die Rolle `publisher` loggt `publish.worker_error` mit dem Verbindungsfehler, etwa `ECONNREFUSED`, die Rolle `scheduler` `metrics.operations_failed`. `smp_queue_counts_up` ist 0, solange sie die Queues nicht lesen kann.
3. **Sind die Daten noch da?** Antwortet Redis wieder, zeigt `pnpm queues counts` (in Produktion `docker compose exec worker node dist/scripts/queues.js counts`) die Queues. In `scheduler` liegt sonst je Tick ein verzögerter Job, lokal zehn. Ist `delayed` dort 0 und sind die übrigen Queues leer, sind die Daten weg. Das Log hilft dabei wenig: Der Worker loggt den Verlust nicht, und ein Tick ohne Arbeit schreibt `scheduler.tick` nur auf der Stufe `debug`.

## Schritte

### Redis nicht erreichbar

1. Redis wieder starten, zum Beispiel `docker compose up -d redis`, nach einem vollen Datenträger erst Platz schaffen.
2. API und Worker verbinden sich von selbst neu. Jobs, Ticks und Zähler sind mit dem AOF erhalten, wenn das Log des Starts kein `NOPERM` enthält (Diagnose, Schritt 1).
3. Jobs, die während des Ausfalls fällig wurden, laufen danach mit Verspätung. Den Rest erledigen die Ticks.

### Daten verloren

1. Redis leer starten (`docker compose up -d redis`); die Nutzer der ACL entstehen neu.
2. **Ticks**: Die Rolle `scheduler` prüft jede Minute, ob Redis die Job-Scheduler der Ticks kennt, legt fehlende neu an und loggt `scheduler.ticks_restored` mit ihren Namen. Ohne Ticks laufen weder Planen noch Sweeper noch Outbox, auch wenn Redis wieder antwortet. Fehlt die Zeile zwei Minuten nach dem Start von Redis oder bleibt `delayed` in `scheduler` bei 0, die Worker mit der Rolle `scheduler` neu starten; ihr Start legt die Ticks immer an.
3. **Kill-Switch**: War er an, ihn auf `/admin` einmal aufheben und wieder aktivieren. So steht `xb:kill` wieder in Redis. Das globale Flag in Postgres hält neue Befehle ohnehin zurück.
4. **Was von selbst zurückkommt**:
   - **Veröffentlichung**: Der Sweeper gibt QUEUED-Varianten nach 2 Minuten ihren Job zurück, PUBLISHING nach Ablauf des Leases und RETRYING nach 3 Stunden. SCHEDULED-Varianten plant `tick.publish` wie immer.
   - **Outbox**: Ereignisse, die noch nicht weitergereicht waren, reicht `tick.outbox-relay` weiter.
   - **Analytics, Tokens, DSGVO**: Ihre Ticks planen die Arbeit beim nächsten Lauf neu.
5. **Was verloren ist**:
   - E-Mails und Benachrichtigungen, die in `notifications` warteten;
   - Uploads, die in `media` auf ihre Verarbeitung warteten;
   - laufende Verbindungen über OAuth und Anmeldungen des X-Browsers;
   - die Zähler der Grenzen.

   Bei vielen offenen Uploads (`media_asset` mit Status `PROCESSING` seit über 10 Minuten) laden die Kunden die Dateien neu hoch. Eine Mitteilung erklärt, dass E-Mails der letzten Minuten vor dem Ausfall fehlen können.
6. **Varianten auf RETRYING**: Wer nicht 3 Stunden warten will, setzt sie zurück. Die Kunden planen sie in der Planungsleiste des Composers neu oder posten sie sofort, oder der Betrieb wartet auf den Sweeper.

## Prüfung

- `QueuesUnreadable` und `SchedulerTickStalled` enden mit `[RESOLVED]`.
- `time() - smp_scheduler_tick_last_success_timestamp_seconds{tick="tick.publish"}` liegt unter 60 s, und `pnpm queues counts` zeigt in `scheduler` wieder je Tick einen verzögerten Job.
- Ein Beitrag, der nach dem Neustart fällig wird, geht pünktlich hinaus. Einer, der davor auf QUEUED stand, bekommt seinen Job mit dem nächsten Lauf des Sweepers, sobald er 2 Minuten auf QUEUED steht.
- `/api/health/ready` antwortet mit 200.

## Nachbereitung

- Ursache des Ausfalls festhalten: Speicher, Datenträger, Host.
- Nach einem Datenverlust die Zahl der neu eingereihten Varianten (Logzeile des Sweepers) und der verlorenen Benachrichtigungen notieren.
- Der Speicher von Redis braucht Luft für Spitzen. `noeviction` verliert keine Jobs, lehnt aber neue ab, wenn er voll ist.

## Protokoll der Proben

| Datum | Umgebung | Ablauf | Ergebnis |
| --- | --- | --- | --- |
| 2026-10-19 | Lokal: Compose mit Infrastruktur und Profil `observability`, API und Worker mit allen Rollen aus `dist` auf dem Host, Mailpit | **Redis nicht erreichbar**: `docker compose stop redis` um 05:51:38, `docker compose start redis` um 05:57:11 | Bestanden mit einem Befund. Der Worker meldete `/health/ready` 503 und `smp_queue_counts_up` 0. Die API antwortete auf jede Anfrage mit 500, auch auf `/api/health/live`: Die Grenze je Adresse liegt in Redis (ADR 0043, Befunde). `QueuesUnreadable` feuerte um 05:54 (Mail 05:54:27). `SchedulerTickStalled` feuerte um 05:57 für `tick.publish` und `tick.outbox-relay` und blieb wie vorgesehen ohne Mail, weil `QueuesUnreadable` feuerte. Nach dem Start waren Worker und API um 05:57:22 bereit, die Ticks liefen ab 05:57:20 wieder; ihre Job-Scheduler hatte das AOF erhalten. `[RESOLVED]` um 05:59:27. |
| 2026-10-19 | Wie oben, Worker ohne die Rolle `publisher` und noch ohne die Prüfung der Ticks | **Daten verloren, vor der Korrektur**: 8 Varianten standen ab 06:10:37 auf QUEUED, ihre Jobs lagen verzögert in Redis; 8 weitere waren für 06:16 geplant. Um 06:10:53 Redis mit leerem Volume neu (`docker compose rm -sf redis`, `docker volume rm social-media-poster_redis-data`, `docker compose up -d redis`) | Bestanden, der Befund aus ADR 0043 bestätigt. Worker und API meldeten drei Sekunden später "bereit", der Worker loggte nichts, aber kein Tick lief mehr. `SchedulerTickStalled` feuerte um 06:16 (Mail 06:16:27). Die Diagnose fand mit `pnpm queues counts` keinen verzögerten Job in `scheduler` und die Varianten von 06:16 noch geplant. Nach dem Neustart des Workers mit allen Rollen um 06:16:48 plante `tick.publish` die 8 geplanten Varianten, sie gingen 52 s nach ihrer Zeit hinaus. Der Sweeper gab den 8 auf QUEUED ihre Jobs zurück (`added: 8`). Um 06:16:52 waren alle 16 veröffentlicht, jede mit einem Versuch. `[RESOLVED]` um 06:21:27. Den Kill-Switch prüfte die Probe nicht, er war aus. |
| 2026-10-19 | Wie oben, API und Worker neu gebaut, mit der Prüfung der Ticks und der Liveness ohne Grenze | **Daten verloren, mit der Korrektur**: 8 Varianten fällig um 06:21:00, um 06:19:00 Redis mit leerem Volume neu. Danach **Redis nicht erreichbar** von 06:21:52 bis 06:21:58 | Bestanden. Um 06:19:54 legte die Rolle `scheduler` die zehn Ticks ohne Neustart neu an (`scheduler.ticks_restored`). `tick.publish` plante die Varianten um 06:20:54, alle 8 gingen höchstens 0,5 s nach ihrer Zeit hinaus. `SchedulerTickStalled` schlug nicht an. Ohne Redis antwortete `/api/health/live` mit 200, `/api/health/ready` und die übrigen Routen der API mit 500, `/health/ready` des Workers mit 503; eine Sekunde nach dem Start waren beide wieder bereit. Danach stand `PublishOnTimeBudgetBurnFast` 90 Sekunden auf pending, ohne zu feuern: Nach den kurzen Läufen der Prozesse sah das SLO pünktliche Beiträge als verspätet (ADR 0043, Grenzen). |
| 2026-10-19 | Lokal: Compose ohne Profil `observability`, mit dem korrigierten Nutzer `default`; API und Worker mit allen Rollen aus `dist` auf dem Host | **Redis neu gestartet**: um 09:47:23 Redis mit leerem Volume, um 09:48:52 `docker compose restart redis` mit den zehn Ticks in `scheduler` und einem offenen Fenster des Throttlers | Bestanden. Redis antwortete in derselben Sekunde wieder, das Log des Starts enthält kein `NOPERM`. Vorher und nachher 43 Schlüssel und dieselben Zahlen in `pnpm queues counts`. Das Fenster `throttle:address:127.0.0.1` behielt seine 5 Treffer und seinen Ablauf (57,9 s Restzeit vorher, 56,1 s nachher). API und Worker waren danach sofort wieder bereit. |

Nachtrag zur ersten Zeile: Bis zur Korrektur am 2026-10-19 verwarf Redis bei jedem Start alle Transaktionen seines AOF ([ADR 0043](../adr/0043-slos-metriken-und-alarme.md), Befunde). Die Probe hat das nicht erkannt, weil sie nur die Ticks prüfte; dass das AOF Jobs und Zähler erhält, war bis dahin falsch.
