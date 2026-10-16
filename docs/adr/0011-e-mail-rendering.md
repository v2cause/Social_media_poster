# ADR 0011: E-Mail-Rendering ohne react-email-Komponentenpaket

- **Status**: Akzeptiert
- **Datum**: 2026-10-16
- **Bezug**: Umsetzungsleitfaden, Schritte 1.4 und 1.8; `docs/ARCHITECTURE.md`, Abschnitt 3 (`packages/emails`)

## Kontext

Der Leitfaden sieht react-email-Templates in Deutsch und Englisch vor. Stand Oktober 2026 ist `@react-email/components` auf npm als nicht mehr unterstützt markiert. Das Nachfolgepaket `react-email` (Version 6) bringt die Komponenten zusammen mit der Vorschau-CLI und deren Abhängigkeiten (esbuild, socket.io, Tailwind, Babel). Für den Versand aus API und Worker wäre das ein großer Laufzeit-Abhängigkeitsbaum mit Install-Skripten.

## Entscheidung

- Templates sind React-Komponenten in `packages/emails`, gerendert mit `@react-email/render` (HTML und Textteil).
- Layout, Absatz, Button und Link-Fallback sind eigene, kleine Komponenten mit Inline-Styles und Tabellen-Layout, wie es Mail-Clients brauchen.
- Texte liegen typisiert pro Sprache in `messages.ts`; das Interface erzwingt jeden Key in beiden Sprachen.
- Jede Mail wird vor dem Rendern mit zod validiert (Template, Sprache, Name, Link nur `http` oder `https`).
- Keine Bilder, keine externen Ressourcen, keine Tracking-Pixel.
- Versand über den `MailPort` aus `@smp/core`; der SMTP-Adapter (nodemailer) liegt in `packages/emails`.

## Alternativen

- **`react-email` 6**: verworfen wegen des CLI-Abhängigkeitsbaums in Produktions-Images.
- **`@react-email/components`**: verworfen, weil nicht mehr unterstützt.
- **MJML**: eigene Template-Sprache und weiterer Compiler; die Templates bleiben in React, wie im Leitfaden vorgesehen.

## Konsequenzen

- Eine lokale Vorschau der Templates fehlt. Bei Bedarf kommt `react-email` nur als devDependency dazu.
- Die Verifizierungs- und Reset-Mail entstehen schon mit Schritt 1.4, weil Better Auth sie dort braucht. Schritt 1.8 ergänzt die Einladung und stellt den Versand auf die Queue um.
