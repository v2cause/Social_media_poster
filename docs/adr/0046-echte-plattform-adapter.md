# ADR 0046: Echte Plattform-Adapter ohne Zugriff auf die offizielle Doku

- **Status**: Akzeptiert
- **Datum**: 2026-10-25
- **Bezug**: Umsetzungsleitfaden, Schritte 4.12 bis 4.14 und 5.2; `docs/ARCHITECTURE.md`, Abschnitte 4, 8 und 16; [ADR 0020](0020-renditions-und-zuschnitt.md) (Bildgrenzen), [ADR 0024](0024-publish-job-schreibmarke-und-lease.md) (Reconcile), [ADR 0027](0027-analytics-kaskade-rollup-und-api.md) (Mappings), [ADR 0035](0035-nutzungsabrechnung-und-durchsetzung-der-limits.md) (Ausgabenlimit von X), [ADR 0045](0045-produktions-vorlage.md) (Vorlage und Egress); [Plattformen einrichten](../betrieb/plattformen-einrichten.md)

## Kontext

Bis hierhin liefen alle Plattformen über den Mock-Adapter. Die Schritte 4.12 bis 4.14 waren offen, weil die offizielle Doku von LinkedIn (`learn.microsoft.com`), Meta (`developers.facebook.com`) und X (`docs.x.com`) aus der Entwicklungsumgebung gesperrt ist. Das gilt auch für die APIs selbst. Der Leitfaden verlangt, mit "gegen die Doku prüfen" markierte Details vor der Umsetzung zu verifizieren (CLAUDE.md, Regel 5).

Mit der App sollen echte Beiträge veröffentlicht werden; am 2026-10-25 wurde dafür die Umsetzung der Adapter beauftragt. Die Freigabe der gesperrten Hosts in der Netzwerkrichtlinie ist angefragt.

## Entscheidung

Die drei Adapter werden jetzt gebaut, nach bestem verfügbarem Wissen: den Vorgaben von Leitfaden und Architektur, Auszügen der offiziellen Seiten aus dem Suchindex und Sekundärquellen. Was davon nicht an der offiziellen Doku geprüft ist, steht unten. Die Abweichung von Regel 5 ist bewusst: Das Kriterium "Fertig, wenn" verlangt ohnehin einen echten Testbeitrag. Dieser Test prüft die ungeprüften Punkte, bevor ein Kunde die Adapter nutzt.

### Gemeinsam

- **Aufbau**: `packages/platform-adapters/src/linkedin`, `src/meta` und `src/x`, jeweils mit Connector, Adapter und Mapping der Kennzahlen (`MAP_VERSION` 1). `liveAdapters(env, deps)` baut sie aus den Umgebungsvariablen. `createAdapterRegistry` nimmt sie über `live` auf, in der API und in den Rollen `publisher`, `analytics` und `gdpr`.
- **Konfiguration**: `platformEnvSchema` kennt die Zugangsdaten. `checkPlatformEnv` lässt API und Worker nicht starten, wenn einer Plattform auf `live` ein Wert fehlt; die Meldung nennt die Variable, nie einen Wert. Instagram ist innerhalb von Meta optional: Ohne `INSTAGRAM_APP_ID` bleibt es weg (`null` in `live`), statt den Start zu verhindern.
- **HTTP**: Alle Aufrufe laufen über den `PlatformHttpClient` aus Schritt 4.4, mit dem gemeinsamen Rate-Limiter in Redis. Der Client kann jetzt auch Multipart-Uploads.
- **Medien**: LinkedIn, Facebook und X bekommen die Bilder als Upload. Der Adapter lädt die Rendition über ihre signierte URL. Nur Instagram holt die Bilder selbst ab und braucht deshalb einen aus dem Internet erreichbaren Speicher.
- **Erster Kommentar**: Er wird nach dem Beitrag gesendet. Scheitert er, schreibt der Adapter eine Warnung ins Log und meldet den Beitrag trotzdem als veröffentlicht.
- **Alt-Text**: Er darf einen Beitrag nie verhindern. Lehnt Instagram das Feld ab, legt der Adapter den Container ohne Alt-Text noch einmal an; lehnt X ihn ab, geht das Bild ohne raus. Beides steht als Warnung im Log.
- **Kennzahlen**:
  - Ein Rate-Limit mitten in einem Batch beendet den Batch mit den Ergebnissen bis dahin. Die übrigen Posts fragt der Collector später erneut ab.
  - Eine Metrik, die eine Plattform verweigert (zum Beispiel umbenannt), wird `null`. Die Rohdaten bleiben im Snapshot.
