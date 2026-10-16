# ADR 0014: Datenmodell für Content und KI

- **Status**: Akzeptiert
- **Datum**: 2026-10-16
- **Bezug**: Umsetzungsleitfaden, Schritt 2.1; `docs/ARCHITECTURE.md`, Abschnitte 5 und 6

## Kontext

Schritt 2.1 legt die Tabellen für Stile, Brand Voices, Ideen, Posts, Varianten, KI-Aufrufe, Quoten und Preise an. Einige Punkte lässt die Architektur offen: wie Stil-Presets und Preise in jede Umgebung kommen, wie globale und mandanteneigene Zeilen in einer Tabelle zusammenleben und welche Tabellen unveränderlich sind.

## Entscheidung

- **Referenzdaten als Migration**: Die sechs Stil-Presets und das PriceBook kommen mit der Migration `0006_reference_data`, nicht mit dem Demo-Seed. Der Demo-Seed läuft nie in Produktion, die Referenzdaten braucht aber jede Umgebung. Eine Änderung an einem Preset oder Preis ist eine neue Migration. Weil `FORCE ROW LEVEL SECURITY` auch den Owner bindet und die Policies keine Zeilen ohne Workspace zulassen, hebt die Migration `FORCE` für das Einfügen auf und setzt es gleich danach wieder.
- **Presets und eigene Stile in einer Tabelle**: Presets haben keinen Workspace und sind für alle Mandanten lesbar; eigene Stile gehören einem Workspace. Schreiben kann `app_user` nur Zeilen des eigenen Workspace, ein Preset also nie. Der Prompt nennt einen Stil über seinen `key` (Presets fest, eigene Stile `custom-<slug>`), nie über die ID. Die Anweisungen eines Presets müssen dem Stil-Katalog des System-Prompts entsprechen; ein Test vergleicht beides. In der UI erscheinen Presets unter übersetzten Namen (i18n-Key pro `key`).
- **Tenant-Filter-Prüfung**: `TENANT_FILTERS` erlaubt für `PostStyle` beim Lesen auch die globalen Zeilen (`workspaceId: null`, auch in einem `OR` mit dem eigenen Workspace). Schreibende Operationen müssen weiterhin den Workspace des Kontexts nennen.
- **Brand-Voice-Versionen** sind unveränderliche Snapshots. Der Inhalt liegt als JSON vor, das ein zod-Schema in `@smp/contracts` prüft, dazu ein SHA-256-Hash des kanonischen JSON. `app_user` darf Versionen anlegen und lesen, nicht ändern oder löschen.
- **Append-only**: `ai_generation` wird einmal am Ende eines Aufrufs geschrieben, `usage_record` ist das Ledger (eindeutig pro Quelle und Meter). Für beide hat `app_user` kein UPDATE und kein DELETE, für `usage_counter` kein DELETE. Das PriceBook ist zur Laufzeit nur lesbar, auch für `app_system`.
- **`PostVariant` vollständig**: alle Felder aus Architektur 6.2 einschließlich Scheduling, Lease, Publishing und Metrik-Planung, damit Phase 4 und 5 diese Tabelle nicht migrieren müssen. `social_account_id` bekommt den Fremdschlüssel erst mit der Tabelle `social_account` in Phase 4.
- **Partial Indexes im Schema**: Die Indizes für den Scheduler (`status = 'SCHEDULED'`) und die Metrik-Planung (`status = 'PUBLISHED'`) sowie der eindeutige Preset-Key stehen über das Preview-Feature `partialIndexes` von Prisma im Schema. Als reines SQL würde sie die nächste Migration als Abweichung wieder löschen. Der Trigram-Index für Ideentitel nutzt `ops: raw("gin_trgm_ops")`.
- **Ersteller ohne Fremdschlüssel**: `created_by_id` und `user_id` der neuen Tabellen verweisen wie `audit_log.actor_user_id` ohne Fremdschlüssel auf Nutzer. Das Löschen eines Nutzers soll Inhalte des Workspace weder löschen noch blockieren.

## Alternativen

- **Referenzdaten im Seed**: fehlten in Produktion oder bräuchten einen zusätzlichen Deploy-Schritt.
- **Presets im Code statt in der Datenbank**: Posts verweisen per Fremdschlüssel auf ihren Stil; Presets und eigene Stile sollen gleich behandelt werden.
- **Brand-Voice-Felder als Spalten**: mehr Migrationen bei jeder Erweiterung, ohne Gewinn, weil Snapshots nur als Ganzes gelesen werden.
- **`AiGeneration` mit Status PENDING**: bräuchte UPDATE-Rechte. Stürzt ein Prozess mitten im Aufruf ab, fehlt der Datensatz; die Quote bleibt dann reserviert, bis ein Abgleich mit dem Ledger sie korrigiert.

## Konsequenzen

- Neue Preise und Presets kommen über Migrationen, nie über Code.
- Phase 4 ergänzt nur den Fremdschlüssel von `social_account_id`.
- `partialIndexes` ist ein Preview-Feature; bei einem Prisma-Update ist zu prüfen, ob es noch nötig ist oder stabil wurde.
