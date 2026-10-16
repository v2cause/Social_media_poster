# ADR 0012: E-Mail-Jobs tragen ihren Link

- **Status**: Akzeptiert
- **Datum**: 2026-10-16
- **Bezug**: Umsetzungsleitfaden, Schritte 1.4 und 1.8; `docs/ARCHITECTURE.md`, Abschnitt 7.4

## Kontext

Job-Payloads enthalten nach der Architektur nur IDs; der Job liest den Rest aus der Datenbank. E-Mails mit Link (Verifizierung, Passwort-Reset, Einladung) passen nicht dazu: Gespeichert ist nur der Hash des Tokens (Einladungen) oder Better Auth hält den Token selbst. Aus der Datenbank lässt sich der Link nicht wieder herstellen. Der Versand soll trotzdem über die Queue laufen, mit Wiederholungen, und die API soll nicht auf den Mailserver warten.

## Entscheidung

- Die API reiht `notify.dispatch` in die Queue `notifications` ein, mit Empfänger, Template, Sprache und Link. Der Worker in der Rolle `notify` validiert, rendert und sendet.
- Jobs werden nach dem Versand sofort gelöscht (`removeOnComplete`), fehlgeschlagene nach einem Tag (`removeOnFail`). Wiederholt wird bis zu sechsmal mit exponentiellem Backoff ab 10 s.
- Logs des Workers enthalten Job-ID und Template, nie Adresse oder Link.
- Die Links bleiben kurzlebig: Verifizierung und Reset eine Stunde, Einladungen sieben Tage und nur einmal verwendbar.
- Redis ist nur im internen Netz erreichbar und hält auch sonst Sitzungs- und Sperrdaten.

## Alternativen

- **Token verschlüsselt im Payload**: braucht die Envelope-Encryption aus Phase 4. Sobald sie da ist, kann der Link im Job verschlüsselt werden; der Payload-Vertrag bleibt.
- **Direkter SMTP-Versand aus der API**: keine Wiederholungen, und die Antwortzeit hinge am Mailserver.
- **Token im Klartext speichern**: verworfen, die Datenbank soll keine verwendbaren Tokens enthalten.

## Konsequenzen

- Ein Angreifer mit Lesezugriff auf Redis sieht Links, die noch nicht versendet wurden oder deren Versand scheiterte. Das Fenster ist auf Versandzeit plus einen Tag begrenzt.
- E-Mails gehen nur raus, wenn ein Worker mit der Rolle `notify` läuft. Lokal ist die Rolle in `WORKER_ROLES` voreingestellt.
