# Plattformen einrichten: LinkedIn, Facebook, Instagram und X

Diese Anleitung schaltet die echten Plattformen ein. Ohne sie läuft alles über den Mock-Adapter: Beiträge lassen sich schreiben und planen, gehen aber nirgends hin. Die Adapter sind in den Schritten 4.12 bis 4.14 gebaut, die Entscheidungen stehen in [ADR 0046](../adr/0046-echte-plattform-adapter.md).

Wichtig vorab: Die Adapter sind gegen nachgebaute Antworten der Plattformen getestet, nicht gegen die echten APIs. Die offizielle Doku war aus der Entwicklungsumgebung gesperrt. Der erste echte Beitrag pro Plattform ist deshalb zugleich der Abnahmetest. Bitte zuerst im Dry Run, dann mit einem Testbeitrag prüfen (Abschnitt "Erster Test").

Die Menüs der Entwicklerportale ändern sich oft. Die Namen unten sind der Stand der Sekundärquellen von Oktober 2026 und können abweichen.

## 1. Voraussetzungen

- **Öffentliche Adresse mit https**: Die Plattformen leiten nach der Anmeldung auf `APP_URL` zurück. Am einfachsten ist ein Staging oder die Produktion aus `deploy/`. Lokal reicht für erste Versuche ein Tunnel auf `http://localhost:3000`; `APP_URL` muss dann die Adresse des Tunnels sein.
- **Redirect-URIs**, je Plattform genau so in der App einzutragen:

  | Plattform | Redirect-URI |
  |---|---|
  | LinkedIn | `<APP_URL>/api/oauth/linkedin/callback` |
  | Facebook | `<APP_URL>/api/oauth/facebook/callback` |
  | Instagram | `<APP_URL>/api/oauth/instagram/callback` |
  | X | `<APP_URL>/api/oauth/x/callback` |

- **Speicher für Instagram**: Instagram holt jedes Bild selbst ab. `S3_PUBLIC_ENDPOINT` muss deshalb aus dem Internet über https erreichbar sein. LinkedIn, Facebook und X bekommen die Bilder als Upload vom Worker; dort reicht der Speicher, den der Worker erreicht.
- **Rechtliches** für die Prüfungen von Meta und LinkedIn: Datenschutzerklärung, Impressum und eine Seite mit Anleitung zur Datenlöschung (Architektur, "Externe Voraussetzungen").

## 2. LinkedIn

