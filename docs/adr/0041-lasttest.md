# ADR 0041: Lasttest

- **Status**: Akzeptiert
- **Datum**: 2026-10-19
- **Bezug**: Umsetzungsleitfaden, Schritt 8.5; `docs/ARCHITECTURE.md`, Abschnitte 7, 8, 12 und 13; [ADR 0004](0004-scheduling-und-outbox.md), [ADR 0006](0006-authentifizierung.md), [ADR 0027](0027-analytics-kaskade-rollup-und-api.md), [ADR 0039](0039-security-review-und-haertung.md), [ADR 0040](0040-publish-job-ueber-node-postgres.md)

## Kontext

Schritt 8.5 verlangt k6-Skripte für zwei Ziele:
- 10.000 fällige Varianten pro Minute,
- ein p95 unter 300 ms für die Lesezugriffe der API.

Fertig ist der Schritt, wenn beide Ziele erreicht sind. Die Teststrategie der Architektur nennt für den Lasttest außerdem den Durchsatz der Analytics-Batches.

## Entscheidung

### Aufbau

- **Testdaten** (`pnpm load:fixture`, `seedLoadFixture` in `packages/db`):
  - Pro Organisation entsteht ein Workspace mit Owner, Agentur-Abo, vier Mock-Accounts (LinkedIn, Instagram, Facebook, X) und der Demo-Historie von 90 Tagen samt Rollup.
  - Dazu kommen Posts mit je vier Varianten, alle in derselben Minute fällig, jede mit einem Bild und fertigen Renditions. Standard: 250 Organisationen mit je zehn Posts, also 10.000 Varianten.
  - Die Mock-Accounts antworten nach 500 ms, wie eine Plattform im Netz.
- **k6** (`tools/load/publish-burst.ts`, k6 2.3):
  - Alle Owner melden sich vorher an. Jede Anfrage trägt die Adresse ihres Owners in `X-Real-IP`, so greifen die Limits je Adresse und Person wie bei so vielen Personen.
  - Das Szenario `reads` liest mit fester Rate, standardmäßig 100 Anfragen pro Sekunde, gewichtet wie die Nutzung der App: Kalenderwoche, Post-Liste und nächste Posts (zusammen 40 %), Composer (10 %), ungelesene Benachrichtigungen (10 %), Accounts, die drei Analytics-Ansichten, Medienbibliothek, Workspace und Profil.
  - Das Szenario `publishing` folgt mit zehn Beobachtern über die Variantenliste der API, bis jede fällige Variante veröffentlicht ist, und misst ihren Verzug.
  - `API_URL` darf mehrere Instanzen nennen; die Anfragen wechseln sich ab, wie der Reverse Proxy sie auf seine Replikas verteilt.
- **Ziele als Schwellen**: Jede fällige Variante ist veröffentlicht, keine später als 60 s nach ihrer Fälligkeit. Das p95 der Lesezugriffe liegt unter 300 ms, über den ganzen Lauf, in der Minute des Schubs und für die Abfragen der Beobachter. Weniger als 1 % der Lesezugriffe scheitern. k6 endet mit Code 99, wenn eine Schwelle verfehlt ist.
- **Datenbank-Sicht** (`pnpm load:stats`, `loadRunReport` in `packages/db`):
  - Sie zeigt Status, Verzug beim Einreihen und Veröffentlichen, Veröffentlichungen pro Sekunde, Versuche, den Verzug der Outbox und die Abfragen der Metriken.
  - Die Abfragen der Metriken laufen im Hintergrund, wo k6 sie nicht sieht. Den Durchsatz der Analytics misst deshalb diese Sicht, nicht k6.
  - Mit `--wait-metrics` wartet sie, bis jede veröffentlichte Variante ihre erste Abfrage hat.
