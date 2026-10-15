# ADR 0002: Modulformat und Pakettypen

- **Status**: Akzeptiert
- **Datum**: 2026-10-15
- **Bezug**: Umsetzungsleitfaden, Schritt 0.2 (Konfiguration in `packages/config`)

## Kontext

Das Monorepo enthält Code für zwei Laufzeiten mit unterschiedlichen Anforderungen. Die NestJS-Apps (API, Worker) brauchen CommonJS-Ausgabe und Decorator-Metadaten. Die Web-App (Next.js) bündelt selbst und braucht Pakete, die im Browser laufen. Ohne feste Regel würden Build-Format, `exports` und Typauflösung pro Paket auseinanderlaufen.

## Entscheidung

Jedes Paket gehört zu genau einem von vier Typen:

| Typ | Pakete | Build |
|---|---|---|
| Nur Backend | core, db, queue, crypto, ai, media, platform-adapters, x-browser, observability, emails, testing | `tsup`, Format CJS, `.d.ts` |
| Geteilt (Backend + Web) | contracts, platform-rules | `tsup`, Format ESM + CJS, `exports` mit `import`/`require`/`types` |
| Nur Web | ui, api-client | kein Build; `exports` zeigen auf `src/index.ts`, Next.js transpiliert sie (`transpilePackages`) |
| Konfiguration | config | kein Build; Presets werden direkt von Werkzeugen geladen |

Weitere Regeln:

- Die Apps haben kein `"type": "module"` und geben CommonJS aus. Dafür gilt `tsconfig.nest.json` mit `module` und `moduleResolution` auf `NodeNext`.
- `verbatimModuleSyntax` ist nicht aktiviert. Typ-Imports erzwingt die ESLint-Regel `consistent-type-imports`.
- Die Images für API und Worker entstehen mit `pnpm deploy --legacy --prod`. pnpm 10 verlangt sonst `inject-workspace-packages=true`; das bindet Workspace-Pakete als Kopien statt als Symlinks ein und würde die lokale Entwicklung verändern.
- Die gemeinsamen Presets liegen in `@smp/config`: `tsconfig.base.json`, `tsconfig.lib.json`, `tsconfig.nest.json`, `tsconfig.next.json`, `eslint` (Factory), `prettier`, `vitest` und `vitest-nest`.

## Alternativen

- **Alles ESM.** Die Decorator-Metadaten von NestJS und einige CJS-only-Abhängigkeiten würden die Backend-Pakete unnötig erschweren.
- **Alles CJS.** Geteilte Pakete laufen auch im Browser. ESM erlaubt Tree-Shaking, und der Next.js-Build verarbeitet ESM ohne Umweg.
- **Nur `tsc` ohne Bundler.** `tsc` erzeugt keine Bundles für beide Formate. `tsup` liefert ESM, CJS und `.d.ts` aus einer Konfiguration.

## Konsequenzen

- `packages/core` darf keine Decorators und keine Framework-Imports enthalten. Das folgt aus der Schichtung in `docs/ARCHITECTURE.md`, Abschnitt 2.1.
- Die Typprüfung läuft mit `NodeNext` (Backend und geteilte Pakete) bzw. `Bundler` (Web). Relative Imports in ESM-Ausgabe brauchen Dateiendungen.
- Die ESLint-Factory löst `.js`-Specifier auf `.ts`-Dateien auf. Dadurch erkennt `import-x/no-cycle` Zyklen unabhängig von der Schreibweise.
- Deep-Imports (`@smp/<name>/src/...`) sperrt `no-restricted-imports`. Konfigurationsdateien sind davon ausgenommen.
- `packages/config` hat keinen Build. `vitest.base.ts` wird direkt aus dem Quelltext geladen.
