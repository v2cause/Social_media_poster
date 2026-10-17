# ADR 0005: X-Anbindung als Hybrid und Leitplanken

- **Status**: Akzeptiert (Browser-Adapter umgesetzt in Phase 6: [ADR 0029](0029-x-browser-freischaltung-und-kill-switch.md) bis [ADR 0032](0032-canary-und-circuit-breaker.md))
- **Datum**: 2026-10-15
- **Bezug**: Umsetzungsleitfaden, Schritte 0.10 und 6.1 bis 6.6; `docs/ARCHITECTURE.md`, Abschnitte 2 und 4.3

## Kontext

Die offizielle X-API ist nur pro Nutzung buchbar und kostet je Post. Ein Browser-Adapter kann günstiger sein, verstößt aber gegen die Nutzungsbedingungen von X und kann zur Sperre führen.

## Entscheidung

- **Standard**: die offizielle Pay-per-Use-API.
- **Optional**: ein Browser-Adapter (Playwright). Er ist per Feature-Flag `FEATURE_X_BROWSER_GLOBAL` abgeschaltet und zusätzlich pro Workspace freizuschalten.
- **Isolation**: Der browser-worker läuft in eigenem Container, mit Chromium, ohne Datenbank- und ohne S3-Zugang. Er hört nur auf `xb-commands`. Der Nachweis steht in Schritt 0.10: Der Container meldet `browser-worker.ready`, läuft als `pwuser` und hat keine Datenbank-Variablen.
- **Keine Passwörter speichern**: Der Login läuft interaktiv. Gespeichert wird nur der Session-Zustand, verschlüsselt.
- **Keine Umgehung**: Captcha, verdächtiger Login oder Sperrseite brechen den Job ab. Es gibt keine Captcha-Löser, kein Stealth und keine automatischen Wiederholungen.
- **Robust**: Selektoren aus versionierten Maps, Post-IDs aus JSON-Antworten statt aus HTML. Ein Canary und ein Circuit Breaker pausieren die Browser-Jobs bei wiederholten Fehlern.
- **Risikobestätigung**: Der Owner oder Admin bestätigt das Risiko versioniert, die Bestätigung landet im Audit-Log.

## Alternativen

- **Nur Browser-Automation**: verworfen, weil das ToS-Risiko dann den Kern des Produkts träfe.
- **Nur die offizielle API**: bleibt die Grundlage. Ein Browser-Adapter wird nur bei passender Kostenlage freigeschaltet.

## Konsequenzen

- Der Adapter ist vom Hauptsystem abtrennbar: Der Container lässt sich einfach nicht deployen.
- Die Kosten pro X-Operation werden in `ApiCostRecord` erfasst, damit ein Ausgabenlimit greifen kann.
