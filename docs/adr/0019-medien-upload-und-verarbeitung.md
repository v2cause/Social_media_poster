# ADR 0019: Medien-Upload und Verarbeitung

- **Status**: Akzeptiert
- **Datum**: 2026-10-16
- **Bezug**: Umsetzungsleitfaden, Schritte 3.1 bis 3.3; `docs/ARCHITECTURE.md`, Abschnitte 7.4 und 9; ADR 0002, ADR 0008

## Kontext

Bilder kommen per Presigned PUT direkt in den Objektspeicher (ADR 0008). Danach muss die Pipeline prüfen, was wirklich angekommen ist, und daraus Dateien erzeugen, die gefahrlos ausgeliefert werden können. Offen waren die Prüfung des Dateityps, die Einstellungen von sharp, die Speicher-Quote vor den Tarifen aus Phase 7, der Lebenszyklus eines Assets und das Verhalten bei wiederholten oder verspäteten Jobs.

## Entscheidung

### Ablauf und Zustände

- **Zustände**: `PENDING_UPLOAD` (Ticket ausgegeben) -> `PROCESSING` (Datei geprüft, Job eingereiht) -> `READY` oder `REJECTED`. Jeder Übergang ist ein bedingtes Update auf den erwarteten Ausgangszustand. Ein verspäteter oder doppelter Job ändert so nichts.
- **`POST /media/:id/complete` ist wiederholbar**: Steht das Asset schon auf `PROCESSING`, wird der Job erneut eingereiht; die Job-ID `media.{assetId}` verhindert einen zweiten, solange der erste wartet oder läuft. Jeder andere Zustand kommt unverändert zurück. Fehlt die Datei noch, antwortet die API mit 409 `MEDIA_UPLOAD_MISSING`.
- **Abweichende Dateien**: Weichen Größe oder Content-Type laut `HeadObject` von der Ankündigung ab, löscht die API das Objekt sofort und setzt `REJECTED` mit `SIZE_MISMATCH` oder `TYPE_MISMATCH`.
- **Ablehnungsgründe**: `SIZE_MISMATCH`, `TYPE_MISMATCH`, `NOT_AN_IMAGE`, `UNSUPPORTED_FORMAT`, `HEIC_NOT_SUPPORTED`, `ANIMATED_NOT_SUPPORTED`, `DIMENSIONS_TOO_LARGE`, `CORRUPT_IMAGE`. Die UI übersetzt den Code. Abgelehnte Dateien und alles daraus Erzeugte werden sofort gelöscht (alle Objekte unter `ws/{ws}/assets/{id}/`).
- **Löschen**: `DELETE` setzt `deletedAt` und schreibt `media.delete` ins Audit-Log. Ein Asset, das eine Variante verwendet, bleibt (409 `MEDIA_IN_USE`). Dateien und Zeile räumt der stündliche `gdpr.sweep` mit seinem nächsten Lauf ab (Architektur, Abschnitt 9; ADR 0038).

### Prüfung im Worker (`media.process`)

- **Eigene Magic-Byte-Prüfung statt `file-type`**: `sniffImageType` in `@smp/core` erkennt JPEG, PNG, GIF, WebP sowie HEIC/HEIF und AVIF (ISO-BMFF-Brands). `file-type` ist seit Version 17 nur noch ESM, unsere Pakete werden als CommonJS gebaut (ADR 0002), und der Core darf außer zod und uuidv7 nichts von npm laden. Für sechs Signaturen lohnt die zusätzliche Abhängigkeit nicht. Der Dateiname und der MIME-Typ des Browsers zählen nie.
- **sharp**: `sharp(buf, { limitInputPixels: 50e6, failOn: 'error' }).rotate()`, Ausgabe in sRGB ohne Metadaten (sharp entfernt EXIF, GPS und ICC ohne `keepMetadata()`). `failOn: 'error'` bricht bei kaputten und abgeschnittenen Pixeldaten ab. sharps Standard `'warning'` würde auch Fotos ablehnen, bei denen der Decoder nur warnt, wie sie manche Kameras erzeugen. Bilder über 50 Megapixel werden schon am Header abgelehnt, bevor die Pixel dekodiert werden.
- **Ressourcen**: `sharp.cache(false)`, ein libvips-Thread pro Bild und höchstens zwei Bilder gleichzeitig pro Worker-Prozess (`MEDIA_CONCURRENCY`). Mehr Durchsatz kommt über weitere Worker-Prozesse mit der Rolle `media`.
- **Thumbnails**: WebP mit Qualität 80 in 320 und 640 px Breite (Box mit vierfacher Höhe, nie vergrößert), gespeichert als `MediaRendition` mit den Profilen `thumb_320` und `thumb_640` und dem Crop-Hash `full`.
- **Retries**: fünf Versuche mit exponentiellem Backoff ab 5 s für Speicher- oder Datenbankfehler. Ein abgelehntes Bild ist kein Fehler: Der Job endet erfolgreich mit `REJECTED`. Ungültige Payloads scheitern sofort (`UnrecoverableError`). Fehlgeschlagene Jobs bleiben einen Tag zur Analyse in Redis.
- **Mandantentrennung**: Der Worker verbindet sich als `app_user` und setzt den Mandanten des Jobs pro Transaktion. RLS gilt auch für ihn.