- **Tests**: Für jede Plattform gibt es einen Fake, der die Antworten in der bekannten Form nachbaut (`*.fake.ts`). Gegen ihn laufen die Contract-Suite und gezielte Tests. Die Suite hat dafür den optionalen Haken `removeOnPlatform` bekommen, weil Instagram Beiträge nicht über die API löscht.

### LinkedIn (Schritt 4.12)

- Eine App mit "Sign In with LinkedIn using OpenID Connect" und "Share on LinkedIn". Die Scopes sind `openid profile w_member_social`. Dazu kommen:
  - `r_member_postAnalytics` mit `LINKEDIN_MEMBER_ANALYTICS=true`;
  - die Scopes der Organisationen mit `LINKEDIN_ORGANIZATIONS=true`.

  So fragt die App nur nach dem, was LinkedIn ihr freigegeben hat.
- **Zweite App**: Die Architektur sieht für die Community Management API womöglich eine zweite App vor (`LINKEDIN_CM_*`). Das ist noch nicht gebaut: Der Connector-Port kennt eine App pro Plattform. Unterstützt LinkedIn die Organisationen auf derselben App nicht, folgt das als eigener Schritt.
- **Person und Seiten**:
  - Die Person kommt aus `/v2/userinfo` (`urn:li:person:{sub}`).
  - Die Seiten kommen aus `organizationAcls` mit den Rollen `ADMINISTRATOR` und `CONTENT_ADMINISTRATOR`.
  - Ohne Freigabe der Community Management API bleibt es beim Profil.
- **Text**: Der Text geht im Little Text Format raus. Reservierte Zeichen bekommen einen Backslash, Hashtags werden zur Vorlage `{hashtag|\#|Tag}`.
- **Bilder**: Jedes Bild durchläuft `initializeUpload`, dann `PUT`. Danach wartet der Adapter bis zu etwa 40 s auf `AVAILABLE`, sonst `MEDIA_PROCESSING`. Ein Bild geht als `media`, mehrere gehen als `multiImage`.
- **Reconcile**: Eigene Beiträge einer Person lassen sich nur mit einer eingeschränkten Berechtigung lesen. Der Reconcile findet deshalb bei Personen nichts, und eine unklare Variante geht auf `NEEDS_ATTENTION`. Seiten suchen in ihren letzten 20 Beiträgen.
- **Kennzahlen**:
  - Seiten nutzen `organizationalEntityShareStatistics` in einem Aufruf pro Batch. Ein Beitrag ohne Statistik wird einzeln auf 404 geprüft.
  - Personen nutzen `memberCreatorPostAnalytics`, einen Aufruf je Metrik, nur mit Freigabe. Ohne Freigabe sind alle Werte `null`.
- **Token**: Ein Zugang gilt 60 Tage. Gibt LinkedIn ein Refresh Token, erneuert der Adapter damit, sonst `not_supported`.

### Meta (Schritt 4.13)

- **Facebook-Login**:
  - Mit `META_LOGIN_CONFIG_ID` fragt der Login über die Konfiguration von Facebook Login for Business, sonst mit Scopes.
  - Das kurzlebige Token wird gegen ein langlebiges getauscht. Die gewährten Berechtigungen kommen aus `/me/permissions`, die Seiten mit ihren Tokens aus `/me/accounts`.
  - Seiten ohne die Aufgabe `CREATE_CONTENT` bietet die App nicht an.
- **Ablauf bei Facebook**: Die Seiten-Tokens laufen nicht ab. Der Datenzugriff der App endet aber 90 Tage nach der letzten Zustimmung. Die Verbindung zählt das als ihr Ende, damit der Token-Monitor rechtzeitig erinnert.
- **Facebook-Beiträge**:
  - Text geht an `/{page}/feed`.
  - Ein Foto geht als Datei an `/{page}/photos`, mit `alt_text_custom`.
  - Mehrere Fotos werden unveröffentlicht hochgeladen und über `attached_media` an einen Feed-Beitrag gehängt.

  Abweichung vom Leitfaden: Die Fotos gehen als Datei statt per URL, damit der Speicher für Facebook nicht öffentlich sein muss.
