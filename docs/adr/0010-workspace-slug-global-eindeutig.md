# ADR 0010: Workspace-Slug global eindeutig

- **Status**: Akzeptiert
- **Datum**: 2026-10-16
- **Bezug**: Umsetzungsleitfaden, Schritte 1.1, 1.5 und 1.6; `docs/ARCHITECTURE.md`, Abschnitte 6.2 und 11

## Kontext

Der Leitfaden sah `Workspace(organizationId, slug)` als Unique-Constraint vor. Die Routen adressieren einen Workspace aber allein über den Slug: `/api/w/:ws/...` in der API und `(app)/w/[ws]/...` im Web. Ein Nutzer kann Mitglied mehrerer Organisationen sein. Ist der Slug nur pro Organisation eindeutig, kann `/w/marketing` auf zwei Workspaces zeigen, und die Route ist mehrdeutig.

## Entscheidung

- `Workspace.slug` ist über alle Organisationen hinweg eindeutig (`@unique`).
- Slugs werden beim Anlegen aus dem Namen erzeugt (Kleinbuchstaben, Ziffern, Bindestrich). Ist der Slug vergeben, hängt `CreateWorkspace` ein kurzes zufälliges Suffix an, statt einen Fehler zu melden.
- Ein Slug, zu dem der Nutzer keine Mitgliedschaft hat, liefert 404, genau wie ein Slug, den es nicht gibt (Schritt 1.6).

## Alternativen

- **Organisation in der Route** (`/o/:org/w/:ws/...`): eindeutig auch mit Slug pro Organisation, aber längere URLs und zwei Parameter in jeder Route und jedem Query-Key.
- **Workspace-ID in der Route**: eindeutig ohne Slug, aber unlesbare URLs.
- **Slug pro Organisation und Auflösung über die aktive Organisation des Nutzers**: Links wären nicht teilbar, weil sie vom Zustand des Betrachters abhängen.

## Konsequenzen

- Kurze, teilbare URLs mit einem Parameter.
- Dass ein Slug in einer anderen Organisation existiert, ist für den Nutzer nicht sichtbar: Kollisionen löst das Suffix, und fremde Slugs liefern 404.
- Die Auflösung des Slugs braucht eine nutzerbezogene Lese-Policy auf `workspace` (Workspaces der eigenen Mitgliedschaften), weil zu diesem Zeitpunkt noch kein Organisations-Kontext gesetzt ist (Schritt 1.2).
