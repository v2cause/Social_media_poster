# ADR 0029: X ohne API: Risikobestätigung, Flags und Kill-Switch

- **Status**: Akzeptiert
- **Datum**: 2026-10-17
- **Bezug**: Umsetzungsleitfaden, Schritt 6.1; `docs/ARCHITECTURE.md`, Abschnitte 4.3 und 10; [ADR 0005](0005-x-hybrid-und-leitplanken.md)

## Kontext

Der Browser-Adapter für X verstößt gegen die Nutzungsbedingungen von X und kann zur Sperre des Accounts führen. Er darf deshalb nur laufen, wenn vier Bedingungen zugleich gelten: Die Installation bietet ihn an, der Kill-Switch ist aus, der Tarif der Organisation erlaubt ihn, und der Workspace hat ihn nach einer ausdrücklichen Risikobestätigung eingeschaltet. Bis zu den Tarifen von Phase 7 schaltet ein Plattform-Admin die Organisation frei.

## Entscheidung

### Risikotext

- **Ort**: `packages/contracts/src/legal/x-browser-risk.{de,en}.md`, versioniert über `X_BROWSER_RISK.version` (Datum der Fassung) und mit dem SHA-256 jeder Sprache.
- **Schutz vor stillen Änderungen**: `legal.test.ts` vergleicht die Hashes mit den Dateien. Ein geänderter Text braucht eine neue Version, und jeder Workspace muss neu bestätigen.

### Flags

- **Eine Tabelle**: `feature_flag` mit dem Schlüssel `x_browser_automation` in drei Ebenen:
  - global: der Kill-Switch (`enabled = false` heißt abgeschaltet, keine Zeile heißt an),
  - pro Organisation: das Tarif-Gate bis Phase 7,
  - pro Workspace: eingeschaltet durch Owner oder Admin.
- **Eine Zeile pro Ebene**: Ein eindeutiger Index über die nullbaren Spalten bräuchte `NULLS NOT DISTINCT`, das Prisma nicht ausdrücken kann. Schreiber derselben Ebene warten deshalb auf eine transaktionsweite Advisory-Lock und ändern die Zeile oder legen sie an.
- **Gate**: `XBrowserGate` öffnet nur, wenn `FEATURE_X_BROWSER_GLOBAL` gesetzt ist, der Kill-Switch aus ist, die Organisation freigeschaltet ist, der Workspace eingeschaltet hat und die gültige Bestätigung zur aktuellen Textversion gehört. Die Adapter-Registry fragt es vor jedem Aufruf; der Worker merkt sich die Antwort pro Workspace 15 Sekunden.

### Einschalten und Ausschalten

- **Wer**: Owner und Admins (Recht `x_browser.enable`).
- **Wie**: die Checkbox "Ich habe die Risiken verstanden", die Version des gelesenen Textes und das Passwort erneut. Nach fünf falschen Passwörtern in 15 Minuten antwortet die API mit `TOO_MANY_ATTEMPTS`.
- **Was gespeichert wird**: In einer Transaktion entstehen `RiskAcknowledgement` (Version, Hash, Sprache, Zeit, Nutzer, IP-Adresse), das Flag des Workspace und der Audit-Eintrag `x_browser.enable`. Eine ältere Bestätigung wird dabei widerrufen.
- **Ausschalten**: widerruft die Bestätigung, setzt das Flag zurück und schreibt `x_browser.disable`. Wer wieder einschaltet, bestätigt neu.

### Plattform-Admins

- **Wer**: Nutzer mit `users.is_platform_admin`; das Feld setzen nur Betreiber, Better Auth nimmt es nicht als Eingabe an.
- **Was**: der Kill-Switch und die Freischaltung von Organisationen über `/api/admin/x-browser` und die Seite `/admin`. Organisationen haben keinen Slug; freigeschaltet wird über den Slug eines ihrer Workspaces.
- **Kill-Switch**: setzt das globale Flag und zugleich den Schlüssel `xb:kill` in Redis, den der browser-worker vor jedem Befehl liest, weil er keine Datenbank hat.
- **Als app_system**: Die globalen und die Organisations-Zeilen gehören zu keinem Workspace.

## Abweichungen

- **Einstellungsseite**: Die Workspace-Einstellungen (`/w/:ws/settings`) zeigen bisher nur den Bereich "X ohne API (experimentell)". Weitere Einstellungen folgen mit späteren Schritten.
- **Admin-Seite ohne Menüeintrag**: `/admin` ist direkt aufrufbar und prüft das Recht serverseitig, steht aber in keiner Navigation. Sie richtet sich an wenige Betreiber.
- **Admin-Aktionen im Log statt im Audit-Log**: Das Audit-Log gehört zu einer Organisation (Abschnitt 6.3), der Kill-Switch zu keiner. Jede Änderung wird mit dem Admin geloggt. Die Freischaltung einer Organisation landet ebenfalls nur im Log.

## Konsequenzen

- Jede Bedingung lässt sich einzeln zurücknehmen; der Kill-Switch wirkt auf den browser-worker sofort und auf die Registry spätestens nach 15 Sekunden.
- Die rechtliche Freigabe des Risikotextes steht aus (Leitfaden, Schritt 6.6). Bis dahin gilt die Fassung `2026-10-17` als Entwurf.
