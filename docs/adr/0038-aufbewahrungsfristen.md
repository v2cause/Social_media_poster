# ADR 0038: Aufbewahrungsfristen

- **Status**: Akzeptiert
- **Datum**: 2026-10-18
- **Bezug**: Umsetzungsleitfaden, Schritt 8.3; `docs/ARCHITECTURE.md`, Abschnitte 4.3, 5.3, 6.2, 6.4, 7.4, 8, 9, 10 und 12; [ADR 0019](0019-medien-upload-und-verarbeitung.md), [ADR 0027](0027-analytics-kaskade-rollup-und-api.md), [ADR 0032](0032-canary-und-circuit-breaker.md), [ADR 0033](0033-tarife-abo-und-nur-lesen.md), [ADR 0037](0037-loeschung-von-organisationen.md)

## Kontext

Der Leitfaden verlangt in Schritt 8.3 Jobs für vier Fristen:
- KI-Rohdaten 180 Tage,
- Screenshots 7 Tage,
- Logs 30 Tage,
- Metriken nach Tarif.

Fertig ist der Schritt, wenn die Jobs nachts laufen. Zwei Zusagen warteten auf diesen Schritt:
- ADR 0037 überlässt ihm verarbeitete Webhook-Ereignisse.
- Abschnitt 9 der Architektur sieht ein Aufräumen der Medien vor: gelöschte Assets nach 30 Tagen, hängende Uploads nach 24 Stunden. Es fehlte bisher. Gelöschte Dateien blieben also im Objektspeicher, und hängende Uploads zählten weiter gegen den Speicher des Tarifs.

## Entscheidung

### Fristen

| Daten | Frist | Was geschieht |
|---|---|---|
| KI-Rohdaten: `input` und `output` von `ai_generation` | 180 Tage | Beide Felder werden geleert. Tokens, Kosten, Modelle, Ergebnis und Zeitpunkt bleiben für Abrechnung und Kostenauswertung. |
| Verarbeitete Webhook-Ereignisse | 30 Tage nach der Verarbeitung | Sie werden gelöscht; wartende bleiben. |
| Verbindungsdaten: IP-Adresse und User-Agent | 30 Tage | Einträge des Audit-Logs verlieren beide Felder, der Eintrag selbst bleibt. Sessions gehen 30 Tage nach ihrem Ablauf, die Zähler der Rate-Limits von Better Auth (Schlüssel aus IP-Adresse und Pfad) 30 Tage nach ihrer letzten Anfrage. |
| Metriken | Analytics-Historie des Tarifs, mindestens 36 Tage | `metric_snapshot` nach dem Zeitpunkt der Messung, `account_metric_snapshot` und `analytics_daily` nach ihrem Tag in UTC |
| Medien | 30 Tage nach dem Entfernen aus der Bibliothek; Uploads ohne Abschluss nach 24 Stunden | Die Objekte gehen, dann die Zeile mit ihren Renditions. |
| Screenshots | entfällt | Der browser-worker speichert keine (ADR 0032). |
| Anwendungslogs | 30 Tage | Das stellt das Log-Backend ein, die Vorlage aus Schritt 8.9. |

### Nächtlicher Lauf

- **Auslöser**: `tick.maintenance` der Rolle `scheduler` läuft um 03:41 UTC. Nach dem Re-Wrap der Schlüssel und dem Löschen der Outbox wendet er die Fristen an (`ApplyRetention`), danach folgen die Rollups. Er arbeitet als `app_system` über alle Organisationen.
- **Stapel**:
  - Jede Anweisung ändert höchstens 1.000 Zeilen pro Tabelle, die sie in einer Unterabfrage auswählt. So hält keine Anweisung lange Sperren.
  - Jede Art von Daten bekommt höchstens 100 Stapel pro Nacht, also höchstens 100.000 Zeilen pro Tabelle; bei den Metriken gilt das pro Organisation.
  - Was darüber liegt, folgt in der nächsten Nacht.
- **Indizes** (Migration `0024_retention`):
  - Partielle Indizes halten nur die Zeilen, die eine Nacht noch ändern muss: Generierungen mit Rohdaten, Einträge mit Verbindungsdaten und verarbeitete Ereignisse.
  - Dazu kommt ein Index auf das Ende einer Session.
  - Die Zähler der Rate-Limits bekommen keinen Index. Better Auth ändert sie mit jeder Anfrage an `/api/auth`, und ein Index auf die letzte Anfrage verteuerte jede dieser Änderungen. Der nächtliche Scan der kleinen Tabelle kostet weniger.
- **Metriken pro Organisation**:
  - Die Organisationen kommen seitenweise, 200 pro Seite.
  - Die Historie liefert der `EntitlementsService`, also der Tarif mit den Overrides der Plattform-Admins.
  - Kann der Lauf den Tarif einer Organisation nicht lesen, bleiben ihre Metriken bis zur nächsten Nacht. Der Bericht zählt sie als `metricsFailed`.
