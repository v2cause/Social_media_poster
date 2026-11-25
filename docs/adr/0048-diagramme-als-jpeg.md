# ADR 0048: Diagramme der KI als JPEG und Download der Bilder

- **Status**: Akzeptiert
- **Datum**: 2026-11-25
- **Bezug**: `docs/ARCHITECTURE.md`, Abschnitte "Getroffene Entscheidungen", 5.1 und 9; [ADR 0019](0019-medien-upload-und-verarbeitung.md), [ADR 0020](0020-renditions-und-zuschnitt.md), [ADR 0047](0047-claude-abo-ueber-claude-code.md)

## Kontext

Bisher gilt: Bilder kommen nur per Upload, die KI schlägt höchstens Alt-Texte vor. Der Betreiber will auf Wunsch ein Diagramm erzeugen lassen, als JPEG gespeichert, um es auf den Plattformen hochzuladen. Solange die Adapter für LinkedIn und Meta fehlen, postet er von Hand: Text kopieren, Bild herunterladen, auf der Plattform hochladen.

Claude erzeugt keine Rasterbilder, schreibt aber zuverlässig SVG. SVG ist als Upload gesperrt, weil es Skripte und externe Verweise tragen kann (ADR 0019).

## Entscheidung

### Diagramm

- **Port**: `AiProvider.generateDiagram()` liefert Titel, Alt-Text und ein SVG (Schema `diagramOutputSchema`). Alle drei Provider setzen es um; der Mock zeichnet die Schritte der Beschreibung als Kästen.
- **Prompt**: Aufgabe `diagram` mit Sprache, Format und der Beschreibung als Daten, dazu der Markenkontext. Er nennt Größe und `viewBox`, die erlaubten Elemente (`DIAGRAM_ELEMENTS` im Core), Schrift, Mindestgröße der Texte, Ränder, Kontrast und verbietet erfundene Zahlen. Effort ist der der Route "generate".
- **Formate**: `square` 1080 x 1080, `portrait` 1080 x 1350 (Instagram-Feed), `landscape` 1200 x 675 (`DIAGRAM_SIZES`).
- **Prüfung vor dem Rendern** (`checkDiagramSvg` in `@smp/media`): höchstens 512 KB; Kommentare und XML-Deklaration werden entfernt; abgelehnt werden Doctype, Entities außer den fünf von XML, CDATA, Processing Instructions, jedes Element außerhalb der Allowlist (also auch `script`, `style`, `image`, `use`, `foreignObject`, `a`, Filter und Animationen), Event-Attribute, `href` in jeder Form, fremde Namensräume, `url()` außer auf `#id` im Dokument sowie `javascript:`, `data:`, `@import` und `expression()` in Werten. Jedes `<` und `>` muss zu einem erkannten Tag gehören.
- **Rendern**: sharp mit librsvg und Pixel-Limit rendert genau die Größe des Formats, ergänzt weiße Ränder, legt das Bild auf Weiß und schreibt JPEG mit Qualität 90 und voller Farbauflösung (4:4:4), ohne Metadaten. Abgelehntes oder nicht lesbares SVG ergibt `DiagramRejectedError` (HTTP 503) und eine `AiGeneration` mit `INVALID_OUTPUT`.
- **Ablage**: `CreateDiagram` prüft vor dem Aufruf den Speicher des Tarifs, misst den Aufruf (Task `DIAGRAM`, Migration `0029_ai_task_diagram`) und legt das JPEG wie einen fertigen Upload ab: Asset in `PENDING_UPLOAD` unter der Speichersperre, Datei ins Upload-Objekt, `PROCESSING`, dann `media.process`. Damit durchläuft es dieselbe Prüfung wie jedes Bild und bekommt Original und Thumbnails. Dateiname aus dem Titel, Alt-Text der KI am Asset.
- **API und Web**: `POST /api/w/:ws/media/diagrams` (Recht `ai.use`, Rate-Limits der KI). In der Medienbibliothek öffnet "Diagramm erstellen" einen Dialog mit Beschreibung und Format.

### Download

`GET /api/w/:ws/media/:assetId/download` (Recht `post.read`) liefert eine für eine Stunde signierte URL, unter der der Browser das Bild speichert. Ausgeliefert wird nicht das Original, das bei Uploads EXIF- und GPS-Daten tragen kann, sondern die Rendition `x_image`: JPEG, gedreht, sRGB, ohne Metadaten, längste Seite höchstens 4096 px, einmal pro Asset erzeugt und behalten. Der Dateiname ist der aus der Bibliothek mit der Endung `.jpg`. Jede fertige Karte der Bibliothek hat dafür "Als JPEG herunterladen".

## Alternativen

- **Diagramm-Bibliothek mit Daten der KI** (etwa Mermaid oder Vega-Lite): Verworfen für den Anfang. Sie liefert einheitlichere Bilder, braucht aber einen Headless-Browser oder eine weitere Render-Kette und deckt Freiformen wie Abläufe mit Symbolen schlechter ab. Das SVG-Schema lässt sich später durch eine solche Spezifikation ersetzen, ohne Port und Ablage zu ändern.
- **SVG bereinigen statt ablehnen**: Verworfen. Ein Bereiniger muss jede Umgehung kennen; die Allowlist mit Ablehnung ist kleiner und prüfbar. Ein abgelehntes Diagramm kostet einen neuen Versuch.
- **Original herunterladen**: Verworfen wegen der Metadaten von Fotos.

## Folgen

- Die Entscheidung "keine KI-Bildgenerierung" gilt nur noch für Fotos und Illustrationen; Diagramme erzeugt die KI.
- Die Qualität hängt am Modell: Überlappende Texte sind möglich. Der Nutzer sieht das Bild in der Bibliothek, bevor er es verwendet, und kann neu erzeugen.
- Schriften kommen vom Rechner, auf dem die API läuft (fontconfig). Fehlt Arial oder Helvetica, nimmt librsvg eine andere serifenlose Schrift.
