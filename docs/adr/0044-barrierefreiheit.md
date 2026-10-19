# ADR 0044: Barrierefreiheit nach WCAG 2.2 AA

- **Status**: Akzeptiert
- **Datum**: 2026-10-19
- **Bezug**: Umsetzungsleitfaden, Schritt 8.8; `docs/ARCHITECTURE.md`, Abschnitte 11 und 13; [Prüfprotokoll](../barrierefreiheit/pruefung-2026-10.md); [ADR 0022](0022-medien-im-web.md), [ADR 0026](0026-planen-im-web.md), [ADR 0028](0028-analytics-im-web.md)

## Kontext

Schritt 8.8 verlangt axe-Checks in Playwright und eine manuelle Tastaturprüfung. Fertig ist er, wenn keine kritischen Verstöße bleiben. Das Ziel der Architektur ist WCAG 2.2 AA (Abschnitt 11).

Einzelne Teile der App sind schon dafür gebaut:
- Medien lassen sich ohne Ziehen ordnen (ADR 0022).
- Der Kalender hat den Dialog "Umplanen" für die Tastatur (ADR 0026).
- Die Diagramme haben Pfeiltasten und eine Tabelle derselben Zahlen (ADR 0028).

Eine Prüfung der ganzen App gab es noch nicht. Die E2E-Tests prüften nur Abläufe.

## Entscheidung

### axe in den E2E-Tests

- **Werkzeug**: `@axe-core/playwright` 4.13.0 mit axe-core 4.13.0, in `apps/web/e2e/axe.ts`. Geprüft wird mit den Regeln für WCAG 2.0, 2.1 und 2.2 in den Stufen A und AA.
- **Schwelle**: Ein Verstoß der Stufe `serious` oder `critical` lässt den Test scheitern.
  - Der Leitfaden verlangt nur, dass keine kritischen Verstöße bleiben. axe stuft aber zu geringe Kontraste und zu kleine Ziele als `serious` ein, und beide verletzen WCAG AA.
  - Jeder Verstoß hängt als JSON am Bericht, auch `moderate` und `minor`.
  - Die Prüfung ist weich (`expect.soft`): Ein Lauf meldet die Verstöße aller Seiten.
- **Umfang** in `apps/web/e2e/accessibility.spec.ts`, im hellen und im dunklen Farbschema:
  - die fünf Seiten vor der Anmeldung;
  - die Seiten eines Workspaces, seiner Organisation und des Kontos: 21 Seiten mit je einer Detailseite eines Beitrags, seiner Analytics und eines Accounts; eine Markenstimme kommt dazu, wenn es eine gibt;
  - die Menüs: Workspace-Wechsel und Kontomenü;
  - die Dialoge: "Umplanen", "Person einladen", "Organisation löschen" und die Navigation schmaler Bildschirme;
  - der Dialog des Zuschnitts, in `media.spec.ts`;
  - die Abrechnungsseite und der Dialog des Tarifwechsels, in `billing.spec.ts` (siehe Reihenfolge).
- **Ausnahme**: In offenen Menüs ist die Regel `aria-hidden-focus` aus.
  - Radix versteckt den Rest der Seite mit `aria-hidden` und hält den Fokus im Menü.
  - axe erkennt das nur bei Dialogen mit `aria-modal`. Deshalb meldet es die Links hinter dem Menü als fokussierbar.
  - Dass der Fokus im Menü bleibt, prüft der Tastaturtest.
