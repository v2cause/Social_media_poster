# ADR 0036: Datenschutz-Anfragen und Datenexport

- **Status**: Akzeptiert
- **Datum**: 2026-10-17
- **Bezug**: Umsetzungsleitfaden, Schritt 8.1; `docs/ARCHITECTURE.md`, Abschnitte 6.2, 7.4, 10 und 11; [ADR 0003](0003-rls-und-mandantentrennung.md), [ADR 0008](0008-objektspeicher.md)

## Kontext

Die Owner einer Organisation haben ein Recht auf ihre Daten in einem gängigen, maschinenlesbaren Format (Art. 15 und 20 DSGVO). Als Auftragsverarbeiter liefern wir alle Daten der Organisation, die wir speichern. Der Leitfaden verlangt in Schritt 8.1 einen Job `gdpr.export`, der alle Daten als JSON pro Entität und die Originale der Medien als ZIP in den Objektspeicher legt, und einen signierten Link (24 Stunden) per E-Mail. Fertig ist der Schritt, wenn der Export vollständig und lesbar ist.

Die Löschung einer Organisation (Schritt 8.2) nutzt dieselben Anfragen.

## Entscheidung

### Anfragen

- **Tabelle `gdpr_request`** (Migrationen `0020_gdpr`, `0021_rls_gdpr`):
  - Hält Exporte und, ab Schritt 8.2, Löschungen mit Status (`PENDING`, `RUNNING`, `COMPLETED`, `FAILED`, `CANCELED`), Zeitpunkten, dem Archiv und Zählern des Laufs. Die Details sind Zahlen und Codes, nie personenbezogene Daten.
  - Hat keinen Fremdschlüssel auf die Organisation, damit der Nachweis einer Löschung sie überdauern kann.
  - Ein partieller Unique-Index lässt pro Art und Organisation höchstens eine wartende oder laufende Anfrage zu. Ein zweiter Klick oder ein paralleler Aufruf bekommt die bestehende zurück, ohne die Transaktion abzubrechen (`ON CONFLICT DO NOTHING`).
- **Zeilenschutz**: Owner lesen die Anfragen ihrer Organisation und legen eine wartende an (die Policy erlaubt nur `PENDING` ohne Ergebnis). Ändern darf nur `app_system`, also die Worker-Rolle `gdpr`.
- **Rechte**: Das neue Recht `org.export` haben nur Owner. Export und Download gehen auch im Nur-Lesen-Zustand (ADR 0033), weil das Recht auf die Daten nicht an ein bezahltes Abo gebunden ist.
- **Audit**: `gdpr.export_requested` und `gdpr.export_downloaded`.
- **API**: `POST /api/org/:org/data-exports` (202, der wartende oder ein neuer Export), `GET /api/org/:org/data-exports` (die letzten zehn), `POST /api/org/:org/data-exports/:exportId/download` (201, Link und sein Ablauf).

### Export

- **Ablauf**: Die API reiht `gdpr.export` mit der Job-ID `gdpr.{requestId}` ein. Die Rolle `gdpr` liest als `app_system`, weil ein Export alle Workspaces der Organisation umfasst. Fünf Versuche mit wachsender Pause; nach dem letzten ist die Anfrage `FAILED`, und der Owner kann neu anfordern.
- **Inhalt des Archivs**:
  - `data/<tabelle>.json`: ein JSON-Array pro Tabelle mit `organization_id` oder `workspace_id`, dazu die Organisation selbst und die Nutzer, die Mitglied sind. Die Zeilen kommen seitenweise in der Reihenfolge des Primärschlüssels als JSON von PostgreSQL (`row_to_json`), mit Zeiten in UTC und großen Zahlen ohne Verlust.
  - Geheimnisse werden gar nicht erst selektiert: versiegelte Tokens und Sessions verbundener Accounts und der Hash einer Einladung. Von den Nutzern fehlen Plattform-Rolle und 2FA-Status; Passwörter und Sessions liegen in den Tabellen von Better Auth und gehören nicht zum Export.
  - `media/<workspace>/<assetId>-<dateiname>`: die Originale der Medienbibliothek unverändert (ohne erneute Kompression). Ein Original, das inzwischen fehlt, hält den Export nicht auf; das Manifest zählt es.
  - `manifest.json` (Organisation, Workspaces, Zeitpunkte, Zeilen pro Tabelle, Format 1) und `README.txt`.
  - Ein Integrationstest hält die Liste der Tabellen gegen den Katalog der Datenbank: Jede Tabelle mit Mandantenspalte ist enthalten, keine binäre Spalte wird exportiert.
- **Schreiben**: archiver packt das ZIP und schreibt es direkt in einen Multipart-Upload (Teile von 16 MiB, bis etwa 156 GiB). Auf der Platte des Workers liegt nichts. Ein Fehler bricht den Upload ab, sodass kein halbes Archiv bleibt.
- **Ablage und Aufbewahrung**: `exports/{organizationId}/{requestId}.zip`. Der Tick `tick.gdpr` übergibt der Rolle `gdpr` stündlich den Job `gdpr.sweep`, der Archive nach 24 Stunden löscht und Exporte aufgibt, die länger als 12 Stunden warten oder laufen.

### Benachrichtigung und Download (Abweichung vom Leitfaden)

- **Leitfaden**: ein signierter Link mit 24 Stunden Gültigkeit per E-Mail.
- **Umgesetzt**:
  - Die E-Mail an den Owner, der angefordert hat, nennt, bis wann das Archiv bereitliegt, und führt zur Seite „Daten und Löschung“ der Organisation. Ist dieser Owner nicht mehr Owner, geht sie an alle Owner.
  - Einen Link zum Archiv enthält sie nicht. Auf der Seite erzeugt jeder Download einen signierten Link von fünf Minuten, der den Dateinamen setzt (`Content-Disposition`), und einen Eintrag im Audit-Log.
  - Das Archiv bleibt 24 Stunden bestehen.
- **Begründung**: Ein Link mit 24 Stunden Gültigkeit auf alle Daten einer Organisation ist ein Bearer-Token in einem Medium, das weitergeleitet, archiviert und von Link-Scannern geöffnet wird. Hinter der Anmeldung (auf Wunsch mit 2FA) ist der Download an einen Owner gebunden und nachvollziehbar.

## Konsequenzen

- **Kein Snapshot**: Der Export liest die Tabellen nacheinander. Was sich während des Laufs ändert, kann zwischen zwei Tabellen auseinanderlaufen, etwa ein neuer Post ohne seine Varianten. Ein einziger Snapshot über die ganze Laufzeit hielte eine lange Transaktion offen.
- **Abgebrochene Uploads**: Stürzt der Worker mitten im Export ab, bleiben Teile eines Multipart-Uploads liegen. Für den Bucket ist eine Regel `AbortIncompleteMultipartUpload` nach einem Tag vorgesehen (Betrieb, Schritte 8.6 und 8.7).
- **Breite Regel**: Auch technische Tabellen mit Mandantenspalte (Outbox, Feature-Flags, Benachrichtigungen) sind enthalten. Die Regel „jede Tabelle mit Mandantenspalte“ lässt sich prüfen; eine Auswahl nicht.
- **Ein Export zur Zeit**: Die Rolle verarbeitet einen Job nach dem anderen. Viele große Exporte gleichzeitig warten aufeinander.
