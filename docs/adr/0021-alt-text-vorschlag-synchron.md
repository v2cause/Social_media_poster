# ADR 0021: Alt-Text-Vorschlag als synchrone KI-Route

- **Status**: Akzeptiert
- **Datum**: 2026-10-16
- **Bezug**: Umsetzungsleitfaden, Schritt 3.5; `docs/ARCHITECTURE.md`, Abschnitte 5.3 und 7.4; ADR 0016, ADR 0020

## Kontext

Der Leitfaden sieht für den Alt-Text-Vorschlag einen Job `ai.alt-text` in der Queue `ai` vor. Der Vorschlag entsteht aber immer auf Knopfdruck, und der Nutzer wartet auf ihn, um ihn zu bestätigen oder zu ändern. Ein Job bräuchte einen Ort für das Ergebnis und ein Nachfragen der Oberfläche, bis es da ist. Für die Themenideen hat Phase 2 aus demselben Grund eine synchrone Route gewählt (ADR 0016).

## Entscheidung

- **Route**: `POST /api/w/:ws/ai/alt-texts` mit `assetId`, optional `language` (sonst die Content-Sprache des Workspace) und `context` (worum es im Beitrag geht). Antwort `{ altText }`, höchstens 250 Zeichen, am Wortende gekürzt, falls das Modell mehr schreibt. Gespeichert wird nichts; die Oberfläche übernimmt den Vorschlag erst, wenn der Nutzer ihn bestätigt.
- **Bild**: die Rendition `ai_vision` (JPEG, längste Seite 1568 px, die Größe, die Claude ohne Verkleinern liest) als Base64-Block. Sie entsteht beim ersten Vorschlag für ein Asset und bleibt wie jede Rendition erhalten; weitere Vorschläge lesen sie nur. Base64 statt URL, weil der Speicher lokal und in Tests für Anthropic nicht erreichbar ist.
- **Abrechnung und Grenzen** wie bei den übrigen KI-Routen: Recht `ai.use`, Rate-Limits pro Nutzer und Workspace, Reservierung der Schätzung (Prompt plus 1600 Tokens für das Bild) vor dem Aufruf, Buchung der tatsächlichen Kosten danach, `AiGeneration` mit `task = ALT_TEXT`. Ins Protokoll gehen nur Asset-ID, Sprache und ob ein Kontext dabei war, nie Bild oder Kontext.
- **Rechenlast**: Die API rendert die Rendition beim ersten Vorschlag selbst (sharp mit einem Thread, ohne Cache). Die Rate-Limits begrenzen das; ein Asset wird nur einmal gerendert.

## Alternativen

- **Job `ai.alt-text`** wie im Leitfaden: verworfen für den Knopf in der Oberfläche, siehe Kontext. Ein Job bleibt sinnvoll für Vorschläge vieler Bilder auf einmal; dann nutzt er denselben Use Case `SuggestAltText`.
- **Thumbnail mit 640 px statt 1568 px**: verworfen. Weniger Tokens, aber Schrift im Bild (Schilder, Folien) wird unleserlich, und gerade sie gehört in einen Alt-Text.

## Konsequenzen

- Die Queue `ai` hat in Phase 3 noch keinen Verbraucher; `ai.topic-ideas` und `ai.alt-text` kommen dazu, sobald es Vorschläge im Hintergrund gibt.