### Speicher-Quote

- **Grenze pro Workspace** aus `MEDIA_STORAGE_LIMIT_BYTES` (Standard 5 GiB), bis die Tarife in Phase 7 sie pro Organisation setzen. Darüber antwortet die API mit 402 `STORAGE_QUOTA_EXCEEDED`.
- **Gezählt** werden die Originale aller Assets, die weder gelöscht noch abgelehnt sind: die gemessene Größe, solange sie fehlt die angekündigte. Thumbnails und Renditions zählen nicht.
- **Atomar** über eine transaktionsgebundene Advisory-Sperre pro Workspace (`pg_advisory_xact_lock(hashtextextended('media.storage.{ws}', 0))`). Prüfung und Anlegen laufen in derselben Transaktion; parallele Uploads eines Workspace warten aufeinander. Ohne Sperre kamen im Test vier von fünf parallelen Anfragen über die Grenze, mit Sperre genau die erlaubten zwei.

### API

- `POST /media/uploads` (201, Ticket mit PUT-URL für 5 min), `POST /media/:id/complete` (200), `GET /media` (Filter `status` und `usage`, Cursor, neueste zuerst; ohne Filter alles außer `PENDING_UPLOAD`), `GET /media/:id`, `PATCH /media/:id` (Alt-Text mit `version`), `DELETE /media/:id` (204).
- Schreiben braucht `media.write`, Lesen `post.read`.
- Antworten enthalten die Thumbnails als für 1 h signierte URLs. Original-URLs und Storage-Keys verlassen die API nie.
- Fehlercodes: `MEDIA_TYPE_NOT_ALLOWED` und `MEDIA_TOO_LARGE` (422), `STORAGE_QUOTA_EXCEEDED` (402), `MEDIA_UPLOAD_MISSING` und `MEDIA_IN_USE` (409), `MEDIA_NOT_FOUND` (404).

## Messung

Integrationstest des Workers gegen PostgreSQL, Redis und SeaweedFS (`apps/worker/test/media.integration.test.ts`): Ein JPEG mit 11,4 MB (4000 x 3000 Pixel) stand 610 ms nach `complete` auf `READY`, einschließlich Abholen aus der Queue, Lesen aus dem Speicher, zwei Thumbnails und Datenbank. Gefordert sind unter 5 s. Eine PDF-Datei namens `Rechnung.jpg` endet auf `REJECTED` (`NOT_AN_IMAGE`) und ist danach aus dem Speicher gelöscht.

## Alternativen

- **`file-type`**: verworfen, siehe oben. Bei neuen Formaten (etwa Videos in einer späteren Phase) wird die Entscheidung neu geprüft.
- **Quote mit `SERIALIZABLE`-Transaktionen**: verworfen, die API müsste Serialisierungsfehler wiederholen. Die Advisory-Sperre ist einfacher und betrifft nur Uploads desselben Workspace.
- **Quote nur beim `complete`**: verworfen, dann wären Tickets über die Grenze hinaus möglich und die Datei läge schon im Speicher.
- **Thumbnails in einer eigenen Tabelle**: verworfen, sie sind Renditions mit festem Profil; Schritt 3.4 nutzt dieselbe Tabelle für die Plattformprofile.

## Konsequenzen

- `@smp/media` bringt sharp mit. Die API lädt es mit, obwohl sie keine Bilder dekodiert; die Images basieren auf `node:24-slim` (glibc, seit Schritt 8.4 `node:24.21.0-trixie-slim` auf Debian 13), passend zu den vorgebauten Binaries von sharp.
- Ein Job, der alle Versuche verbraucht, lässt das Asset auf `PROCESSING` stehen, und ein erneutes `complete` reiht ihn erst nach Ablauf des fehlgeschlagenen Jobs (ein Tag) wieder ein. `tick.maintenance` (Architektur, Abschnitte 7.4 und 9) soll solche Assets erneut einreihen oder ablehnen.
- Das Aufräumen von `PENDING_UPLOAD` nach 24 h und gelöschten Assets nach 30 Tagen folgt mit `tick.maintenance`.
