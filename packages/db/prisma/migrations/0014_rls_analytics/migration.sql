-- Row-level security for the analytics tables (guide step 5.1, architecture 6.3).
--
-- Same rules as the earlier rls_* migrations: FORCE applies the policies to the owner, every
-- policy reads the context as NULLIF(current_setting(name, true), '')::uuid, and app_system
-- bypasses them. The analytics planner scans the due variants and accounts across workspaces as
-- app_system; the collector and the rollup write in the context of each workspace.

-- metric_snapshot: append-only for app_user, so the history of a post stays as it was polled ----
ALTER TABLE metric_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE metric_snapshot FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON metric_snapshot
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
REVOKE UPDATE, DELETE ON metric_snapshot FROM app_user;

-- post_metric_latest, account_metric_snapshot, analytics_daily: replaced by newer numbers ------
ALTER TABLE post_metric_latest ENABLE ROW LEVEL SECURITY;
ALTER TABLE post_metric_latest FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON post_metric_latest
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE account_metric_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_metric_snapshot FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON account_metric_snapshot
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE analytics_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_daily FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON analytics_daily
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