1. Unter [linkedin.com/developers](https://www.linkedin.com/developers/apps) eine App anlegen. LinkedIn verlangt eine Company Page, mit der die App verknüpft ist, und deren Bestätigung durch einen Admin der Seite.
2. Unter "Products" die beiden Self-Serve-Produkte hinzufügen: **Sign In with LinkedIn using OpenID Connect** und **Share on LinkedIn**. Beide sind sofort aktiv.
3. Unter "Auth" die Redirect-URI eintragen und **Client ID** und **Primary Client Secret** kopieren.
4. In `.env`:

   ```bash
   PLATFORM_MODE_LINKEDIN=live
   LINKEDIN_CLIENT_ID=...
   LINKEDIN_CLIENT_SECRET=...
   # Version der REST API im Format YYYYMM, zum Beispiel der Vormonat. Welche Versionen
   # LinkedIn gerade unterstützt, steht in der Doku der Posts API.
   LINKEDIN_VERSION=YYYYMM
   ```

5. Optional, beide brauchen einen Antrag bei LinkedIn:
   - **Community Management API** für Company Pages, dann `LINKEDIN_ORGANIZATIONS=true`. Danach bietet "Verbinden" auch die Seiten an, auf denen die Person Admin oder Content-Admin ist. LinkedIn verlangt dafür womöglich eine eigene App nur mit diesem Produkt; diesen Fall deckt die Vorlage noch nicht ab (ADR 0046).
   - **Member Post Analytics** für Impressions und Reichweite persönlicher Beiträge, dann `LINKEDIN_MEMBER_ANALYTICS=true`. Ohne das zeigen persönliche Beiträge keine Zahlen.

Grenzen: Ein Zugang gilt 60 Tage. LinkedIn gibt Refresh Tokens nur Partnern, deshalb erinnert die App 14, 7 und 1 Tag vor Ablauf an das erneute Verbinden. Einen persönlichen Beitrag kann der Adapter nach einem unklaren Ausgang nicht wiederfinden; die Variante geht dann auf "Prüfung nötig", statt doppelt zu posten.

## 3. Facebook-Seiten

1. Unter [developers.facebook.com/apps](https://developers.facebook.com/apps) eine App vom Typ **Business** anlegen.
2. Das Produkt **Facebook Login for Business** (oder **Facebook Login**) hinzufügen und die Redirect-URI unter "Valid OAuth Redirect URIs" eintragen.
3. Berechtigungen: `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`, `read_insights`.
   - Mit **Facebook Login for Business** kommen sie in eine Konfiguration; deren ID gehört in `META_LOGIN_CONFIG_ID`.
   - Mit **Facebook Login** bleibt `META_LOGIN_CONFIG_ID` leer, dann fragt die App mit diesen Scopes.
4. Unter "App settings > Basic" **App ID** und **App Secret** kopieren.
5. In `.env`:

   ```bash
   PLATFORM_MODE_META=live
   META_APP_ID=...
   META_APP_SECRET=...
   # Graph-API-Version im Format vNN.0, die aktuelle aus dem App-Dashboard.
   META_GRAPH_VERSION=vNN.0
   META_LOGIN_CONFIG_ID=
   ```

6. **Entwicklungsmodus**: Bis zum App-Review funktioniert die App nur für Personen mit einer Rolle in der App (Admin, Developer, Tester). Für die eigenen Seiten reicht das. Für fremde Nutzer braucht es Business Verification und App-Review mit Screencast je Berechtigung.

Grenzen: Die Seiten-Tokens laufen nicht ab, aber Meta beendet den Datenzugriff der App 90 Tage nach der letzten Zustimmung. Die App erinnert deshalb vorher an das erneute Verbinden. Die Callbacks für "App entfernt" und "Daten löschen" sind noch nicht gebaut; für das App-Review reicht vorerst die Seite mit der Anleitung zur Datenlöschung (ADR 0046).

## 4. Instagram

Voraussetzung ist ein **professionelles Konto** (Business oder Creator).

1. In derselben Meta-App das Produkt **Instagram** hinzufügen und "API setup with Instagram login" wählen.
2. Dort die Redirect-URI eintragen und die **Instagram App ID** und das **Instagram App Secret** kopieren. Beide unterscheiden sich von App ID und Secret der Meta-App.
3. Berechtigungen: `instagram_business_basic`, `instagram_business_content_publish`, `instagram_business_manage_insights`.
4. Im Entwicklungsmodus das Instagram-Konto als Tester eintragen und die Einladung in Instagram annehmen.
5. In `.env` (zusätzlich zu den Meta-Werten aus Abschnitt 3):

   ```bash
   INSTAGRAM_APP_ID=...
   INSTAGRAM_APP_SECRET=...
   ```

Ohne diese beiden Werte bietet die App Instagram nicht an, auch wenn Meta auf `live` steht.

Grenzen: Instagram nimmt nur JPEG (die Medien-Pipeline liefert das), in Karussells mit gleichem Seitenverhältnis, und höchstens das Tageslimit an Beiträgen über die API in 24 Stunden. Beiträge lassen sich über die API nicht löschen. Der Zugang gilt 60 Tage und wird automatisch verlängert.

## 5. X

1. Unter [developer.x.com](https://developer.x.com) ein Projekt mit einer App anlegen.
2. Unter "User authentication settings" **OAuth 2.0** einschalten:
   - Typ der App: **Web App** (vertraulicher Client mit Secret);
   - Berechtigung: **Read and write**;
   - Callback URI: die Redirect-URI von oben;
   - Website URL: die Adresse der App.
3. **Client ID** und **Client Secret** von OAuth 2.0 kopieren (nicht API Key und Secret von OAuth 1.0a).
4. X rechnet pro Aufruf ab. Guthaben aufladen und im Portal ein Ausgabenlimit mit Alarm setzen. Die App erfasst die Kosten zusätzlich pro Workspace und stoppt beim Limit des Tarifs.
5. In `.env`:

   ```bash
   PLATFORM_MODE_X=live
   X_CLIENT_ID=...
   X_CLIENT_SECRET=...
   ```

Grenzen: Ein Beitrag mit Link kostet deutlich mehr als einer ohne. Die Preise in `packages/platform-adapters/src/prices.ts` stammen aus Sekundärquellen und sind mit dem Portal abzugleichen.

## 6. Erster Test

1. API und Worker neu starten. Fehlt ein Wert, starten sie nicht und nennen die Variable.
2. Unter **Accounts** die Plattform verbinden und die Accounts auswählen.
3. Mit `PUBLISH_DRY_RUN=true` (Standard in `.env.example`) einen Beitrag planen. Der Worker erneuert die Tokens und prüft den Beitrag, sendet aber nichts.
4. `PUBLISH_DRY_RUN=false` setzen, Worker neu starten und einen Testbeitrag mit Bild über **Jetzt posten** senden.
5. Prüfen:
   - Der Beitrag erscheint auf der Plattform, der Link in der Post-Tabelle führt hin.
   - Die Logs von API und Worker zeigen jeden Aufruf als `platform.http`, mit Pfad und Status, ohne Tokens.
   - Bei X zeigt die Accounts-Seite die bisherigen Kosten des Accounts.
   - Die ersten Zahlen kommen nach einer Stunde in Analytics, bei X nach 24 Stunden.

Geht etwas schief, steht der Grund an der Variante in der Post-Tabelle. Das Log nennt den Code der Plattform, zum Beispiel `Graph API 190` für ein ungültiges Token bei Meta.

## 7. Produktion mit `deploy/`

1. In `deploy/.env` die Werte wie oben setzen. Die IDs und Versionen stehen dort, die Secrets kommen als Dateien nach `deploy/secrets/`:
   - `linkedin_client_secret`
   - `meta_app_secret`
   - `instagram_app_secret`
   - `x_client_secret`

   Angelegt werden sie wie im [Runbook Deployment](../runbooks/deployment.md), Schritt 4.
2. `SMP_EGRESS_HOSTS` um die Hosts der Plattformen und um `SMP_MEDIA_DOMAIN` ergänzen (Liste in `deploy/.env.example`). Ohne die Medien-Domain kann der Worker die Bilder nicht lesen.
3. `bash scripts/deploy.sh` nimmt die Override-Dateien der Plattformen auf `live` dazu. `scripts/preflight.sh` prüft die Secrets und warnt bei fehlenden Hosts.
