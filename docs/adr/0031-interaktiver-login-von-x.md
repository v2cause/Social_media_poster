# ADR 0031: Interaktiver Login von X ohne API

- **Status**: Akzeptiert
- **Datum**: 2026-10-17
- **Bezug**: Umsetzungsleitfaden, Schritt 6.4; `docs/ARCHITECTURE.md`, Abschnitte 4.3, 7.4 und 10; [ADR 0030](0030-browser-worker-isolation-protokoll-und-flows.md)

## Kontext

Ein Account für X ohne API entsteht durch einen Login im browser-worker: Der Nutzer gibt Benutzername und Passwort einmal ein, fragt X nach einem Code der Zwei-Faktor-Anmeldung, gibt er ihn in der App ein, und gespeichert wird danach nur der versiegelte `storageState`. Zugangsdaten dürfen nie in der Datenbank oder in Logs landen, der Job verschwindet sofort nach seinem Ende, und der ganze Login dauert höchstens fünf Minuten.

## Entscheidung

### Ablauf

1. **Start**: `POST /api/w/:ws/x-browser/login-sessions` mit Benutzername, Passwort und der Sprache von X (die der Oberfläche); optional die ID des Accounts, der neu verbunden werden soll. Erlaubt für Owner und Admins (`account.manage`), wenn das Gate offen ist.
2. **Versiegelt in den Job**: Die API versiegelt `{username, password}` mit dem Session-Keyring (`SESSION_KEKS`) und der AAD `{workspaceId}:xb-login.{id}:credentials` und legt sie nur in den Job `xb.login.start` (ID `xb.login.start.{id}`, ein Versuch, `removeOnComplete` und `removeOnFail`). Gespeichert wird davon nichts.
3. **Login im browser-worker**: Er öffnet die Zugangsdaten, meldet sich in einem frischen Kontext an und stoppt bei jedem Schritt, den X für einen verdächtigen Login einschiebt. Fragt X nach einem Code, meldet er `AWAITING_2FA` und wartet auf einer eigenen Verbindung (`BLPOP`) auf `xb:login:{id}:input`. X bekommt höchstens drei Codes, das Passwort einmal.
4. **Code**: `POST .../login-sessions/:id/code` nimmt einen Code (6 bis 12 Zeichen, auch Backup-Codes) nur an, solange X danach fragt, versiegelt ihn mit der AAD `...:code`, schiebt ihn in die Liste und setzt den Login auf `VERIFYING`. Ein zweiter Code auf dieselbe Frage wird abgelehnt.
5. **Ende**: Der browser-worker meldet `login.succeeded` mit dem X-Nutzer und dem für ihn versiegelten `storageState`, oder `login.failed` mit dem Grund. Die Rolle `publisher` legt die Browser-Verbindung mit ihrem Account an oder erneuert sie, schreibt `channel.connect` bzw. `channel.reconnect` ins Audit-Log und setzt den Login auf `SUCCEEDED`.

### Zustand

- **In Redis, nicht in der Datenbank**: Der Login ist ein Hash `x-browser:login:{id}` (Status, Grund, Account, Nutzer, Sprache, Ablauf) außerhalb der Schlüssel des browser-workers. Er bleibt eine Viertelstunde über sein Ende hinaus lesbar.
- **Ein Schritt nach dem anderen**: Ein Skript ändert den Status nur aus den erlaubten Vorgängern, so nimmt von zwei gleichzeitigen Meldungen nur eine den Schritt.
- **Fristen**: Der browser-worker startet einen Login höchstens zwei Minuten nach dem Start, und der ganze Login endet nach fünf Minuten: Die Seite schließt sich, und ein noch offener Login gilt als `TIMEOUT`.
- **Gründe**: `INVALID_CREDENTIALS`, `INVALID_CODE`, `CHALLENGE_REQUIRED`, `SELECTOR_DRIFT`, `TIMEOUT`, `ACCOUNT_MISMATCH`, `UNAVAILABLE`, `TRANSIENT`; die Oberfläche übersetzt sie.

### Grenzen

- **Fünf Starts pro Workspace und Stunde**, danach `TOO_MANY_ATTEMPTS`; X achtet auf viele Logins von einer Adresse.
- **Nur der Starter**: Den Login sieht und bedient nur, wer ihn gestartet hat; für alle anderen existiert er nicht.
- **Neu verbinden**: Meldet sich ein anderer X-Nutzer an als der des Accounts, endet der Login mit `ACCOUNT_MISMATCH`, und es wird nichts gespeichert.
- **Sprache**: Der Account bekommt `settings.locale`; in dieser Sprache öffnet der browser-worker X, und darauf sind die Namen der Selector-Map abgestimmt.

### Live-Status

- **Ereignis `xb.login`**: Jeder Schritt geht als Live-Ereignis mit ID und Status an die Browser des Starters, ohne Nutzer-ID im Ereignis. Der Dialog fragt zusätzlich alle drei Sekunden nach, falls ein Ereignis verloren geht.
- **Dialog**: Auf der Accounts-Seite wählt die Karte von X die Methode "Browser (experimentell)", wenn der Workspace X ohne API eingeschaltet hat. Ein Browser-Account verbindet sich über denselben Dialog neu.

## Abweichungen

- **Sprache von X im Start**: Der Start nimmt zusätzlich die Sprache entgegen. Die Anzeigesprache von X selbst ist eine Einstellung des X-Accounts; die Sprache der App ist die beste Annahme.
- **API braucht `SESSION_KEKS`**: Sobald `FEATURE_X_BROWSER_GLOBAL` gesetzt ist, startet die API nur mit dem Session-Keyring. Sie versiegelt damit, öffnet aber nichts.
- **Wartende Jobs**: Ein Job, den kein browser-worker abholt, bleibt mit den versiegelten Zugangsdaten in Redis, bis ein browser-worker ihn nach Ablauf der Frist verwirft. Öffnen kann ihn nur, wer `SESSION_KEKS` hat.

## Konsequenzen

- Der E2E-Test spielt den browser-worker über die Queues (`apps/web/e2e/browser-worker-stand-in.ts`) und prüft, dass weder Passwort noch Code im Klartext durch Redis gehen.
- Ein echter Login gegen x.com ist aus dieser Umgebung nicht geprüft; die Login-Schritte der Selector-Map stammen aus den nachgebauten Fixtures (ADR 0030).
