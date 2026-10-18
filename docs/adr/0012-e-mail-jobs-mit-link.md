# ADR 0012: E-Mail-Jobs tragen ihren Link

- **Status**: Akzeptiert
- **Datum**: 2026-10-16
- **Bezug**: Umsetzungsleitfaden, Schritte 1.4, 1.8 und 8.4; `docs/ARCHITECTURE.md`, Abschnitt 7.4

## Kontext

Job-Payloads enthalten nach der Architektur nur IDs; der Job liest den Rest aus der Datenbank. E-Mails mit Link (Verifizierung, Passwort-Reset, Einladung) passen nicht dazu: Gespeichert ist nur der Hash des Tokens (Einladungen) oder Better Auth hält den Token selbst. Aus der Datenbank lässt sich der Link nicht wieder herstellen. Der Versand soll trotzdem über die Queue laufen, mit Wiederholungen, und die API soll nicht auf den Mailserver warten.

## Entscheidung

- Die API reiht `notify.dispatch` in die Queue `notifications` ein, mit Empfänger, Template, Sprache und Link. Der Worker in der Rolle `notify` validiert, rendert und sendet.
- Seit Schritt 8.4 sind Empfänger und E-Mail im Payload versiegelt: mit der Envelope-Verschlüsselung aus Schritt 4.2, dem Token-Keyring (`TOKEN_KEKS`) und der AAD `notify.email`. Der Payload ist `{ channel: 'email', sealed }`. Der Producer prüft die E-Mail vor dem Versiegeln, die Rolle `notify` öffnet sie direkt vor dem Versand und prüft sie erneut. Das gilt für alle E-Mails der Queue, auch für die Benachrichtigungen aus der Outbox (ADR 0025).
- Jobs werden nach dem Versand sofort gelöscht (`removeOnComplete`), fehlgeschlagene nach einem Tag (`removeOnFail`). Wiederholt wird bis zu sechsmal mit exponentiellem Backoff ab 10 s.
- Logs des Workers enthalten Job-ID und Template, nie Adresse oder Link. Auch der Fehler eines gescheiterten Versands nennt keine Adresse: Nodemailer schreibt die Antwort des Mailservers, die eine abgelehnte Adresse nennt, in seine Meldung, und BullMQ hält Meldung und Stacktrace des Jobs einen Tag. Der SMTP-Adapter wirft deshalb `SmtpDeliveryError` mit den Codes allein, etwa `SMTP delivery failed: EENVELOPE, RCPT TO, 550`.
- Ein Umschlag, der sich nicht öffnen lässt (beschädigt, mit einem anderen Schlüssel desselben Namens oder ohne gültige E-Mail), scheitert sofort ohne Wiederholung (`notify.unreadable_email`). Eine Key-ID, die der Keyring nicht kennt, wiederholt die Rolle dagegen: Beim Neustart nach einer Rotation kann der Absender den neuen Schlüssel schon kennen (`notify.unknown_key`, `docs/runbooks/secret-rotation.md`).
- Die Links bleiben kurzlebig: Verifizierung und Reset eine Stunde, Einladungen sieben Tage und nur einmal verwendbar.
- Redis ist nur im internen Netz erreichbar und hält auch sonst Sitzungs- und Sperrdaten.

## Alternativen

- **Token verschlüsselt im Payload**: brauchte die Envelope-Encryption aus Phase 4 und ist seit Schritt 8.4 umgesetzt, für die ganze E-Mail samt Adresse statt nur für den Link. Der Payload-Vertrag hat sich dabei geändert (siehe Konsequenzen).
- **Direkter SMTP-Versand aus der API**: keine Wiederholungen, und die Antwortzeit hinge am Mailserver.
- **Token im Klartext speichern**: verworfen, die Datenbank soll keine verwendbaren Tokens enthalten.

## Konsequenzen

- Ein Angreifer mit Lesezugriff auf Redis, die AOF-Datei oder ein Backup davon sieht seit Schritt 8.4 weder Adressen noch Links, auch nicht in gescheiterten Jobs; er bräuchte zusätzlich den Token-Keyring. Vorher sah er Links, die noch nicht versendet wurden oder deren Versand scheiterte, für die Versandzeit plus einen Tag.
- API und jede Worker-Rolle, die E-Mails einreiht oder versendet (`notify`, `scheduler`, `billing`, `gdpr` und `publisher` für die Alarme des X-Browsers), brauchen denselben Token-Keyring.
- Jobs im alten Klartext-Format, die beim Deployment noch in der Queue liegen, scheitern als ungültig. Betroffen sind höchstens E-Mails aus den Minuten davor und aus Wiederholungen; Bestätigungs- und Reset-Links lassen sich neu anfordern, Einladungen neu senden.
- E-Mails gehen nur raus, wenn ein Worker mit der Rolle `notify` läuft. Lokal ist die Rolle in `WORKER_ROLES` voreingestellt.
