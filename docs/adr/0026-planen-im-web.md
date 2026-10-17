# ADR 0026: Planen im Web mit einer Variantenliste, eigenem Kalender und Abgleich mit dem Server

- **Status**: Akzeptiert
- **Datum**: 2026-10-17
- **Bezug**: Umsetzungsleitfaden, Schritt 4.11; `docs/ARCHITECTURE.md`, Abschnitte 7.3 und 11; [ADR 0017](0017-composer-zustand-und-auto-speichern.md), [ADR 0022](0022-medien-im-web.md), [ADR 0023](0023-planen-zeitzonen-und-zustandsautomat.md), [ADR 0025](0025-benachrichtigungen-und-token-monitor.md)

## Kontext

Schritt 4.11 bringt Planen und Veröffentlichen in die Oberfläche: die Accounts mit der Auswahl nach dem OAuth, den Kalender, die Post-Tabelle, die Planen-Leiste im Composer und das Dashboard-Widget. Offen waren:

1. Woher Kalender, Tabelle und Dashboard ihre Daten bekommen.
2. Wie Planen und Live-Status mit dem Auto-Speichern des Composers aus ADR 0017 zusammenpassen.
3. Wie der Kalender in einer anderen Zeitzone zeigt und verschiebt als der, in der eine Variante geplant ist.
4. Welche Bibliotheken der Kalender und der Zustand in der URL brauchen. Abschnitt 11 nennt FullCalendar, nuqs und date-fns.
5. Wie Plattformen und Accounts aussehen, wenn die Logos Marken sind und die CSP keine fremden Bilder erlaubt.

## Entscheidung

### Eine Liste der Varianten für alle Ansichten

- **Ein Endpunkt**: `GET /api/w/:ws/variants` (`post.read`) liefert die Varianten eines Workspace mit dem Anfang des Textes (140 Zeichen), dem Account und dem Plan.
  - Filter: Status (kommagetrennt, ohne Angabe alle außer `DELETED`), Plattform, Account und der geplante Zeitraum (`from` inklusive, `to` exklusive).
  - Sortierung: `recent` (zuletzt geändert, für die Tabelle) oder `schedule` (nach Plan, für Kalender und Dashboard).
  - Cursor über die Position in der Sortierung; bis 500 Einträge pro Seite.
- **Index**: Migration 0012 ersetzt den Index auf `post_variant(workspace_id)` durch einen auf `(workspace_id, scheduled_at)`.
- **Tabelle**: eine Zeile pro Variante. "Löschen" löscht ganze Beiträge, weil die API Beiträge löscht; der Dialog sagt das.
- **Kosten**: `GET /api/w/:ws/accounts` liefert die bisherigen Kosten eines X-Accounts (`costMicros`, Summe aus `ApiCostRecord`), bei den anderen Plattformen null.
- **Live**: Ein Live-Event `variant.status` macht alle Abfragen dieser Liste veraltet, über das Präfix ihres Query-Keys.

### Composer: Planen nach dem Speichern, Status vom Server

- **Stand pro Variante**: Jede Variante im Zustand des Composers trägt ihren Veröffentlichungsstand (Status, Account, Plan, Veröffentlichung, Fehlercode).
- **Eine Warteschlange**: Planen, Jetzt posten, Abbrechen und die Entscheidungen zu einem unklaren Ausgang laufen in der Warteschlange des Auto-Speicherns, nach den offenen Speicherungen. So konkurriert eine Planung nie mit einem Speichern um die `version` derselben Variante.
- **Welche Anfrage**:
  - Planen: Entwurf und Abgebrochen über `schedule`, Geplant und Warteschlange über `reschedule`, Fehlgeschlagen über `retry` mit Zeit (behält den Account).
  - Jetzt posten: `publish-now`, Fehlgeschlagen über `retry` ohne Zeit.
- **Abgleich**: Ein Live-Event lädt den Beitrag neu.
  - Status und Plan folgen immer dem Server, außer die Antwort ist älter (kleinere `version`).
  - Die `version` übernimmt der Composer nur, wenn die Variante keine ungespeicherte Änderung und denselben Inhalt hat. Sonst meldet das nächste Speichern den Konflikt aus ADR 0017.
