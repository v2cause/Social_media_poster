# ADR 0034: Stripe-Integration

- **Status**: Akzeptiert
- **Datum**: 2026-10-17
- **Bezug**: Umsetzungsleitfaden, Schritte 7.2, 7.3 und 7.5; `docs/ARCHITECTURE.md`, Abschnitte 6.4, 7.4 und 10; [ADR 0033](0033-tarife-abo-und-nur-lesen.md), [ADR 0035](0035-nutzungsabrechnung-und-durchsetzung-der-limits.md)

## Kontext

Stripe übernimmt Zahlung, Rechnungen, Steuern und die Abrechnung des Mehrverbrauchs. Laut Leitfaden ändern nur Webhooks den Zustand eines Abos, nie die Erfolgsseite des Checkouts, und die Reihenfolge der Events darf keine Rolle spielen. Die Dokumentation von Stripe (docs.stripe.com) ist aus dieser Umgebung nicht erreichbar, ebenso die API selbst. Geprüft wurde gegen die offizielle OpenAPI-Spezifikation (GitHub `stripe/openapi`, API-Version `2026-09-30.endive`) und die README von stripe-node.

## Entscheidung

### SDK und Katalog

- **SDK**: `stripe` (stripe-node) mit fest eingestellter API-Version `2026-09-30.endive`, 20 Sekunden Timeout und zwei Wiederholungen. `packages/billing` kapselt es hinter dem Port `BillingGateway` des Kerns.
- **Katalog im Code** (`STRIPE_CATALOG`):
  - ein Produkt mit Monatspreis pro bezahltem Tarif,
  - ein Produkt mit nutzungsbasiertem Preis pro Meter (`ai_overage`, `x_api_cost`, beide in Mikro-USD),
  - alles über Lookup-Keys gefunden, die auch in der Tabelle `plan` stehen.

  Die Beträge sind Platzhalter, netto in EUR.
- **Abgleich** (`pnpm stripe:sync`, `tools/stripe-sync.ts`):
  - Legt Produkte, Preise und Meter an.
  - Ein geänderter Betrag ergibt einen neuen Preis, der den Lookup-Key übernimmt (`transfer_lookup_key`).
  - Legt eine Konfiguration des Kundenportals an, erkennbar an der Markierung `managedBy`.
- **Steuern**: Stripe Tax mit `automatic_tax` im Checkout; die Adresse ist Pflicht, die Steuer-ID wird abgefragt. Einen eigenen `tax_code` setzt der Katalog nicht, es gilt der Standard des Stripe-Kontos.

### Checkout, Tarifwechsel, Portal

- **Checkout** (`POST /api/org/:org/billing/checkout`, nur Owner): eine gehostete Checkout-Session im Modus `subscription` mit dem Monatspreis und den beiden Meter-Preisen.
  - Den Stripe-Kunden legt der erste Checkout einer Organisation an (Metadaten `organizationId`); er bleibt der einzige.
  - Erfolgs- und Abbruch-URL führen zur Abrechnungsseite. Läuft schon ein bezahltes Abo, antwortet die API mit 409.
- **Tarifwechsel** (`POST /api/org/:org/billing/plan`): stellt den Tarifposten des laufenden Abos auf den neuen Preis um, mit anteiliger Verrechnung (`create_prorations`). Der Tarif der Organisation ändert sich erst mit dem folgenden Webhook.
- **Kundenportal** (`POST /api/org/:org/billing/portal`): Zahlungsmethoden, Rechnungen, Adresse, Name, Steuer-ID und Kündigung zum Periodenende. Tarifwechsel sind im Portal ausgeschaltet: Wie das Portal sie mit den Meter-Preisen umsetzt, lässt sich ohne Zugang zu Stripe nicht prüfen, also wechselt die App selbst.
- **Rechnungen** (`GET /api/org/:org/billing/invoices`): die letzten Rechnungen des Kunden mit Links zu Stripe.
- **Übersicht** (`GET /api/org/:org/billing`): Tarif, Zustand, Verbrauch pro Limit und die Tarife mit Preisen.
  - Die Preise kommen von Stripe und bleiben 10 Minuten im Speicher, eine unvollständige Antwort 1 Minute.
  - Ohne Stripe zeigt die Seite die Tarife ohne Preise.

