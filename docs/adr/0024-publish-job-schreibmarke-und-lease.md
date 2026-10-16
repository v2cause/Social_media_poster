# ADR 0024: Publish-Job mit Schreibmarke vor dem Senden, Token vor dem Reconcile und Lease pro Lauf

- **Status**: Akzeptiert
- **Datum**: 2026-10-16
- **Bezug**: Umsetzungsleitfaden, Schritt 4.8; `docs/ARCHITECTURE.md`, Abschnitte 4.1, 7, 7.1 und 16; [ADR 0004](0004-scheduling-und-outbox.md), [ADR 0023](0023-planen-zeitzonen-und-zustandsautomat.md)

## Kontext

Schritt 4.8 baut den Publish-Job. Die Architektur verlangt, dass nach einem unklaren Versuch zuerst `reconcile()` läuft und nie ein doppelter Post entsteht (7, Schritt 4), und sie nennt die Schritte in der Reihenfolge Reconcile (4), Token erneuern (5), validieren (6), Dry-Run (7), senden (8). Beim Umsetzen ergaben sich fünf Fragen:

1. Ein Versuch, dessen Worker abgestürzt ist, steht auf `STARTED`. Daran lässt sich nicht erkennen, ob die Anfrage schon an die Plattform ging. Findet der Reconcile nichts, ist offen, ob gesendet werden darf.
2. Der Reconcile liest bei der Plattform und braucht dafür ein gültiges Token. Bei X läuft das Access Token nach 2 h ab.
3. Wer gilt als Inhaber eines Lease? Ein Job, der in BullMQ als hängengeblieben gilt, kann in einem langsamen, aber lebenden Prozess noch laufen, während derselbe Job ein zweites Mal startet.
4. Instagram wartet bis zu 5 min auf seinen Container; der Lease muss in dieser Zeit verlängert werden, das Warten liegt aber im Adapter.
5. Ein Job, der zu oft hängenblieb, scheitert in BullMQ endgültig. Die Variante steht dann noch auf `PUBLISHING`.

## Entscheidung

- **Schreibmarke vor dem Senden**: Direkt vor `adapter.publish()` geht der Versuch von `STARTED` auf `UNKNOWN`. Ein Lauf, der danach stirbt, hinterlässt also `UNKNOWN` ("gesendet, Antwort fehlt"); einer, der vorher stirbt, `STARTED` ("vermutlich nichts gesendet").
- **Reconcile und danach**: Gibt es offene Versuche (`STARTED` oder `UNKNOWN`) oder lautet der Trigger `recheck`, läuft zuerst der Reconcile. Findet er den Post, ist die Variante `PUBLISHED` (Versuch `RECONCILED`). Findet er nichts:
  - bei `recheck` oder einem `UNKNOWN`-Versuch derselben `scheduleVersion`: `NEEDS_ATTENTION`, es wird nicht erneut gesendet;
  - sonst (nur `STARTED`, oder `UNKNOWN` einer früheren Version, auf die der Nutzer schon mit "trotzdem posten" oder "erneut" geantwortet hat): senden.
