# ADR 0025: Benachrichtigungen über die Outbox, Token-Monitor und markierte geplante Varianten

- **Status**: Akzeptiert
- **Datum**: 2026-10-16
- **Bezug**: Umsetzungsleitfaden, Schritt 4.9; `docs/ARCHITECTURE.md`, Abschnitte 4.2, 6.3, 7, 7.1 und 7.4; [ADR 0004](0004-scheduling-und-outbox.md), [ADR 0012](0012-e-mail-jobs-mit-link.md), [ADR 0024](0024-publish-job-schreibmarke-und-lease.md)

## Kontext

Schritt 4.9 verlangt `tick.tokens` (stündlich), `token.refresh`, die Benachrichtigungen `token-expiring`, `reauth-required`, `publish-failed` und `needs-attention` in der App und per E-Mail, eine Erinnerung bei T-14, T-7 und T-1 Tagen und nach dem Ablauf `NEEDS_REAUTH` mit markierten geplanten Varianten. Die Benachrichtigungen sollen dedupliziert sein (eine pro Stufe) und die Einstellungen der Nutzer beachten. Die Architektur nennt für die Queue `notifications` nur den Job `notify.dispatch` mit der Job-ID `ntf.{outboxId}` und verlangt Payloads mit IDs.

Offen waren:

1. Wie kommt ein Ereignis aus einem Use Case beim Empfänger an, ohne dass ein Fehler beim Versand die fachliche Änderung zurückrollt oder eine Wiederholung doppelt zustellt?
2. Wer bekommt welche Benachrichtigung?
3. Was heißt "markiert" für eine geplante Variante, deren Verbindung neu verbunden werden muss?
4. Welche Erinnerung geht an eine Verbindung, die der Monitor erst wenige Tage vor dem Ablauf sieht?

## Entscheidung

- **Ereignis in der Outbox**: Ein Use Case schreibt in der Transaktion seiner Änderung das Outbox-Ereignis `notification.requested`. Es nennt nur, was geschah, mit IDs: `token-expiring` (Verbindung, Stufe, Ablauf), `reauth-required` (Verbindung, Grund, Zahl der markierten Varianten), `publish-failed` und `needs-attention` (Variante, Fehlercode). Der Publish-Job schreibt es mit dem Ende einer Variante auf `FAILED` oder `NEEDS_ATTENTION` und beim verpassten Zeitfenster; der Claim von `tick.publish` ebenso für die Pläne, die er auf `FAILED(MISSED_WINDOW)` setzt.
- **Zwei Arten von `notify.dispatch`**: Der Relay reicht das Ereignis als Job mit `channel: 'event'` und der ID `ntf.{outboxId}` an die Rolle `notify` weiter (nur IDs). Die Rolle liest in der Mandanten-Transaktion des Ereignisses, worum es geht (Plattform, verbundene Accounts, Anfang des Post-Textes), findet die Empfänger und gibt jedem die Kanäle, die er eingestellt hat:
  - In der App: genau eine Zeile pro Nutzer und Ereignis (`notification.event_id`, eindeutig mit `user_id`, Migration 0011). Ein zweiter Lauf fügt nichts hinzu.
  - Per E-Mail: ein eigener Job mit `channel: 'email'` und der ID `ntf.{outboxId}.{userId}`. Er trägt Adresse und Text wie die E-Mails aus Schritt 1.8, aber keinen Token; seit Schritt 8.4 beides versiegelt ([ADR 0012](0012-e-mail-jobs-mit-link.md)).
  - Beide Jobs bleiben nach dem Lauf einen Tag in Redis, damit ihre ID wirkt: Ein zweiter Dispatch desselben Ereignisses (nach einem gescheiterten Commit des Relays) oder ein wiederholter Lauf versendet nichts doppelt. Fehlgeschlagene Jobs bleiben wie bisher einen Tag.
