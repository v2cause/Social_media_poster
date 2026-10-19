# Runbook: X-Drift

Schritt 8.7 des Leitfadens, [ADR 0043](../adr/0043-slos-metriken-und-alarme.md), [ADR 0032](../adr/0032-canary-und-circuit-breaker.md). Für den Fall, dass der X-Browser (X ohne API, Architektur 4.3) die Oberfläche von X nicht mehr versteht, weil X sie geändert hat, oder dass X Bestätigungen verlangt.

## Alarme

- **`XBrowserDrift`** (ticket): Der Browser-Worker meldete in den letzten 30 Minuten eine Drift: Ein Eintrag der Selector-Map oder eine Antwort von X passt nicht mehr.
- **`XBrowserCanaryFailed`** (ticket): Der tägliche Canary gegen den internen Test-Account (`XB_CANARY_ACCOUNT_ID`, `tick.xb-canary` um 05:23 UTC) fand in den letzten 26 Stunden Selektoren nicht.
- **`KillSwitchActive`** (ticket): Ein globaler Kill-Switch ist an, das Label `key` nennt ihn. Für `x_browser_automation` heißt das: Der X-Browser postet für niemanden.
- **`PlatformChallenges`** (ticket): X verlangte in der letzten Stunde bei einem Post oder einer Anmeldung eine Bestätigung (Captcha, Code, Prüfung des Kontos).

## Was die App von selbst tut

- **Circuit Breaker**: Die dritte Drift innerhalb einer Stunde schaltet den X-Browser für alle Workspaces ab. Das globale Flag geht aus, der Kill-Switch der Browser-Worker in Redis (`xb:kill`) geht an. Die Plattform-Admins bekommen die E-Mail "X ohne API wurde automatisch gestoppt". Ein fehlgeschlagener Canary schickt "Der Canary von X ohne API ist fehlgeschlagen" und zählt als Drift.
- **Varianten bei Kill-Switch**: Varianten über den X-Browser scheitern mit `ADAPTER_UNAVAILABLE` und ohne Wiederholung. Eine Kopie geht in `publish-dead`, die Autoren werden benachrichtigt. Befehle, die schon beim Browser-Worker liegen, lehnt er ab; ihre Varianten warten auf eine Wiederholung und scheitern dann ebenso. Varianten über die API von X betrifft das nicht.
- **Challenges**: Der X-Browser löst keine Captchas und umgeht keine Prüfung (Architektur 4.3). Er bricht ab, und die Verbindung kommt auf `NEEDS_REAUTH`. Die Kundin oder der Kunde meldet sich auf der Seite "Konten" im Dialog des X-Browsers neu an.
- **Wieder einschalten**: Das tun nur Plattform-Admins, sobald die Selector-Map wieder zu X passt.

## Diagnose

1. **Was ist gedriftet?** Die Logzeilen `xb.drift` des Workers (Rolle `publisher`) nennen `flow` (zum Beispiel `publish` oder `login`), `selector` und `selectorsVersion`, `xb.breaker_opened` die Zahl der Drifts. Die E-Mail an die Admins nennt dasselbe. Screenshots speichert der Browser-Worker nicht ([ADR 0032](../adr/0032-canary-und-circuit-breaker.md)).
2. **Echte Änderung von X oder ein Einzelfall?** Mehrere Drifts desselben Eintrags von verschiedenen Konten und ein fehlgeschlagener Canary sprechen für eine Änderung von X. Eine einzelne Drift kann an einem Konto liegen, das X anders anzeigt, etwa mit einem Hinweis oder einer Sperre.
3. **Challenges**: `sum(increase(smp_challenges_total[1h]))` und die Logs mit `CHALLENGE_REQUIRED` zeigen, wie viele Konten betroffen sind. Viele auf einmal sprechen dafür, dass X die Automatisierung erkennt. Dann den Kill-Switch von Hand einschalten (unten) und den X-Browser nicht weiter betreiben, bis geklärt ist, warum.
4. **Zustand des Schalters**: Auf `/admin` unter "X ohne API" oder mit `GET /api/admin/x-browser` als Plattform-Admin.

