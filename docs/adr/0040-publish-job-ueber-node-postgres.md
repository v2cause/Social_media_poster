# ADR 0040: Publish-Job über node-postgres

- **Status**: Akzeptiert
- **Datum**: 2026-10-19
- **Bezug**: Umsetzungsleitfaden, Schritt 8.5; `docs/ARCHITECTURE.md`, Abschnitte 3, 6.3 und 7; [ADR 0001](0001-monorepo-und-stack.md), [ADR 0003](0003-rls-und-mandantentrennung.md), [ADR 0004](0004-scheduling-und-outbox.md)

## Kontext

Schritt 8.5 verlangt 10.000 fällige Varianten pro Minute, also im Mittel rund 167 pro Sekunde. Der Lasttest lief auf einer Maschine mit 4 vCPU, auf der auch Postgres, Redis, die API und k6 liefen. Mit dem Publish-Job über Prisma veröffentlichte er höchstens 109 Varianten pro Sekunde, auch nachdem ein Lauf drei statt sechs Transaktionen brauchte.

Der Engpass war die CPU:
- In den Publishern lag der größte Teil der Zeit im Prisma-Client: Query-Compiler, Treiber-Adapter und interaktive Transaktion.
- Postgres parste und plante jede Anweisung neu, weil Prisma keine benannten Prepared Statements verwendet. Diese CPU teilen sich alle Publisher; sie wächst nicht mit, wenn mehr Publisher laufen.

Eine Messung mit Testcontainers zeigt den Unterschied. Sie lief über eine Verbindung, mit je 3.000 Transaktionen samt Mandanten-Kontext als `app_user`, und zählt die CPU-Zeit pro Transaktion:

| Transaktion | Prisma: Node | Prisma: Postgres | node-postgres: Node | node-postgres: Postgres |
|---|---|---|---|---|
| leer (BEGIN, Kontext, COMMIT) | 1,1 ms | 0,5 ms | 0,2 ms | 0,2 ms |
| ein UPDATE | 1,7 ms | 1,3 ms | 0,4 ms | 0,7 ms |
| Account mit Verbindung lesen | 2,2 ms | 1,6 ms | 0,4 ms | 0,4 ms |
| ein INSERT in die Outbox | 1,8 ms | 1,2 ms | 0,4 ms | 0,6 ms |
| sechs Anweisungen | 5,8 ms | 5,5 ms | 1,4 ms | 2,3 ms |

## Entscheidung

- **Ort**: Der Publish-Job der Rolle `publisher` spricht Postgres über node-postgres an: `PgPublishJobUnitOfWork` und `createPublishJobPool` in `packages/db`. Beide stehen hinter dem Port `PublishJobUnitOfWork` des Kerns, der unverändert bleibt.
- **Anweisungen**: Jede Anweisung ist ein benanntes Prepared Statement. Postgres parst und plant sie einmal pro Verbindung. Die Anweisungen entsprechen denen des Prisma-Speichers. Wo Prisma `updated_at` setzt, setzt es die Anweisung mit `now()`. Neue IDs sind UUIDv7 wie die Defaults des Schemas.
- **Mandanten**:
  - Eine Unit ist eine Transaktion als `app_user`. Sie setzt zu Beginn den Mandanten des Jobs transaktionslokal, wie `setTenantContext`.
  - Row-Level Security gilt wie bisher, und jede Anweisung filtert zusätzlich ausdrücklich nach dem Workspace.
  - Bei einem Fehler folgt ROLLBACK. Scheitert auch das, verlässt die Verbindung den Pool.
- **Pool**:
  - Höchstens zehn Verbindungen pro Publisher, so viele wie der Pool von Prisma, den er ersetzt, und nicht mehr als `PUBLISH_CONCURRENCY`. Ein Job hält eine Verbindung nur während seiner Transaktionen, nicht während die Plattform antwortet.
  - Verbindungsaufbau, Anweisung und offene Transaktion haben je 10 s; was hängt, lässt den Lauf scheitern, statt ihn zu blockieren.
  - Bricht eine freie Verbindung ab, etwa bei einem Neustart von Postgres, loggt der Worker `publish.pool_error`, und der Pool öffnet eine neue.
- **Prisma bleibt** für alles andere: die API, die übrigen Jobs, Migrationen und Seed. Auch die Analytics nutzen weiter den Prisma-Speicher des Publish-Jobs für Ziele, Verbindungen, Kosten und Outbox. Im Publisher bleiben über Prisma die Ausgabengrenze für X, der X-Browser und die Logins.
- **Tests**:
  - Beide Speicher bestehen dieselbe Integrationssuite `packages/db/test/publish-job-adapters.integration.test.ts`.
  - Sie prüft dazu Row-Level Security über den Mandanten der Unit, unabhängig vom genannten Workspace, sowie das Rollback.
  - Für node-postgres prüft sie außerdem, dass die gepoolte Verbindung danach keinen Mandanten mehr trägt.
  - Die Integrationstests des Workers laufen mit dem neuen Speicher.

## Konsequenzen

- **Kosten**: Die Datenbankzugriffe eines Laufs kosten rund ein Drittel der CPU, im Publisher wie in Postgres. Wie sich das im Lasttest auswirkt, hält der Leitfaden in Schritt 8.5 fest.
- **Zwei Implementierungen**: Derselbe Port hat zwei Implementierungen. Eine Schemaänderung an den Tabellen des Publish-Jobs muss beide nachziehen. Die gemeinsame Suite fängt Abweichungen im Verhalten ab, aber nicht in den Typen: Der node-postgres-Speicher beschreibt seine Zeilen selbst, statt sie aus dem Prisma-Client zu beziehen.
- **Doppelte Logik**: Das Markieren einer Verbindung als `NEEDS_REAUTH` mit den Marken ihrer geplanten Varianten steht zweimal: in `channels/reauth.ts` für Prisma und im node-postgres-Speicher.
- **Explizite Filter**: Die Prüfung der Mandantenfilter in Dev und Test (`TENANT_FILTERS`) greift nur für Prisma. Für node-postgres zeigt die Suite die Filter, Row-Level Security bleibt die eigentliche Grenze.
- **Verbindungen**: Jeder Publisher hält bis zu zehn Verbindungen zusätzlich zum Pool von Prisma, der im Publisher kaum noch gebraucht wird. `max_connections` von Postgres muss für alle Publisher, die API und die übrigen Rollen reichen.
- **Tracing**: Die Instrumentierung von node-postgres in OpenTelemetry erfasst die Anweisungen wie zuvor die des Treiber-Adapters von Prisma, ohne Parameter.

## Alternativen

- **Weniger Anweisungen über Prisma**: Schon umgesetzt. Der Claim liest Ziel und Medien, die Schreibmarke des Versuchs geht mit der Verlängerung der Lease, `lockForJob` liest die Einstellungen des Workspace mit. Mit 2.000 fälligen Varianten stieg der Durchsatz von 83 auf 105 pro Sekunde; das reicht nicht.
- **Rohes SQL über Prisma** (`$queryRaw`): Die interaktive Transaktion und der Treiber-Adapter bleiben, und Postgres plant weiter jede Anweisung neu. In derselben Messung kostete eine Transaktion mit einer Anweisung über `$queryRaw` im Node-Prozess 1,5 bis 1,8 ms statt 1,8 bis 2,2 ms über die Methoden des Clients; über node-postgres waren es 0,4 ms.
- **Mehr Publisher oder größere Maschinen**: Das verteilt die CPU der Publisher, nicht die von Postgres, und Postgres ist der gemeinsame Teil.
