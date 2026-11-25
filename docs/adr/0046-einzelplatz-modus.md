# ADR 0046: Einzelplatz-Modus ohne Anmeldung und ohne Abrechnung

- **Status**: Akzeptiert
- **Datum**: 2026-11-25
- **Bezug**: `docs/ARCHITECTURE.md`, Abschnitte "Getroffene Entscheidungen", 6.3, 6.4 und 10; [ADR 0047](0047-claude-abo-ueber-claude-code.md); [ADR 0035](0035-nutzungsabrechnung-und-durchsetzung-der-limits.md)

## Kontext

Die Plattform ist als mandantenfähiges SaaS gebaut: Anmeldung mit Better Auth, Organisationen, Rollen, Row-Level Security, Tarife mit Stripe. Der Betreiber will das System vorerst selbst nutzen, auf dem eigenen Rechner: herunterladen, starten, posten. Anmeldung, Paywall und Abrechnung stehen dabei nur im Weg.

Die Mandantentrennung, die Rechte und das Audit-Log sind tief in API, Worker und Datenbank verankert. Sie auszubauen oder für einen Modus zu umgehen, würde jede Prüfung zweimal nötig machen.

## Entscheidung

`LOCAL_MODE=true` schaltet einen Einzelplatz-Modus ein. Er ersetzt keine Schicht, sondern stellt eine echte Identität bereit:

- **Lokaler Inhaber**: Beim Start legt die API (`LocalOwnerBootstrap`) den Nutzer `LOCAL_USER_EMAIL` an, falls es ihn nicht gibt, mit bestätigter Adresse. Hat er keine Mitgliedschaft, entsteht über `CreateOrganization` eine Organisation mit einem Workspace (Name `LOCAL_USER_NAME`, Zeitzone des Rechners, Inhaltssprache Deutsch). Danach hält `LocalSession` eine Sitzung dieses Nutzers ohne Cookie und ohne Token.
- **Ohne Anmeldung**: `AuthGuard` und der OAuth-Callback der Plattformen nehmen diese Sitzung, wenn eine Anfrage keine eigene hat. Eine echte Sitzung geht immer vor. Workspace-Kontext, Row-Level Security, Rechte-Matrix, Lesemodus und Audit-Log laufen unverändert, weil hinter jeder Anfrage ein echter Nutzer mit echter Mitgliedschaft steht.
- **Ohne Abrechnung**: `LocalModeSubscriptionReader` umhüllt den einen Leser des Abos. Er meldet ein aktives Abo des größten Tarifs mit sehr hohen Limits, ohne Lesemodus und ohne KI-Überziehung. API (`plan.module`) und Worker (`subscriptionReaderOf`: Scheduler, Browser von X, Ausgabengrenze der KI) lesen die Limits nur über diesen Punkt.
- **Web**: Der Proxy leitet nicht mehr zur Anmeldung um und schickt die Anmeldeseiten auf die Startseite. Die Shell blendet Abrechnung und Abmelden aus. Gelesen wird `LOCAL_MODE` nur auf dem Server.
- **Start**: `pnpm local` (`tools/local/start.ts`) legt `.env` beim ersten Lauf an und füllt leere Secrets, prüft die Claude-CLI, startet die Dienste von `compose.yaml`, baut die Pakete, spielt die Migrationen ein und startet API, Worker und Web mit `LOCAL_MODE=true`, `API_HOST=127.0.0.1` und `AI_PROVIDER=claude-code`.

### Schutz

Wer die API erreicht, handelt als Inhaber. Die Env-Prüfung der API lehnt den Modus deshalb ab, außer `API_HOST` ist `127.0.0.1` oder `::1` und `APP_URL` sowie `BETTER_AUTH_URL` zeigen auf `localhost`, `127.0.0.1` oder `[::1]`. Die Produktions-Vorlage (ADR 0045) setzt den Modus nicht.

## Alternativen

- **Anmeldung und Billing ausbauen**: Verworfen. Die Mandantentrennung hängt an Nutzer und Mitgliedschaft; ohne sie fielen RLS, Rechte und Audit-Log weg, und eine spätere SaaS-Version bräuchte alles neu.
- **Automatische Anmeldung per Cookie**: Verworfen. Ein Cookie müsste erzeugt, erneuert und vor anderen Programmen auf dem Rechner geschützt werden; die Sitzung im Prozess braucht nichts davon.
- **Feste Tarif-Zeile in der Datenbank**: Verworfen. Sie müsste beim Start gepflegt werden und wäre bei einem späteren Wechsel zu SaaS ein Altlast-Datensatz.

## Folgen

- Die Anwendung ist auf dem eigenen Rechner ohne Konto nutzbar; alle Funktionen außer Abrechnung und Kontoverwaltung stehen bereit.
- Andere Programme auf demselben Rechner erreichen die API auf 127.0.0.1 ebenfalls. Das ist für einen persönlichen Rechner hingenommen; auf einem geteilten Rechner gehört der Modus nicht eingeschaltet.
- Die Anmelde-, Team- und Abrechnungsseiten bleiben im Code und kehren mit `LOCAL_MODE=false` zurück.
