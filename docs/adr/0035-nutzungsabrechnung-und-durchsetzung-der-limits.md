# ADR 0035: Nutzungsabrechnung und Durchsetzung der Limits

- **Status**: Akzeptiert
- **Datum**: 2026-10-17
- **Bezug**: Umsetzungsleitfaden, Schritte 7.3 und 7.4; `docs/ARCHITECTURE.md`, Abschnitte 5.3, 6.4, 7.4 und 9; [ADR 0033](0033-tarife-abo-und-nur-lesen.md), [ADR 0034](0034-stripe-integration.md)

## Kontext

Bezahlte Tarife enthalten ein KI-Guthaben pro Monat; was darüber hinausgeht, bis zur Obergrenze des Tarifs, und die Kosten der X-API werden mit der Rechnung weiterberechnet (Stripe Billing Meters). Die Limits der Tabelle in Schritt 7.4 gelten an neun Stellen in API und Worker. Manche Zählungen gehen über alle Workspaces einer Organisation, deren Zeilen `app_user` nur im Kontext des jeweiligen Workspace sieht.

## Entscheidung

### Nutzungsabrechnung (Schritt 7.3)

- **Ablauf**: `tick.usage-report` läuft täglich um 00:07 UTC, nur wenn Stripe eingerichtet ist. Er reiht pro Organisation mit Stripe-Kunden, begonnener Abrechnung und noch nicht gemeldetem Verbrauch einen Job `usage.report` mit dem Vortag ein (Job-ID `usage.{organizationId}.{Tag}`, über 30 Minuten verteilt). Die Rolle `billing` führt `ReportUsage` unter der Sperre `usage.{organizationId}` aus.
- **Batches**: Pro Meter und Monat fasst der Bericht die noch nicht gemeldeten Einträge bis zum Stichtag zu einem Batch zusammen:
  - KI aus dem Ledger (`usage_record`), X aus `api_cost_record`.
  - Gezählt wird nur, was nach dem Beginn der Abrechnung (`billing_started_at`) entstand.
  - Jeder Batch bekommt einen festen Identifier (`ai.{organizationId}.{JJJJ-MM}.{Tag}` bzw. `x.…`), geht als Meter-Event an Stripe, und erst danach setzt die Rolle `reported_to_stripe_at` seiner Einträge.
  - Ein wiederholter Bericht findet die beanspruchten Batches und schickt sie mit demselben Identifier; Stripe zählt sie einmal.
- **Mehrverbrauch der KI**: Gemeldet wird nur der Teil eines Batches jenseits des Guthabens des Monats, unter Berücksichtigung dessen, was der Monat vorher verbraucht hat: `max(0, R+N-C) - max(0, R-C)` (R vorher, N der Batch, C das Guthaben).
- **Zeitstempel**: Ein Meter-Event trägt den jüngsten Eintrag seines Batches, höchstens 34 Tage zurück, weil Stripe ältere Events nicht annimmt.

### Durchsetzung der Limits (Schritt 7.4)

