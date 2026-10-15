# ADR 0004: Scheduling und Outbox

- **Status**: Akzeptiert (Umsetzung ab Phase 4)
- **Datum**: 2026-10-15
- **Bezug**: Umsetzungsleitfaden, Schritte 0.8 und 4.7 bis 4.8; `docs/ARCHITECTURE.md`, Abschnitt 7

## Kontext

Geplante Posts müssen genau zur Uhrzeit erscheinen, auch wenn Redis neu startet, ein Worker abstürzt oder der Nutzer umplant. Reine verzögerte BullMQ-Jobs reichen dafür nicht.

## Entscheidung

- **Postgres ist die Quelle der Wahrheit.** Der Zustand der Variante (`SCHEDULED`, `QUEUED`, `PUBLISHING`, …) steht in der Tabelle `post_variant`. BullMQ führt nur aus.
- **Scheduler-Tick** als BullMQ Job Scheduler mit fester ID. Jede Replik legt dieselbe Definition an, also gibt es genau eine. Der Nachweis steht in Schritt 0.8: Zwei Worker-Prozesse ergeben `ZCARD bull:scheduler:repeat = 1`.
- **Auswahl der fälligen Varianten** per `FOR UPDATE SKIP LOCKED`, damit mehrere Replikas sich nicht in die Quere kommen.
- **Idempotenz**: Die Job-ID ist `pub:{variantId}:{scheduleVersion}`. Umplanen erhöht die Version, ein veralteter Job endet dadurch ohne Aktion.
- **Outbox**: Ereignisse entstehen in derselben Transaktion wie die Änderung. Ein Relay im Ein-Sekunden-Takt schiebt sie nach Redis.
- **Sweeper** findet Varianten, die zu lange auf `QUEUED` stehen, und reiht sie erneut ein. Das ist wegen der festen Job-ID gefahrlos.

## Alternativen

- **Nur verzögerte Jobs in BullMQ**: verworfen. Redis ist nicht dauerhaft verlässlich, DB und Redis laufen ohne Outbox auseinander, und Umplanen würde Jobs herumschieben.
- **Cron in der Datenbank** (pg_cron): verworfen, weil die Ausführung dann an eine Erweiterung gebunden wäre und der Betrieb in Managed-Umgebungen unklar ist.

## Konsequenzen

- Zwei Speicher (Postgres und Redis) müssen konsistent bleiben. Dafür gibt es die Outbox.
- Ein verpasstes Zeitfenster (mehr als 6 Stunden überfällig) führt zu `FAILED(MISSED_WINDOW)` und einer Benachrichtigung, außer der Workspace erlaubt das Nachholen.