- **Bericht**: Der Tick gibt seine Zähler zurück (`aiRawDataCleared`, `webhooksDeleted`, `connectionDataCleared`, `metricsDeleted`, `metricsFailed`). Sie stehen im Log des Jobs.

### Aufräumen der Medien

- **Ort**: `CleanUpMedia` läuft im stündlichen `gdpr.sweep` der Rolle `gdpr`, nicht in `tick.maintenance`. Nur diese Rolle hat neben `app_system` auch den Objektspeicher, und sie löscht schon Archive und Organisationen nach Fristen.
- **Umfang**: Ein Lauf nimmt höchstens zehn Stapel zu je 100 Assets.
- **Reihenfolge**:
  - Erst gehen die Objekte unter dem Präfix des Assets, dann die Zeile mit ihren Renditions.
  - Die Zeile geht nur, solange das Asset noch abgelaufen ist: Keine Variante verwendet es, und kein Upload wurde inzwischen abgeschlossen.
  - Scheitert ein Lauf, findet der nächste die Zeile wieder. Objekte ohne Zeile bleiben nie zurück.
- **Indizes**: Partielle Indizes (Migration `0025_media_cleanup`) halten nur entfernte Assets und offene Uploads.
- **Bericht**: Der Sweep zählt `mediaDeleted` und `mediaObjectsDeleted`.

### Auslegung des Leitfadens

- **„KI-Rohdaten“** sind Eingabe und Ausgabe einer Generierung.
  - Die Eingabe besteht aus Brief, Stil, Zielen, Sprache und Refine-Aktion; den gerenderten Prompt speichert die Anwendung ohnehin nicht.
  - Was Abrechnung und Kostenauswertung brauchen, bleibt.
- **„Screenshots 7 Tage“**: Es gibt keine. Speichert der browser-worker später Fehler-Screenshots, liegen sie unter einem eigenen Präfix im Objektspeicher. Dann löscht sie eine Lifecycle-Regel des Buckets oder dieser Job nach 7 Tagen.
- **„Logs 30 Tage“**:
  - Die Anwendungslogs (pino auf stdout) hält das Log-Backend. Dessen Frist setzt die Produktions-Vorlage aus Schritt 8.9 auf 30 Tage.
  - In der Datenbank stehen dieselben Verbindungsdaten an drei Stellen: im Audit-Log, in den Sessions und in den Zählern der Rate-Limits. Für sie gilt dieselbe Frist.
  - Das Audit-Log bleibt als Nachweis, wer was getan hat, so lange wie die Organisation (ADR 0037).
  - Auch die IP-Adresse einer Risikobestätigung bleibt, weil sie die Einwilligung belegt (Art. 7 Abs. 1 DSGVO).
- **„Metriken nach Tarif“**:
  - Die Frist ist die Analytics-Historie des Tarifs: Testphase 30, Starter 90, Pro 365 und Agency 730 Tage.
  - Sie beträgt aber mindestens 36 Tage. Der nächtliche Rollup rechnet die letzten 35 Tage neu und nimmt den Zuwachs aus dem Snapshot des Tages davor.
  - Die letzten Zahlen eines Posts (`post_metric_latest`) bleiben mit dem Post.

## Konsequenzen

- **Downgrade löscht**:
  - Nach einem Wechsel in einen Tarif mit kürzerer Historie löscht die nächste Nacht die älteren Metriken. Ein späteres Upgrade bringt sie nicht zurück; der Dialog zum Wechsel sagt das.
  - Eine Kündigung behält den Tarif des Abos und damit seine Historie.
  - Nach einer Testphase ohne Kauf bleiben 36 Tage.
- **Audit-Log**: `app_user` kann Einträge weiterhin weder ändern noch löschen. Nur der Job leert als `app_system` IP-Adresse und User-Agent.
- **Medien**:
  - Beim Löschen sagt die Bibliothek, dass die Datei nach 30 Tagen endgültig gelöscht wird. Bis dahin ließe sie sich in der Datenbank wiederherstellen; eine Oberfläche dafür gibt es nicht.
  - Hängende Uploads zählen nach 24 Stunden nicht mehr gegen den Speicher des Tarifs.
- **Abweichung von Abschnitt 9 der Architektur**:
  - Das Aufräumen der Medien läuft stündlich in der Rolle `gdpr` statt nachts in `tick.maintenance`.
  - Nach Objekten ohne Asset sucht kein Job. Uploads legen die Zeile an, bevor es den Link gibt, und jede Löschung entfernt die Objekte vor den Zeilen und wiederholt sich, bis beides weg ist. Eine Suche über den ganzen Bucket kostete mehr, als sie fände.
- **Backups** enthalten gelöschte Daten bis zu ihrem eigenen Ablauf (Schritt 8.6).
- **Große Mengen**: Sind in einer Nacht mehr als 100.000 Zeilen einer Art fällig, wächst ein Rückstand. Die Zähler im Bericht zeigen das; dann werden die Stapel größer oder der Takt kürzer.