## Schritte

1. **Selector-Map anpassen**: Eine neue Version neben `packages/x-browser/src/selectors/v1.ts` anlegen, nicht die alte ändern. Die DOM-Fixtures unter `packages/x-browser/test/fixtures` an die neue Oberfläche anpassen und `pnpm --filter @smp/x-browser test:integration` grün bekommen. Danach mit dem internen Test-Account prüfen und ausliefern.
2. **Canary prüfen**: Der nächste Canary läuft um 05:23 UTC. Erst wenn er ohne fehlende Selektoren endet (kein neuer `XBrowserCanaryFailed`, keine E-Mail), ist die Map bestätigt.
3. **Wieder einschalten**: Als Plattform-Admin auf `/admin` unter "X ohne API" auf "Kill-Switch aufheben", oder:

   ```bash
   curl -X PUT https://<host>/api/admin/x-browser/kill-switch \
     -H 'Content-Type: application/json' -H 'Origin: https://<host>' \
     -b <Sitzung> -d '{"active": false}'
   ```

   Die API verlangt einen Plattform-Admin mit zweitem Faktor. Ein TOTP-Code gilt nur einmal: Hat er gerade schon eine Anmeldung bestätigt, auf den nächsten Code warten. Die API loggt die Änderung mit `x_browser.kill_switch` und der ID des Admins.
4. **Gescheiterte Varianten**: Die Kunden planen Varianten mit `ADAPTER_UNAVAILABLE` in der Planungsleiste des Composers neu oder posten sie sofort (`POST /api/w/<workspace>/variants/<id>/retry`). Bei vielen Organisationen hilft eine Mitteilung an die Owner. Die Kopien in `publish-dead` entfernt [Hängende Queue](haengende-queue.md), Abschnitt Dead-Letter-Queue.
5. **Von Hand abschalten**: Bei vielen Challenges oder einer unklaren Lage aktiviert ein Plattform-Admin den Kill-Switch auf `/admin` ("Kill-Switch aktivieren", in der API `{"active": true}`). Das wirkt sofort auf alle Browser-Worker.

## Prüfung

- `KillSwitchActive` endet mit `[RESOLVED]`, sobald der Schalter aus ist; `smp_kill_switch_active{key="x_browser_automation"}` ist 0.
- `XBrowserDrift` endet 30 Minuten nach der letzten Drift, `XBrowserCanaryFailed` 26 Stunden nach dem letzten fehlgeschlagenen Canary oder früher mit einem neuen Lauf, der besteht.
- Ein Post über den X-Browser mit dem internen Test-Account gelingt.

## Nachbereitung

- Notiz mit dem Eintrag der Map, der gedriftet ist, der Zeit ohne X-Browser und der Zahl der gescheiterten Varianten.
- Häufen sich Challenges bei einem Konto, bekommt seine Organisation den Hinweis, die Anmeldung über die API von X zu nutzen.

## Protokoll der Proben

| Datum | Umgebung | Ablauf | Ergebnis |
| --- | --- | --- | --- |
| 2026-10-19 | Lokal: Compose mit dem Profil `observability`, API und Worker mit allen Rollen aus `dist`, Mailpit | `pnpm drill xb-drift` (drei Drifts) und `pnpm drill xb-canary` um 05:11; danach als Plattform-Admin mit zweitem Faktor über die API den Kill-Switch aus | Bestanden. Der dritte Drift öffnete den Breaker, die Admins bekamen um 05:11 beide E-Mails. `XBrowserDrift` und `XBrowserCanaryFailed` feuerten um 05:12 (Mail 05:13), `KillSwitchActive` um 05:14 (Mail 05:14). Nach dem Ausschalten um 05:20 endete `KillSwitchActive` um 05:24 mit `[RESOLVED]`. Der erste Versuch scheiterte mit 401: Der TOTP-Code war im selben 30-Sekunden-Fenster schon beim Einrichten des Faktors benutzt worden; mit dem nächsten Code ging es. |