- **Umbruch** (WCAG 1.4.10): Ein Test öffnet elf Seiten bei 320 CSS-Pixeln Breite und verlangt, dass keine seitlich scrollt; die Abrechnungsseite prüft `billing.spec.ts` ebenso. Breite Tabellen scrollen in ihrem eigenen Kasten; Datentabellen nimmt das Kriterium aus.
- **Reihenfolge**:
  - Die E2E-Tests laufen mit einem Worker in alphabetischer Reihenfolge. Die Datei läuft also zuerst, auf dem frischen Seed. Sie liest nur und schließt jeden Dialog wieder.
  - Die Abrechnungsseite prüft `billing.spec.ts`, wo das Fake-Stripe läuft. Ohne Stripe merkt sich die API eine unvollständige Preisliste eine Minute lang, und der Test der Abrechnung sähe danach keine Preise. Das zeigte die Gesamtprüfung, als `accessibility.spec.ts` die Seite noch selbst öffnete.

### Tastatur

- **Manuelle Prüfung**: 18 Seiten der App wurden mit der Tab-Taste durchlaufen, in beiden Farbschemata. Menüs, Dialoge, Kalender, Composer und Zuschnitt wurden mit der Tastatur allein bedient. Das [Protokoll](../barrierefreiheit/pruefung-2026-10.md) beschreibt Vorgehen und Ergebnisse.
- **Automatisch**: `apps/web/e2e/keyboard.spec.ts` hält fest, was sich wiederholen lässt:
  - Der Link "Zum Inhalt springen" ist der erste Halt und setzt den Fokus auf den Inhalt.
  - Ein Menü öffnet auf seinem ersten Eintrag und hält den Fokus bis Escape. Danach hat ihn wieder der Auslöser.
  - Ein Dialog hält den Fokus, während Tab im Kreis geht, und gibt ihn mit Escape zurück. Das gilt auch für einen Dialog, der über seinen Zustand öffnet statt über einen Trigger, wie "Umplanen".
  - Die Tabs der Varianten im Composer sind ein einziger Halt. Pfeiltasten, Pos1 und Ende wechseln den Tab.
  - Auf der langen Tabelle der Beiträge bleibt der Fokus vorwärts und rückwärts unter dem fixierten Kopf.
  - Der Knopf des Kalenders in einem Datumsfeld ist ein eigener Halt, auf dem das Feld `:focus-within`, aber nicht `:focus` ist. An diesem Zustand hängt sein Fokusrahmen.
- **Zuschnitt**: `media.spec.ts` verschiebt das Bild mit einer der neuen Schaltflächen.

### Änderungen an der App

- **Überschriften**: Diese Seiten haben jetzt eine Überschrift erster Ebene: die Seiten vor der Anmeldung, der zweite Faktor, die Einladung und die Seite "nicht gefunden". `CardTitle` aus `@smp/ui` nimmt dafür `as="h1"`, wenn die Karte die Seite ist.
- **Farben** in `apps/web/src/app/globals.css`:
  - Im dunklen Schema sind die Flächen für Primär und Gefahr heller und tragen dunklen Text, mit mindestens 7:1. Die roten Badges werden damit ebenfalls lesbar.
  - Die Rahmen der Formularfelder haben in beiden Schemata mindestens 3:1 gegen ihren Hintergrund (WCAG 1.4.11).
  - Neu ist `--warning-foreground` für Symbole auf der Warnfarbe.
  - Das Zeichen von Facebook ist ein dunkleres Blau, damit die weiße Schrift 4,5:1 erreicht.
  - Vergangene Tage im Kalender sind grau hinterlegt statt abgeblendet.
- **Zielgrößen** (WCAG 2.5.8): Kleine Textlinks neben anderen Links stehen auf einer Zeile von 24 Pixeln. Das sind die Accounts in den Top-Beiträgen und die Top-Beiträge einer Idee.
- **Umbruch**:
  - Raster beginnen mit einer Spalte, die schmaler werden darf (`grid-cols-1`).
  - Der Kasten einer Tabelle ist positioniert. So scrollt Text für Screenreader in ihren Zellen mit der Tabelle.