- **Instagram**: Instagram API mit Instagram Login.
  - Das Token aus dem Code-Tausch steht in `data[0]` (die alte, flache Form wird auch gelesen) und wird gegen ein langlebiges von 60 Tagen getauscht. Der Adapter erneuert es mit `ig_refresh_token`.
  - Vor jedem Beitrag prüft er `content_publishing_limit`; ist das Limit erreicht, kommt `RATE_LIMITED` mit einer Stunde Wartezeit.
  - Danach legt er die Container an (bei einem Karussell zuerst die Kinder) und wartet je Container auf `FINISHED`: nach 5 s, 15 s, 30 s und dann minütlich, höchstens 5 Minuten, mit `keepAlive` vor jeder Pause. Erst dann folgt `media_publish`.
  - Die Container-IDs stehen in `PublishResult.meta`. Ein neuer Lauf legt neue Container an, statt alte wiederzuverwenden: Der Port reicht die Daten früherer Versuche nicht an den Adapter.
- **Löschen bei Instagram**: Instagram löscht Beiträge nicht über die API, `deletePost` lehnt mit `VALIDATION_REJECTED` ab. Die App ruft `deletePost` derzeit nirgends auf.
- **Fehler**: Die Codes der Graph API werden vor der allgemeinen Abbildung übersetzt:

  | Code der Graph API | Ergebnis |
  |---|---|
  | 102, 190, 463, 467 | `AUTH_EXPIRED` |
  | 4, 9, 17, 32, 613, 80001 bis 80014 | `RATE_LIMITED`, Wartezeit aus `X-Business-Use-Case-Usage` |
  | 506 | `DUPLICATE` |
  | 10, 200 bis 299, 368 | `PERMISSION_DENIED` |
  | 100 mit Subcode 33 | nicht gefunden |
  | Subcode 2207027 | `MEDIA_PROCESSING` |
  | Subcode 2207052 | `VALIDATION_REJECTED` mit Hinweis auf den öffentlichen Speicher |

- **Callbacks**: `verifyMetaSignedRequest` prüft die `signed_request` der Callbacks für "App entfernt" und "Daten löschen". Die Endpunkte selbst fehlen noch: Sie müssen Verbindungen über alle Mandanten hinweg finden und brauchen dafür einen eigenen Weg mit `app_system`. Für das App-Review reicht vorerst die Seite mit der Anleitung zur Datenlöschung.

### X (Schritt 4.14)

- **OAuth**: OAuth 2.0 mit PKCE (S256) über `x.com/i/oauth2/authorize` und `api.x.com/2/oauth2/token`.
  - Ein vertraulicher Client meldet sich mit HTTP Basic an, ein öffentlicher nennt `client_id` im Body. Die Produktions-Vorlage verlangt einen vertraulichen Client ("Web App").
  - Ein verbrauchtes Refresh Token wird `AUTH_EXPIRED`. Die Erneuerung läuft unter dem Lock der Verbindung (`ConnectionTokens`).
- **Bilder**: Der Upload läuft in einem Aufruf über `POST /2/media/upload` (Multipart mit `media`, `media_category` und `media_type`). Der Alt-Text kommt über `POST /2/media/metadata`. Videos und Uploads in Teilen sind nicht gebaut, weil die Medien-Pipeline nur Bilder liefert.
- **Beiträge**: `POST /2/tweets`. Ein 403 mit "duplicate" wird `DUPLICATE`, ein 402 (kein Guthaben) `PERMISSION_DENIED`.
- **Kosten**:
  - Nach jedem Beitrag erfasst der Adapter `x.post_create`. Enthält der Text einen Link, ist es `x.post_create_with_url`. Die Oberfläche setzt `linkUrl` derzeit nicht, Links stehen im Text; das Ausgabenlimit rechnet deshalb ebenso.
  - Jeder gelesene Beitrag kostet `x.post_read`. Der Reconcile liest die letzten 5 Beiträge und vergleicht die Texte ohne Links, weil X sie auf t.co kürzt.
  - Für den Upload ist kein Preis bekannt; er wird nicht erfasst.
