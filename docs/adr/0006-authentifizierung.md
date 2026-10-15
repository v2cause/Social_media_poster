# ADR 0006: Authentifizierung

- **Status**: Vorgeschlagen. Spike (d) ist ausstehend.
- **Datum**: 2026-10-15
- **Bezug**: Umsetzungsleitfaden, Schritte 1.1, 1.4 und Spike 0.14(d); `docs/ARCHITECTURE.md`, Abschnitte 1 und 10

## Kontext

Die API ist die einzige Auth-Instanz. Gebraucht werden E-Mail-Passwort, Verifizierung, 2FA mit TOTP und DB-Sessions in einem httpOnly-Cookie unter derselben Origin.

## Entscheidung

Better Auth, eingebunden in NestJS (Express 5). Mandanten und Rollen bleiben in der eigenen Domäne. Das Cookie ist same-origin. Der Auth-Handler hängt vor dem JSON-Parser, und `isPlatformAdmin` darf der Nutzer nie selbst setzen.

## Spike (d): nicht ausgeführt

Der Spike verlangt Registrierung, Login und `getSession` im Rundlauf. Das braucht die Auth-Tabellen aus Schritt 1.1 und den Mailversand aus Schritt 1.8 für die Verifizierung. Vor diesen Schritten würde der Spike nur prüfen, dass sich das Paket laden lässt. Er wird deshalb mit Schritt 1.4 nachgeholt, und dieses ADR wird dann akzeptiert oder überarbeitet.

**Ausweichlösung**: Trägt Better Auth in Express 5 nicht, baut die API eine eigene Sitzungsschicht mit DB-Sessions (Token nur als Hash) und Argon2id für Passwörter. Das Schema bleibt dasselbe.

## Alternativen

- **Auth.js**: die Bibliothek ist seit 2025 beim Better-Auth-Team. Auth.js ist vor allem auf Next.js zugeschnitten und passt nicht zur Entscheidung, die API zur einzigen Auth-Instanz zu machen.
- **Eigene Lösung ohne Bibliothek**: verworfen. Passwort-Reset, 2FA und Sitzungsverwaltung sind sicherheitskritisch.

## Konsequenzen

- Rate-Limits auf den Auth-Routen sind Pflicht.
- Die Antworten bei "Passwort vergessen" verraten nicht, ob eine Adresse existiert.
