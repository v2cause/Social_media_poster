# Runbook: Massenhafter Token-Ablauf

Schritt 8.7 des Leitfadens, [ADR 0043](../adr/0043-slos-metriken-und-alarme.md). Für den Fall, dass viele Verbindungen einer Plattform auf einmal eine neue Anmeldung brauchen (`NEEDS_REAUTH`), weil die Plattform ihre Tokens nicht mehr annimmt.

## Alarme

- **`ReauthWave`** (page): Mindestens 5 Verbindungen einer Plattform mehr als zum niedrigsten Stand der letzten Stunde brauchen eine neue Anmeldung, seit 5 Minuten. Das Label `platform` nennt die Plattform, der Wert die Zahl.
- **`TokenRefreshFailing`** (ticket): Mindestens 10 Token-Refreshes in einer Stunde scheiterten oder endeten in einer neuen Anmeldung.
- **`PlatformFailureRateHigh`** (page) folgt oft, denn jeder Beitrag einer solchen Verbindung scheitert mit `REAUTH_REQUIRED`. **`DeadLetterQueueNotEmpty`** (ticket) folgt, weil diese Jobs nicht wiederholt werden.

## Was die App von selbst tut

- Lehnt die Plattform ein Token beim Veröffentlichen ab, versucht der Publish-Job einen Refresh. Gelingt der nicht, kommt die Verbindung auf `NEEDS_REAUTH`, und die Variante scheitert mit `REAUTH_REQUIRED`.
- Der Tick `tick.tokens` prüft jede Stunde die Tokens, die bald ablaufen, und erneuert sie, wo die Plattform das erlaubt (Instagram, X). LinkedIn und Facebook bieten keinen Refresh; die Owner werden vor dem Ablauf erinnert.
- Die Owner bekommen die E-Mail "Die Verbindung zu … muss erneuert werden" mit dem Knopf "Neu verbinden", und für jede gescheiterte Variante "Ein Post auf … wurde nicht veröffentlicht". Geplante Beiträge der Verbindung erscheinen nur, wenn sie vor ihrem Termin neu verbunden wird.

Eine neue Anmeldung kann nur die Kundin oder der Kunde selbst geben. Das Runbook klärt, ob der Grund bei uns liegt, und behebt ihn dann für alle zugleich.

## Diagnose

1. **Welche Plattform, wie viele?**

   ```promql
   max by (platform) (smp_connections_needs_reauth)
   sum by (outcome) (increase(smp_token_refresh_total[1h]))
   ```

2. **Alle Verbindungen der Plattform oder nur einige?** Betrifft die Welle alle Organisationen, liegt der Grund fast immer bei der App der Plattform, nicht bei den Kunden:
   - **Zugangsdaten der App**: Das Secret der App bei der Plattform wurde erneuert oder ist abgelaufen, und `.env` oder der Secret-Store hat noch das alte. Die Meldungen der Versuche (Abfrage in [Plattform-Ausfall](plattform-ausfall.md), Diagnose Schritt 2) nennen dann einen Fehler des Clients, zum Beispiel `invalid_client`.
   - **Rechte der App**: Die Plattform hat Berechtigungen entzogen, etwa nach einem App-Review, oder verlangt neue. Die Entwicklerkonsole der Plattform zeigt das.
   - **Ein Vorfall bei der Plattform**: Sie hat Tokens aus Sicherheitsgründen widerrufen. Das steht in ihren Ankündigungen.
   - **Ein Fehler bei uns**: ein falscher Schlüssel zum Entschlüsseln der Tokens nach einer Rotation ([Runbook](secret-rotation.md)). Das zeigt sich als Fehler im Log (`err` beim Entschlüsseln), nicht als Ablehnung der Plattform.
3. **Wenige Verbindungen**: Personen haben den Zugriff der App in ihrem Konto bei der Plattform entfernt oder ihr Passwort geändert. Dann gibt es nichts zu beheben; die Benachrichtigungen reichen.

## Schritte

1. **Grund bei uns** (Zugangsdaten oder Rechte der App, Schlüssel):
   - neue Zugangsdaten der App in den Secret-Store und `.env`, API und Worker neu starten;
   - fehlende Rechte bei der Plattform beantragen, bis dahin die Kunden informieren.

   Verbindungen, die schon auf `NEEDS_REAUTH` stehen, kommen davon nicht zurück: Die Plattform hat ihre Tokens abgelehnt. Die Kunden verbinden sie auf der Seite "Konten" neu.
2. **Kunden informieren**: Die E-Mails der App gehen an die Owner jeder betroffenen Organisation. Bei einer Welle über viele Organisationen hilft zusätzlich eine Mitteilung (Statusseite oder E-Mail an alle Owner) mit dem Grund und dem Hinweis, die Verbindung neu herzustellen.
3. **Gescheiterte Beiträge**: Varianten mit `REAUTH_REQUIRED` planen die Kunden nach dem Neuverbinden neu. Die Jobs in `publish-dead` sind dann nur noch eine Kopie; [Hängende Queue](haengende-queue.md), Abschnitt Dead-Letter-Queue.

## Prüfung

- `max by (platform) (smp_connections_needs_reauth)` sinkt, wenn Kunden neu verbinden.
- `ReauthWave` endet, sobald die Welle länger als eine Stunde zurückliegt oder der Stand wieder sinkt; danach misst der Alarm wieder gegen den neuen Stand.
- Nach einer neuen Verbindung gelingt der nächste Beitrag: `increase(smp_publish_runs_total{platform="X", outcome="published"}[15m]) > 0`.

## Nachbereitung

- War der Grund bei uns, braucht es eine Erinnerung vor dem nächsten Ablauf der Zugangsdaten der App, zum Beispiel einen Termin im Kalender des Betriebs.
- Eine Notiz mit Zahl der betroffenen Verbindungen und Organisationen, dem Grund und der Zeit bis zum Neuverbinden.

## Protokoll der Proben

| Datum | Umgebung | Ablauf | Ergebnis |
| --- | --- | --- | --- |
| 2026-10-19 | Lokal: Compose mit Infrastruktur und Profil `observability`, API und Worker aus `dist` auf dem Host, Mailpit | `pnpm drill token-wave --platform X --minutes 10` um 05:11: sechs Organisationen, ihre 12 Varianten auf X fällig um 05:14, die Mock-Konten von X lehnten die Tokens ab | Bestanden. Alle 12 Läufe endeten mit `REAUTH_REQUIRED`, die sechs Verbindungen kamen auf `NEEDS_REAUTH`. Die Owner bekamen um 05:14 "Die Verbindung zu … muss erneuert werden" und je Variante "Ein Post auf X wurde nicht veröffentlicht". `ReauthWave` für X feuerte mit dem Wert 6 um 05:19:42 (Mail 05:20:12). `DeadLetterQueueNotEmpty` feuerte um 05:19:23 mit 12 Kopien (Mail 05:19:53). `PlatformFailureRateHigh` für X feuerte um 05:24:53 (Mail 05:25:23, `[RESOLVED]` 05:30:23). `pnpm queues dead-letters` zeigte die 12 Kopien mit `REAUTH_REQUIRED`. Nach der Prüfung entfernte `pnpm queues remove-dead-letters --before 2026-10-19T05:15:00Z` alle 12, `[RESOLVED]` um 05:34:53. `ReauthWave` endete eine Stunde nach der Welle von selbst, um 06:14 (`[RESOLVED]` 06:17:42). |
