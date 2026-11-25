# ADR 0047: KI über das Claude-Abo mit der Claude-Code-CLI

- **Status**: Akzeptiert
- **Datum**: 2026-11-25
- **Bezug**: `docs/ARCHITECTURE.md`, Abschnitt 5; [ADR 0007](0007-ki-provider-und-caching.md); [ADR 0046](0046-einzelplatz-modus.md)

## Kontext

Die KI läuft bisher über die Claude API mit einem API-Schlüssel und Abrechnung nach Tokens (`AnthropicAiProvider`). Für den Einzelplatz-Modus will der Betreiber sein bestehendes Claude-Abo nutzen, ohne API-Schlüssel.

Die Claude-Code-CLI meldet sich mit dem Abo an und beantwortet mit `claude -p` einzelne Anfragen ohne Oberfläche. Mit `--system-prompt-file`, `--json-schema`, `--input-format stream-json` und ohne Werkzeuge verhält sie sich wie ein einfacher Modellaufruf.

## Entscheidung

`AI_PROVIDER=claude-code` wählt `ClaudeCodeAiProvider` in `@smp/ai`. Er nutzt dieselben Prompts, Schemas und Prüfungen wie der API-Provider und ruft die CLI so auf:

- `-p --input-format stream-json --output-format stream-json --verbose`, die Nutzernachricht als JSON-Zeile auf stdin, Bilder (Alt-Text) als Content-Blöcke in base64.
- `--tools ""`, `--strict-mcp-config`, `--disable-slash-commands`, `--no-session-persistence`: keine Werkzeuge, keine MCP-Server, keine gespeicherte Sitzung.
- `--system-prompt-file` mit dem Systemprompt der Posts und dem Markenkontext statt des Coding-Prompts von Claude Code.
- `--json-schema` mit dem Ausgabe-Schema als JSON Schema Draft 7; zod prüft die Antwort ein zweites Mal. Den Draft 2020-12, den zod sonst schreibt, lehnt die CLI ab.
- `--model` aus `AI_MODEL`, `--effort` je Route.
- Nie `--bare`: Es schaltet die Anmeldung über das Abo ab.

Der Kindprozess startet ohne Shell in einem leeren temporären Verzeichnis und bekommt nur eine Allowlist der Umgebung (PATH, HOME, Proxy, CA, Konfiguration von Claude). `ANTHROPIC_API_KEY` und `ANTHROPIC_AUTH_TOKEN` erreichen ihn nie, weil die CLI damit auf API-Abrechnung wechseln würde; die Secrets der App ebenso nicht. Zeitlimit (`CLAUDE_CODE_TIMEOUT_MS`, Standard fünf Minuten), Abbruch und eine Grenze von 16 MB für die Ausgabe beenden den Prozess. Fehlende CLI, fehlende Anmeldung und erreichte Abo-Limits werden zu verständlichen Fehlern.

Der Bericht eines Aufrufs hat keine Versuche mit Tokens. Er kostet damit nichts in der Preisliste und belastet weder die KI-Quote noch den Nutzungszähler.

## Alternativen

- **Claude Agent SDK**: Verworfen. Es setzt für den Betrieb einen API-Schlüssel voraus; die Anmeldung über ein Abo ist dort nicht vorgesehen.
- **Den Abo-Token der CLI selbst an die API schicken**: Verworfen. Das wäre ein inoffizieller Weg an den Bedingungen des Abos vorbei.

## Folgen

- Generieren, Verfeinern, Ideen, Alt-Texte und Diagramme (ADR 0048) laufen mit dem Abo.
- Die API muss dort laufen, wo die CLI installiert und angemeldet ist, also auf dem Rechner des Nutzers (`pnpm local`), nicht im Container der Produktions-Vorlage.
- Die Antwort kommt am Stück: Beim Generieren gibt es kein Streaming der Teilausgabe, nur das fertige Ergebnis.
- Die Limits des Abos gelten. Ist eines erreicht, meldet der Provider einen Fehler, der sich später wiederholen lässt.
