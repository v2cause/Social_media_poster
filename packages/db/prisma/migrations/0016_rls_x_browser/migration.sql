-- Row-level security for the X browser (guide step 6.1, architecture 6.3).
--
-- Same rules as the earlier rls_* migrations: FORCE applies the policies to the owner, every
-- policy reads the context as NULLIF(current_setting(name, true), '')::uuid, and app_system
-- bypasses them.

-- risk_acknowledgement: the record of who accepted which text stays. app_user adds rows and may
-- set revoked_at when the workspace switches the X browser off; it never changes the rest.
ALTER TABLE risk_acknowledgement ENABLE ROW LEVEL SECURITY;
ALTER TABLE risk_acknowledgement FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON risk_acknowledgement
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
REVOKE UPDATE, DELETE ON risk_acknowledgement FROM app_user;
GRANT UPDATE (revoked_at) ON risk_acknowledgement TO app_user;

-- feature_flag: a workspace switches its own flags. Global rows (the kill switch) and rows of an
-- organization (the plan gate until phase 7) stay with the platform admins, who write through
-- app_system. No row is ever deleted at runtime.
CREATE POLICY workspace_insert ON feature_flag FOR INSERT
  WITH CHECK (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
  );
CREATE POLICY workspace_update ON feature_flag FOR UPDATE
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (
    workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid
    AND organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
  );
REVOKE DELETE ON feature_flag FROM app_user;
