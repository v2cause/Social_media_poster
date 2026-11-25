# Plattformen einrichten

Diese Anleitung verbindet LinkedIn, Facebook, Instagram und X mit der lokalen Installation (`pnpm local`, [ADR 0046](adr/0046-einzelplatz-modus.md)). Jede Plattform verlangt eine eigene Entwickler-App; deren Zugangsdaten kommen in die Datei `.env` im Projektordner. Danach `start.sh` beziehungsweise `start.cmd` neu starten. Eine Plattform ohne Zugangsdaten bietet die App nicht an; die anderen funktionieren trotzdem.

Die Angaben sind am 2026-11-25 an der offiziellen Dokumentation geprüft. Die Oberflächen der Entwicklerportale ändern sich oft; heißt ein Menüpunkt anders, ist meist ein gleichbedeutender gemeint. Eine echte Veröffentlichung war bei der Entwicklung nicht möglich, weil keine Apps und Test-Accounts bereitstanden ([ADR 0049](adr/0049-plattform-adapter.md)).

Die Rückleitungs-Adressen (Redirect URIs) sind immer:

| Plattform | Adresse |
|---|---|
| LinkedIn | `http://localhost:3000/api/oauth/linkedin/callback` |
| Facebook | `http://localhost:3000/api/oauth/facebook/callback` |
| Instagram | `http://localhost:3000/api/oauth/instagram/callback` |
| X | `http://localhost:3000/api/oauth/x/callback` und `http://127.0.0.1:3000/api/oauth/x/callback` |

Nach dem Eintragen in `.env` und dem Neustart: in der App unter "Accounts" auf "Verbinden" klicken, bei der Plattform zustimmen und die Accounts auswählen.

## LinkedIn (persönliches Profil)

Kostenlos. Veröffentlicht Text und bis zu 20 Bilder auf dem eigenen Profil.

1. Eine LinkedIn-Seite (Unternehmensseite) anlegen, falls keine existiert. LinkedIn verknüpft jede App mit einer Seite; es darf eine kleine eigene Seite sein.
2. Auf https://www.linkedin.com/developers/apps "Create app" wählen, Name, Seite und Logo angeben.
3. Im Reiter "Products" die beiden Self-Service-Produkte "Sign In with LinkedIn using OpenID Connect" und "Share on LinkedIn" hinzufügen.
4. Im Reiter "Auth" unter "Authorized redirect URLs" die Adresse von oben eintragen. Dort stehen auch Client ID und Primary Client Secret.
5. In `.env`:

   ```
   LINKEDIN_CLIENT_ID=...
   LINKEDIN_CLIENT_SECRET=...
   ```

Gut zu wissen:

- Der Zugang gilt 60 Tage und lässt sich ohne Partner-Freigabe nicht verlängern. Die App erinnert vorher; dann einfach neu verbinden.
- Statistiken zu Posts, Follower-Zahlen und Unternehmensseiten brauchen die "Community Management API", die LinkedIn erst nach einem Antrag freigibt. Nach der Freigabe in `.env` `LINKEDIN_MEMBER_POST_ANALYTICS`, `LINKEDIN_MEMBER_FOLLOWER_STATISTICS` oder `LINKEDIN_ORGANIZATIONS` auf `true` setzen. Ohne Freigabe bleiben die Statistiken leer.
- Grenze: 150 Posts pro Tag und Person.
- Die LinkedIn-Doku verlangt für Redirect URIs HTTPS und nennt `localhost` nicht. In der Praxis nimmt das Portal `http://localhost` an. Lehnt es die Adresse ab, ist das ein offener Punkt (siehe ADR 0049).

## Facebook-Seite und Instagram

Kostenlos. Eine Meta-App deckt beide Plattformen ab. Die App bleibt im Entwicklungsmodus; ohne App-Review darf sie alles für Personen mit einer Rolle in der App, also für dich als Ersteller.

Vorbereitung für Instagram: Das Instagram-Konto muss ein professionelles Konto sein (Business oder Creator) und mit einer Facebook-Seite verknüpft sein, die du verwaltest (Seiteneinstellungen, "Verknüpfte Konten").

1. Auf https://developers.facebook.com als Entwickler registrieren und unter https://developers.facebook.com/apps/creation eine App anlegen.
2. Als Anwendungsfälle "Alles auf deiner Seite verwalten" und für Instagram "Nachrichten und Inhalte auf Instagram verwalten" mit "API-Einrichtung mit Facebook Login" wählen. Werden sie nicht angeboten: "Andere", dann "Business", dann die Produkte "Facebook Login for Business" und "Instagram" (API-Einrichtung mit Facebook Login) hinzufügen. Kein Business-Portfolio verbinden.
3. Diese Berechtigungen in den Anwendungsfällen hinzufügen (Standardzugriff reicht):
   - Facebook: `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`, `pages_read_user_content`, `read_insights`
   - Instagram: `instagram_basic`, `instagram_content_publish`, `instagram_manage_insights`, `instagram_manage_contents`, `pages_show_list`, `pages_read_engagement`