- **Sprunglink** (WCAG 2.4.1): "Zum Inhalt springen" ist der erste Halt jeder Seite der App und erscheint, sobald er den Fokus hat.
- **Tabs**: Die Tabs der Varianten folgen dem Muster "Tabs" der WAI-ARIA Authoring Practices, mit wanderndem `tabindex` (`apps/web/src/lib/roving-focus.ts`).
- **Zuschnitt ohne Ziehen** (WCAG 2.5.7):
  - Vier Schaltflächen verschieben das Bild um je 10 Pixel und halten es über dem Ausschnitt (`nudge` in `apps/web/src/features/media/crop.ts`).
  - Der Bereich hat einen Namen und einen Hinweis auf die Pfeiltasten.
- **Fokus unter dem Kopf** (WCAG 2.4.11): Das Dokument hält oben 64 Pixel frei, wenn es zu einem Element scrollt (`scroll-pt-16`). Der fixierte Kopf ist 56 Pixel hoch.
- **Fokus nach einem Dialog** (WCAG 2.4.3): Radix gibt den Fokus beim Schließen nur an einen `DialogTrigger` zurück. `DialogContent` und `SheetContent` in `@smp/ui` merken sich deshalb das Element, das beim Öffnen den Fokus hatte, und geben ihn dorthin zurück, wenn es noch auf der Seite ist. Das Modul ist dafür ein Client-Modul.
- **Native Teile der Formularfelder**:
  - Die Seite nennt ihr Farbschema (`color-scheme`), damit Chromium etwa den Knopf des Kalenders in Datumsfeldern passend zeichnet.
  - Hat dieser Knopf den Fokus, trägt er den Rahmen der App (WCAG 2.4.7).

## Befunde

Die Prüfung vom 2026-10-19 fand vierzehn Mängel, und alle sind behoben. Messwerte und Einzelheiten stehen im Protokoll.

| Befund | Kriterium | Gefunden durch |
|---|---|---|
| Keine Überschrift erster Ebene auf acht Seiten: vor der Anmeldung, zweiter Faktor, Einladung, "nicht gefunden" | 1.3.1 | den E2E-Test, der auf die Überschrift wartet |
| Weiße Schrift auf den blauen (3,67:1) und roten Schaltflächen (3,76:1) des dunklen Schemas, rote Badges mit 4,32:1 | 1.4.3 | axe |
| Abgeblendete vergangene Kalendertage: 3,52:1 im hellen, 4,06:1 bis 4,37:1 im dunklen Schema | 1.4.3 | axe |
| Zeichen von Facebook mit 4,23:1 | 1.4.3 | Nachrechnen der Farben |
| Rahmen der Formularfelder mit 1,48:1 im hellen und 1,90:1 im dunklen Schema | 1.4.11 | manuelle Prüfung |
| Warnsymbol am Medienstreifen mit 2,15:1 im dunklen Schema | 1.4.11 | manuelle Prüfung |
| Account-Links in den Top-Beiträgen 15 Pixel hoch, direkt unter dem Link des Beitrags | 2.5.8 | axe |
| Dashboard, Ideen, Beiträge und Sicherheit scrollten bei 320 Pixeln seitlich | 1.4.10 | den Umbruch-Test |
| Kein Weg an der Seitenleiste mit zehn Links und am Kopf vorbei | 2.4.1 | manuelle Prüfung |
| Tabs des Composers: jeder Tab ein eigener Halt, keine Pfeiltasten | Muster "Tabs" der WAI-ARIA Authoring Practices | manuelle Prüfung |
| Ausschnitt des Zuschnitts nur durch Ziehen oder mit den Pfeiltasten im unbenannten Bereich wählbar | 2.5.7 | manuelle Prüfung |
| Beim Rückwärtsgehen mit Umschalt+Tab lag der Fokus unter dem fixierten Kopf; in der Tabelle der Beiträge verschwanden Schaltflächen und Kontrollkästchen einer Zeile ganz | 2.4.11 | manuelle Prüfung |
| Nach dem Schließen eines Dialogs ohne Trigger lag der Fokus auf der ganzen Seite; 17 Dialoge öffnen so, darunter "Umplanen" | 2.4.3 | manuelle Prüfung |
| Knopf des Kalenders in Datumsfeldern im dunklen Schema dunkel auf dunklem Grund, sein Fokusrahmen kaum zu sehen | 1.4.11, 2.4.7 | manuelle Prüfung |

