# Runbook: Plattform-Ausfall

Schritt 8.7 des Leitfadens, [ADR 0043](../adr/0043-slos-metriken-und-alarme.md). Für den Fall, dass LinkedIn, Facebook, Instagram oder X Beiträge nicht annimmt, weil die Plattform gestört ist oder wir sie nicht erreichen.

## Alarme

- **`PlatformFailureRateHigh`** (page): Mehr als ein Fünftel der Läufe einer Plattform scheitert oder wartet auf eine Wiederholung, über 15 Minuten und mindestens 5 Läufe, seit 10 Minuten. Das Label `platform` nennt die Plattform.
- **`PublishOnTimeBudgetBurnFast`** (page) und **`PublishOnTimeBudgetBurnSlow`** (ticket): Folgen oft, wenn die Wiederholungen nach dem Ausfall gelingen, denn diese Beiträge kommen zu spät.
- **`DeadLetterQueueNotEmpty`** (ticket): Folgt, wenn Varianten ihre Versuche aufgebraucht haben.

## Was die App von selbst tut

- Ein Fehler der Plattform ohne Antwort oder mit 5xx zählt als `TRANSIENT`, ein 429 als `RATE_LIMITED`. Der Publish-Job versucht es dann wieder, nach 30 Sekunden, 2, 8 und 30 Minuten und 2 Stunden, bei einem 429 nach `Retry-After`, wenn das länger ist. Die Variante steht dabei auf `RETRYING`, das sehen die Kunden in Beitragsliste und Kalender.
- Nach dem sechsten Versuch scheitert die Variante (`FAILED`), und eine Kopie ihres Jobs liegt in `publish-dead`. Die Owner bekommen eine E-Mail, die Variante zeigt den Fehler.
- Das Zeitfenster von 6 Stunden (`MISSED_WINDOW`) gilt nur für den ersten Lauf einer Variante, nicht für die Wiederholungen nach einem Fehler der Plattform.
- Ein Versuch, dessen Antwort verloren ging (`OUTCOME_UNKNOWN`), sucht vor dem nächsten Senden auf der Plattform nach dem Beitrag. Kein Beitrag geht so doppelt hinaus.

Das Runbook muss die Wiederholungen also nicht anstoßen. Es klärt, wo der Fehler liegt, und informiert die Kunden.

## Diagnose

1. **Welche Codes?** In Prometheus:

   ```promql
   sum by (platform, outcome, code) (increase(smp_publish_runs_total{platform="LINKEDIN"}[15m]))
   ```

   - `retry` mit `TRANSIENT`: Die Plattform antwortet mit 5xx, nicht oder zu langsam, oder wir erreichen sie nicht.
   - `retry` mit `RATE_LIMITED`: Die Plattform drosselt die App.
   - `failed` mit `PERMISSION_DENIED` oder `REAUTH_REQUIRED`: Rechte oder Tokens, weiter im Runbook [Token-Ablauf](token-ablauf.md).
   - `failed` mit `VALIDATION_REJECTED`: Die Plattform lehnt die Inhalte ab, oft nach einer Änderung ihrer Regeln.
2. **Die Meldungen der Plattform** stehen je Versuch in der Datenbank, ohne Tokens. Als `app_system`:

   ```sql
   SELECT v.platform, a.error_code, a.error_message, count(*)
     FROM publish_attempt a JOIN post_variant v ON v.id = a.variant_id
    WHERE a.started_at > now() - interval '30 minutes' AND a.error_code IS NOT NULL
    GROUP BY 1, 2, 3 ORDER BY 4 DESC LIMIT 20;
   ```

   Eine Meldung wie `could not connect (ENOTFOUND)` oder ein Fehler des Zertifikats (`CERT_HAS_EXPIRED`) heißt, dass die Anfrage nie bei der Plattform ankam: DNS, Firewall, ausgehender Proxy oder die Zertifikate des Hosts. Ein HTTP-Status 5xx oder ein Timeout nach dem Senden liegt bei der Plattform.
