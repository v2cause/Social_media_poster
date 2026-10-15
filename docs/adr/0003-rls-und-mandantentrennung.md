# ADR 0003: Row-Level Security und Mandantentrennung

- **Status**: Akzeptiert
- **Datum**: 2026-10-15
- **Bezug**: Umsetzungsleitfaden, Schritt 0.5 (Rollen), 1.2 (Policies), 1.3 (Kontext), Spike 0.14(b); `docs/ARCHITECTURE.md`, Abschnitt 6.3

## Kontext

Mandantendaten dürfen nie über eine vergessene Filterbedingung in der Anwendung sichtbar werden. Die Datenbank muss die Trennung erzwingen. Offen war, was Prisma und die transaktionslokale Mandanten-Variable kosten.

## Entscheidung

- **Rollen**: `app_migrator` ist Eigentümer und führt Migrationen aus. `app_user` nutzt die API und den Worker und hat kein BYPASSRLS. `app_system` hat BYPASSRLS und ist nur für die wenigen mandantenübergreifenden Jobs gedacht. Die Rollen legt `infra/docker/postgres/init/01-roles.sql` an. Verifiziert ist, dass `app_user` ohne BYPASSRLS verbindet und das falsche Passwort abgelehnt wird.
- **Policies**: `ENABLE` und `FORCE ROW LEVEL SECURITY`. Der Mandanten-Schlüssel richtet sich nach der Tabelle: Inhalte tragen `workspace_id`, Billing, Mitgliedschaft und Audit tragen `organization_id`. Die Tabelle `workspace` selbst hängt an `organization_id`. Damit ist die Abweichung zwischen Architektur 6.3 (nur `workspace_id`) und Leitfaden 1.2 aufgelöst.
- **Kontext**: `set_config('app.organization_id', …, true)` und `set_config('app.workspace_id', …, true)` laufen in derselben Transaktion wie die Abfrage. Nie ein sitzungsweites `SET`, weil sonst der Kontext an gepoolten Verbindungen hängen bleibt.

## Spike (b): Kosten und Isolation

Messung mit 1.000 Abfragen gegen die lokale Datenbank (`tools/spikes/rls-overhead.ts`):

| Variante | Ms pro Abfrage |
|---|---|
| ohne RLS | 0,79 |
| mit RLS, `set_config` im Batch | 1,45 |
| Mehrkosten | 0,66 (Faktor 1,8) |

Isolation: Die Organisation sieht 500 eigene Zeilen und 0 fremde. Der Test besteht.

Die Messung läuft ohne Netzwerk zwischen Anwendung und Datenbank. Im Betrieb fällt der Anteil der Mehrkosten an einer echten Anfrage deutlich kleiner aus.

**Ausweichlösung**: Wird der Overhead bei einem späteren Lasttest zu groß, setzt der Kontext nur für Tabellen mit RLS, nicht für jede Abfrage. Die Repositories filtern außerdem ausdrücklich nach der Mandanten-ID (Defense in Depth, siehe Architektur 6.3).

## Alternativen

- **Filter nur in der Anwendung**: verworfen. Ein vergessener Filter würde Daten offenlegen.
- **Eine Datenbank pro Mandant**: verworfen. Der Betrieb wird zu teuer, und Migrationen laufen dann pro Mandant.

## Konsequenzen

- Interaktive Transaktionen erhalten den Helfer `withTenantTx`, der den Kontext einmal am Anfang setzt.
- Materialized Views für Mandantendaten sind verboten, weil RLS auf ihnen nicht greift.
- Die CI prüft im Schritt 1.2 (`check-rls`), dass jede Mandanten-Tabelle RLS mit Policy hat.
