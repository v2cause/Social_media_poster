# ADR 0030: browser-worker: Isolation, Protokoll und Flows

- **Status**: Akzeptiert
- **Datum**: 2026-10-17
- **Bezug**: Umsetzungsleitfaden, Schritte 6.2, 6.3 und 6.6; `docs/ARCHITECTURE.md`, Abschnitte 2, 4.3 und 7; [ADR 0005](0005-x-hybrid-und-leitplanken.md), [ADR 0029](0029-x-browser-freischaltung-und-kill-switch.md)

## Kontext

Der browser-worker bedient X über die Web-Oberfläche. Er bekommt keine Datenbank- und keine Speicher-Zugangsdaten, darf nur zu X und zum Medienspeicher, öffnet als einziger die Sitzungen und soll Änderungen der Oberfläche als `SELECTOR_DRIFT` erkennen statt zu raten. Die Architektur beschreibt den Weg der Befehle über `xb-commands` und der Ergebnisse über `xb-results`, aber nicht, wie der Aufrufer auf das Ergebnis eines Posts wartet.

## Entscheidung

### Protokoll in `@smp/x-browser`

- **Ein Paket für beide Seiten**: Queue-Namen, zod-Schemas der Befehle, Ergebnisse und Meldungen, die AAD der Sitzungen und des Logins, die Redis-Schlüssel und die Redis-ACL liegen in `packages/x-browser/src/protocol.ts`. Worker, API und browser-worker prüfen dieselben Schemas.
- **Befehle**: `publish`, `reconcile`, `metrics` (zehn Posts je Befehl), `account-metrics`, `delete`, `verify-session`, `canary` und `login.start`. `reconcile` und `account-metrics` kommen zu den Jobs der Architektur hinzu, weil der Publish-Ablauf und die Analytics sie verlangen.
- **Ergebnis als Rückgabewert des Jobs**: Ein Befehl ist ein Job auf `xb-commands` mit einem Versuch und der ID `xb.{op}.{commandId}`. Der Aufrufer wartet über `QueueEvents` auf den Rückgabewert, hält dabei seinen Lease am Leben (Heartbeat jede Minute) und gibt nach Startfenster (2 Minuten) plus Aufgabenzeit auf. Ohne Ergebnis gilt ein Post oder eine Löschung als vielleicht gesendet (`OUTCOME_UNKNOWN`), ein Lesebefehl als vorübergehend gescheitert.
- **Meldungen auf `xb-results`**: die neue Sitzung nach einer Aufgabe (`session.updated`), Abweichungen der Selector-Map (`drift`), der Canary und die Schritte des Logins. Die Rolle `publisher` verarbeitet sie.
- **Fristen**: Jeder Befehl trägt eine Deadline. Startet der browser-worker ihn später, schickt er nichts und antwortet `EXPIRED`; bei aktivem Kill-Switch `UNAVAILABLE`.

### Laufzeit

- **Ein Chromium pro Prozess**, für jeden Befehl ein neuer Kontext mit dem `storageState` des Accounts, Viewport 1280 x 800, Sprache des Accounts (`settings.locale`, Standard Deutsch), 30 Sekunden je Aktion, Service Worker gesperrt.
- **Keine Tarnung**: keine Stealth-Plugins, kein geänderter Fingerabdruck, nichts in die Seiten injiziert; Chromium meldet sich als HeadlessChrome.
- **Ein Befehl pro Account**: `xb:lock:{accountId}` und zwei Minuten Abstand zwischen Posts (`xb:spacing:{accountId}`). Ein belegter Account wartet als verzögerter Job, ohne einen Versuch zu verbrauchen.
- **Sitzung an den X-Nutzer gebunden**: Die AAD ist `{workspaceId}:x-browser.{externalUserId}:session`, nicht die ID der Verbindung. So kann der browser-worker die Sitzung eines Logins versiegeln, bevor es eine Verbindung gibt.

### Isolation

- **Netz**: Der Container hängt nur im internen Netz `xb` mit Redis und dem Egress-Proxy; Datenbank, API und Internet sind von dort nicht erreichbar.
- **Egress-Proxy**: eine eigene kleine App (`apps/egress-proxy`). Sie erlaubt Tunnel (CONNECT) nur zu den Hosts der Selector-Map und `XB_EGRESS_HOSTS` (Medienspeicher) und antwortet sonst 403, bevor eine Verbindung entsteht. Zusätzlich bricht der Browser-Kontext Anfragen außerhalb der Liste selbst ab.
- **Redis-ACL**: Der browser-worker meldet sich als Nutzer `browser-worker` an. Er erreicht nur die xb-Queues und die Schlüssel `xb:lock:*`, `xb:spacing:*` und `xb:login:*`, den Kill-Switch nur lesend, keine Kanäle und keine gefährlichen Befehle.
- **Container**: schreibgeschützt, ohne Capabilities, `no-new-privileges`, eigener Nutzer; Chromium läuft ohne eigene Sandbox, der Container ist die Sandbox.

### Selector-Map und Flows

- **`selectors/v1.ts`**: Rollen, ARIA-Namen und `data-testid` je Sprache, die GraphQL-Operationen als Muster und die Schritte des Logins (`onboarding/task.json`).
- **Daten aus JSON**: Post-IDs, Zähler und Login-Schritte kommen aus den JSON-Antworten der Web-App, nie aus HTML.
- **Challenge zuerst**: Nach jeder Navigation prüft `detectChallenge`; eine Challenge beendet den Flow mit `CHALLENGE_REQUIRED`, der Account geht auf `NEEDS_REAUTH`, die Variante auf `NEEDS_ATTENTION`.
- **Drift**: Fehlt ein Eintrag, endet der Flow mit `SELECTOR_DRIFT` und dem Namen des Eintrags, ohne weiteren Versuch.
- **Metriken**: Ein Browser-Account wird nur nach 24 Stunden und nach 7 Tagen abgefragt.

### Tests

- **Fixtures**: Ein nachgebautes X liefert DOM und JSON-Antworten über `page.route` (`packages/x-browser/test/fake-x.ts`, `test/fixtures/*.json`) für Login, Composer, Challenge und Drift; die Flow-Tests laufen in Chromium.
- **Ohne Browser**: Die Tests von Worker, API und browser-worker spielen den jeweils anderen Teil über die Queues.

## Abweichungen

- **Kein Abschluss über `xb-results`**: Abschnitt 7 sieht vor, dass `xb-results` eine Variante abschließt. Stattdessen wartet der Publish-Job selbst auf den Rückgabewert und schreibt das Ergebnis wie bei jedem anderen Adapter. Lease, Schreibmarke und Reconcile bleiben so an einer Stelle.
- **Fixtures nachgebaut statt aufgezeichnet**: Ohne Zugang zur Live-UI von X aus dieser Umgebung sind die JSON-Antworten nach öffentlichen Beschreibungen nachgebaut. Selektoren, Antworten und Egress-Hosts sind gegen x.com zu prüfen, bevor ein echter Account angebunden wird.
- **WebSockets**: Der Browser-Kontext leitet WebSockets nicht um, weil das ein Skript in die Seite bringen würde; sie laufen über den Egress-Proxy und seine Liste.

## Konsequenzen

- Ändert X die Oberfläche, ändert sich nur die Selector-Map; ihre Version steht in jeder Drift-Meldung.
- Wer den Container nicht deployt, hat keinen Browser-Adapter; alles andere läuft unverändert.
