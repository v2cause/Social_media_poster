# ADR 0015: Anthropic-Adapter: Fallback mitten im Stream und eigenes Parsen

- **Status**: Akzeptiert
- **Datum**: 2026-10-16
- **Bezug**: Umsetzungsleitfaden, Schritte 2.4 und 2.8; `docs/ARCHITECTURE.md`, Abschnitte 5.1 und 5.3; ADR 0007

## Kontext

Architektur und Leitfaden gingen davon aus, dass bei einem serverseitigen Fallback mitten im Stream die bis dahin gestreamte Teilausgabe verworfen wird und der Client ein `variant.reset` bekommt. Für nicht gestreamte Aufrufe war `client.messages.parse()` mit `parsed_output` vorgesehen. Beim Umsetzen mit `@anthropic-ai/sdk` 0.134.0 und der offiziellen Doku (Refusals and fallback, Stand 2026-10-16) zeigte sich:

- **Fallback mitten im Stream**: Der Stream wird nicht verworfen. Ein `fallback`-Block markiert die Stelle, und das Fallback-Modell setzt die Teilausgabe fort; nur die Textblöcke davor gehen als Kontext an das Fallback-Modell. Die Antwort besteht danach aus dem Text vor und dem Text nach dem `fallback`-Block. Würde die Teilausgabe verworfen, wäre das JSON der strukturierten Ausgabe unvollständig.
- **Geliefertes Modell**: Nach einem Fallback mitten im Stream nennt `message_start` und damit `message.model` weiterhin das angefragte Modell. Das liefernde Modell steht im letzten `fallback_message`-Eintrag von `usage.iterations` (und in `to.model` des `fallback`-Blocks).
- **Automatisches Parsen des SDK**: Mit einem parsebaren Format (`betaZodOutputFormat`) parst das SDK in `finalMessage()` jeden Textblock einzeln und wirft bei ungültigem JSON. Das scheitert an der Fortsetzung nach einem Fallback (zwei Textblöcke) und an einer Antwort, die bei `max_tokens` abbricht, bevor der Stop-Grund geprüft werden kann.
- Die offene Frage aus Spike 0.14(a), ob ein Zod-Helper auf dem Beta-Pfad funktioniert, ist beantwortet: Das SDK hat dafür `betaZodOutputFormat` (`@anthropic-ai/sdk/helpers/beta/zod`).

## Entscheidung

- Der Adapter sammelt die Texte aller Textblöcke in ihrer Reihenfolge; die Teilausgabe vor einem `fallback`-Block bleibt erhalten. Gespeichert wird als geliefertes Modell der letzte `fallback_message`-Eintrag, sonst `message.model`. Der Fallback wird mit Ausgangs- und Zielmodell sowie Kategorie geloggt (Info).
- `variant.reset` gibt es nur noch für den einen Neuversuch nach `max_tokens` mit höherem Limit: Dann beginnt die Antwort tatsächlich von vorn.
- Das Ausgabeformat kommt aus `betaZodOutputFormat`, wird aber ohne seine `parse`-Funktion übergeben. Der Adapter prüft zuerst `stop_reason` (`refusal`, `max_tokens`), verbindet dann die Textblöcke und validiert mit zod. Ungültiges JSON oder eine Variante zu wenig ergeben `INVALID_OUTPUT`.
- Auch Ideen und Alt-Texte laufen über `client.beta.messages.stream()` und `finalMessage()`, mit derselben Prüfung. Das vermeidet zudem lange blockierende HTTP-Anfragen.
- Das partielle JSON parst der Server (`partial-json`). `variant.partial` trägt Teil-Varianten, gedrosselt auf etwa 50 ms; das Frontend rendert sie, ohne selbst JSON zu parsen. Das endgültige Ergebnis validiert zod auf dem Server.
- Bricht der Client ab, endet der Aufruf mit `CANCELED`. Erfasst wird der begonnene Versuch mit den bekannten Input-Tokens und geschätzten Output-Tokens, damit die Kosten nicht als null verbucht werden.

## Alternativen

- **Teilausgabe verwerfen**: zerstört das JSON der strukturierten Ausgabe.
- **`messages.parse()` und SDK-Parsing**: wirft bei der Fortsetzung nach einem Fallback und bei abgeschnittenen Antworten, bevor der Stop-Grund ausgewertet ist.
- **Partielles JSON im Frontend parsen**: doppelte Logik in Browser und Server; der Mock-Provider müsste JSON-Text erzeugen.

## Konsequenzen

- Der SSE-Client des Composers wird einfacher: Er übernimmt Teil-Varianten und leert sie nur bei `variant.reset`.
- Architektur 5.1 und 5.3 sowie die Leitfaden-Schritte 2.4 und 2.8 sind angepasst.
- Spike 0.14(a) bleibt für die Messungen mit echtem Schlüssel offen (Time-to-first-token, Cache-Treffer, Kosten).
