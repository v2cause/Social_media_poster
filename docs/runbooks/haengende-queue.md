# Runbook: Hängende Queue

Schritt 8.7 des Leitfadens, [ADR 0043](../adr/0043-slos-metriken-und-alarme.md). Für den Fall, dass Jobs warten und niemand sie abarbeitet, dass Jobs einer Queue scheitern oder dass die Ticks des Schedulers zu spät, gar nicht oder mit Fehlern laufen.

## Alarme

- **`QueueStalled`** (page): Jobs warten in einer Queue, und kein Worker hat dort seit 10 Minuten einen beendet. Das Label `queue` nennt sie.
- **`QueueJobsOverdue`** (page): Verzögerte Jobs einer Queue sind seit über 2 Minuten überfällig. BullMQ macht einen fälligen Job nur in einem Worker seiner Queue wartend; ohne einen bleibt er verzögert, und `QueueStalled` sieht ihn nie. So zeigen sich eine fehlende Rolle `publisher` (die Publish-Jobs warten bis zu ihrer Zeit verzögert) und eine fehlende Rolle `analytics`.
- **`QueuedVariantsStuck`** (page): Varianten stehen über 10 Minuten auf QUEUED, ohne dass ihr Job startet.
- **`QueueJobsFailing`** (ticket): Mehr als die Hälfte der Jobs einer Queue scheitert, über 30 Minuten und mindestens 10 Jobs. Publish-Jobs und Ticks haben eigene Alarme.
- **`DeadLetterQueueNotEmpty`** (ticket): In `publish-dead` liegen Kopien von Publish-Jobs, die endgültig gescheitert sind.
- **`SchedulerTickLagging`** (page): `tick.publish`, `tick.sweep-queued` oder `tick.outbox-relay` startet über 60 s nach seiner Zeit.
- **`SchedulerTickFailed`** (ticket): Der letzte Lauf eines Ticks scheiterte.
- **`SchedulerMissing`** (page): Kein Worker mit der Rolle `scheduler` meldet sich. Solange er feuert, schweigen die Alarme auf Ticks und hängende Varianten.
- **`PublishOnTimeBudgetBurnFast`**, **`PublishOnTimeBudgetBurnSlow`**: folgen, wenn die Beiträge danach verspätet hinausgehen.

## Welche Rolle welche Queue abarbeitet

| Queue | Rolle (`WORKER_ROLES`) | Inhalt |
|---|---|---|
| `scheduler` | `scheduler` | die Ticks: Planen, Sweeper, Outbox, Tokens, Analytics, Wartung |
| `publish` | `publisher` | ein Job je fällige Variante |
| `tokens` | `publisher` | Token-Refreshes |
| `xb-results` | `publisher` | Berichte des Browser-Workers |
| `xb-commands` | Browser-Worker (eigener Dienst) | Befehle an den X-Browser |
| `notifications` | `notify` | E-Mails und Benachrichtigungen in der App |
| `media` | `media` | Verarbeitung der Uploads |
| `analytics` | `analytics` | Abruf der Metriken |
| `billing` | `billing` | Nutzungsberichte an Stripe |
| `gdpr` | `gdpr` | Datenexport, Löschung, Aufräumen der Medien |
| `ai` | keine | derzeit ungenutzt |
| `publish-dead` | keine | Kopien endgültig gescheiterter Publish-Jobs |

Jeder Worker loggt beim Start seine Rollen (`worker.started` mit `roles`). Die Gauges der Queues meldet nur die Rolle `scheduler`.

## Diagnose

1. **Welche Queue, welcher Zustand?**

   ```bash
   docker compose exec worker node dist/scripts/queues.js counts   # lokal nach pnpm build: pnpm queues counts
   ```

   Je Queue eine JSON-Zeile mit `waiting`, `active`, `delayed`, `prioritized`, `paused`, `failed` und `completed`. Viele `waiting` und kein `active`: Niemand arbeitet die Queue ab. `delayed`, das über die Zeit der Jobs hinaus nicht sinkt (`smp_queue_overdue_seconds`), heißt dasselbe. Viele `active` über lange Zeit: Jobs hängen, zum Beispiel an einer Datenbank, die nicht antwortet.
2. **Läuft die Rolle?** Die Tabelle oben nennt die Rolle. Ihre Worker müssen laufen (`docker compose ps`, `/health/ready` auf ihrem Health-Port) und die Rolle in `WORKER_ROLES` haben. `rate(smp_worker_jobs_total[5m])` je `queue` und `status` zeigt, ob und wie sie Jobs beenden.
3. **Scheitern die Jobs?**

   ```bash
   docker compose exec worker node dist/scripts/queues.js failed --queue notifications --limit 20
   ```

   Je Job Name, Grund, Versuche und Zeit, nie seine Daten. Häufige Gründe: SMTP nicht erreichbar (`notifications`), Objektspeicher (`media`, `gdpr`), Stripe (`billing`).
4. **Ticks**:
   - `smp_scheduler_tick_lag_seconds` zeigt, wie spät jeder Tick startet.
   - `time() - smp_scheduler_tick_last_success_timestamp_seconds` zeigt, wie lange der letzte erfolgreiche Lauf her ist.
   - `smp_scheduler_tick_last_failure_timestamp_seconds` zeigt den letzten Fehlschlag.
   - Die Logzeile `scheduler.tick_failed` nennt den Tick und den Fehler.
