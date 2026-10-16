# ADR 0020: Renditions und Zuschnitt

- **Status**: Akzeptiert
- **Datum**: 2026-10-16
- **Bezug**: Umsetzungsleitfaden, Schritt 3.4; `docs/ARCHITECTURE.md`, Abschnitt 9; ADR 0019

## Kontext

Jede Plattform bekommt ein Bild in ihrem eigenen Format: Instagram nur JPEG zwischen 4:5 und 1.91:1, X höchstens 5 MB, Facebook und LinkedIn eigene Grenzen. Der Nutzer schneidet pro Plattform zu oder wählt Letterbox. Offen waren die Werte der Profile, die Darstellung des Zuschnitts, der Schlüssel einer Rendition, der Umgang mit Byte-Grenzen und wo das Anhängen an Varianten in der API liegt.

## Entscheidung

### Profile in `@smp/platform-rules`

| Profil | Format | Box | Weitere Regeln | Max. Bytes | Quelle |
|---|---|---|---|---|---|
| `instagram_feed` | JPEG (mozjpeg), Qualität 85 | 1080 x 1350 | 4:5 bis 1.91:1; unter 320 px Breite wird vergrößert | 8 MB | Metas Referenz `ig-user/media`, über deren Suchindex geprüft am 2026-10-16 |
| `facebook_photo` | JPEG, 85 | 2048 x 2048 | - | 4 MB | Fehlertext der Graph API ("less than 4 MB"); nicht bestätigt, Prüfung in Phase 4b |
| `linkedin_image` | JPEG, 85 | 2048 x 2048 | weit unter 36.152.320 Pixeln | 5 MB | Sekundärquellen; Prüfung in Phase 4a |
| `x_image` | JPEG, 85 | 4096 x 4096 | - | 5 MB | `docs.x.com/x-api/media/introduction`, über den Suchindex geprüft am 2026-10-16 |
| `thumb_320`, `thumb_640` | WebP, 80 | Breite 320 bzw. 640, höchstens viermal so hoch | - | 1 bzw. 2 MB | Thumbnails der Bibliothek (ADR 0019) |

- Die offiziellen Seiten von Meta, LinkedIn und X sind aus dieser Umgebung nicht erreichbar (403 der Netzwerk-Policy). Bestätigt sind die Werte, die der Suchindex aus den offiziellen Seiten zitiert; die übrigen tragen im Code den Vermerk, in welcher Adapter-Phase sie geprüft werden.
- Alle Plattform-Renditions sind JPEG in sRGB. PNG mit Transparenz wird auf Weiß gesetzt; das genügt für Fotos und hält eine Datei pro Profil.
- **Karussell**: Instagram schneidet alle Bilder eines Karussells auf das Verhältnis des ersten zu (Content-Publishing-Leitfaden). `validatePost` meldet deshalb `MIXED_ASPECT_RATIOS`, wenn die Bilder einer Instagram-Variante verschiedene Verhältnisse haben.

### Zuschnitt und Planung

- **Zuschnitt** als `{ x, y, width, height }` in Pixeln des Originals, wie es angezeigt wird (nach EXIF-Drehung). Gespeichert pro Verwendung an `PostMedia.crop`, dazu `letterbox` und ein eigener Alt-Text; ohne Alt-Text gilt der des Assets.
- **`planRendition()`** (browser-tauglich, auch für die Warnungen im Composer) prüft den Zuschnitt gegen die Bildgröße und das erlaubte Verhältnis. Liegt das Verhältnis außerhalb, braucht es Zuschnitt oder Letterbox (`ASPECT_RATIO_OUT_OF_RANGE`). Letterbox ergänzt weiße Ränder bis zum nächsten erlaubten Verhältnis. Danach wird in die Box des Profils skaliert, nie darüber hinaus vergrößert.
- **sharp**: `autoOrient` vor dem Ausschneiden, damit die Koordinaten im angezeigten Bild gelten; die Ränder setzt sharp nach dem Skalieren in Pixeln des Ergebnisses.

### Schlüssel und Erzeugung

- **Crop-Hash**: lesbar statt kryptografisch, etwa `full`, `x200y0w960h1200` oder mit Letterbox `full-lb`. Er enthält nur Buchstaben, Ziffern und `-` und ist damit direkt Teil des Objekt-Keys: `ws/{ws}/assets/{id}/renditions/{profile}-{cropHash}.jpg`. Eine Rendition ist eindeutig über `(assetId, profile, cropHash)`.
- **Beim Anhängen**: `PUT /api/w/:ws/variants/:variantId/media` ersetzt alle Medien einer Variante, mit der `version` der Variante wie beim Text (409 bei veraltetem Stand) und nur für bearbeitbare Varianten. Für jede Verwendung, die ins Profil passt, reiht die API `media.render` ein (Job-ID `rend.{assetId}.{profile}.{cropHash}`). Verwendungen, die noch einen Zuschnitt brauchen, bekommen keinen Job; der Composer zeigt die Warnung.
- **Payload** mit IDs und dem Crop-Hash. Der Worker liest die Verwendung neu; wurde sie entfernt oder anders zugeschnitten, endet der Job ohne Wirkung (`SKIPPED`), denn der Job des neuen Zuschnitts deckt sie ab.
- **Vor dem Posten**: `RenderRendition` gibt eine vorhandene Rendition zurück und erzeugt sonst eine. Der Publisher in Phase 4 ruft es vor jedem Versand auf.
- **Byte-Grenzen**: erst Qualität 85, 75, 65, dann 75 % und 50 % der Größe mit Qualität 50, bis die Datei passt; sonst Fehler. Bei Fotos reicht fast immer der erste Versuch; ein Rauschbild mit 12 Megapixeln für X braucht weniger Qualität (Test im Worker).
- **Rechte**: Anhängen braucht `post.write` (es ändert die Variante). Die Varianten in Beitrags- und Varianten-Antworten enthalten ihre Medien mit signierten Thumbnails.
- **Fehlercodes**: `MEDIA_NOT_READY` (409, Asset noch nicht fertig), `CROP_OUT_OF_BOUNDS` (422), `VARIANT_MEDIA_INVALID` (422, zweite Linie hinter dem Schema: höchstens 20 Medien, jedes Asset einmal).

## Alternativen

- **Zuschnitt in relativen Koordinaten**: verworfen. Pixel des angezeigten Originals sind eindeutig; der Browser rechnet von der Vorschau hoch.
- **SHA-256 als Crop-Hash**: verworfen, ein lesbarer Schlüssel ist ebenso eindeutig und hilft bei der Fehlersuche im Speicher.
- **Eigener Endpunkt pro Verwendung (POST/PATCH/DELETE)**: verworfen. Die Reihenfolge ist Teil des Zustands; eine ganze Liste mit der Version der Variante vermeidet Zwischenzustände.
- **Zugeschnittene Vorschau-Thumbnails rendern**: verworfen, der Composer zeigt den Zuschnitt per CSS auf dem vorhandenen Thumbnail.

## Konsequenzen

- Renditions bleiben, wenn eine Verwendung entfernt wird; `tick.maintenance` räumt sie später mit dem Asset ab.
- Die Werte für Facebook und LinkedIn werden in den Adapter-Phasen 4a und 4b gegen die Dokumentation geprüft.
