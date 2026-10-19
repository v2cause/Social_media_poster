# Prüfung der Barrierefreiheit, Oktober 2026

- **Datum**: 2026-10-19
- **Ziel**: WCAG 2.2 AA (`docs/ARCHITECTURE.md`, Abschnitt 11), Schritt 8.8 des Umsetzungsleitfadens
- **Entscheidungen und Grenzen**: [ADR 0044](../adr/0044-barrierefreiheit.md)
- **Umgebung**:
  - Postgres, Redis, SeaweedFS und Mailpit aus `compose.yaml`, API und Worker aus `dist`, die Web-App als Produktions-Build mit `next start`.
  - Daten aus `pnpm db:seed`. Angemeldet als Owner der Demo-Organisation im Workspace `demo`; die Seite der Plattform-Admins als Plattform-Admin mit zweitem Faktor.
  - Chromium aus Playwright 1.64 ohne Bildschirm, Fenster 1280 x 720 Pixel, Sprache Deutsch, helles und dunkles Farbschema.
- **Werkzeuge**:
  - axe-core 4.13.0 über `@axe-core/playwright`, mit den Regeln für WCAG 2.0 bis 2.2 in A und AA.
  - Skripte mit Playwright für die Tab-Läufe, die Breite bei 320 Pixeln und die Fokusführung in Menüs und Dialogen.
  - Kontraste nachgerechnet mit der Formel aus WCAG 2.2.

## Umfang

| Bereich | Seiten, Menüs und Dialoge |
|---|---|
| Vor der Anmeldung | Anmelden, Registrieren, Passwort vergessen, Passwort zurücksetzen, E-Mail bestätigen, zweiter Faktor |
| Workspace | Dashboard, Erstellen, Beiträge, ein Beitrag im Composer, Kalender als Monat, Woche und Liste, Ideen, Mediathek, Analytics, Analytics eines Beitrags und eines Accounts, Accounts, Markenstimmen, neue Markenstimme, Einstellungen |
| Organisation | Mitglieder, Abrechnung, Daten und Löschung |
| Konto | Sicherheit, Benachrichtigungen |
| Plattform-Admins | `/admin` |
| Menüs und Dialoge | Workspace-Wechsel, Kontomenü, Umplanen, Person einladen, Organisation löschen, Navigation schmaler Bildschirme, Zuschnitt |

Die Demo-Daten haben keine Markenstimme; ihre Detailseite war deshalb nicht Teil der Prüfung.

## 1. axe

- **Erster Lauf**:
  - Im hellen Schema hatten drei von 26 Seiten Verstöße: der Kalender mit 42 Kontrasten, das Dashboard und die Analytics mit zu kleinen Zielen.
  - Im dunklen Schema hatten 20 von 26 Seiten Verstöße: fast alle wegen weißer Schrift auf den blauen und roten Flächen, im Kalender wegen der abgeblendeten Tage.
  - Alle Verstöße hatten die Stufe `serious`.
- **Menüs**: In beiden offenen Menüs meldete axe `aria-hidden-focus` für die Links hinter dem Menü.
  - Ein Skript zeigte, dass der Fokus im Menü bleibt: Tab und Umschalt+Tab verlassen es nicht, und Escape gibt den Fokus dem Auslöser zurück.
  - Die Regel ist für offene Menüs aus (ADR 0044, Ausnahme).
- **Dialoge**: Die geöffneten Dialoge hatten keine Verstöße der Stufen `serious` und `critical`.
- **Plattform-Admins** mit dem Schritt des zweiten Faktors: keine Verstöße in beiden Schemata.
- **Nach allen Korrekturen**: keine Verstöße auf allen 26 Seiten in beiden Schemata, auch nicht der Stufen `moderate` und `minor`.

## 2. Tab-Läufe

Ein Skript drückte auf 18 Seiten der App von oben Tab, bis der Fokus wieder am Anfang stand. Für jeden Halt hielt es Element, Name, Sichtbarkeit, Lage im Fenster und Fokusrahmen fest. Wo es einen Halt ohne Rahmen meldete, zeigten Screenshots den Zustand. Der letzte Lauf mit allen Korrekturen, in beiden Schemata:

| Seite | Halte |
|---|---|
| Dashboard | 31 |
| Erstellen | 26 |
| Beiträge | 215 |
| Kalender, Monat | 76 |
| Kalender, Woche | 35 |
| Kalender, Liste | 73 |
| Ideen | 51 |
| Mediathek | 21 |
| Analytics | 55 |
| Accounts | 46 |
| Markenstimmen | 20 |
| Neue Markenstimme | 36 |
| Einstellungen | 18 |
| Mitglieder | 20 |
| Abrechnung | 11 |
| Daten und Löschung | 12 |
| Sicherheit | 101 im hellen, 102 im dunklen Schema |
| Benachrichtigungen | 18 |

Ergebnisse:
- Der erste Halt jeder Seite ist "Zum Inhalt springen". Vorher kamen zuerst die Schaltfläche "Seitenleiste einklappen" und die Links der Seitenleiste.
- Jeder Halt war sichtbar und lag im Fenster.
- Jeder Halt zeigt den Fokusrahmen der App.
  - Die Datumsfelder "Geplant ab" und "Geplant bis" der Beiträge haben vier Halte: Tag, Monat, Jahr und den Knopf des Kalenders.
  - Auf Tag, Monat und Jahr zeigt das Feld den Rahmen der App, und Chromium markiert das Segment.
  - Den Knopf des Kalenders markierte Chromium mit einem eigenen Rahmen, der im dunklen Schema kaum zu sehen war (Befund 14). Das Skript sieht den Rahmen an diesem Knopf nicht, weil er an einem Teil des Felds hängt. Vergrößerte Screenshots zeigen den Rahmen der App nach der Korrektur in beiden Schemata.
  - Datum und Uhrzeit im Dialog "Umplanen" haben ebenso einen Knopf als eigenen Halt. Die Korrektur gilt für alle Datums- und Zeitfelder.

## 3. Bedienung mit der Tastatur

| Ablauf | Vorgehen | Ergebnis |
|---|---|---|
| Sprunglink | Tab, Enter | Der Fokus liegt auf dem Inhalt, der nächste Tab bleibt darin. |
| Workspace-Wechsel, Kontomenü | Enter, Pfeiltasten, Tab, Umschalt+Tab, Escape | Das Menü öffnet auf seinem ersten Eintrag, und die Pfeiltasten wechseln den Eintrag. Tab und Umschalt+Tab verlassen es nicht. Escape schließt es und gibt den Fokus dem Auslöser zurück. |
| Person einladen | Enter auf "Einladen", achtmal Tab, Escape | Der Fokus bleibt im Dialog und geht mit Escape an "Einladen" zurück. |
| Umplanen im Kalender | Tab bis zu "… umplanen", Enter, Datum und Uhrzeit, Escape | Der Dialog öffnet auf dem Datum. Nach Escape lag der Fokus zuerst auf der ganzen Seite statt auf "… umplanen" (Befund 13). Nach der Korrektur liegt er wieder auf "… umplanen". |
| Tabs der Varianten im Composer | Tab, Pfeiltasten, Pos1, Ende | Vorher war jeder Tab ein eigener Halt ohne Pfeiltasten. Jetzt sind die Tabs ein Halt, und die Tasten wechseln den Tab. |
| Zuschnitt | Tab in den Bereich, Pfeiltasten, die neuen Schaltflächen | Die Pfeiltasten verschoben den Ausschnitt schon vorher, aber der Bereich hatte keinen Namen. Ohne Tastatur ging es nur durch Ziehen. Jetzt gibt es einen Namen, einen Hinweis und vier Schaltflächen. |
| Datumsfelder | Tab durch Tag, Monat, Jahr und den Knopf des Kalenders, in beiden Schemata | Im dunklen Schema war der Knopf dunkel auf dunklem Grund, und sein Fokus war kaum zu sehen (Befund 14). Jetzt ist der Knopf hell und trägt mit dem Fokus den Rahmen der App. |
| Langer Inhalt unter dem fixierten Kopf | Beiträge bei 1280 x 600 Pixeln, je 40 Halte vorwärts und rückwärts | Rückwärts lag der Fokus vorher unter dem Kopf, bei Zeilen der Tabelle ganz. Jetzt bleibt er darunter. |

## 4. Breite von 320 Pixeln

Bei 320 CSS-Pixeln Breite, wie bei 400 % Zoom in einem Fenster von 1280 Pixeln, scrollten vier Seiten seitlich:

| Seite | Breite vorher | Ursache |
|---|---|---|
| Dashboard | 1148 Pixel | Ein Raster ohne Spalten für schmale Bildschirme wuchs mit seiner breitesten Tabelle. |
| Beiträge | 973 Pixel | Text für Screenreader in den Zellen lag außerhalb des scrollenden Kastens der Tabelle. |
| Ideen | 902 Pixel | Raster wie beim Dashboard |
| Sicherheit | 585 Pixel | Text für Screenreader wie bei den Beiträgen |