Ohne Befund blieben:
- die Seite der Plattform-Admins mit dem Schritt des zweiten Faktors, einmalig mit axe geprüft;
- der Fokusrahmen auf allen anderen Halten der Tab-Läufe;
- der Fokus in offenen Dialogen und Menüs: Er bleibt darin, bis sie schließen.

## Grenzen

- **Keine echten Hilfsmittel**: Es gab keinen Test mit Screenreadern wie NVDA, JAWS oder VoiceOver und keine Prüfung durch Menschen mit Behinderungen. axe findet nur einen Teil der Probleme. Ob Texte verständlich sind und Ansagen sinnvoll, beurteilt es nicht.
- **Kein Gerät mit Tastatur**: Die Tastaturprüfung lief im Container ohne Bildschirm. Die Tasten drückte Playwright. Beurteilt wurden die festgehaltenen Halte und Screenshots. Eine Prüfung durch eine Person an einem echten Gerät steht aus.
- **Nur Chromium**: Firefox und Safari mit ihren eigenen Fokusrahmen und Datumsfeldern sind nicht geprüft.
- **Nicht geprüft** sind die Textabstände (WCAG 1.4.12), die E-Mails und die Seite der Plattform-Admins im automatischen Test, weil sie einen zweiten Faktor braucht.
- **Datumsfelder**: Der Rahmen um den Knopf des Kalenders hängt an einem Verhalten von Chromium, nämlich `:focus-within` ohne `:focus` auf dem Feld. Ändert Chromium das, meldet es der Tastaturtest. Andere Browser zeichnen ihre Datumsfelder selbst.
- **Neue Seiten**: Neue Seiten und Dialoge prüft axe nur, wenn sie in `accessibility.spec.ts` eingetragen werden.

## Konsequenzen

- **Positiv**:
  - Jede Änderung an Seiten, Menüs und Dialogen läuft in der CI durch axe, in beiden Farbschemata. Zu geringe Kontraste und zu kleine Ziele brechen den Build.
  - Der Weg der Tastatur durch Sprunglink, Menüs, Dialoge und Tabs ist als Test festgehalten.
- **Negativ**:
  - Der E2E-Job dauert länger: Die axe-Tests brauchen lokal rund zwei Minuten, die Tastaturtests 20 Sekunden.
  - Die Primärfarbe des dunklen Schemas ist heller als bisher, mit dunkler Schrift. Das verändert das Aussehen jeder Schaltfläche dort.
  - `playwright-core` ist als eigene Abhängigkeit auf die Version des Test-Runners festgelegt. Beide müssen zusammen aktualisiert werden.
  - Menüs, Dialoge und Popover aus `@smp/ui` sind Client-Komponenten. Server-Komponenten können sie weiter einbinden, aber nur mit serialisierbaren Props.

## Alternativen

- **Lighthouse**: prüft je Lauf eine Seite mit einem Teil der Regeln von axe, ohne Anmeldung und ohne geöffnete Menüs oder Dialoge.
- **pa11y-ci**: braucht einen eigenen Browser-Lauf neben Playwright. Anmeldung und geöffnete Dialoge müssten dort als Aktionen nachgebaut werden.
- **eslint-plugin-jsx-a11y**: findet Fehler im JSX ohne Browser, sieht aber weder Farben noch Größen noch Zustände wie ein offenes Menü. Als Ergänzung bleibt es möglich.
- **Nur `critical` als Schwelle**, wie im Leitfaden: Kontraste und Zielgrößen wären durchgerutscht.
