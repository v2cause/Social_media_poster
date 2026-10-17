# ADR 0028: Analytics im Web mit eigenen SVG-Diagrammen und Demo-Daten über 90 Tage

- **Status**: Akzeptiert
- **Datum**: 2026-10-17
- **Bezug**: Umsetzungsleitfaden, Schritt 5.5; `docs/ARCHITECTURE.md`, Abschnitte 8, 11 und 16; [ADR 0026](0026-planen-im-web.md), [ADR 0027](0027-analytics-kaskade-rollup-und-api.md)

## Kontext

Schritt 5.5 bringt die Analytics in die Oberfläche: Filterleiste, sechs KPI-Kacheln mit Sparkline und Vergleich, ein Liniendiagramm pro Plattform, ein Balkendiagramm für den Plattformvergleich, Top-Posts, eine Auswertung nach Post-Stil, die Detailseiten für Post und Account und den leeren Zustand. Die Diagramme müssen barrierefrei sein (Tabellenalternative, keine Information nur über Farbe), "n. v." und 0 sichtbar unterscheiden und mit Seed-Daten über 90 Tage korrekt rendern.

Abschnitt 11 der Architektur nennt für Analytics TanStack Table und Recharts. Der Leitfaden empfiehlt das Skill `dataviz` für Farben und Diagrammregeln; in dieser Umgebung gibt es kein solches Skill.

## Entscheidung

### Eigene SVG-Diagramme statt Recharts

- **Was es gibt**: drei Diagrammarten.
  - Ein Liniendiagramm: Achsen mit runden Schritten, Lücken statt Nullen, Legende, Tooltip, Pfeiltasten und Tabelle.
  - Eine Balkenliste: Name, Balken und Wert als Text.
  - Sparklines.
- **Geometrie**: liegt in reinen, getesteten Funktionen (`chart-geometry.ts`); die Komponenten zeichnen nur.
- **Begründung**:
  - Barrierefreiheit: Strichmuster und Marker pro Serie, eine Tabelle derselben Zahlen, Pfeiltasten, die den gewählten Wert ansagen, und Balken, die ihren Wert als Text tragen. In einer Bibliothek müsste das meiste davon ohnehin eigens gebaut werden.
  - Wenig Abhängigkeiten: Recharts bringt D3-Module mit. Drei einfache Diagramme lohnen das nicht, gemessen an der Lieferketten-Härtung ([ADR 0009](0009-sicherheits-baseline.md)).
  - Wie der Kalender ([ADR 0026](0026-planen-im-web.md)) bleibt die Oberfläche bei den Bausteinen von `@smp/ui`.
- **Tabellen**: Statt TanStack Table genügen die Tabellen von `@smp/ui`. Sortieren und Filtern der Top-Posts übernimmt die API.

### Farben und Darstellung

- **Farben**: Die vier Serienfarben sind Theme-Tokens (`--chart-1` bis `--chart-4`, hell und dunkel). Jede hat mindestens 4,5:1 Kontrast zur Karte.
- **Feste Zuordnung**: Eine Plattform behält in jeder Ansicht Farbe, Strichmuster und Marker. Reihenfolge wie in der Filterleiste: LinkedIn, Instagram, Facebook, X.
- **Zahlen**: Fehlende Werte erscheinen als "n. v." mit einer Erklärung. Raten stehen in Prozent, ihre Veränderung in Prozentpunkten. Die Veränderung zeigt Pfeil, Vorzeichen und Farbe.
- **Leerer Zustand**: "Noch keine Daten. Erste Metriken etwa 1 Stunde nach der Veröffentlichung.", wenn kein Tag des Zeitraums einen Wert hat.
- **Breite**: Diagramme messen ihre Breite (`ResizeObserver`), statt über eine viewBox zu skalieren; Text bleibt so lesbar. Der Hauptbereich der App-Shell wächst nicht mehr mit breitem Inhalt (`min-w-0`), damit bei 390 px nichts seitlich überläuft.

### Seiten und Zustand

- **Routen**:
  - `/w/:ws/analytics`.
  - `/w/:ws/analytics/posts/:variantId`: Verlauf der Abfragen nach der Zeit seit der Veröffentlichung.
  - `/w/:ws/analytics/accounts/:accountId`: Follower und Tageswerte.
- **Zustand in der URL**: Zeitraum (7, 30, 90 Tage oder frei), Plattformen, Accounts, Kennzahl, Einteilung, Vergleich, Sortierung und Auswertung stehen im Query-String. Standardwerte erscheinen nicht.
- **Zeitraum**: Die Voreinstellungen zählen vom heutigen Tag der Workspace-Zone zurück; ein freier Zeitraum wird vor der Anfrage geprüft.
- **Export**: Der Link auf `export.csv` trägt dieselben Filter.
- **Dashboard**: vier KPIs der letzten 30 Tage und die drei besten Posts.
- **Verlinkung**: Account-Karten und Top-Posts führen zu den Detailseiten.

### Demo-Daten

- **Was `pnpm db:seed` anlegt**:
  - Im Demo-Workspace vier Mock-Accounts ohne Token.
  - Veröffentlichte Posts über die 90 Tage bis heute mit den Snapshots ihrer Kaskade, die Tageszahlen der Accounts und den Rollup.
  - Dazu geplante Posts, Entwürfe, einen fehlgeschlagenen und einen zu prüfenden Post.
- **Herkunft der Zahlen**: eine feste Pseudozufallsfolge. Die Plattformen melden dieselben Werte wie die Mock-Plattformen; X hat keine Reichweite, Instagram keine Klicks.
- **Zweiter Lauf**: rechnet nur den Rollup neu.
- **Abfragen**: Die veröffentlichten Posts werden nicht abgefragt, weil die Mock-Plattformen sie nicht kennen. Die Tageszahlen der Accounts setzen die Mock-Plattformen des Workers ab der nächsten Nacht mit eigenen Werten fort.
- **Abweichung von Abschnitt 16**: Eine Brand Voice legt der Seed nicht an. Ein Default im Demo-Workspace würde Tests der Content-API verändern, die mit `seedDemoData` arbeiten und die erste Stimme als Default erwarten; sie ist in der Oberfläche in einer Minute angelegt.
- **E2E**: Der E2E-Job der CI lädt den Seed. `apps/web/e2e/analytics.spec.ts` meldet sich als Betrachter an und liest nur.

## Konsequenzen

- Die Diagramme brauchen keine weitere Abhängigkeit, und ihre Geometrie ist ohne Browser getestet.
- Die Hover-Hilfe des Liniendiagramms zeigt alle Serien eines Tages. Für Screenreader und Tastatur gibt es die angesagte Auswahl und die Tabelle.
- Eine Heatmap der besten Posting-Zeiten (Abschnitt 8, "später") ist nicht Teil dieses Schritts.
- **Offen**: Der Abgleich der Zahlen mit den Plattform-UIs auf Staging (Kriterium "Fertig, wenn" von Schritt 5.5) braucht echte Accounts und Staging.
