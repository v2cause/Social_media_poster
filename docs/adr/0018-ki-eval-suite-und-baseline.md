# ADR 0018: KI-Eval-Suite und Baseline

- **Status**: Akzeptiert; die gemessene Baseline mit der Claude API steht noch aus (siehe "Baseline")
- **Datum**: 2026-10-16
- **Bezug**: Umsetzungsleitfaden, Schritt 2.10; `docs/ARCHITECTURE.md`, Abschnitt 5; ADR 0007, 0015, 0016

## Kontext

Prompts, Modell und Effort ändern sich. Ob eine Änderung die Texte besser oder schlechter macht, soll messbar sein: gültige Ausgaben, eingehaltene Längen, keine verbotenen Wörter, die richtige Sprache, wenige Ablehnungen und bekannte Kosten. Ein Lauf kostet echtes Geld und darf deshalb weder unbegrenzt noch bei jedem Push laufen.

## Entscheidung

- **Golden Briefs** in `packages/ai/eval/golden-briefs.json`: je eine Marke mit Brand Voice (inklusive verbotener Wörter) für Deutsch und Englisch, sechs Stile pro Sprache, jeder Fall als eine Generierung für LinkedIn, Instagram, Facebook und X, also 12 Generierungen mit 48 Varianten. So entsteht jede Generierung wie im Composer, mit allen Zielen in einem Aufruf.
- **Prüfungen pro Variante** mit denselben Funktionen wie der Server (`@smp/platform-rules`): gültig nach dem Ausgabeschema und für das richtige Ziel, Länge innerhalb des Limits, keine weiteren Text-Probleme der Plattform (zum Beispiel zu viele Hashtags), keine verbotenen Wörter der Brand Voice, richtige Sprache. Die Sprache erkennt eine kleine Prüfung über häufige Funktionswörter. Medienregeln entfallen, weil die Suite keine Medien anhängt.
- **Pro Generierung**: Ergebnis (`completed` oder der Fehlercode, etwa `REFUSED`), Kosten aus dem PriceBook der Datenbank, Latenz, Time-to-first-token, Tokens inklusive Cache und die Zahl der Versuche (mehr als einer heißt: der Server-Fallback hat geantwortet).
- **Budget**: `pnpm eval:ai` startet nur mit `EVAL_BUDGET_MICROS`. Vor jedem Aufruf wird die obere Schätzung (`PromptTokenEstimator`, Preise aus dem PriceBook) gegen den Rest des Budgets geprüft; reicht er nicht, werden die übrigen Fälle übersprungen und im Bericht so markiert. `--dry-run` schätzt nur und ruft die KI nicht auf, `--only <text>` wählt Fälle aus.
- **Bericht**: JSON und Markdown in `packages/ai/eval/reports/`, verglichen mit dem letzten echten Lauf desselben Providers, Modells und derselben Fälle (besser, schlechter, gleich je Kennzahl). Läufe gegen den Mock prüfen nur die Pipeline und werden nicht eingecheckt; Läufe gegen die Claude API werden als Baseline eingecheckt.
- **Wann**: nie in jedem CI-Lauf. Der Workflow `.github/workflows/eval.yml` läuft von Hand (Budget und Fallauswahl als Eingaben) oder nachts, sobald die Repository-Variable `EVAL_NIGHTLY` auf `true` steht. Er braucht das Secret `ANTHROPIC_API_KEY` und schreibt den Bericht in die Job-Zusammenfassung.
- **Gebaut** wird die CLI von tsup als zweiter Einstiegspunkt des Pakets (`dist/eval/run-eval.js`), damit die Prompt-Dateien genauso gebündelt sind wie im Paket selbst. `@smp/db` bleibt extern und ist nur eine Entwicklungsabhängigkeit; das Paket selbst importiert die Datenbank nie.

## Baseline

- **Pipeline (Mock)**: Alle 12 Generierungen abgeschlossen, alle 48 Varianten gültig, im Limit, ohne Text-Probleme, ohne verbotene Wörter und in der richtigen Sprache; keine Ablehnungen. Die Kosten des Mocks beruhen auf geschätzten Tokens und sagen nichts über echte Kosten.
- **Obere Schätzung (Trockenlauf)** mit den Preisen von `claude-opus-5-5` im PriceBook (4 USD pro Million Input-Tokens, 20 USD pro Million Output-Tokens): 0,17 USD pro Generierung mit vier Zielen, 2,04 USD für die ganze Suite. Die Schätzung rechnet das Output-Budget voll (2.000 plus 1.500 Tokens pro Ziel) und jeden Input ungecacht; die echten Kosten liegen darunter.
- **Gemessen (Claude API)**: steht aus, weil in der Entwicklungsumgebung kein API-Key vorliegt. Sobald einer da ist:

  ```bash
  AI_PROVIDER=anthropic ANTHROPIC_API_KEY=... EVAL_BUDGET_MICROS=3000000 pnpm eval:ai
  ```

  Den Bericht aus `packages/ai/eval/reports/` einchecken und hier die Kennzahlen eintragen: Kosten pro Generierung, Latenz (p50, p95), Anteil im Limit, Ablehnungsquote. Danach die Output-Budgets in `packages/ai/src/estimate.ts` an die gemessenen Tokens anpassen.

## Alternativen

- **Eval in jedem CI-Lauf**: verlässlicher Alarm, aber Kosten bei jedem Push und Abhängigkeit vom API-Status für jeden Merge.
- **Preise als feste Zahlen in der Suite**: einfacher ohne Datenbank, widerspricht aber der Regel, dass Preise nur im PriceBook stehen; Suite und Abrechnung würden auseinanderlaufen.
- **LLM als Bewerter** (Stil, Tonalität): misst mehr, kostet aber zusätzlich und ist schwer reproduzierbar. Kann später als eigener, optionaler Teil dazukommen.

## Konsequenzen

- Jede Änderung an Prompts, Modell oder Effort sollte mit einem Eval-Lauf belegt werden; der Bericht zeigt die Veränderung zur letzten Baseline.
- Neue Plattformen oder Stile brauchen neue Fälle in den Golden Briefs; deren `version` steigt dann, und der Vergleich beginnt neu.