### Webhooks

- **Empfang** (`POST /api/webhooks/stripe`): Die API prüft die Signatur mit `constructEvent` gegen den Raw Body.
  - Behandelt werden `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid` und `invoice.payment_failed`; andere Typen bestätigt sie nur.
  - Jedes Event landet einmal in `webhook_event` (nur IDs, keine Kundendaten), dann als Job `stripe.{eventId}` in der Queue `billing`.
- **Verarbeitung** (Worker-Rolle `billing`): unter einer Sperre pro Kunde (`billing.{customerId}`).
  - Die Rolle lädt das Abo frisch von Stripe. Dadurch spielt die Reihenfolge keine Rolle, und ein doppeltes Event ändert nichts.
  - Aus den Lookup-Keys der Posten ergibt sich der Tarif; Status, Periode und Kündigung übernimmt sie als `app_system` (`syncSubscription`).
  - Danach markiert sie das Event als verarbeitet.
- **Benachrichtigung**: Bei `invoice.payment_failed` benachrichtigt die Rolle die Owner, bevor sie speichert, mit dem Event als Schlüssel (`ntf.{eventId}.{userId}`). So kommt jede E-Mail einmal an, auch wenn das Event wiederholt läuft.

### Tests ohne Stripe

- **Fake-Stripe** (`packages/testing`): hält Kunden, Preise, Meter, Checkouts, Abos und Rechnungen im Speicher.
  - Er prüft jeden Parameter gegen einen Auszug der offiziellen OpenAPI-Spezifikation (`tools/stripe-api-subset.ts`).
  - Er signiert Webhooks wie Stripe und hat eine gehostete Checkout-Seite mit Bezahl-Knopf sowie eine Portal-Seite.
  - Preise mit Lookup-Key haben feste IDs, damit ein neu gestarteter Fake zu einem gemerkten Preis passt.
- **Anbindung**: Die Apps erreichen ihn über `STRIPE_API_BASE`. Das nimmt nur Testschlüssel an und wird in Produktion abgelehnt.
- **E2E-Test** (`apps/web/e2e/billing.spec.ts`, in CI): spielt mit dem Fake durch Web, API und Worker:
  - Kauf über den Checkout,
  - zweiter Workspace und Downgrade mit dem Hinweis zum Reduzieren,
  - fehlgeschlagene Verlängerung mit E-Mail und Kulanzfrist,
  - Kündigung mit Nur-Lesen.
- **Test mit Test Clocks** (`apps/worker/test/stripe-test-clock.integration.test.ts`): Gegen den Testmodus des echten Stripe spielt er dieselben Zustände mit einer Test Clock durch, nur mit `STRIPE_TEST_CLOCK_SECRET_KEY`. Er liest die Events über die Events-API statt über einen Webhook.

## Konsequenzen

- API und Worker-Rolle `billing` brauchen `STRIPE_SECRET_KEY`; die API zusätzlich `STRIPE_WEBHOOK_SECRET`, die Rolle `billing` zusätzlich `DATABASE_SYSTEM_URL` und `APP_URL`. Ohne Schlüssel antworten Checkout, Portal und Tarifwechsel mit `BILLING_UNAVAILABLE`.
- Nicht geprüft, weil api.stripe.com und docs.stripe.com aus dieser Umgebung nicht erreichbar sind und kein Testschlüssel vorliegt:
  - der Lauf mit Test Clocks,
  - das Verhalten von Stripe Tax ohne `tax_code`,
  - die Darstellung der Meter-Preise im gehosteten Checkout.
- Ändert ein Abgleich die Preise, nutzt die API bis zu 5 Minuten den alten Preis für neue Checkouts (Preis-Cache des Gateways).
