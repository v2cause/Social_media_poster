# ADR 0037: Löschung von Organisationen

- **Status**: Akzeptiert
- **Datum**: 2026-10-18
- **Bezug**: Umsetzungsleitfaden, Schritt 8.2; `docs/ARCHITECTURE.md`, Abschnitte 6.4, 7.4, 10 und 11; [ADR 0033](0033-tarife-abo-und-nur-lesen.md), [ADR 0034](0034-stripe-integration.md), [ADR 0036](0036-datenschutz-anfragen-und-datenexport.md)

## Kontext

Die Owner einer Organisation können sie samt allen Daten löschen lassen (Art. 17 DSGVO, Ende des Vertrags). Der Leitfaden verlangt in Schritt 8.2 ein Soft-Delete und nach 30 Tagen den Job `gdpr.erase`:
- die Kaskade in der Datenbank,
- das Löschen der Präfixe im Objektspeicher,
- den Widerruf der Plattform-Tokens,
- das Löschen oder Anonymisieren des Stripe-Kunden,
- einen anonymisierten Audit-Eintrag.

Fertig ist der Schritt, wenn ein Prüfskript keine Restdaten findet. Die Anfragen und die Rolle `gdpr` stammen aus Schritt 8.1 (ADR 0036).

## Entscheidung

### Löschen und Zurücknehmen

- **Recht und Bestätigung**: Das Recht `org.delete` haben nur Owner, auch im Nur-Lesen-Zustand. Sie bestätigen mit dem Namen der Organisation; Leerzeichen am Rand zählen nicht.
- **Löschen** (`POST /api/org/:org/deletion`, 201 mit `deletedAt` und `eraseAfter`), in einer Transaktion als `app_user`:
  - setzt `organization.deleted_at` (Migration `0022_organization_deletion`),
  - legt eine Anfrage `ERASURE` an (`PENDING`, fällig nach 30 Tagen). In ihren Details stehen die Workspaces, weil die Löschung danach ihre Objekte und Restzeilen finden muss, wenn ihre Zeilen schon fehlen, und ob das Abo endet,
  - schreibt den Audit-Eintrag `organization.delete_requested`.
- **Zurücknehmen** (`DELETE /api/org/:org/deletion`, 204), solange die Löschung wartet:
  - die Anfrage wird `CANCELED`, `deleted_at` wird leer, Audit `organization.delete_canceled`;
  - als `app_user` dürfen Owner nur den Status einer wartenden Löschung auf `CANCELED` setzen (Migration `0023_rls_organization_deletion`, Policy `erasure_cancel`). Alles andere an einer Anfrage ändert weiter nur `app_system`.
- **Abo**: Ein bezahltes Abo, das sich verlängert, endet mit seiner Periode (`cancel_at_period_end`). So zahlt niemand eine weitere Periode, während die Löschung wartet. Wer die Löschung zurücknimmt, lässt es wieder verlängern. Ein Abo, das ohnehin endet, bleibt, wie es ist.
- **E-Mail** `gdpr-erasure-scheduled` an alle Owner, in ihrer Sprache und Zeitzone: der Tag der endgültigen Löschung und der Link zur Seite „Daten und Löschung“.
- **Nach dem Commit**: Scheitern Stripe oder die E-Mail, bleibt die Löschung bestehen; der Fehler steht im Log.

### Die 30 Tage bis zur Löschung

- **API**: Der `DeletedOrganizationGuard` läuft nach dem `WorkspaceGuard` und vor dem `PermissionGuard`. Jede Route der Organisation antwortet mit 409 `ORGANIZATION_DELETION_PENDING`, außer den Routen mit `@AllowWhenDeleted()`:
  - die Kontexte von Organisation und Workspace, die die Löschung zeigen (`deletion` mit `deletedAt` und `eraseAfter`),
  - die Datenexporte, weil das Recht auf die Daten bis zur Löschung gilt,
  - das Zurücknehmen.
- **Cache**: Der Zugriffs-Cache (60 s) trägt den Zeitpunkt der Löschung. Nach Löschen und Zurücknehmen verwirft die API die Einträge aller Mitglieder, sodass die Sperre sofort für alle gilt.
- **Scans**: Die mandantenübergreifenden Scans lassen gelöschte Organisationen aus:
  - Scheduler-Tick und Sweeper veröffentlichen ihre geplanten Posts nicht, wie bei Nur-Lesen,
  - die Token-Überwachung,
  - der Planer der Metriken,
  - die Hinweise zum Nur-Lesen-Zustand; die Owner hörten von der Löschung.
- **Web**: Über jeder Seite der Organisation steht ein Hinweis mit dem Tag der Löschung. Außer auf der Datenseite steht statt des Inhalts eine Erklärung; Owner führt ein Link zur Datenseite, alle anderen bitten einen Owner.

### Endgültige Löschung (`gdpr.erase`)

