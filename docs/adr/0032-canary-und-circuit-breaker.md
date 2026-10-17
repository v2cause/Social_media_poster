# ADR 0032: Canary und Circuit Breaker des X-Browsers

- **Status**: Akzeptiert
- **Datum**: 2026-10-17
- **Bezug**: Umsetzungsleitfaden, Schritte 6.5 und 6.6; `docs/ARCHITECTURE.md`, Abschnitte 4.3, 7.1 und 7.4; [ADR 0029](0029-x-browser-freischaltung-und-kill-switch.md), [ADR 0030](0030-browser-worker-isolation-protokoll-und-flows.md)

## Kontext

Ändert X seine Oberfläche, scheitern die Flows mit `SELECTOR_DRIFT`. Ein täglicher Canary gegen einen internen Test-Account soll das früh zeigen, und drei Drifts innerhalb einer Stunde sollen das globale Flag ausschalten und die Admins alarmieren. Abschnitt 4.3 der Architektur sieht außerdem bei Fehlern einen Screenshot mit geschwärzten Bereichen und kurzer Aufbewahrung vor.

## Entscheidung

### Circuit Breaker

- **Zählen**: Jede Meldung `drift` auf `xb-results` geht an `XBrowserBreaker` in der Rolle `publisher`. Ein Sorted Set in Redis (`x-browser:breaker:drifts`) hält die Drifts der letzten Stunde für alle Worker; ein Skript fügt hinzu, entfernt Älteres und zählt, sodass zwei gleichzeitige Drifts zwei Zählungen bekommen.
- **Öffnen**: Bei der dritten Drift innerhalb einer Stunde
  - schaltet der Breaker das globale Flag aus, als app_system unter der Sperre des Flags, sodass von zwei gleichzeitigen Drifts nur eine schaltet,
  - setzt er den Kill-Switch `xb:kill` für den browser-worker,
  - beginnt die Zählung neu,
  - und bekommt jeder Plattform-Admin mit bestätigter E-Mail-Adresse eine E-Mail in seiner Sprache mit Ablauf, Selektor, Version der Selector-Map und einem Link zur Admin-Seite.
- **Schon offen**: War der Kill-Switch bereits an, setzt der Breaker nur `xb:kill` erneut und alarmiert nicht.
- **Wieder einschalten**: nur durch Plattform-Admins über den Kill-Switch, nachdem die Selector-Map angepasst ist.

### Canary

- **Wann**: täglich um 05:23 UTC (`tick.xb-canary` der Rolle `scheduler`), nur mit `FEATURE_X_BROWSER_GLOBAL` und `XB_CANARY_ACCOUNT_ID`. Ohne Test-Account verliert der Tick beim Start seinen Job-Scheduler.
- **Was**: Der Tick liest den Test-Account mit seiner Browser-Sitzung als app_system und schickt den Befehl `canary`. Der Flow prüft nur, ob die Einträge der Selector-Map zu finden sind, und postet nichts.
- **Auswertung**: Der browser-worker meldet das Ergebnis auf `xb-results`. Fehlt etwas, bekommen die Plattform-Admins eine E-Mail mit den fehlenden Einträgen, und der Ausfall zählt als eine Drift.

### Fehler-Screenshots: vorerst nicht

- **Entscheidung**: Der browser-worker speichert bei Fehlern keine Screenshots.
- **Begründung**:
  - Isolation: Der browser-worker hat bewusst keine Speicher-Zugangsdaten. Screenshots müssten über Redis zum Worker und von dort in den Speicher.
  - Datenschutz: Eine Seite von X zeigt fremde Posts, Namen und Profilbilder. Mit den generischen Selektoren lässt sich nicht verlässlich schwärzen, was personenbezogen ist; für die Aufbewahrung bräuchte es Löschfristen und Zugriffsregeln (Phase 8).
  - Ersatz: Jede Drift nennt Ablauf, Eintrag und Version der Selector-Map. Der Canary und die Fixtures von `packages/x-browser` stellen sie mit dem Test-Account bzw. lokal nach.
- **Später**: Mit Phase 8 lässt sich prüfen, ob Screenshots nur für den internen Test-Account (Canary) gespeichert werden.

## Konsequenzen

- Die Rolle `publisher` braucht mit dem X-Browser `DATABASE_SYSTEM_URL` und `APP_URL`; ohne beide startet sie nicht.
- Die Alarme gehen über die Queue `notifications`; ohne laufende Rolle `notify` bleiben sie dort liegen.
- Der Test-Account ist nicht angelegt: Für den Canary braucht der Betrieb einen internen X-Account, der einmal über den Login verbunden wird.