Nach den Korrekturen ist keine der 20 geprüften Seiten breiter als 320 Pixel. Breite Tabellen scrollen in ihrem Kasten.

## 5. Kontraste

| Stelle | Vorher | Nachher |
|---|---|---|
| Schaltflächen, dunkles Schema | weiß auf `#3b82f6` 3,67:1, auf `#ef4444` 3,76:1 | `#0a0a0a` auf `#60a5fa` 7,79:1, auf `#f87171` 7,16:1 |
| Rote Badges, dunkles Schema | 4,32:1 | ohne Befund von axe |
| Rahmen der Formularfelder, hell | `#d4d4d8` auf Weiß 1,48:1 | `#858590` 3,65:1 |
| Rahmen der Formularfelder, dunkel | `#3f3f46` auf `#0a0a0a` 1,90:1 | `#71717a` 4,10:1 auf der Seite, 3,90:1 auf Karten |
| Zeichen von Facebook | weiß auf `#1877f2` 4,23:1 | weiß auf `#1469d9` 5,18:1 |
| Warnsymbol am Medienstreifen, dunkel | weiß auf `#f59e0b` 2,15:1 | `#0a0a0a` auf `#f59e0b` 9,22:1 |
| Vergangene Kalendertage | 70 % Deckkraft: 3,52:1 hell, 4,06:1 bis 4,37:1 dunkel | grauer Hintergrund, volle Deckkraft, ohne Befund von axe |
| Knopf des Kalenders in Datumsfeldern, dunkel | dunkles Symbol auf dunklem Grund, kaum zu sehen | helles Symbol, weil die Seite ihr Farbschema nennt (`color-scheme`) |

## Befunde

1. Keine Überschrift erster Ebene auf acht Seiten (WCAG 1.3.1)
2. Kontraste der Schaltflächen und Badges im dunklen Schema (1.4.3)
3. Abgeblendete vergangene Kalendertage (1.4.3)
4. Zeichen von Facebook (1.4.3)
5. Rahmen der Formularfelder (1.4.11)
6. Warnsymbol am Medienstreifen (1.4.11)
7. Zu kleine Account-Links in den Top-Beiträgen (2.5.8)
8. Vier Seiten breiter als 320 Pixel (1.4.10)
9. Kein Sprunglink (2.4.1)
10. Tabs des Composers ohne Pfeiltasten (Muster "Tabs" der WAI-ARIA Authoring Practices)
11. Zuschnitt nur durch Ziehen oder mit den Pfeiltasten im unbenannten Bereich (2.5.7)
12. Fokus unter dem fixierten Kopf (2.4.11)
13. **Fokus nach dem Schließen eines Dialogs ohne Trigger verloren** (2.4.3). Radix gibt den Fokus nur an einen `DialogTrigger` zurück, und 17 Dialoge der App öffnen über ihren Zustand ohne einen. Nach dem Schließen lag der Fokus auf der ganzen Seite, und die nächste Tab-Taste begann wieder oben. `DialogContent` und `SheetContent` in `@smp/ui` merken sich jetzt das Element, das beim Öffnen den Fokus hatte, und geben ihn dorthin zurück.
14. **Knopf des Kalenders in Datumsfeldern** (1.4.11, 2.4.7). Die Seite nannte kein Farbschema, deshalb zeichnete Chromium die Teile der Formularfelder für eine helle Seite: Im dunklen Schema war der Knopf dunkel auf dunklem Grund. Seinen Fokus markierte Chromium mit einem eigenen Rahmen, der im dunklen Schema kaum zu sehen war. Jetzt nennt die Seite ihr Schema, und der Knopf trägt mit dem Fokus den Rahmen der App.

Alle Befunde sind behoben. Den Weg der Tastatur halten `apps/web/e2e/keyboard.spec.ts` und `media.spec.ts` fest. Die Seiten und Dialoge prüfen `accessibility.spec.ts` und, für die Abrechnung mit dem Fake-Stripe, `billing.spec.ts` mit axe.

## Offen

- Eine Prüfung durch eine Person an einem echten Gerät und mit Screenreadern wie NVDA, JAWS oder VoiceOver.
- Firefox und Safari.
- Textabstände (WCAG 1.4.12) und die E-Mails.
