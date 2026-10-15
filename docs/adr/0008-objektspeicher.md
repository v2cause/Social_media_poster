# ADR 0008: Objektspeicher und Uploads

- **Status**: Akzeptiert (Spike e bestanden)
- **Datum**: 2026-10-15
- **Bezug**: Umsetzungsleitfaden, Schritte 0.3, 0.14(e) und 3.1 bis 3.3; `docs/ARCHITECTURE.md`, Abschnitte 1 und 9

## Kontext

Bilder werden direkt aus dem Browser in einen S3-kompatiblen Speicher hochgeladen. Der Speicher muss cloudunabhängig sein. MinIO ist als Community-Edition archiviert.

## Entscheidung

- **Schnittstelle**: AWS SDK v3, S3-kompatibel. Lokal läuft SeaweedFS 4.48, pinned im `compose.yaml`.
- **Upload**: Presigned PUT mit 5 Minuten Laufzeit und signiertem Content-Type. Die API prüft danach per `HeadObject` Größe und Typ, bevor das Asset als hochgeladen gilt.
- **CORS** wird über die S3-API am Bucket gesetzt (`put-bucket-cors`, Origins `http://localhost:3000` für `pnpm dev` und `http://localhost:8080` für den Proxy im Compose-Profil `app`).

## Spike (e): Ergebnis

`tools/spikes/s3-presign.ts`, alle fünf Prüfungen bestanden:

| Prüfung | Ergebnis |
|---|---|
| Presigned PUT mit signiertem Content-Type | HTTP 200 |
| `HeadObject` liefert Größe und Typ | 1028 Byte, `image/jpeg` |
| Anderer Content-Type als signiert | HTTP 403 |
| CORS-Preflight vom Web-Origin | HTTP 200, `allow-origin` gesetzt, `PUT` erlaubt |
| Abgelaufene URL | HTTP 403 |

Zwei Befunde aus dem Spike:

1. Neuere Versionen des AWS SDK setzen auch bei Presigned-URLs eine CRC32-Prüfsumme. Sie gilt für einen leeren Body, der Browser-Upload schlägt dann an der Signatur fehl. Gegenmaßnahme: `requestChecksumCalculation: 'WHEN_REQUIRED'`. Diese Einstellung gilt auch für den S3-Client der API.
2. SeaweedFS speichert die Identität des Masters im Volume. Ohne feste Identität startet ein neu erstellter Container mit anderer IP und meldet dann `raft.Server: Not current`. Gegenmaßnahme: `-ip=s3` im Compose-Befehl. Der Healthcheck prüft jetzt den S3-Port, denn der Master-Status war trotz Fehler als gesund gemeldet.

**Ausweichlösung**: Schlägt CORS in einer Zielumgebung fehl, läuft der Upload same-origin über einen Proxy-Pfad `/storage/*` der API.

## Alternativen

- **MinIO**: verworfen, die Community-Edition ist archiviert.
- **Presigned POST**: verworfen, Cloudflare R2 unterstützt es nicht.
- **Uploads über die API**: verworfen, die API würde die Dateien durchreichen und damit Last und Speicherbedarf tragen.

## Konsequenzen

- Der lokale Speicher prüft nicht, dass ein Upload vollständig ankommt. Das erledigt der `HeadObject`-Schritt.
- Die Bilder werden vor der Auslieferung neu kodiert (Schritt 3.3). Das Original geht nie an eine Plattform.
