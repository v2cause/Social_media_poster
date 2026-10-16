# ADR 0016: Content- und KI-API

- **Status**: Akzeptiert
- **Datum**: 2026-10-16
- **Bezug**: Umsetzungsleitfaden, Schritt 2.7; `docs/ARCHITECTURE.md`, Abschnitte 5.3 und 10; ADR 0007, 0014, 0015

## Kontext

Schritt 2.7 baut die Endpunkte für Posts, Varianten, Stile, Brand Voices, Ideen und die KI. Einige Punkte lassen Architektur und Leitfaden offen oder beschreiben sie anders, als sie sich sauber umsetzen lassen: wohin das Ergebnis einer Generierung geschrieben wird, wie Fehler vor dem Stream beim Client ankommen, welche Rechte für Stile gelten und wie die Leitplanken der KI-Routen technisch greifen.

## Entscheidung

- **Die KI schreibt nie in Varianten.** Generierung und Refine liefern ihre Ergebnisse nur als Events. Der Editor übernimmt sie in Varianten, die der Nutzer nicht bearbeitet hat, und speichert sie über `PATCH /variants/:id` mit Optimistic Locking. So gibt es einen einzigen Schreibweg für Varianten, und Streaming überschreibt nie eine Bearbeitung. Der Ausgang jedes Aufrufs bleibt in `AiGeneration` erhalten.
- **Fehler vor dem Stream als HTTP-Fehler.** Laden, Prüfungen und die Quoten-Reservierung laufen, bevor der Server das erste Event (`generation.started`) erzeugt; erst danach sendet er die Header. Unbekannte Posts (404), ein leeres Briefing (422 `BRIEF_REQUIRED`) und eine erschöpfte Quote (402 `QUOTA_EXCEEDED`) kommen deshalb als Problem-Dokument an, nicht als `generation.failed`. Ab dem ersten Event endet jeder Fehler als `generation.failed` mit `REFUSED`, `TRUNCATED`, `INVALID_OUTPUT`, `PROVIDER_ERROR` oder `CANCELED`.
- **Jeder Aufruf wird einmal gebucht.** Kosten aller Versuche, `AiGeneration` und Quoten-Abschluss laufen im `finally` des Use Cases, auch nach Ablehnung, Fehler oder Abbruch. Bricht der Client ab, wird der Aufruf über `res.on('close')` abgebrochen und als `CANCELED` gebucht. Eine zu lange Variante wird einmal automatisch gekürzt; der Kürz-Aufruf ist ein eigener gebuchter `REFINE`-Aufruf und entfällt, wenn die Quote ihn nicht deckt.
- **Prüfung auf dem Server.** Jede fertige Variante bekommt die Zeichenzahl wie die Plattform zählt, die Plattform-Issues und die gefundenen verbotenen Wörter der Brand Voice (`forbiddenWords`). Jedes Event wird vor dem Senden gegen `generationEventSchema` validiert; interne Felder verlassen den Server nicht.
- **Teil-Varianten sind unvollständig.** In `variant.partial` kann jedes Feld fehlen oder abgeschnitten sein, auch die Plattform (`"LINK"`). Der Vertrag erlaubt dort einen beliebigen String; der Client ordnet Teil-Varianten über ihre Reihenfolge den Zielen zu.
- **Rechte**: Lesen von Stilen und Brand Voices (inklusive Versionen) braucht `post.read`, weil der Composer sie für Editoren anzeigt. Eigene Stile anlegen und ändern braucht wie Brand Voices `brand_voice.manage` (Owner, Admin). Ideen generieren braucht `ai.use`, weil es das KI-Budget belastet; Ideen ändern `idea.write`.
- **Leitplanken der KI-Routen**: Pro Nutzer 10 Aufrufe pro Minute und 2 gleichzeitig, pro Workspace 60 pro Stunde, als feste Zeitfenster in Redis (`INCR` mit Ablauf in einem Lua-Skript). Ein laufender Aufruf hält einen Slot, der nach 10 Minuten auch dann verfällt, wenn ein Prozess abstürzt. Überschreitung: 429 `AI_RATE_LIMITED`. Die Quote begrenzt die Kosten unabhängig davon.
- **Fehlerarten**: Neben `invalid`, `forbidden`, `not_found` und `conflict` gibt es `quota_exceeded` (402), `rate_limited` (429) und `unavailable` (503). Nicht gestreamte KI-Aufrufe (Ideen, Stimmtest) melden einen Fehlschlag als `AI_<CODE>`: 422 bei einer Ablehnung, sonst 503.

## Alternativen

- **Server schreibt die Varianten**: bräuchte eine Regel, welche Varianten der Nutzer inzwischen bearbeitet hat, und einen zweiten Schreibweg mit eigenen Konflikten.
- **QUOTA_EXCEEDED als `generation.failed`**: Der Client müsste für denselben Fehler zwei Wege kennen; die Reservierung ist ohnehin vor dem Stream fertig.
- **`@nestjs/throttler`** für die KI-Leitplanken: deckt keine gleichzeitigen Aufrufe ab und bräuchte trotzdem einen eigenen Speicher in Redis.

## Konsequenzen

- Der Composer (Schritt 2.8) speichert übernommene Varianten selbst und zeigt bei 409 den Dialog "neu laden oder überschreiben".
- Ein Prozess, der zwischen Reservierung und Abschluss abstürzt, hinterlässt eine Reservierung im Zähler; ein Abgleich mit dem Ledger korrigiert sie später (ADR 0014).
- Die Grenzwerte der Leitplanken stehen im Code (`DEFAULT_AI_RATE_LIMITS`); Tests setzen eigene.