5. **Redis und Datenbank**: Fehlen alle Ticks auf einmal oder sind die Queues nicht lesbar (`QueuesUnreadable`), weiter mit [Redis-Verlust](redis-verlust.md). Hängen Jobs `active`, die Datenbank prüfen: lange Transaktionen und Sperren in `pg_stat_activity`.

## Schritte

1. **Rolle fehlt oder hängt**: Worker mit der Rolle starten oder neu starten, die Logs vorher sichern. Mehrere Worker mit derselben Rolle sind unbedenklich; jeder Tick läuft trotzdem nur einmal.
2. **Jobs scheitern**: Die Ursache aus Schritt 3 der Diagnose beheben. BullMQ wiederholt die Jobs nach ihren Optionen. Ein endgültig gescheiterter Job bleibt einen Tag in `failed`, bei `publish`, `billing` und `gdpr` sieben Tage. Publish-Jobs startet der Sweeper neu.
3. **Hängende QUEUED-Varianten**: Der Sweeper (`tick.sweep-queued`, jede Minute) gibt Varianten ihren Job zurück:
   - QUEUED, seit über 2 Minuten ohne Job: neuer Job;
   - PUBLISHING mit abgelaufenem Lease: neuer Job;
   - RETRYING ohne Bewegung seit 3 Stunden: neuer Job.

   Ein gescheiterter oder abgeschlossener Job dazu startet neu. Läuft der Sweeper selbst nicht, zuerst die Rolle `scheduler` starten.
4. **Gescheiterter Tick**: Er läuft erst zu seiner nächsten Zeit wieder, bei `tick.maintenance` also am nächsten Tag. Die Ursache beheben und den nächsten Lauf im Log prüfen (`scheduler.tick`).
5. **Dead-Letter-Queue**:

   ```bash
   docker compose exec worker node dist/scripts/queues.js dead-letters --limit 100
   ```

   - Je Kopie eine Zeile mit Organisation, Workspace, Variante, Grund (`failedReason`), Versuchen und Zeit (`failedAt`).
   - Die Variante selbst hat ihren Status, meist `FAILED`. Die Owner wurden benachrichtigt und planen sie neu.
   - Ein Job, der zweimal stehen blieb, hinterlässt eine Kopie, auch wenn der Sweeper die Variante danach veröffentlicht. Vor einer Nachricht an Kunden deshalb den Status der Variante prüfen.

   Sind die Gründe geklärt, entfernt man die Kopien, die man angesehen hat:

   ```bash
   docker compose exec worker node dist/scripts/queues.js remove-dead-letters --before 2026-10-19T05:15:00Z
   ```

   Ohne `--before` gehen alle. Das Kommando loggt die Zahl (`queues.dead_letters_removed`).
6. **Fehlender Scheduler**: Einen Worker mit der Rolle `scheduler` starten. Beim Start legt er die Ticks in Redis neu an.

## Prüfung

- `pnpm queues counts`: `waiting` der Queue sinkt auf 0, `completed` steigt.
- `QueueStalled` und `QueuedVariantsStuck` enden mit `[RESOLVED]`.
- In der Beitragsliste steht keine Variante mehr über 10 Minuten auf "In Warteschlange".

## Nachbereitung

- Eine Notiz mit Dauer, Ursache und Zahl der verspäteten Varianten. Die Zahl kommt aus der Datenbank (als `app_system`), nicht aus den Metriken. Veröffentlicht ein neu gestarteter Publisher den Rückstand, bevor Prometheus ihn das erste Mal abfragt, können diese Beiträge in den Raten des SLO fehlen ([ADR 0043](../adr/0043-slos-metriken-und-alarme.md), Grenzen):

  ```sql
  SELECT count(*) FILTER (WHERE published_at - scheduled_at > interval '2 minutes') AS late, count(*) AS published
    FROM post_variant WHERE status = 'PUBLISHED' AND published_at > now() - interval '24 hours';
  ```
- Fehlte eine Rolle nach einem Deployment, gehört die Prüfung von `WORKER_ROLES` in die Checkliste des Deployments (Schritt 8.9).

## Protokoll der Proben

| Datum | Umgebung | Ablauf | Ergebnis |
| --- | --- | --- | --- |
| 2026-10-19 | Lokal: Compose mit Infrastruktur und Profil `observability`, API und Worker aus `dist` auf dem Host, Mailpit | Worker ohne die Rolle `publisher` ab 05:31, mit `pnpm load:fixture --organizations 2 --due-posts 2` 16 Varianten fällig um 05:34; nach den Alarmen der Worker mit allen Rollen | Bestanden nach einer Korrektur. Die Publish-Jobs blieben nach 05:34 verzögert, denn BullMQ macht fällige Jobs nur in einem Worker der Queue wartend. `QueueStalled` sah das nie. Neu sind `smp_queue_overdue_seconds` und `QueueJobsOverdue` (ADR 0043). Dieser Alarm feuerte um 05:41:23 (Mail 05:41:53), `QueuedVariantsStuck` um 05:48:55 (Mail 05:49:23). Die Diagnose fand mit `pnpm queues counts` 16 verzögerte Jobs in `publish`, und `worker.started` nannte keine Rolle `publisher`. Nach dem Neustart mit allen Rollen um 05:49:16 waren alle 16 Varianten zwei Sekunden später veröffentlicht; `[RESOLVED]` um 05:51:53 und 05:54:23. Die verspäteten Beiträge zählte das SLO nicht: Der Publisher veröffentlichte sie vor seiner ersten Abfrage (ADR 0043, Grenzen). |