- **Stack**:
  - Ein eigener Compose-Stack mit neuen Volumes, Migrationen und Seed. Die gebauten Prozesse von API und Worker laufen außerhalb von Docker.
  - Ein Worker-Prozess mit den Rollen `scheduler`, `analytics`, `media`, `notify` und `gdpr`, drei Publisher-Prozesse mit `PUBLISH_CONCURRENCY=50` und eine oder zwei API-Instanzen.
  - `SCHEDULER_TICK_MS=15000`. `ANALYTICS_CADENCE_SCALE=3600` macht die erste Abfrage der Metriken nach 1 s statt 1 h fällig (bei X nach 24 s statt 24 h).
  - Die Prozesse erreichen Postgres und Redis über die Adressen der Container, wie eine Anwendung ihre Datenbank in Produktion erreicht. Der Port-Proxy von Docker kostete in den ersten Läufen 30 bis 55 % CPU.
- **Maschine**: 4 vCPU und 15 GB RAM, für alles zugleich: Postgres, Redis, API, Worker, Publisher und k6.

### Ergebnisse

Alle Läufe mit 10.000 Varianten, fällig in derselben Sekunde, und 100 Lesezugriffen pro Sekunde:

| Lauf | Aufbau | Verzug max. | Veröffentlicht pro Sekunde (Mittel / Spitze) | p95 Lesen: gesamt / im Schub / Beobachter | Outbox max. |
|---|---|---|---|---|---|
| 1 | Ausgangslage: Port-Proxy von Docker, zwei Publisher | 149 s | 68 / 110 | 2,33 s / 2,40 s / 2,31 s | nicht gemessen |
| 2 | Drei statt sechs Transaktionen pro Lauf, direkte Adressen, drei Publisher | 94 s | 109 / 150 | 449 ms / 875 ms / 594 ms | 141 s |
| 3 | Dazu Relay mit bis zu zehn Stapeln pro Takt, Publish-Job über node-postgres | 48,9 s | 208 / 253 | 357 ms / 770 ms / 643 ms | 4,3 s |
| 4 | Dazu Publisher mit `nice 10` | 47,2 s | 213 / 275 | 300 ms / 666 ms / 531 ms | 4,5 s |
| 5 | Dazu eine zweite API-Instanz | 51,8 s | 200 / 259 | 70 ms / 208 ms / 191 ms | 5,0 s |

- **Lauf 5 erreicht beide Ziele**:
  - Alle 10.000 Varianten waren veröffentlicht, im Median 29,6 s und höchstens 51,8 s nach ihrer Fälligkeit, mit genau einem Versuch je Variante.
  - Kein Lesezugriff scheiterte.
  - In der API gemessen lag das p95 jedes Endpunkts vor und nach dem Schub zwischen 6 und 31 ms, im Schub zwischen 73 und 380 ms. Am langsamsten waren die Top-Posts.
- **Analytics** (Läufe 4 und 5):
  - Jede der 10.000 Varianten bekam ihre erste Abfrage. 1.000 Jobs `metrics.post`, einer je Account mit je zehn Posts, schrieben 10.000 Snapshots in 143 s (im Mittel 69, in der Spitze 80 pro Sekunde). Dazu kamen 250 Rollups, einer je Workspace. Die Rolle `analytics` arbeitet vier Jobs zugleich ab, und jede Abfrage der Plattform dauerte 500 ms.
  - Den Takt gibt `tick.analytics` vor, alle fünf Minuten. Die erste Abfrage kam deshalb 67 bis 193 s nach ihrer Fälligkeit. Der Rückstand war lange vor dem nächsten Takt abgearbeitet.
- **CPU im Schub** (Lauf 5): Postgres 1,1 bis 1,3 Kerne, die drei Publisher zusammen 0,9 bis 1,5, jede API-Instanz 0,3 bis 0,55, der Worker bis 0,2, k6 und Redis je bis 0,2.

### Befunde und Änderungen

1. **Zu viele Transaktionen pro Lauf**: Ein Publish-Lauf brauchte sechs Transaktionen mit rund 37 Anweisungen.
   - Jetzt liest der Claim Ziel und Medien mit, die Schreibmarke des Versuchs geht mit der Verlängerung der Lease, `lockForJob` liest die Einstellungen des Workspace mit, und der Versuch findet seine Nummer beim Schreiben.
   - Damit sind es drei Transaktionen mit rund 24 Anweisungen.