4. Unter "Facebook Login for Business", "Einstellungen", "Gültige OAuth-Redirect-URIs" die beiden Adressen für Facebook und Instagram eintragen.
5. App-ID und App-Geheimcode stehen unter "App-Einstellungen", "Allgemeines". In `.env`:

   ```
   META_APP_ID=...
   META_APP_SECRET=...
   ```

Instagram holt jedes Bild selbst von einer öffentlichen Adresse ab; ein Hochladen der Bytes gibt es für Bilder nicht. Der Speicher der lokalen Installation ist aus dem Internet nicht erreichbar. Deshalb öffnet `pnpm local` einen Cloudflare-Tunnel (ohne Konto, kostenlos) zu einem Nur-Lese-Proxy, der ausschließlich signierte Instagram-Bilder ausliefert. Dafür `cloudflared` installieren:

- macOS: `brew install cloudflared`
- Windows: `winget install --id Cloudflare.cloudflared`
- Linux: Paket von https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

Ohne `cloudflared` funktioniert Facebook trotzdem; Instagram meldet beim Veröffentlichen, dass die Bilder nicht öffentlich erreichbar sind. Wer einen eigenen öffentlichen Zugang zum Speicher hat, trägt ihn als `META_PUBLIC_MEDIA_BASE_URL` ein.

Gut zu wissen:

- Instagram nimmt nur JPEG mit Seitenverhältnis 4:5 bis 1,91:1; die App erzeugt die passenden Bilder selbst. Höchstens 50 Posts in 24 Stunden.
- Der Zugang der Seiten läuft nicht nach Zeit ab. Nach 90 Tagen ohne Nutzung kann Instagram eine neue Anmeldung verlangen.
- Seiten mit weniger als 100 Likes bekommen von Facebook keine Reichweiten-Statistik; Likes, Kommentare und Shares kommen trotzdem.

## X

Kostenpflichtig: X rechnet seit Februar 2026 pro Aufruf ab. Neue Apps haben keine Gratis-Stufe; du kaufst vorab Guthaben.

| Vorgang | Preis |
|---|---|
| Post | 0,015 USD |
| Post mit Link | 0,20 USD |
| Alt-Text pro Bild | 0,005 USD |
| Statistik pro Post und Abruf | 0,005 USD (drei Abrufe pro Post) |
| Follower-Zahl pro Tag | 0,01 USD |

1. Auf https://console.x.com mit dem eigenen X-Konto anmelden, die Developer-Vereinbarung annehmen und das Profil ausfüllen.
2. "New App" anlegen. Name und Website erscheinen als Quelle unter den Posts.
3. Unter "User authentication settings": OAuth 2.0 einschalten, Berechtigung "Read and write", App-Typ "Web App". Beide Callback-Adressen von oben eintragen, dazu eine Website.
4. Unter "Keys and tokens" die OAuth-2.0-Client-ID (die lange Zeichenkette, nicht die numerische App-ID) und das Client Secret kopieren; sie werden nur einmal angezeigt.
5. Unter "Billing" Guthaben kaufen. Dort lässt sich ein monatliches Ausgabenlimit setzen; das ist die verlässliche Grenze, denn im lokalen Modus sind die Tarif-Limits der App aufgehoben. Meldet X "client-not-enrolled", die App auf "Pay-per-use" und "Production" stellen.
6. In `.env`:

   ```
   X_CLIENT_ID=...
   X_CLIENT_SECRET=...
   ```

Gut zu wissen:

- Laut einer Seite der X-Doku muss die Callback-Adresse für lokale Entwicklung `127.0.0.1` statt `localhost` enthalten; andere Seiten der Doku verwenden `localhost`. Beide eintragen. Lehnt X `localhost` ab, die App unter http://127.0.0.1:3000 öffnen und in `.env` `APP_URL=http://127.0.0.1:3000` und `BETTER_AUTH_URL=http://127.0.0.1:3000` setzen.
- Optional `X_APP_OWNER_USER_ID` mit der eigenen X-Nutzer-ID setzen: Das Lesen der eigenen Posts kostet dann 0,001 statt 0,005 USD.
- Ein doppelter Post (gleicher Text) wird von X abgelehnt.

## Wenn etwas nicht klappt

- Beim Start nennt `pnpm local` jede Plattform mit "connected with your app" oder "not set up" und den fehlenden Variablen.
- Fehlt eine Variable einer Plattform, die auf `live` steht, bricht der Start mit ihrem Namen ab; der Wert erscheint nie im Log.
- Eine lokale Claude-Code-Instanz kann beim Anlegen der Apps helfen: diese Datei öffnen und Schritt für Schritt durchgehen.
