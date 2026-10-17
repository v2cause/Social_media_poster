# ADR 0033: Tarife, Abo-Zustand und Nur-Lesen

- **Status**: Akzeptiert
- **Datum**: 2026-10-17
- **Bezug**: Umsetzungsleitfaden, Schritte 7.1, 7.2, 7.4 und 7.5; `docs/ARCHITECTURE.md`, Abschnitte 6.2 und 6.4; [ADR 0034](0034-stripe-integration.md), [ADR 0035](0035-nutzungsabrechnung-und-durchsetzung-der-limits.md)

## Kontext

Bis Phase 6 galten feste Limits aus Umgebungsvariablen (`AI_MONTHLY_CAP_MICROS`, `ANALYTICS_HISTORY_DAYS`, `MEDIA_STORAGE_LIMIT_BYTES`) und ein Tarif-Gate des X-Browsers, das nur Plattform-Admins öffnen konnten. Phase 7 führt Tarife ein. Jede Organisation hat genau ein Abo. Dessen Zustand entscheidet, was die Organisation darf: alles, eingeschränkt durch die Limits ihres Tarifs, oder nur noch lesen.

## Entscheidung

### Tarife als Referenzdaten

- **Tabelle `plan`**: Die Migration `0018_rls_billing` legt die Tarife an, wie Preise und Stil-Presets als Referenzdaten (ADR 0014). Zur Laufzeit ist die Tabelle nur lesbar. Jeder Tarif hat:
  - einen Schlüssel,
  - Limits als JSON, das `planLimitsSchema` aus `@smp/contracts` bei jedem Lesen prüft,
  - den Lookup-Key seines Monatspreises in Stripe (bei der Testphase leer),
  - eine Position und ein Aktiv-Kennzeichen.
- **Die vier Tarife** (Preise sind Platzhalter im Stripe-Katalog, ADR 0034):

  | Tarif | Workspaces | Accounts | Mitglieder | KI-Guthaben | KI-Mehrverbrauch | Posts/Monat | Speicher | Historie | X-Browser | X-Kosten |
  |---|---|---|---|---|---|---|---|---|---|---|
  | `trial` | 1 | 3 | 3 | 2 USD | 0 | 30 | 1 GiB | 30 Tage | nein | 1 USD |
  | `starter` | 1 | 5 | 3 | 10 USD | 10 USD | 150 | 5 GiB | 90 Tage | nein | 10 USD |
  | `pro` | 3 | 15 | 10 | 30 USD | 50 USD | 600 | 25 GiB | 365 Tage | ja | 50 USD |
  | `agency` | 15 | 75 | 50 | 100 USD | 200 USD | 3000 | 100 GiB | 730 Tage | ja | 200 USD |

- **Overrides**: Die Betreiber können pro Organisation einzelne Limits setzen (`subscription.limit_overrides`, geprüft mit `limitOverridesSchema`). Wirksam sind die Limits des Tarifs mit den Overrides darüber (`effectiveLimits`).
- **Monatliche Limits**: KI-Guthaben, Posts pro Monat und X-Kosten zählen im Kalendermonat in UTC.

### Das Abo einer Organisation