- **Empfänger**: Verbindungen (`token-expiring`, `reauth-required`) gehen an Owner und Admins der Organisation, weil nur sie Accounts verbinden. Posts (`publish-failed`, `needs-attention`) gehen an die Person, die den Post erstellt hat, solange sie Mitglied ist und den Workspace öffnen darf; sonst an Owner und Admins.
- **Einstellungen**: pro Nutzer, Typ und Kanal (`NotificationPreference`); ohne Eintrag sind beide Kanäle an. Die Seite "Konto, Benachrichtigungen" setzt sie (`GET/PUT /api/me/notification-preferences`).
- **Anzeige**: Die Glocke listet die Benachrichtigungen des Nutzers neuestes zuerst (`GET /api/me/notifications`, Cursor), aber nur aus Workspaces, die er noch öffnen darf, damit jeder Link funktioniert. Sie fragt alle 30 s nach, bis die Live-Events aus Schritt 4.10 neue melden. Ein Eintrag, dessen Inhalt nicht mehr zum Vertrag passt, wird ausgelassen und protokolliert.
- **Token-Monitor**: `tick.tokens` sieht stündlich die nutzbaren Verbindungen (`ACTIVE`, `EXPIRING`), deren Zugang in 14 Tagen endet. Der Zugang endet mit dem Refresh Token, wenn es eines gibt, sonst mit dem Access Token.
  - Eine `ACTIVE`-Verbindung bekommt den Job `token.refresh` (`tok.{connectionId}`, Rolle `publisher`). Er erneuert unter dem Lock `lock:conn:{id}` wie der Publish-Job. Bietet die Plattform keinen Refresh (LinkedIn ohne Partner-Status, Facebook), wird die Verbindung `EXPIRING`. Lehnt sie ihn ab, `NEEDS_REAUTH`.
  - Eine `EXPIRING`-Verbindung bekommt die Erinnerung der nächstgelegenen Stufe, in die die Restzeit fällt (14, 7 oder 1 Tag), höchstens einmal pro Stufe. `expiry_notice_days` hält die letzte Stufe und wird per Compare-and-Swap gesetzt. Eine Verbindung, die erst 6 Tage vor dem Ablauf `EXPIRING` wird, bekommt also gleich die Erinnerung "7 Tage". Ein erfolgreicher Refresh oder ein neuer Grant setzt die Stufen zurück.
  - Ist der Zugang abgelaufen, wird die Verbindung `NEEDS_REAUTH(EXPIRED)`.
- **Markierte Varianten**: Wird eine Verbindung `NEEDS_REAUTH`, im Monitor, im Refresh oder im Publish-Job, bekommen die `SCHEDULED`-Varianten ihrer Accounts den Fehlercode `REAUTH_REQUIRED` als Markierung. Status und `version` bleiben, damit der Nutzer weiter planen und umplanen kann. Ein neuer Grant (`replaceGrant`) nimmt die Markierung wieder ab. Ohne neuen Grant scheitert der Publish-Job zum Termin mit `FAILED(REAUTH_REQUIRED)`.
- **Ein Token-Pfad**: Die Token-Logik des Publish-Jobs (`ConnectionTokens`) liegt jetzt im Kontext `channels` und wird vom Publish-Job und von `token.refresh` geteilt.
- **Mock-Adapter**: Er erneuert wie die echten Plattformen. Instagram verlängert sein Long-Lived Token, X erneuert mit Refresh Token, LinkedIn und Facebook antworten `not_supported`.

## Alternativen

- **Versand direkt im Use Case oder im Publish-Job**: verworfen. Ein SMTP-Fehler würde die fachliche Änderung blockieren oder verloren gehen, und eine Wiederholung des Jobs würde doppelt senden.
- **Alle E-Mails eines Ereignisses im Job des Ereignisses senden**: verworfen. Scheitert die dritte E-Mail, sendet die Wiederholung die ersten beiden erneut.
- **Varianten bei `NEEDS_REAUTH` sofort auf `FAILED` setzen**: verworfen. Der Nutzer verlöre seine Planung, obwohl er bis zum Termin neu verbinden kann.
- **Erinnerungen für jede Stufe nachholen**: verworfen. Eine Verbindung mit 6 Tagen Restzeit würde zwei Erinnerungen auf einmal schicken.

## Konsequenzen

- `docs/ARCHITECTURE.md` nennt in 7.4 die beiden Arten von `notify.dispatch` mit ihren Job-IDs und in 7.1 die Benachrichtigungen der Fehlertabelle.
- Die Rolle `notify` braucht `APP_URL` für die Links der E-Mails und die Datenbank als `app_user`.
- Tests: `packages/core/test/notifications/*`, `packages/core/test/channels/token-monitor.test.ts`, `packages/db/test/notification-adapters.integration.test.ts`, `packages/db/test/token-maintenance-adapters.integration.test.ts`, `apps/worker/test/notify.integration.test.ts` (Ereignis bis Mailpit und Glocke, ohne Doppelung), `apps/worker/test/publish.integration.test.ts` (`token.refresh`) und `apps/api/test/notifications.integration.test.ts`.
- Seit Schritt 4.10 meldet die Rolle `notify` jede neue In-App-Benachrichtigung als Live-Event `notification.created` auf dem Kanal ihres Workspace. Die API reicht es nur an die Streams des Nutzers weiter, und die Glocke fragt nur noch ohne Stream nach.