- **Unklarer Ausgang im Lauf**: `OUTCOME_UNKNOWN` und jeder unerwartete Fehler nach der Schreibmarke führen sofort zum Reconcile. Bleibt er ohne Fund, folgt `NEEDS_ATTENTION`; scheitert der Reconcile selbst, bleibt der Versuch `UNKNOWN` und der nächste Lauf gleicht zuerst ab. Ein unklarer Ausgang wird nie zu `FAILED`, weil "erneut" sonst ein zweites Mal senden könnte.
- **Token vor dem Reconcile**: Schritt 5 läuft vor Schritt 4. Ein Token, das in weniger als 5 min abläuft, wird unter dem Lock `lock:conn:{id}` erneuert, die Verbindung danach neu gelesen. Ein abgelehntes Token (`AUTH_EXPIRED`) bekommt pro Lauf genau einen erzwungenen Refresh, danach `NEEDS_REAUTH` und `FAILED(REAUTH_REQUIRED)`.
- **Dry-Run**: erneuert das Token wie ein echter Lauf und validiert, liest aber nicht (kein Reconcile, keine X-Kosten) und sendet nicht (Architektur 16).
- **Lease pro Lauf**: Inhaber des Lease ist das Lock-Token von BullMQ, das für jeden Lauf eines Jobs neu ist. Claim, Verlängerung und Ende sind Compare-and-Swap auf `version`, der Claim sperrt zusätzlich die Zeile (`FOR UPDATE`). Trifft ein Job auf den lebenden Lease eines anderen Laufs, wartet er bis zu dessen Ende plus einer Sekunde (`moveToDelayed`, ohne einen Versuch zu verbrauchen).
- **Lange Schritte im Adapter**: `AdapterContext.keepAlive()` verlängert den Lease; ist er verloren, wirft der Aufruf und der Lauf schreibt die Variante nicht mehr.
- **Endgültig gescheiterte Jobs**: BullMQ markiert einen zu oft hängengebliebenen Job und lässt ihn scheitern, sobald ein Worker ihn abholt. Der Sweeper (Schritt 4.7) findet die Variante auf `PUBLISHING` mit abgelaufenem Lease und startet den Job mit `job.retry()` neu; der neue Lauf gleicht zuerst ab.
- **Dead-Letter-Queue**: Ein Job ohne weiteren Versuch (endgültiger Fehler, erschöpfte Versuche oder zu oft hängengeblieben) hinterlässt eine Kopie in der Queue `publish-dead` (Job-ID `dead.pub.{variantId}.{scheduleVersion}`), die niemand verarbeitet; die Metrik `smp_worker_publish_dead_letters_total` speist den Alarm "Dead-Letter-Queue nicht leer" (Architektur 12).
- **Verpasstes Zeitfenster im Job**: Zusätzlich zum Tick prüft der Job bei den automatischen Triggern (`schedule`, `sweep`) eine Variante auf `QUEUED`: Mehr als 6 h nach ihrer Zeit endet sie mit `FAILED(MISSED_WINDOW)`, wenn der Workspace nicht "trotzdem posten" eingestellt hat.

## Alternativen

- **Reconcile nur bei `UNKNOWN`**: verworfen. Die Architektur verlangt den Abgleich nach jedem offenen Versuch; ein `STARTED`-Versuch kann kurz vor dem Absturz noch gesendet haben, wenn die Schreibmarke selbst nicht mehr gespeichert wurde.
- **Nach jedem Reconcile ohne Fund `NEEDS_ATTENTION`**: verworfen. Nach einem Absturz vor dem Senden wäre jede Variante eine Aufgabe für den Nutzer, obwohl nichts gesendet wurde.
- **Worker-ID plus Job-ID als Lease-Inhaber**: verworfen. Ein hängengebliebener Lauf und sein Nachfolger im selben Prozess hätten denselben Inhaber und könnten beide senden.
- **Refresh nach dem Reconcile wie in der Liste der Architektur**: verworfen. Der Reconcile scheitert sonst bei abgelaufenem Token, gerade bei X mit 2 h Laufzeit.

## Konsequenzen

- Der Chaos-Test (`apps/worker/test/publish.integration.test.ts`) stoppt einen Worker mitten in `publish`, startet einen neuen und zählt genau einen Post; ein zweiter Test lässt den Job endgültig scheitern, der Sweeper holt die Variante zurück.
- `docs/ARCHITECTURE.md` beschreibt in 7 die Reihenfolge und die Schreibmarke, in 4.1 `keepAlive`.
- Die Plattform-Adapter (Schritte 4.12 bis 4.14) müssen nach dem Senden jeden unklaren Ausgang als `OUTCOME_UNKNOWN` melden, ein 5xx vor dem Senden als `TRANSIENT`. Instagram ruft vor dem Warten auf den Container `keepAlive()` auf.