3. **Die Plattform selbst**: ihre Status- oder Entwicklerseite und die Ankündigungen zu ihrer API. Betrifft der Fehler nur einen Endpunkt, zum Beispiel Medien, zeigt das die Meldung in Schritt 2.
4. **Nur eine Plattform?** Scheitern alle Plattformen zugleich, liegt es fast immer an uns: Netz, DNS, Worker oder Datenbank. Dann weiter mit [Hängende Queue](haengende-queue.md).
5. **Die Logs des Workers** nennen je Lauf `publish.outcome` mit Variante, Versuch und Ergebnis. Die Organisationen der betroffenen Varianten stehen dort und in der Abfrage oben.

## Schritte

1. **Fehler bei uns**: Netz oder DNS des Hosts reparieren, den ausgehenden Proxy oder die Firewall prüfen, ein abgelaufenes Zertifikat im Zertifikatsspeicher des Images erneuern. Die Wiederholungen gelingen danach von selbst.
2. **Ausfall der Plattform**: abwarten. Die Wiederholungen tragen einen Ausfall von gut zwei Stunden, bevor Varianten scheitern. Dauert er länger:
   - Kunden informieren (Statusseite oder E-Mail), dass Beiträge auf der Plattform später oder gar nicht erscheinen und dass sie gescheiterte Beiträge danach neu planen können;
   - nichts an den Varianten ändern, solange die Plattform nicht antwortet.
3. **Drosselung** (`RATE_LIMITED`): die Grenzen der App bei der Plattform prüfen. Hält sie an, bremst ein kleinerer Durchsatz des Publishers, zum Beispiel weniger Replikas der Rolle `publisher`, bis die Grenze wieder Luft hat.
4. **Abgelehnte Inhalte** (`VALIDATION_REJECTED` in großer Zahl): Die Regeln der Plattform haben sich vermutlich geändert. Die Meldung in Schritt 2 der Diagnose nennt die Regel; die Grenzen in `packages/platform-rules` werden angepasst und ausgeliefert. Gescheiterte Varianten planen die Kunden neu.

## Prüfung

- `increase(smp_publish_runs_total{platform="LINKEDIN", outcome="published"}[15m])` steigt wieder.
- `PlatformFailureRateHigh` endet mit einer Mail `[RESOLVED]`, spätestens 15 Minuten nach dem letzten Fehler.
- In der Beitragsliste stehen keine Varianten der Plattform mehr auf `RETRYING`.
- `DeadLetterQueueNotEmpty`: Varianten, die gescheitert sind, behandelt [Hängende Queue](haengende-queue.md), Abschnitt Dead-Letter-Queue.

## Nachbereitung

- Bei mehr als einer Stunde Ausfall: eine kurze Notiz mit Beginn, Ende, betroffenen Plattformen, Zahl der verspäteten und gescheiterten Varianten und den informierten Kunden.
- Sind Varianten gescheitert, bekommen die betroffenen Owner einen Hinweis, damit sie neu planen.
- Lag der Fehler bei uns, folgt ein Eintrag in die Liste der Verbesserungen, zum Beispiel ein Alarm auf das Ablaufdatum der Zertifikate.

## Protokoll der Proben

| Datum | Umgebung | Ablauf | Ergebnis |
| --- | --- | --- | --- |
| 2026-10-19 | Lokal: Compose mit Infrastruktur und Profil `observability`, API und Worker aus `dist` auf dem Host, Mailpit | `pnpm drill platform-outage --platform LINKEDIN --minutes 10` um 05:11: sechs Organisationen mit 48 Varianten, fällig um 05:14; die Mock-Konten von LinkedIn antworteten bis 05:21:38 mit 503 | Bestanden. Die 12 Varianten auf LinkedIn scheiterten dreimal mit `TRANSIENT` (05:14, 05:14, 05:16) und gingen mit dem vierten Versuch zwischen 05:23 und 05:26 hinaus, die übrigen 36 pünktlich. `PlatformFailureRateHigh` für LinkedIn feuerte um 05:24:53, Mail um 05:25:23, `[RESOLVED]` um 05:35:23. `smp_publish_runs_total` nach Code zeigte `retry` mit `TRANSIENT` nur bei LinkedIn. Die Probe fand die leere Quote des SLO (ADR 0043, Befunde); nach der Korrektur schlug `PublishOnTimeBudgetBurnSlow` für die 12 verspäteten Varianten an. |