2. **Outbox im Rückstand**: Der Relay gab einen Stapel von 100 Ereignissen pro Takt weiter. Die 30.000 Statusereignisse eines Schubs stauten sich auf über zwei Minuten.
   - Jetzt folgt einem vollen Stapel im selben Lauf der nächste, höchstens zehn.
   - Ein Stapel mit einem Fehler beendet den Lauf, damit nicht der nächste Stapel gegen denselben Fehler läuft.
3. **CPU des Prisma-Clients**: Prisma kostete im Publisher und in Postgres rund das Dreifache dessen, was dieselben Anweisungen als Prepared Statements über node-postgres kosten. Der Publish-Job läuft jetzt über node-postgres (ADR 0040).
4. **Eine API-Instanz ist zu knapp**:
   - Ein Profil der API zeigt rund 6,7 ms CPU je Lesezugriff, gut ein Drittel davon im Prisma-Client: die Prüfung der Session und die Read-Models.
   - Eine Instanz lief bei 100 Anfragen pro Sekunde mit 70 bis 100 % eines Kerns. Im Schub, wenn sich alle Prozesse die vier Kerne teilten, kam sie nicht mehr nach.
   - Die niedrigere Priorität der Publisher half kaum: Postgres führt ihre Anweisungen weiter mit voller Priorität aus.
   - Mit zwei Instanzen hat jede Reserve. In Produktion laufen ohnehin mindestens zwei Replikas hinter dem Proxy.

### Grenzen

- Die Plattformen sind Mocks mit fester Latenz, ohne die Rate-Limits und Fehler der echten Plattformen.
- Alles läuft auf einer Maschine; k6 teilt sich die CPU mit dem System, das es misst.
- Die Web-App ist nicht Teil des Tests, nur die API.
- 100 Lesezugriffe pro Sekunde entsprechen 250 Personen, die alle 2,5 s etwas öffnen.
- Der Schub ist der ungünstigste Fall: alle 10.000 Varianten in derselben Sekunde fällig. `--spread` der Testdaten verteilt sie über die Minute.

## Konsequenzen

- **Deployment**: Die Vorlage aus Schritt 8.9 startet die API mit mindestens zwei Replikas. API und Publisher bekommen eigene CPU-Anteile, damit ein Schub von Veröffentlichungen die Lesezugriffe nicht ausbremst.
- **Wiederholen**: Wer den Durchsatz neu misst, nimmt `pnpm load:fixture`, k6 und `pnpm load:stats`. Das README beschreibt den Ablauf; die Läufe hier dienen als Vergleich.
- **Offen**:
  - Die API prüft jede Session in der Datenbank (ADR 0039) und liest über den Prisma-Client. Beides ist der größte Posten ihrer CPU.
  - Sessions in Redis über `secondaryStorage` von Better Auth würden die Abfrage sparen, ohne den Widerruf zu verzögern. Das ist eine Entscheidung für später.
  - Der Treiber-Adapter von Prisma löst beim Schreiben der Testdaten eine Deprecation-Warnung von node-postgres aus (gleichzeitige Abfragen auf einer Verbindung). Sie betrifft nur das Werkzeug der Testdaten. Mit node-postgres 9 würde daraus ein Fehler; bis dahin muss der Adapter das ändern.

## Alternativen

- **Eigene Maschinen für k6, API und Datenbank**: Das wäre näher an Produktion, steht in der Entwicklungsumgebung aber nicht zur Verfügung. Die Ergebnisse auf einer gemeinsamen Maschine sind die ungünstigere Messung.
- **Ein Cookie-Cache der Sessions**: Better Auth kann die Session eine Weile im Cookie halten und spart dann die Abfrage. Ein Widerruf wirkte aber erst nach dieser Zeit, und ADR 0039 verlangt die Prüfung bei jeder Anfrage.
- **Weniger Publisher**: Weniger Publisher würden die Lesezugriffe im Schub entlasten, wären aber knapp am Ziel. Die Kapazität von rund 200 Veröffentlichungen pro Sekunde lässt Reserve.
