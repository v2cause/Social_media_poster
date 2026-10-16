-- Row-level security for the channel and publishing tables (guide step 4.1, architecture 6.3).
--
-- Same rules as rls_content_ai and rls_media: FORCE applies the policies to the owner, every
-- policy reads the context as NULLIF(current_setting(name, true), '')::uuid, and app_system
-- bypasses them. The scheduler tick, the sweeper, the token monitor and the outbox relay scan
-- across workspaces as app_system and continue every row in the context of its workspace.

-- social_connection, social_account: keyed by workspace ---------------------------------------
ALTER TABLE social_connection ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_connection FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON social_connection
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE social_account ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_account FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON social_account
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

-- publish_attempt: the log of the publish job; app_user finishes attempts but never removes them --
ALTER TABLE publish_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE publish_attempt FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON publish_attempt
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
REVOKE DELETE ON publish_attempt FROM app_user;

-- outbox_event: written in the transaction of a change; only the relay (app_system) marks events
-- as processed. -------------------------------------------------------------------------------
ALTER TABLE outbox_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON outbox_event FOR SELECT
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY tenant_insert ON outbox_event FOR INSERT
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
REVOKE UPDATE, DELETE ON outbox_event FROM app_user;

-- api_cost_record: the append-only cost ledger, keyed by organization like usage_record ---------
ALTER TABLE api_cost_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_cost_record FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON api_cost_record FOR SELECT
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY tenant_insert ON api_cost_record FOR INSERT
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
REVOKE UPDATE, DELETE ON api_cost_record FROM app_user;

-- webhook_event: global, without a tenant. The API records an event once and reads it back for
-- the answer; the worker processes it as app_system, because a deauthorization can concern
-- connections in several workspaces. ----------------------------------------------------------
REVOKE UPDATE, DELETE ON webhook_event FROM app_user;
