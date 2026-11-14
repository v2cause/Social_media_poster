# ADR 0047: Unbegrenzter Zugang für den Eigenbetrieb

- **Status**: Akzeptiert
- **Datum**: 2026-11-14
- **Bezug**: `docs/ARCHITECTURE.md`, Abschnitt 6.4; [ADR 0033](0033-tarife-abo-und-nur-lesen.md) (Tarife, Overrides, Nur-Lesen), [ADR 0035](0035-nutzungsabrechnung-und-durchsetzung-der-limits.md) (Nutzungsabrechnung), [ADR 0046](0046-echte-plattform-adapter.md); [Plattformen einrichten](../betrieb/plattformen-einrichten.md)

## Kontext

Die App soll vorerst privat laufen, auf dem eigenen Rechner oder einem eigenen Server, mit einem Zugang ohne Limits und ohne Nutzungskosten.

Bisher gilt:

- Eine neue Organisation startet in der Testphase und kann nach 14 Tagen nur noch lesen, solange kein Abo über Stripe läuft (ADR 0033).
- Die Testphase hat enge Limits: 3 Accounts, 30 Posts im Monat, 2 USD KI-Guthaben.
- Nur die Demo-Organisation des Seeds läuft auf `agency` ohne Ablauf, aber mit dessen Limits.

ADR 0033 sieht vor, dass Betreiber ohne Stripe das Abo direkt in der Datenbank setzen. Einen Befehl dafür gab es nicht.

## Entscheidung

Der Befehl `pnpm billing:grant-unlimited --owner <email> [--ticket <Referenz>] [--check]` macht jede Organisation, deren Owner die Person ist, unbegrenzt:

- **Tarif und Zustand**: Tarif `agency`, Status `ACTIVE`. Testphase, Zahlungsverzug und Nur-Lesen werden geleert, ebenso der Zeitpunkt der Nur-Lesen-Meldung.
- **Limits**: Die Overrides setzen jedes Limit auf den größten Wert, den das Schema erlaubt (`UNLIMITED_PLAN_LIMITS` in `@smp/contracts`):

  | Limit | Wert |
  |---|---|
  | Workspaces | 10.000 |
  | Accounts | 100.000 |
  | Mitglieder | 100.000 |
  | Posts pro Monat | 10.000.000 |
  | Analytics-Historie | 3.650 Tage |
  | KI-Guthaben, Speicher, X-Kosten | `Number.MAX_SAFE_INTEGER` |
  | KI-Mehrverbrauch | 0 |
  | X-Browser | erlaubt |

  Die Grenzen des Schemas und diese Werte stehen an einer Stelle, damit beide zusammenbleiben.
- **Keine Nutzungskosten**: Meter-Events an Stripe gehen nur für Organisationen mit Stripe-Kunden und begonnenem Abo raus (ADR 0035). Eine unbegrenzte Organisation hat beides nicht, es wird also nie etwas gemeldet. Weil das KI-Guthaben nie aufgebraucht ist, entsteht auch kein Mehrverbrauch.
- **Organisationen mit Stripe**: Eine Organisation mit laufendem Stripe-Abo bleibt unverändert (`billed_by_stripe`, Exit-Code 1). Der nächste Webhook würde die Änderung sonst überschreiben.
- **Nachvollziehbar**: Jede Änderung schreibt in derselben Transaktion den Eintrag `billing.unlimited_granted` ins Audit-Log der Organisation, ohne Akteur, mit dem vorherigen Tarif und der Referenz (ohne `--ticket`: `own-use`). Das Log des Befehls nennt Nutzer- und Organisations-IDs und das Ergebnis, nie die Adresse.
- **Wiederholbar**: Ein zweiter Lauf meldet `unchanged` und schreibt nichts. `--check` listet die Organisationen und ihren Zustand, ohne etwas zu ändern.
- **Datenbank**: Der Befehl schreibt als `app_system` (`PrismaUnlimitedAccess` in `@smp/db`), weil `app_user` Tarif und Status nicht schreiben darf.
- **Ort**: Der Befehl gehört wie `auth:reset-two-factor` zur API (`apps/api/src/scripts/grant-unlimited.ts`). So läuft er lokal nach `pnpm build` und im Container der API.
- **Abrechnungsseite**: Sie zeigt ein Limit am Höchstwert als "unbegrenzt" (`billing.usage.ofUnlimited` in de und en), ohne Balken und ohne Warnung.

## Alternativen

- **Eigener Tarif `internal`**: Sauberer im Namen, aber er hätte Tarifliste, Stripe-Katalog, Verträge, Checkout und Abrechnungsseite berührt, nur um ihn überall auszublenden. Die Overrides gibt es dafür schon (ADR 0033).
- **Unbegrenzt als `null` im Schema**: Jede der neun Prüfstellen und die Abrechnungsseite hätten einen Sonderfall gebraucht. Die Höchstwerte wirken an jeder Stelle ohne Änderung.
- **Ein Flag pro Nutzer statt pro Organisation**: Limits und Abo hängen an der Organisation. Ein Nutzer-Flag hätte eine zweite Quelle der Wahrheit für dieselben Prüfungen geschaffen.
- **SQL im Runbook**: Fehleranfällig, ohne Audit-Eintrag und ohne Schutz für Organisationen mit Stripe.

## Konsequenzen

- Für den Eigenbetrieb: registrieren (oder die Demo-Organisation nutzen), dann einmal `pnpm billing:grant-unlimited --owner <Adresse>`. Eine später angelegte Organisation startet wieder in der Testphase; der Befehl gilt für die Organisationen zum Zeitpunkt des Laufs und wird dann erneut ausgeführt.
- Die Kosten der Anbieter bleiben: Die Claude API rechnet über den eigenen Schlüssel ab, die X API über das eigene Guthaben. Gegen eine teure Fehlbedienung bei X schützt dann nur das Ausgabenlimit im Entwicklerportal von X, nicht mehr der Deckel der App.
- Zurück geht es über ein Stripe-Abo (der Webhook setzt Tarif und Status) oder in der Datenbank. Einen Befehl zum Zurücknehmen gibt es nicht.
- Rechte der Plattform-Admins (`/admin`) gibt der Befehl nicht. Die setzt weiterhin das Flag aus dem [Runbook Deployment](../runbooks/deployment.md), Schritt 7.