| Stelle | Limit | Prüfung | Zählung |
|---|---|---|---|
| Workspace anlegen | `maxWorkspaces` | `CreateWorkspace` | exakt: als `app_user` in der Transaktion unter der Advisory-Sperre `plan.{organizationId}` |
| Mitglied einladen | `maxMembers` | `InviteMember` | exakt unter derselben Sperre: Mitglieder plus offene Einladungen ohne die an dieselbe Adresse |
| Einladung annehmen | `maxMembers` | `AcceptInvitation` | exakt unter derselben Sperre: Mitglieder (die Einladung zählte schon) |
| Account verbinden | `maxSocialAccounts` | Start der Verbindung, Bestätigen der Auswahl (mit der Zahl der Accounts), Start und Abschluss des Logins des X-Browsers | als `app_system` über alle Workspaces; beim Bestätigen und beim Abschluss des Logins exakt nach der Advisory-Sperre `plan.accounts.{organizationId}` (seit Schritt 8.4) |
| KI-Aufruf | `aiCreditsMicros` + `aiOverageCapMicros` | Reservierung der Quote vor dem Aufruf | exakt: bedingtes `UPDATE` des Monatszählers |
| Post planen | `scheduledPostsPerMonth` | Planen, Jetzt posten und Erneut versuchen einer Variante | exakt: als `app_system` nach der Advisory-Sperre `plan.posts.{organizationId}` (seit Schritt 8.4): geplante, laufende und veröffentlichte Varianten des Monats (`COALESCE(published_at, scheduled_at)`), ohne die Variante selbst |
| Upload | `storageBytes` | Upload anfordern | exakt: als `app_system` über alle Workspaces, gezählt erst nach der Advisory-Sperre `media.storage.{organizationId}`, wenn ein Upload, der sie vorher hielt, bestätigt ist |
| Analytics-Zeitraum | `analyticsHistoryDays` | Abfragen der Analytics | ein früherer Beginn ergibt `ANALYTICS_HISTORY_EXCEEDED` |
| X-Browser aktivieren | `xBrowserAllowed` | Freischaltung und Registry | der Tarif erlaubt es oder ein Plattform-Admin hat die Organisation freigeschaltet |
| X-API-Aufruf | `xApiSpendCapMicros` | `spendCappedAdapter` um die Adapter der X-API (auch MOCK) | Kosten des Monats aus `api_cost_record` als `app_user` |

- **Ausgaben-Deckel der X-API**:
  - Vor dem Posten (15.000 bzw. mit Link 200.000 Mikro-USD) und vor Metrik-Abfragen (5.000 pro Post) prüft der Adapter, ob der Aufruf den Deckel des Monats überschreiten würde, und wirft dann `SPEND_CAP_REACHED`.
  - Ein Publish-Job endet mit `SPEND_CAP` ohne Wiederholung, eine Metrik-Abfrage wartet wie bei einem Rate-Limit.
  - Abgleich (`reconcile`), Löschen und Account-Metriken sind nicht gedeckelt.
- **Fehler**: Ein erreichtes Limit ergibt 402 `PLAN_LIMIT_REACHED` mit dem Namen des Limits und seinem Wert; die KI-Quote 402 `QUOTA_EXCEEDED`; der Speicher 402 `STORAGE_QUOTA_EXCEEDED`.
- **Downgrade**: Geprüft wird nur, was neu hinzukommt. Was über einem kleineren Limit liegt, bleibt bestehen. Die Abrechnungsseite zeigt es rot mit der Bitte, auf das Limit zu reduzieren, und der Dialog des Tarifwechsels nennt es vorher. Löschen, Trennen, Entfernen und Abbrechen bleiben auch im Nur-Lesen-Zustand erlaubt (ADR 0033).

## Konsequenzen

Akzeptierte Risiken:
- **Paralleles Anlegen** (bis Schritt 8.4): Accounts und Posts pro Monat wurden ohne Sperre als `app_system` über bestätigte Daten gezählt. Das Security-Review zeigte, dass n gleichzeitige Anfragen ein Limit um bis zu n-1 überschreiten (ASVS 2.3.4). Seit Schritt 8.4 ([ADR 0039](0039-security-review-und-haertung.md)) zählen beide nach einer Advisory-Sperre der Organisation, die bis zum Ende der Transaktion gilt. Das serialisiert nur Planungen bzw. Verbindungen derselben Organisation, und nur von der Zählung bis zum Commit.
- **Doppelt gemeldeter Batch**: Scheitert das Bestätigen eines gemeldeten Batches länger als 24 Stunden, kann Stripe den erneut gesendeten Batch ein zweites Mal zählen, weil Stripe Identifier nur mindestens 24 Stunden kennt.
- **Abgleich ohne Deckel**: Der Abgleich nach unklarem Ausgang liest auch bei erreichtem Deckel, damit kein Post doppelt erscheint; seine Kosten können den Deckel geringfügig übersteigen.

Weitere Folgen:
- Die Worker lesen Tarif und Kosten als `app_user` und halten den Tarif 60 Sekunden im Speicher; ein Tarifwechsel wirkt dort mit dieser Verzögerung.