- **Kennzahlen**: `GET /2/tweets?ids=...` mit `public_metrics`, bis 100 je Aufruf. Ein Fehler `resource-not-found` heißt gelöscht.

### Produktion

- `deploy/compose.linkedin.yaml`, `compose.meta.yaml`, `compose.instagram.yaml` und `compose.x.yaml` geben API und Worker die Zugangsdaten, die Secrets als Dateien. `scripts/deploy.sh` nimmt sie dazu, wenn die Plattform auf `live` steht.
- `scripts/preflight.sh` verlangt die Secrets. Es warnt, wenn `SMP_EGRESS_HOSTS` die Medien-Domain fehlt: Der Worker liest die Bilder dort über den Egress-Proxy.

## Ungeprüft gegen die offizielle Doku

Diese Punkte stammen aus Sekundärquellen oder Auszügen im Suchindex. Sie sind beim ersten echten Beitrag je Plattform zu prüfen; sobald die Hosts freigegeben sind, auch an der Doku.

- **LinkedIn**:
  - die Antwortform von `initializeUpload` und der Upload-Host;
  - die Statuswerte von Bildern;
  - `organizationAcls` mit `q=roleAssignee`;
  - die Form der Rest.li-Listen in `organizationalEntityShareStatistics`;
  - `memberCreatorPostAnalytics` (Parameter und Antwort);
  - `networkSizes` mit `COMPANY_FOLLOWED_BY_MEMBER`;
  - die Kommentare über `socialActions`;
  - die Fehlermeldung bei Duplikaten;
  - der Endpunkt zum Widerruf;
  - die Fehlerwerte `user_cancelled_*` aus Schritt 4.5.
- **Meta**:
  - die Namen der Insights (`post_media_view`, `post_impressions_unique`, `post_clicks`; bei Instagram `views`, `reach`, `likes`, `comments`, `shares`, `saved`);
  - `alt_text_custom` bei Fotos und `alt_text` bei Instagram-Containern;
  - ob `graph.instagram.com` das Token im Header `Authorization: Bearer` annimmt;
  - die Subcodes 2207027 und 2207052;
  - ob Facebook Login for Business für Seiten-Tokens weitere Berechtigungen braucht (etwa `business_management`);
  - die Bildgrenzen für Facebook aus ADR 0020.
- **X**:
  - die Form des Uploads in einem Aufruf und von `media/metadata`;
  - die Fehlerform bei Duplikaten und bei fehlendem Guthaben;
  - die Lebensdauer der Refresh Tokens (angenommen: 180 Tage);
  - die Preise in `prices.ts`.

## Alternativen

- **Warten, bis die Doku erreichbar ist**: Das hält die App weiter ohne echte Plattformen. Verworfen, weil mit der App gepostet werden soll und der echte Testbeitrag die offenen Punkte ohnehin prüft.
- **SDKs der Plattformen**: Die Architektur schließt schwere Vendor-SDKs aus (Abschnitt 4.1). Die SDKs hätten dieselben Fragen nur verlagert.
- **Fotos für Facebook per URL**: Das braucht einen öffentlichen Speicher auch für Facebook. Der Upload als Datei kostet nur den Download im Worker.

## Konsequenzen

- Mit den Plattform-Apps aus der [Anleitung](../betrieb/plattformen-einrichten.md) lässt sich auf LinkedIn (Profil), Facebook-Seiten, Instagram und X veröffentlichen. Seiten bei LinkedIn kommen nach der Freigabe der Community Management API dazu.
- Die Schritte 4.12 bis 4.14 sind gebaut, ihr Kriterium "Fertig, wenn" aber erst mit dem echten Testbeitrag auf Staging erfüllt. Bei Meta gehört dazu auch das eingereichte App-Review.
- Bei Schritt 5.2 fehlen für die echten Plattformen noch die Tests mit bereinigten echten Payloads. Die Mappings sind gegen die Fakes getestet.
- Offen bleiben:
  - die Meta-Callbacks;
  - die zweite App für die Community Management API von LinkedIn, falls nötig;
  - Videos;
  - die Wiederverwendung von Instagram-Containern über Läufe hinweg.