- **Sperre**: Eine Variante, die gerade veröffentlicht wird oder veröffentlicht ist, lässt sich im Editor nicht ändern, wie die API (`VARIANT_LOCKED`).
- **Hinweise**: Vor dem Planen nennt die Leiste Accounts, die neu verbunden werden müssen oder deren Zugang vor dem Termin endet; danach zeigt sie die Warnungen der API. Bei X nennt sie die bisherigen Kosten des Accounts. Eine Kostenvorschau pro Post kommt mit dem X-Adapter (Schritt 4.14).

### Kalender

- **Eigener Kalender statt FullCalendar**: ein CSS-Grid mit `dnd-kit`, das schon der Medienstreifen nutzt. Monat, Woche und Liste sind wenig Code, und Darstellung, Übersetzungen und Status-Badges bleiben die der App. FullCalendar hätte eigenes CSS, eine eigene Lokalisierung und für IANA-Zonen ein Plugin gebracht.
- **Verschieben**: Ziehen auf einen anderen Tag behält die Uhrzeit. Eine neue Uhrzeit setzt der Dialog "Umplanen", den auch Tastaturnutzer bekommen.
  - Optimistisch im Query-Cache, bei einem Fehler zurück.
  - Vergangene Tage nehmen nichts an; ein Zeitpunkt in der Vergangenheit wird vor der Anfrage abgelehnt.
- **Zeitzone**: Der Kalender zeigt die Zone des Workspace oder die des Browsers. Ein verschobener Termin geht in der Zone an die API, in der die Variante geplant ist. Die Ansicht ändert also nie die Zone einer Variante.
- **Zeitrechnung mit `Intl`** statt date-fns (`apps/web/src/features/publishing/zoned-time.ts`). Lokale Zeiten in einer Lücke oder einer doppelten Stunde werden aufgelöst wie in ADR 0023.

### Zustand in der URL

- Kalender (Ansicht, Tag, Zeitzone) und Tabelle (Filter) halten ihren Zustand im Query-String. Ein Link, ein Neuladen oder die Rückkehr zur Seite zeigt dieselbe Ansicht.
- Ein kleiner Hook (`useSearchState`) liest den Query-String über ein zod-Schema mit Standardwerten, weil er Eingabe des Clients ist. Änderungen ersetzen den Eintrag der History. nuqs entfällt.

### Darstellung

- **Plattformen** als Kürzel auf ihrer Farbe (in, IG, f, X). Die Logos sind Marken, und lucide enthält sie nicht mehr.
- **Avatare** als Initialen. Die CSP erlaubt Bilder nur aus der App und dem Objektspeicher (ADR 0022); Bilder der Plattformen bräuchten einen Proxy.
- **X-Methode**: Die Karte zeigt die Methode neuer Verbindungen (API, in der Entwicklung Mock). "Browser (experimentell)" ist sichtbar, aber gesperrt, bis Phase 6 sie bringt.

## Alternativen

- **Je ein Endpunkt für Kalender, Tabelle und Dashboard**: drei Lesemodelle für dieselbe Liste.
- **FullCalendar**: siehe oben. Seine Ansichten Monat, Woche und Liste sind frei, aber Darstellung und Ziehen hätten neben dem Rest der App eine zweite Welt gebildet.
- **Planen neben dem Auto-Speichern**: Eine Planung und ein Speichern derselben Variante hätten mit derselben `version` konkurriert, eines von beiden hätte 409 bekommen.
- **Den Status aus dem Live-Event direkt in den Zustand übernehmen**: Das Event trägt nur den Status, nicht Plan, Link und Fehlercode. Ein Neuladen des Beitrags ist einfacher und vollständig.
- **nuqs**: eine weitere Abhängigkeit für zwei Seiten; der Hook hat 30 Zeilen.

## Konsequenzen

- `docs/ARCHITECTURE.md`, Abschnitt 11, nennt den eigenen Kalender, den Hook für die URL und `Intl` statt FullCalendar, nuqs und date-fns; Abschnitt 7.3 sagt, in welcher Zone ein Verschieben gesendet wird.
- Offen: Bilder der Accounts über einen Proxy, die Kostenvorschau bei X mit Schritt 4.14, Verschieben auf eine Uhrzeit per Ziehen in der Wochenansicht (bisher nur über den Dialog).
- Tests: `packages/db/test/variant-list-read-model.integration.test.ts`, `apps/api/test/publishing.integration.test.ts` (Liste), Unit-Tests der Modelle in `apps/web/src/features/*` und der E2E-Test `apps/web/e2e/planning.spec.ts`.
