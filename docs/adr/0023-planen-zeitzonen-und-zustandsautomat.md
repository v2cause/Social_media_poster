# ADR 0023: Planen mit lokalen Zeiten im Core und ergänzter Zustandsautomat

- **Status**: Akzeptiert
- **Datum**: 2026-10-16
- **Bezug**: Umsetzungsleitfaden, Schritt 4.6; `docs/ARCHITECTURE.md`, Abschnitte 7, 7.1, 7.2 und 7.3

## Kontext

Schritt 4.6 baut die Use Cases zum Planen. Die Architektur sieht vor, dass die API lokale Zeiten mit `@date-fns/tz` in UTC umrechnet (7.3), und zeigt den Zustandsautomaten einer Variante als Diagramm (7.2). Beim Umsetzen ergaben sich drei Fragen:

1. Die Prüfung "Zeit in einer Zeitumstellungslücke ergibt 422 mit Vorschlag" ist eine Geschäftsregel und soll mit Property-Tests abgesichert werden. Der Core darf außer zod und uuidv7 keine npm-Pakete nutzen.
2. Das Diagramm kennt "Jetzt posten" und die drei Antworten auf einen unklaren Ausgang aus 7.1 ("erneut prüfen", "trotzdem posten", "verwerfen") nicht als eigene Übergänge.
3. Der Leitfaden verlangt eine Prüfung der Quote beim Planen; die Tarife mit dem Limit "Posts pro Monat" kommen erst in Phase 7.

## Entscheidung

- **Lokale Zeiten im Core mit `Intl`**: `resolveLocalTime(localDateTime, timeZone)` in `packages/core/src/publishing/domain/local-time.ts` nutzt nur `Intl.DateTimeFormat`, das jede Laufzeit mitbringt. Ergebnis ist `exact`, `ambiguous` (die frühere Instanz gilt, wie in 7.3), `gap` (mit der ersten gültigen Minute nach der Lücke als Vorschlag) oder `invalid`. Die API übergibt Datum, Uhrzeit und Zone unverändert an den Use Case; `@date-fns/tz` entfällt im Backend.
- **Fehler mit Parametern**: `DomainError` trägt optional `params`, die das Problem-Dokument der API als `params` weitergibt, zum Beispiel `{ suggestion: '2027-03-28T03:00', timeZone: 'Europe/Berlin' }` bei `SCHEDULE_TIME_IN_GAP`. Der API-Client liest sie in `ApiError.params`.
- **Ergänzter Zustandsautomat** (`VARIANT_TRANSITIONS`), zusätzlich zum Diagramm:
  - "Jetzt posten" führt aus `DRAFT`, `SCHEDULED` und `CANCELED` direkt nach `QUEUED`, "erneut" mit "jetzt" ebenso aus `FAILED`; das Outbox-Ereignis `publish.requested` reiht den Job sofort ein.
  - Abbrechen geht auch aus `QUEUED` und `RETRYING`; der Job findet dann eine neuere `scheduleVersion` bzw. einen anderen Status und endet ohne Aktion.
  - Aus `NEEDS_ATTENTION`: "erneut prüfen" und "trotzdem posten" nach `QUEUED` (Trigger `recheck` bzw. `now`), "verwerfen" nach `CANCELED`.
  - Bearbeiten macht eine fehlgeschlagene oder abgebrochene Variante wieder zum Entwurf; eine geplante bleibt geplant. `NEEDS_ATTENTION` ist gesperrt, weil der Reconcile den unveränderten Inhalt sucht.
  - `PUBLISHING` nach `PUBLISHING`: Ein Job übernimmt eine Variante, deren Lease abgelaufen ist (Sweeper, Schritt 4.7).
- **Jeder Statuswechsel** schreibt in derselben Transaktion ein Outbox-Ereignis `variant.status`; das Relay gibt es an den Redis-Kanal `ws:{workspaceId}:events` weiter (Live-Events, Schritt 4.10).
- **Quote**: Die Prüfung "Posts pro Monat" kommt mit den Tarifen in Phase 7. Bis dahin plant der Use Case ohne Limit.

## Alternativen

- **`@date-fns/tz` in der API**: verworfen. Die Regel läge außerhalb des Core, die Property-Tests liefen gegen einen Adapter, und `@date-fns/tz` rechnet intern ebenfalls mit `Intl`.
- **Lückenzeit verschieben statt ablehnen** (02:30 wird 03:30, wie es Bibliotheken oft tun): verworfen. Die Architektur verlangt 422 mit Vorschlag, damit der Nutzer die tatsächliche Zeit sieht.
- **Nur die Übergänge des Diagramms**: verworfen. "Jetzt posten" und die Antworten auf `NEEDS_ATTENTION` sind in 7 und 7.1 vorgesehen und brauchen Übergänge; Abbrechen aus `QUEUED` vermeidet einen Konflikt, wenn der Tick die Variante gerade eingereiht hat.

## Konsequenzen

- Property-Tests mit fast-check prüfen die Umrechnung für elf Zonen über zwanzig Jahre, darunter Lord Howe (30 Minuten Umstellung), Chatham und Santiago.
- Das Web zeigt beim Fehler `SCHEDULE_TIME_IN_GAP` den Vorschlag aus `params` an (Schritt 4.11).
- Der Publish-Job (Schritt 4.8) muss die Trigger `now`, `retry` und `recheck` unterscheiden: Bei `recheck` gleicht er nur ab und postet nichts.
