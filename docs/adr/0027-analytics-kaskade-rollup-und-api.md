# ADR 0027: Analytics mit Abfrage-Kaskade, Rollup in der Workspace-Zeitzone und einer API für alle Ansichten

- **Status**: Akzeptiert
- **Datum**: 2026-10-17
- **Bezug**: Umsetzungsleitfaden, Schritte 5.1 bis 5.4 und 5.6; `docs/ARCHITECTURE.md`, Abschnitte 5.3, 6.2, 7.4 und 8; [ADR 0023](0023-planen-zeitzonen-und-zustandsautomat.md), [ADR 0024](0024-publish-job-schreibmarke-und-lease.md)

## Kontext

Phase 5 holt die Zahlen der veröffentlichten Posts und der Accounts von den Plattformen, verdichtet sie pro Tag und zeigt sie in Dashboard und Analytics. Abschnitt 8 der Architektur legt die Kaskade, die Normalisierung und die Kennzahlen fest. Offen waren:

1. Wie die Abfragen geplant werden, ohne dass zwei Läufe dieselben Posts abfragen.
2. Was mit Fehlern, gelöschten Posts und dem Zustand einer Variante geschieht.
3. Wie der Rollup die Tage der Workspace-Zeitzone füllt, ohne Werte doppelt zu zählen.
4. Wie die API Zeiträume, fehlende Werte und den Vergleich mit dem Vorzeitraum behandelt.
5. Wie die besten Posts in die Themenvorschläge kommen, sodass eine Idee auf einen echten Post verweist.

## Entscheidung

### Datenmodell

- **Tabellen**: `MetricSnapshot` (append-only, mit Rohdaten und `mappingVersion`), `PostMetricLatest` (wird nur durch einen neueren Snapshot ersetzt), `AccountMetricSnapshot` (ein Eintrag pro Account und lokalem Tag), `AnalyticsDaily` (Rollup pro Account und Tag).
- **Migrationen**: 0013 legt die Tabellen an, 0014 die Policies `tenant_isolation` über `workspace_id`.
- **Variante**: `PostVariant.externalDeletedAt` markiert einen Post, den die Plattform nicht mehr kennt.

### Kaskade und Planung

- **Zeitpunkte**: 1, 24, 72, 168 und 720 Stunden nach der Veröffentlichung, bei X über die API 24, 72 und 168 Stunden, über den Browser (Phase 6) 24 und 168 Stunden. Der Mock fragt ab wie die API seiner Plattform.
- **Zeitraffer**: `ANALYTICS_CADENCE_SCALE` teilt die Abstände (60: eine Stunde dauert eine Minute).
- **Verpasste Stufen**: Eine Stufe, deren Zeit schon vorbei ist, wird übersprungen.
- **Planer**: `tick.analytics` (alle 5 Minuten) reiht einen Job `metrics.post` pro Account mit fälligen Varianten ein. Seine Job-ID enthält den Takt.
- **Beanspruchen**: Der Job nimmt die fälligen Varianten seines Accounts mit `FOR UPDATE SKIP LOCKED` und schiebt ihre Fälligkeit um eine Sperrzeit von 15 Minuten. So fragt ein zweiter Lauf andere Varianten oder keine ab.
- **Batches**: X bis 100 Posts, Meta bis 50, LinkedIn 50.
- **Account-Zahlen**: `tick.account-metrics` (stündlich) holt für jeden Account die Zahlen des Vortags, sobald es in der Zone seines Workspace 03:00 Uhr ist und der Tag fehlt. Die Jobs verteilen sich über 50 Minuten.

### Fehler und Zustand

- **Wartezeiten**:
  - Rate-Limit oder Ausgabenlimit: `Retry-After`, sonst 15 Minuten.
  - Abgelaufener oder entzogener Zugang: 6 Stunden.
  - Alles andere: 30 Minuten.
- **Gelöschte Posts**: Ein Post, den die Plattform nicht mehr kennt, bekommt `externalDeletedAt`, und seine Abfragen enden (`metricsNextAt` ist null).
- **Kein Konflikt mit dem Composer**: Die Abfragen ändern nur die Metrikfelder einer Variante, per SQL und ohne `version` oder `updated_at`. Ein offener Composer oder die Reihenfolge der Post-Liste bemerkt sie nicht.

### Rollup