- **Auslöser**: Der stündliche Job `gdpr.sweep` reiht die fälligen Löschungen ein, dazu solche, die seit über einer Stunde laufen, weil ihr Job verloren ging.
- **Nie aufgegeben**: Ein Job hat fünf Versuche. Danach entfernt BullMQ ihn, und der nächste Sweep reiht ihn unter derselben ID neu ein.
- **Reihenfolge**, jeder Schritt verträgt eine Wiederholung:
  1. **Grants widerrufen** mit dem Schlüsselbund der Tokens (`TOKEN_KEKS`). Lehnt eine Plattform ab oder hat die Installation keinen Adapter mehr für sie, wird das nur gezählt; die Tokens gehen ohnehin mit den Zeilen.
  2. **Stripe-Kunden löschen**, was seine Abos sofort beendet. Ein Kunde, den Stripe nicht mehr kennt, gilt als gelöscht. Ohne Stripe bleibt er dort, und der Nachweis sagt das.
  3. **Objekte löschen**: `exports/{organizationId}/` und `ws/{workspaceId}/` jedes Workspaces.
  4. **Zeilen löschen** in einer Transaktion als `app_system`:
     - Sie zählt über den Katalog jede Zeile mit `organization_id` oder `workspace_id`, sodass eine neue Tabelle ohne Änderung erfasst ist.
     - Zuerst löscht sie, was die Fremdschlüssel nicht erreichen: die Medien der Posts (ihr Schlüssel auf das Asset beschränkt), Benachrichtigungen und Feature-Flags (ohne Schlüssel zur Organisation), die anderen Datenschutz-Anfragen und die Webhook-Ereignisse des Stripe-Kunden.
     - Dann löscht sie die Workspaces und die Organisation; der Rest folgt über die Kaskaden.
  5. **Restzeilen prüfen**: Findet die Prüfung etwas, schlägt der Job fehl und läuft erneut.
  6. **Abschluss**: Die Anfrage wird `COMPLETED` und vergisst, wer sie gestellt hat (`requested_by_id` leer). Ihre Details sind Zähler: widerrufene und gescheiterte Grants, gelöschte Objekte und Zeilen, der Verbleib des Kunden.
- **Nutzer bleiben**: Sie können Mitglied anderer Organisationen sein; ihre Mitgliedschaften gehen mit. Ein Nutzerkonto zu löschen ist ein eigener Vorgang.
- **Webhooks von Stripe**: Von einem Ereignis speichert die API nur die IDs von Kunde und Abo (ADR 0034); die Löschung entfernt die Ereignisse des Kunden. Ereignisse, die Stripe nach dem Löschen des Kunden schickt (`customer.subscription.deleted`), verwirft die Rolle `billing`: Keine Organisation kennt diesen Kunden mehr, und sonst blieben seine IDs liegen.

### Prüfskript

- `pnpm check:erasure <requestId>` (`tools/check-erasure.ts`) prüft:
  - die Anfrage ist `COMPLETED` und nennt niemanden,
  - keine Tabelle hält eine Zeile mit der Organisation oder einem ihrer Workspaces (über den Katalog),
  - unter den Präfixen der Exporte und der Workspaces liegt kein Objekt.
- Sonst endet es mit Exit-Code 1 und listet, was übrig ist.
- Die Webhook-Ereignisse kann das Skript nur finden, solange das Abo den Kunden nennt. Nach der Löschung prüft sie der Job selbst, mit dem Kunden, den er gelöscht hat.

### Auslegung des Leitfadens

- **„Audit-Eintrag anonymisiert“**: Das Audit-Log der Organisation nennt ihre Mitglieder und gehört zu ihren Daten; es geht mit ihr. Als anonymisierter Eintrag bleibt die Anfrage in `gdpr_request`: ohne Fremdschlüssel auf die Organisation und ohne Antragsteller, mit Zeitpunkten und Zählern.
- **„Stripe-Kunde löschen bzw. anonymisieren“**: Der Kunde wird gelöscht. Was Stripe selbst aufbewahrt, liegt außerhalb dieser Anwendung.

## Konsequenzen

- **30 Tage Bestand**: Während der Wartezeit liegen alle Daten noch vor. Das ist Absicht: Ein Versehen lässt sich zurücknehmen, und die Owner können die Daten vorher exportieren.
- **Backups**: Sicherungen enthalten die Daten bis zu ihrem eigenen Ablauf. Fristen und Restore regelt Schritt 8.6.
- **Lange Transaktion**: Eine sehr große Organisation löscht eine Transaktion von bis zu zehn Minuten. Läuft sie ab, wiederholt sich der Job.
- **Geplante Posts**: Was während der Löschung fällig wurde, behandelt der Scheduler nach dem Zurücknehmen wie nach dem Ende des Nur-Lesen-Zustands.
- **Enger Wettlauf**: Kommt ein Webhook von Stripe an, während die Transaktion läuft, kann die Rolle `billing` es noch als verarbeitet ablegen. Dann bleiben die IDs von Kunde und Abo in `webhook_event`; die Aufbewahrungsjobs (Schritt 8.3) räumen verarbeitete Ereignisse ab.
