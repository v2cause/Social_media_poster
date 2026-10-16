# ADR 0022: Medien im Web

- **Status**: Akzeptiert
- **Datum**: 2026-10-16
- **Bezug**: Umsetzungsleitfaden, Schritt 3.6; `docs/ARCHITECTURE.md`, Abschnitte 9 und 11; ADR 0009, ADR 0017, ADR 0020

## Kontext

Schritt 3.6 bringt die Medien in die Oberfläche: die Bibliothek mit Uploads und Alt-Texten, im Composer einen Medienstreifen pro Variante mit Reihenfolge und Zuschnitt pro Plattform, dazu die Vorschau mit Bild. Offen waren:

- wie der Browser die Bilder aus dem Objektspeicher lädt,
- wie die Vorschau einen Zuschnitt zeigt, bevor der Worker die Rendition erzeugt hat,
- wie die Medien in das Auto-Speichern aus ADR 0017 passen,
- wie sich die Reihenfolge ohne Ziehen ändern lässt (WCAG 2.2, Kriterium 2.5.7).

## Entscheidung

### Bilder im Browser

- **Thumbnails als `<img>` mit signierten URLs.** Bibliothek, Medienstreifen und Vorschau zeigen die WebP-Thumbnails (320 und 640 px) über `srcset`. Das Original wird nie angezeigt. Der Bildoptimierer von Next.js (`next/image`) entfällt aus zwei Gründen:
  - Er würde die eine Stunde gültigen URLs auf dem Server abrufen und unter eigener Adresse über ihre Laufzeit hinaus cachen.
  - Er bräuchte den Speicher als `remotePatterns`.
- **CSP mit dem Objektspeicher.** Der Browser lädt direkt in den Speicher hoch und die Thumbnails von dort. Deshalb enthalten `img-src` und `connect-src` den Origin aus `S3_PUBLIC_ENDPOINT` (sonst aus `S3_ENDPOINT`), und zwar genau diesen, ohne Platzhalter. Damit ist der Vermerk aus ADR 0009 umgesetzt.
- **Uploads per XHR.** Fortschritt beim Hochladen meldet nur `XMLHttpRequest` (`upload.onprogress`), `fetch` nicht. Es laufen höchstens drei Uploads gleichzeitig, weitere warten.
- **Status beim Prüfen.** Solange der Worker ein Asset prüft, fragen Bibliothek und Auswahldialog alle 2 s nach dem Stand. Die Live-Events aus Schritt 4.10 ersetzen das später.

### Zuschnitt und Vorschau

- **Zuschnitt im Dialog** mit `react-easy-crop` auf dem größten Thumbnail. Als Voreinstellungen gibt es nur Verhältnisse, die die Plattform annimmt:
  - Instagram: 4:5, 1:1 und 1.91:1.
  - Facebook und LinkedIn: 1.91:1, 1:1, 4:5 und das Original.
  - X: 16:9, 1:1, 4:5 und das Original.
- **Weiße Ränder (Letterbox)** bietet der Dialog nur an, wo das Profil das Verhältnis begrenzt (Instagram).
- **Gespeichert in Pixeln des Originals.** Der Cropper liefert Prozent eines Thumbnails, dessen Seiten gerundet sind. Damit ein Zuschnitt am Rand des erlaubten Bereichs (Instagram 4:5) nicht knapp danebenliegt, rastet er beim Übernehmen in ganzen Pixeln auf das Verhältnis der Voreinstellung ein. Dabei wird er nur kleiner, nie größer, und bleibt so im Bild.
- **Vorschau ohne eigene Rendition.** Den Zuschnitt zeigt ein CSS-Fenster auf dem Thumbnail, die Ränder `object-contain` auf Weiß. So kostet eine Änderung keine Anfrage. Die Datei für die Plattform erzeugt der Worker nach dem Speichern (`media.render`, ADR 0020). Rahmen mit einem anderen Verhältnis zeigen die Mitte des Zuschnitts, statt ihn zu verzerren.
- **Ort des Bildes in der Vorschau:** Instagram zeigt die Bilder über dem Text, die anderen Plattformen darunter.
- **Hinweise im Editor.** Die Medienregeln (Pflichtbild, Höchstzahl, Seitenverhältnis, einheitliches Karussell) prüft `validatePost` mit den Maßen der geplanten Renditions. Ein Bild, das ohne Zuschnitt nicht passt, trägt im Streifen ein Warnzeichen.

### Medien im Auto-Speichern

- **Eigene Revision.** Die Medien einer Variante haben ihren eigenen Zähler (`mediaRevision`) neben dem des Textes.
- **Eigene Anfrage nach dem Text.** Der Composer speichert sie mit `PUT /api/w/:ws/variants/:variantId/media` als ganze Liste, nach dem Text derselben Variante und mit der `version`, die das Speichern des Textes zurückgab. Sonst gilt ADR 0017: nacheinander, 800 ms nach der letzten Änderung, und ein 409 hält das Speichern an.
- **Antwort des Servers.** Die Medien aus der Antwort übernimmt der Composer nur, wenn währenddessen keine neuere lokale Änderung dazugekommen ist.
- **Alt-Text pro Verwendung.** Ein Alt-Text im Composer gilt für die Verwendung an der Variante. Bleibt er leer, gilt der aus der Bibliothek. Der KI-Vorschlag bekommt die Sprache des Beitrags und das Briefing als Kontext.

### Reihenfolge

- **Ziehen mit `dnd-kit`**, mit Zeiger und Tastatur (Leertaste, Pfeiltasten) und mit Ansagen für Screenreader auf Deutsch und Englisch.
- **Ohne Ziehen:** Die Schaltflächen "Nach vorne" und "Nach hinten" am ausgewählten Bild erfüllen WCAG 2.2, Kriterium 2.5.7 (Bewegungen durch Ziehen).

## Alternativen

- **`next/image` mit `unoptimized`**: bringt gegenüber `<img>` nichts, nur eine weitere Schicht.
- **Ein Proxy der API für Thumbnails**: hielte die CSP bei `'self'`, schickte aber jeden Bildabruf durch die API. Für Uploads bräuchte es ihn ebenfalls, sonst bleibt der Speicher in `connect-src`.
- **Eine Vorschau-Rendition pro Zuschnitt**: wäre pixelgenau, kostet aber pro Änderung einen Job und Wartezeit.
- **Medien im selben Request wie der Text**: hätte `PATCH` der Variante um eine Liste mit eigener Validierung erweitert. Der getrennte `PUT` hält beide Anfragen einfach und nutzt dieselbe `version`.

## Konsequenzen

- Zieht der Speicher hinter ein CDN oder auf eine andere Domain, muss `S3_PUBLIC_ENDPOINT` mitziehen, sonst blockiert die CSP Uploads und Thumbnails.
- Die Vorschau zeigt den Zuschnitt auf dem 640-px-Thumbnail. Die echte Rendition kann in Schärfe und Kompression davon abweichen, nicht im Ausschnitt.
- Phase 4 stellt die Renditions vor dem Posten erneut sicher (ADR 0020). Der Composer braucht dafür nichts Neues.
