# Runbook: Zweiter Faktor verloren

Schritt 8.7 des Leitfadens, ASVS 6.4.4, [ADR 0039](../adr/0039-security-review-und-haertung.md). Für Personen, die App und Backup-Codes verloren haben und sich nicht mehr anmelden können.

## Wann

- Eine Person meldet, dass ihr der zweite Faktor fehlt: Smartphone verloren, App gelöscht, Backup-Codes nicht mehr auffindbar.
- Hat sie noch einen Backup-Code, braucht es den Support nicht: Anmeldung mit dem Code (er gilt einmal), danach unter Konto, Sicherheit den zweiten Faktor neu einrichten.

## Grundsätze

- **Nachweis wie bei der Registrierung**: Die Person zeigt, dass sie die Adresse des Kontos kontrolliert, mit einem Passwort-Reset über den Link an diese Adresse, und zwar nach ihrer Anfrage. Das Kommando entfernt den Faktor nur, wenn das Passwort in den letzten 24 Stunden so zurückgesetzt wurde; eine Registrierung zählt nicht.
- **Kein anderer Nachweis**: Anrufe, Angaben über Konto oder Posts, Kopien von Ausweisen und Nachrichten von einer anderen Adresse als der des Kontos reichen nicht. Druck oder Eile sind kein Grund für eine Ausnahme.
- **Organisationen**: Für jede Organisation der Person mit weiteren Owners (`otherOwners` größer 0) bestätigt einer dieser Owners die Person, von der Adresse seines eigenen Kontos. Ist die Person dort einziger Owner, genügt der Nachweis über die Adresse.
- **Plattform-Admins** (`platformAdmin: true`): zusätzlich die Bestätigung eines zweiten Plattform-Admins.
- **Ticket**: Jede Anfrage bekommt ein Ticket mit dem Zeitpunkt der Anfrage. Dessen Referenz gibt `--ticket` an, sie steht in jeder Zeile des Kommandos. Antworten gehen nur an die Adresse des Kontos.
- **Datenschutz**: Das Kommando nennt nur IDs, Rollen und Zeiten, nie Adressen oder Namen.

## Ablauf

1. **Anfrage aufnehmen**: Ticket anlegen. Bei einer Anfrage von einer anderen Adresse an die Adresse des Kontos antworten und dort weitermachen.
2. **Prüfen**:

   ```bash
   docker compose exec api node dist/scripts/reset-two-factor.js --user <Adresse> --ticket <Ticket> --check
   ```

   Lokal nach `pnpm build`: `pnpm auth:reset-two-factor --user <Adresse> --ticket <Ticket> --check`. Die Zeile `auth.two_factor_check` nennt `userId`, `twoFactorEnabled`, `platformAdmin`, `resetAt` und je Organisation `organizationId`, `role`, `otherOwners` und `requireTwoFactor`. Exit-Code 1: Zu der Adresse gibt es kein Konto. Ist `twoFactorEnabled` false, fehlt nur das Passwort; dann genügt "Passwort vergessen".
3. **Adresse nachweisen**: Die Person setzt auf der Anmeldeseite über "Passwort vergessen" ein neues Passwort. Der Reset beendet alle Sitzungen, der zweite Faktor bleibt. Danach Schritt 2 wiederholen: `resetAt` muss nach dem Zeitpunkt der Anfrage im Ticket liegen.
4. **Owner bestätigen lassen**: Für jede Organisation mit `otherOwners` größer 0 schreibt ein Owner an den Support, dass die Person dazugehört und den Reset erwartet. Ob der Absender Owner ist, zeigt Schritt 2 mit seiner Adresse: Rolle `OWNER` bei derselben `organizationId`. Bei Plattform-Admins bestätigt ein zweiter Plattform-Admin im Ticket.
5. **Faktor entfernen**:

   ```bash
   docker compose exec api node dist/scripts/reset-two-factor.js --user <Adresse> --ticket <Ticket>
   ```

   Die Zeile `auth.two_factor_reset` (Pegel warn) nennt `userId`, `resetAt`, `hadSecondFactor`, die Zahl der beendeten Sitzungen und die Organisationen. Exit-Code 1 mit `auth.two_factor_reset_refused` und `outcome: no_recent_password_reset`: Der Reset fehlt oder liegt mehr als 24 Stunden zurück; zurück zu Schritt 3. Exit-Code 2: Aufruf ohne `--user` oder `--ticket`.
6. **Abschließen**: Die Person bekommt die E-Mail "Der zweite Faktor Ihres Kontos wurde entfernt" mit einem Link zur Sicherheitsseite. Sie meldet sich mit dem neuen Passwort an und richtet den zweiten Faktor neu ein; verlangt eine Organisation ihn, führt die App sie dorthin. Die Ausgaben der Kommandos kommen ins Ticket, dann wird es geschlossen.

## Prüfung

- Die Anmeldung mit dem neuen Passwort fragt nicht mehr nach dem zweiten Faktor, und eine Sitzung von vor dem Entfernen bekommt 401.
- Die E-Mail an die Adresse ist angekommen.
- Nach dem Einrichten fragt die nächste Anmeldung wieder nach dem Faktor.

## Missbrauch

- Antwortet die Person auf die E-Mail, dass sie den Reset nicht veranlasst hat: Sitzungen beenden (`auth:revoke-sessions --user <Adresse>`, [Runbook](secret-rotation.md)), die Person setzt das Passwort erneut zurück und richtet den zweiten Faktor ein. Danach klären, wer das Postfach erreicht hat; das Ticket hält fest, wer welche Bestätigung gegeben hat.
- Mehrere Anfragen für dasselbe Konto in kurzer Zeit oder Bestätigungen von neu angelegten Konten sind ein Warnzeichen: Rückfrage über einen Owner, der schon länger Mitglied ist.

## Protokoll der Proben

| Datum | Umgebung | Ablauf | Ergebnis |
| --- | --- | --- | --- |
| 2026-10-19 | Lokal: Compose, API und Worker-Rolle `notify` aus `dist`, Mailpit | Mit curl gegen die API: Konto mit zweitem Faktor, Abmeldung; Prüfung, Entfernen ohne Reset, Reset über den Link aus Mailpit, Prüfung, Anmeldung bis zum zweiten Schritt, Entfernen, Anmeldung, E-Mail, neuer Faktor | Bestanden nach zwei Korrekturen: Das Feld `passwordResetAt` schwärzte der Logger (Name mit `password`), es heißt jetzt `resetAt`; der Prüfmodus fehlte im ersten Build. Ohne Reset verweigert das Kommando mit `no_recent_password_reset`, nach dem Reset entfernt es den Faktor in unter einer Sekunde, die Anmeldung braucht danach nur das Passwort, die E-Mail nennt die Sicherheitsseite, der neue Faktor lässt sich einrichten. |

Denselben Ablauf mit einer Organisation der Person spielt der Integrationstest `apps/api/test/two-factor-reset.integration.test.ts` bei jedem Lauf der CI durch.
