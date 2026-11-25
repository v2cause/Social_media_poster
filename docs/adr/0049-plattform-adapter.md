# ADR 0049: Echte Adapter für LinkedIn, Facebook, Instagram und X

- **Status**: Akzeptiert
- **Datum**: 2026-11-25
- **Bezug**: Umsetzungsleitfaden, Schritte 4.12 bis 4.14; `docs/ARCHITECTURE.md`, Abschnitt 4; [ADR 0046](0046-einzelplatz-modus.md); [Anleitung](../plattformen-einrichten.md)

## Kontext

Bis hierhin liefen alle Plattformen über den Mock-Adapter, weil die Dokumentation von LinkedIn, Meta und X aus der Entwicklungsumgebung gesperrt war. Für den Einzelplatz-Modus will der Betreiber das System zuhause starten und wirklich veröffentlichen. Die Dokumentation ist seit 2026-11-25 erreichbar; Apps, Test-Accounts und Guthaben bei X gibt es in der Entwicklungsumgebung weiterhin nicht.

## Entscheidung

Die Adapter liegen in `packages/platform-adapters/src/linkedin`, `src/meta` und `src/x`. Jeder Endpunkt, Header, Scope, Grenzwert und Fehlerwert ist mit Link und Prüfdatum (2026-11-25) im Code kommentiert; was die Doku offen lässt, steht dort als offen. `liveAdapters()` baut sie aus den Zugangsdaten in der Env, und API sowie Worker übergeben sie an die Registry. Fehlt einer Plattform im Modus `live` eine Variable, bricht der Start mit deren Namen ab.

### LinkedIn

- Nur die Self-Service-Produkte "Sign In with LinkedIn using OpenID Connect" und "Share on LinkedIn": persönliches Profil, Text und bis zu 20 Bilder, Alt-Texte, Little Text Format mit Hashtag-Vorlagen, `LinkedIn-Version` 202611.
- Statistiken, Follower und Unternehmensseiten brauchen die freigabepflichtige Community Management API. Sie sind je Funktion per Env schaltbar und fügen erst dann ihre Scopes hinzu, weil LinkedIn eine Anmeldung mit nicht freigegebenen Scopes komplett ablehnt. `email` wird nicht mehr angefragt.
- Ohne Freigabe kann ein Profil seine Posts nicht lesen: Reconcile liefert `null` (die Variante geht auf `NEEDS_ATTENTION`), Statistiken sind `null` mit dem Grund in den Rohdaten.

### Facebook und Instagram

- Eine Meta-App mit Facebook Login für beide. Instagram läuft über "Instagram API with Facebook Login", nicht über Instagram Login: Facebook Login erlaubt im Entwicklungsmodus `http://localhost` als Redirect, braucht nur eine App-ID, und Löschen geht nur so. Dafür muss das Instagram-Konto mit einer Facebook-Seite verknüpft sein.
- Der kurzlebige Nutzer-Token wird in einen langlebigen getauscht; jedes Konto hält den Token seiner Seite, der nicht nach Zeit abläuft.
- Graph API v27.0, gepinnt und per Env änderbar.
- Facebook lädt die Bytes der Fotos als Multipart hoch. Instagram holt Bilder nur von einer öffentlichen `image_url`; einen Byte-Upload gibt es nur für Videos.

### Öffentliche Bilder für Instagram

Der lokale Speicher läuft mit den bekannten Schlüsseln des Repositorys und Admin-Rechten. Ein Tunnel direkt auf ihn würde ihn für jeden im Internet beschreibbar machen. `pnpm local` startet deshalb, wenn Meta live ist, einen Proxy auf 127.0.0.1, der nur signierte `GET`- und `HEAD`-Anfragen auf Renditions `instagram_feed-*.jpg` weitergibt, ohne Header des Aufrufers und mit dem Host des Speichers, damit die Signatur gültig bleibt. Davor öffnet `cloudflared` einen Quick Tunnel ohne Konto; seine Adresse wird `META_PUBLIC_MEDIA_BASE_URL`. Der Adapter setzt Pfad und Query der signierten URL auf diese Basis und lehnt private Hosts vor jedem Aufruf ab. Ohne `cloudflared` funktioniert Facebook weiter, Instagram meldet den fehlenden öffentlichen Zugang.

### X

- OAuth 2.0 mit PKCE für eine vertrauliche App, Media Upload v2 in Stücken, Alt-Texte über `/2/media/metadata`, rotierende Refresh Tokens, Reconcile über die letzten fünf eigenen Posts, Statistiken in Batches von 100.
- X rechnet seit 2026-02-06 pro Aufruf ab, ohne Gratis-Stufe für neue Apps. Die Preise in `prices.ts` sind an der Preisseite geprüft; neu sind eigene Timeline, Nutzer, Alt-Text und Löschen. Kosten werden nach einer erfolgreichen Antwort gebucht. Die Ausgabengrenze erkennt Links jetzt auch im Text.

### Einzelplatz-Modus

`PLATFORM_MODE_*` kennt zusätzlich `off`. `pnpm local` setzt eine Plattform mit Zugangsdaten auf `live`, sonst auf `off`, und veröffentlicht echt (`PUBLISH_DRY_RUN=false`). Die Accounts-Seite erklärt bei einer Plattform ohne Zugangsdaten, wie man sie einrichtet. `start.sh` und `start.cmd` prüfen Node.js, Docker und Claude Code und starten alles.

## Abweichungen vom Leitfaden

- **Kein echter Test-Post** (Fertig-Kriterium von 4.12 bis 4.14): Die Adapter laufen gegen nachgebaute APIs mit Antworten nach den Beispielen der Doku und bestehen die Contract-Suite. Der erste echte Post geschieht beim Betreiber.
- **Meta-Webhooks** (Deauthorize, Data Deletion) und App-Review fehlen. Im Entwicklungsmodus nutzt nur der Betreiber selbst die App.
- **Erster Kommentar**: LinkedIn versucht ihn ohne Gewähr, Meta sendet ihn nicht (bräuchte weitere Berechtigungen).
- **Kein Video** auf allen Plattformen.

## Offen

- Ob LinkedIn `http://localhost` als Redirect annimmt; die Doku verlangt HTTPS.
- Ob X `localhost` oder nur `127.0.0.1` als Callback annimmt; die Doku widerspricht sich. Die Anleitung lässt beide eintragen.
- Undokumentiert und deshalb nach Beobachtung abgebildet: der Fehler für doppelte Inhalte bei LinkedIn (422) und X, der HTTP-Status bei aufgebrauchtem X-Guthaben, Meta-Fehler 100/33 als gelöschter Post.
- Ob Instagram mit dem Token der Seite veröffentlicht (Publishing-Guide) oder einen Nutzer-Token verlangt (Endpunkt-Referenz).
