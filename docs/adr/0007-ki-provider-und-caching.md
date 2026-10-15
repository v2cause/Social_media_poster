# ADR 0007: KI-Provider und Prompt-Caching

- **Status**: Akzeptiert. Spike (a) ist ausstehend.
- **Datum**: 2026-10-15
- **Bezug**: Umsetzungsleitfaden, Schritte 2.3 bis 2.6 und Spike 0.14(a); `docs/ARCHITECTURE.md`, Abschnitt 5

## Kontext

Die KI erzeugt Varianten, Ideen und Alt-Texte. Kosten, Ausgabeformat und Abbrüche müssen beherrschbar bleiben. Ein Prompt-Cache spart Kosten, nur wenn der Präfix byte-genau gleich bleibt.

## Entscheidung

- **Port** `AiProvider` mit `generateVariants`, `refineVariant`, `suggestTopics` und `suggestAltText`. Implementierungen: `AnthropicAiProvider` (über `@anthropic-ai/sdk`) und `MockAiProvider`. Auswahl über `AI_PROVIDER`. Der Mock ist in Produktion nicht aktivierbar.
- **Modell** `claude-opus-5-5` über `AI_MODEL`.
- **Effort pro Route**: Generieren `medium`, Refine `low`, Ideen `medium`, Alt-Text `low`. Die Werte stehen in `.env.example` und entsprechen Architektur 5.1. In diesem Schritt korrigiert, zuvor stand dort `high`/`medium`.
- **Prompt-Cache**: zwei Breakpoints, einer für das globale Regelwerk, einer für Workspace und Marke. Aufgabe und Briefing werden nicht gecacht. Keine `temperature`, kein Prefill.
- **Ausgabe**: strukturierte Ausgabe mit zod. `stop_reason` wird vor dem Lesen geprüft.

## Spike (a): nicht ausgeführt

Der Spike misst Time-to-first-token, `cache_read_input_tokens` beim zweiten Aufruf, Refusal-Verhalten und Kosten. Er braucht einen `ANTHROPIC_API_KEY`, der in dieser Umgebung nicht vorliegt. Der Spike wird nachgeholt, sobald der Schlüssel da ist. Bis dahin gilt dieses ADR mit den Werten aus der Architektur.

**Ausweichlösung**: Funktioniert `zodOutputFormat` auf dem Beta-Pfad nicht, wird das JSON-Schema aus `z.toJSONSchema()` direkt an `output_config.format` übergeben.

## Konsequenzen

- Jede Generierung wird mit Prompt-Version, angefragtem und geliefertem Modell, Tokens inkl. Cache und Kosten gespeichert.
- Preise stehen nur im `PriceBook`, nie im Code.