- **Anlage**: Eine neue Organisation bekommt in derselben Transaktion ihr Abo: Tarif `trial`, Status `TRIALING`, 14 Tage Testphase. Bestehende Organisationen bekamen mit der Migration ebenfalls 14 Tage Testphase; fehlt einer Organisation dennoch die Zeile, gilt sie als Testphase ohne Ende. Der Demo-Seed setzt die Demo-Organisation auf `agency` und `ACTIVE`.
- **Rechte**: `app_user` liest das Abo der eigenen Organisation, darf nur eine Testphase anlegen (Policy `trial_insert`) und nur den Stripe-Kunden speichern (Spaltenrecht auf `stripe_customer_id`). Tarif, Status und Zeitpunkte schreibt die Worker-Rolle `billing` als `app_system`.
- **Status**: Die Werte folgen Stripe (`TRIALING`, `ACTIVE`, `PAST_DUE`, `CANCELED`, `UNPAID`, `INCOMPLETE`, `INCOMPLETE_EXPIRED`, `PAUSED`). Nur Webhooks ändern Tarif und Status (ADR 0034).
- **Ab wann nur noch lesen** (`readOnlyAtOf`; der Zeitpunkt steht in `subscription.read_only_at`):

  | Zustand | Nur-Lesen ab |
  |---|---|
  | Testphase ohne bezahltes Abo | Ende der Testphase |
  | `ACTIVE`, Testphase eines bezahlten Abos | nie |
  | `PAST_DUE` | 7 Tage nach Beginn des Zahlungsverzugs (Kulanzfrist) |
  | `CANCELED`, `UNPAID`, `INCOMPLETE`, `INCOMPLETE_EXPIRED`, `PAUSED` | sofort |

  Eine Organisation, die schon nur lesen kann, behält den Zeitpunkt, an dem das begann, auch wenn derselbe Zustand erneut übernommen wird.
- **EntitlementsService**: liefert Tarif, wirksame Limits und Zustand einer Organisation.
  - Die API liest das Abo bei jeder Änderung neu, damit ein Webhook mit der nächsten Anfrage wirkt.
  - Worker dürfen es 60 Sekunden im Speicher halten.

### Nur-Lesen

- **API**: Der `ReadOnlyGuard` läuft als vierter globaler Guard nach Sitzung, Mandant und Berechtigung. Er lehnt jede schreibende Anfrage (alles außer GET, HEAD, OPTIONS) einer Organisation, die nur lesen kann, mit 402 `SUBSCRIPTION_INACTIVE` ab.
- **Ausnahmen** (`@AllowWhenReadOnly()`): Ausgenommen ist, was zum Bezahlen oder Reduzieren nötig ist:
  - die Abrechnung,
  - Mitglieder entfernen und Einladungen widerrufen,
  - die Organisation verlassen,
  - Accounts trennen,
  - Medien und Posts löschen,
  - geplante Varianten abbrechen,
  - den X-Browser ausschalten.
- **Scheduler**: übergeht fällige und verpasste Varianten von Organisationen, die nur lesen können. Die Posts bleiben geplant. Zahlt die Organisation wieder, gehen sie aus, und für Posts jenseits des Zeitfensters gilt die Regel für verpasste Zeitfenster.
- **Benachrichtigung**:
  - Bei fehlgeschlagener Zahlung bekommt jeder Owner mit bestätigter Adresse eine E-Mail mit dem Ende der Kulanzfrist, einmal pro Stripe-Event.
  - Beginnt die Nur-Lesen-Phase, meldet `tick.read-only` (alle 15 Minuten, mit `APP_URL`) das mit dem Grund (Testphase, Zahlung, Abo-Ende), einmal pro Organisation und Zeitpunkt (`subscription.read_only_notified_at`).
  - In der Web-App zeigt jede Seite der Organisation allen Mitgliedern einen Hinweis bei Nur-Lesen, bei Zahlungsverzug und in den letzten drei Tagen der Testphase. Owner bekommen den Weg zur Abrechnung, alle anderen den Hinweis auf den Owner.

## Konsequenzen

- `AI_MONTHLY_CAP_MICROS`, `ANALYTICS_HISTORY_DAYS` und `MEDIA_STORAGE_LIMIT_BYTES` entfallen. Wer andere Limits braucht, setzt Overrides.
- Die Kontexte von Organisation und Workspace tragen den Zustand des Abos (`billing`). Dafür lesen sie das Abo bei jedem Laden der App-Shell.
- Ohne Stripe (ohne `STRIPE_SECRET_KEY`) läuft jede neue Organisation nach 14 Tagen in Nur-Lesen. Betreiber ohne Stripe heben das mit einem Override nicht auf; sie setzen das Abo direkt in der Datenbank.
- Ein Tarifwechsel ändert Limits sofort. Was über einem kleineren Limit liegt, bleibt, nur Neues wird blockiert (ADR 0035).
