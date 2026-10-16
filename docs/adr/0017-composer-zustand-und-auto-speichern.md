# ADR 0017: Zustand und Auto-Speichern des Composers

- **Status**: Akzeptiert
- **Datum**: 2026-10-16
- **Bezug**: Umsetzungsleitfaden, Schritt 2.8; `docs/ARCHITECTURE.md`, Abschnitt 11; ADR 0016

## Kontext

Der Composer hält Briefing, Stil, Brand Voice, Plattformen und die Varianten eines Beitrags. Die Architektur sieht für lokalen Composer-State kleine Zustand-Stores vor. Offen sind außerdem, wann ein neuer Beitrag entsteht, wie das Auto-Speichern mit dem Optimistic Locking der API (ADR 0016) zusammenspielt und welche Varianten eine Generierung überschreiben darf.

## Entscheidung

- **Ein Reducer statt Zustand.** Der State lebt in einem reinen Reducer (`apps/web/src/features/composer/composer-model.ts`) unter `useReducer` in `ComposerPage`. Nur diese Seite und ihre Kinder brauchen ihn; eine zusätzliche Bibliothek bringt dafür nichts. Die Regeln (was ungespeichert ist, welche Varianten eine Generierung überschreibt) sind so ohne Browser testbar.
- **Revisionen statt Vergleich.** Beitrag und Varianten zählen jede lokale Änderung in `revision` hoch und merken sich die gespeicherte in `savedRevision`. Ein Speichern gilt für den Stand, mit dem es gestartet ist; was währenddessen dazukommt, bleibt ungespeichert und läuft im nächsten Durchgang.
- **Auto-Speichern nacheinander.** 800 ms nach der letzten Änderung speichert der Composer den Beitrag und danach jede geänderte Variante, nie zwei Anfragen gleichzeitig, jeweils mit der zuletzt gelesenen `version`. Ein 409 hält das Speichern an, bis der Nutzer "neu laden" oder "überschreiben" wählt. Beim Verlassen innerhalb der App wird gespeichert, beim Schließen des Tabs warnt der Browser.
- **Neuer Beitrag erst mit Inhalt.** Ein Beitrag entsteht, sobald er ein Briefing und mindestens eine Plattform hat, vorher gibt es nichts zu speichern. Er bekommt seine Adresse `/w/:ws/posts/:postId` per `history.replaceState`, damit der Editor mit seinem State erhalten bleibt.
- **Generieren nach dem Speichern.** Der Server generiert aus dem gespeicherten Briefing, deshalb speichert der Composer vor jeder Generierung. Mit dem Start gelten die Ziel-Varianten als "nicht bearbeitet"; tippt der Nutzer während des Streams in eine Variante, bleibt sie unberührt, und ein Hinweis nennt die Zahl der nicht überschriebenen Varianten. Gibt es schon Texte, fragt der Composer vorher nach.
- **Daten vom Server.** Die Seiten laden Beitrag, Stile und Brand Voices in der Server-Komponente und geben sie als Startwerte weiter. Unbekannte Beiträge enden so in der 404-Seite, und der Composer startet ohne Ladezustand.

## Alternativen

- **Zustand-Store**: gleiche Logik, aber eine weitere Abhängigkeit und ein globaler Store für State, der nur auf einer Seite gebraucht wird.
- **Speichern bei jedem Tastendruck**: viele Anfragen und häufige 409 bei mehreren Tabs.
- **Beitrag beim Öffnen anlegen**: hinterlässt leere Entwürfe, wenn jemand den Composer nur ansieht.

## Konsequenzen

- Ein späterer Schritt, der State über Seiten hinweg teilt (etwa Kalender und Composer), kann dafür weiterhin einen kleinen Store einführen.
- Die Planungsleiste aus Phase 4 erweitert denselben Reducer um Zeitpunkte pro Variante.
