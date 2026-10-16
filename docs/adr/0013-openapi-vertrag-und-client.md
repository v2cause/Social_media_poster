# ADR 0013: OpenAPI-Vertrag aus zod und generierter Client

- **Status**: Akzeptiert
- **Datum**: 2026-10-16
- **Bezug**: Umsetzungsleitfaden, Schritt 1.9 (und Spike 0.14c); `docs/ARCHITECTURE.md`, Abschnitte 1 und 13; ADR 0001

## Kontext

Die Architektur sieht vor: zod-Schemas in `packages/contracts`, nestjs-zod für Validierung und OpenAPI, Orval erzeugt daraus den typisierten Client mit TanStack-Query-Hooks, und die CI schlägt bei Abweichungen fehl. Mit den ersten echten Endpunkten (Schritte 1.4 bis 1.7) zeigten sich drei Lücken:

- nestjs-zod übergibt nullable Felder als Typ-Array an das Swagger-Modul von Nest. Das Modul liest sie als Array: aus `string | null` wurde `string[]`. Der Spike hatte keine nullable Felder.
- Orval 8 verarbeitet die Typ-Arrays von OpenAPI 3.1 nur lückenhaft und meldete Validierungsfehler.
- Die Architektur legt nicht fest, ob Dokument oder Client im Repository liegen und wie der Drift-Check läuft.

## Entscheidung

- **Routen aus Nest, Schemas aus zod**: Pfade, Parameter, Statuscodes und Tags kommen aus den Metadaten der Controller (`@ZodResponse`, `@ApiTags`, `@ApiParam`). Die Component-Schemas erzeugt `apps/api/src/openapi.ts` direkt aus den zod-Schemas mit `z.toJSONSchema(schema, { target: 'openapi-3.0' })`, getrennt nach Eingabe und Ausgabe (Suffix `_Output`). Alle DTOs stehen in der Liste `OPENAPI_DTOS`; ein Test schlägt fehl, wenn ein Schema des Dokuments dort fehlt.
- **OpenAPI 3.0**: nullable Felder als `nullable: true`. Damit erzeugt Orval korrekte Typen.
- **Lesbare Operation-IDs**: `<controller><Methode>`, zum Beispiel `organizationMembers`. Daraus werden Hooks wie `useOrganizationMembers`.
- **Dokument im Repository, Client generiert**: `packages/api-client/openapi.json` wird committet. Ein Integrationstest der API vergleicht es mit dem Dokument der laufenden App (Drift-Check in der CI). Nach einer Änderung an Routen oder DTOs: `UPDATE_OPENAPI=1 pnpm --filter @smp/api test:integration`. Prettier ignoriert die Datei, damit sie Byte für Byte vergleichbar bleibt.
- Orval erzeugt den Client im `build` von `packages/api-client` nach `src/generated` (nicht committet, Turbo-Output); Turbo führt diesen Build vor `lint`, `typecheck` und `test` des Pakets aus. Der Fetch-Mutator `apiFetch` sendet Cookies nur an die eigene Origin und wirft bei Fehlern `ApiError` mit Status, Fehlercode und `traceId` aus der Problem-Details-Antwort.

## Alternativen

- **Dokument von nestjs-zod unverändert**: falsche Typen für alle nullable Felder.
- **OpenAPI 3.1**: von Orval nicht vollständig unterstützt.
- **Generierten Client committen**: großes Diff-Rauschen bei jeder API-Änderung; der Drift-Check am Dokument reicht.
- **Dokument zur Build-Zeit aus der laufenden API holen**: Der Web-Build bräuchte dann eine laufende API mit Datenbank.

## Konsequenzen

- Neue DTO-Klassen müssen in `OPENAPI_DTOS` eingetragen werden; der Test erinnert daran.
- Für eine spätere Public API bleibt das Dokument die Grundlage. Ein Wechsel auf OpenAPI 3.1 ist möglich, sobald Orval Typ-Arrays vollständig unterstützt.