- **Zeitzone**: `AnalyticsDaily` entsteht per SQL-Upsert pro Account und lokalem Tag in der Zone des Workspace.
- **Deltas**: Gezählt wird, um wie viel die Zähler zwischen aufeinanderfolgenden Snapshots gewachsen sind. Ein erster Wert zählt ganz; null bleibt null.
- **Weitere Werte**: dazu die an dem Tag veröffentlichten Posts und die Tageszahlen der Accounts.
- **Gesperrt und vollständig**: Eine Advisory-Sperre pro Workspace verhindert, dass zwei Rollups gleichzeitig laufen. Summen werden bei `INT_MAX` gekappt, ohne dass null zu einer Zahl wird. Tage des Zeitraums, die der Lauf nicht schreibt, werden gelöscht.
- **Wann**: Der Collector bestellt den Rollup der berührten Tage (Job-ID pro Workspace und Zeitraum, 10 s Verzögerung). `tick.maintenance` rechnet nachts die letzten 35 Tage neu.

### Kennzahlen

- **Engagements**: die Summe aus Likes, Kommentaren, Shares, Saves und Klicks. Sie ist null, wenn keiner dieser Werte gemeldet ist.
- **Impressions**: Impressions, sonst Views.
- **Engagement-Rate**: Σ Engagements geteilt durch Σ (Impressions, sonst Views, sonst Reichweite), pro Eintrag; null ohne Basis.
- **Reichweite**: die Reichweite der Accounts, wo sie gemeldet wird, sonst die Summe der Post-Reichweiten. Die Antwort nennt die Basis (`account`, `posts`, `mixed`), weil Reichweiten über Posts nicht addierbar sind.
- **Follower-Zuwachs**: vom letzten Stand vor dem Zeitraum aus, sonst vom ersten Stand im Zeitraum.

### API

- **Endpunkte**: sieben unter `/api/w/:ws/analytics`, alle mit `analytics.read`, also für jede Rolle.
- **Zeitraum**: in lokalen Tagen des Workspace. Ohne Angabe gelten die letzten 30 Tage bis heute, höchstens 366 Tage pro Anfrage.
- **Vorzeitraum**: Er hat dieselbe Länge und wird an der Historie des Tarifs abgeschnitten. Bis Phase 7 gilt `ANALYTICS_HISTORY_DAYS` (Standard 365). Ein früherer Beginn ergibt `ANALYTICS_HISTORY_EXCEEDED` (422, mit dem frühesten Tag).
- **Cache**: Die Übersicht liegt 5 Minuten in Redis. Ist Redis nicht erreichbar, wird ohne Cache gerechnet.
- **CSV-Export**: gestreamt, ein Batch nach dem anderen. Felder, die wie eine Formel beginnen, bekommen ein Apostroph.

### Rückkopplung in die Themenvorschläge (Schritt 5.6)

- **Auswahl**: die fünf veröffentlichten Varianten der letzten 90 Tage mit den meisten Engagements. Sie brauchen mindestens 100 Impressions (sonst Views oder Reichweite); Probeläufe und gelöschte Posts zählen nicht.
- **Prompt**: Die Posts stehen mit Kürzel (`top-1` bis `top-5`), Plattform, Tag und Zahlen im Prompt. Die Prompt-Version ist `gen-v2`.
- **Verweis**: Nennt eine Idee ein Kürzel in `basedOn`, speichert sie die Variante als `variant:<id>`. Kürzel ohne Post entfallen.
- **Anzeige**: Die Ideen-API löst die Verweise in `basedOnPosts` auf (Vorschau und Plattform). Ein inzwischen gelöschter Post verschwindet aus der Liste.

## Konsequenzen

- Jede Ansicht rechnet mit denselben Funktionen des Cores, deshalb stimmen KPIs, Reihen, Breakdowns und Export überein.
- Fehlende Werte bleiben bis in die Oberfläche null, und die Oberfläche zeigt sie als "n. v." an ([ADR 0028](0028-analytics-im-web.md)).
- Tageswerte sind die an diesem Tag gemessenen Zuwächse. Ein Tag ohne Abfrage hat keinen Wert, obwohl seine Interaktionen in der nächsten Messung enthalten sind.
- Den manuellen Aktualisieren-Button aus Abschnitt 8 gibt es noch nicht; der Leitfaden sieht ihn in Phase 5 nicht vor. Die Kaskade steht im Code (`cadence.ts`). Die Abfrage nach 30 Tagen bei X und Einstellungen pro Tarif kommen mit Phase 7.
- **Offen**:
  - Die Mappings der echten Plattformen (`src/<platform>/metrics-map.ts`) und ihre Tests mit bereinigten echten Payloads fehlen, weil die Doku von LinkedIn, Meta und X aus der Entwicklungsumgebung gesperrt ist und Test-Accounts fehlen. Damit ist das Kriterium "Fertig, wenn" von Schritt 5.2 nur für den Mock erfüllt.
  - Der Abgleich der Zahlen mit den Plattform-UIs auf Staging steht aus (Schritt 5.5).
  - Der Eval-Lauf für `gen-v2` mit der Claude API wartet auf einen `ANTHROPIC_API_KEY` (Schritt 2.10).
