-- Row-level security for the tenancy tables (guide step 1.2, architecture 6.3).
--
-- The tenant extension sets the context per transaction with set_config(..., true):
--   app.user_id, app.organization_id, app.workspace_id and, for invitation links only,
--   app.invitation_token_hash.
-- Every policy reads it as NULLIF(current_setting(name, true), '')::uuid. After the first
-- transaction-local set_config a pooled connection returns '' instead of NULL, and ''::uuid would
-- fail; with NULLIF a query without context returns no rows. tools/check-rls.ts checks this.
--
-- FORCE applies the policies to the table owner (app_migrator) as well. app_system bypasses them.
-- The Better Auth tables (users, session, auth_account, verification, two_factor, rate_limit)
-- are global and stay without row-level security.

-- organization: keyed by its own id --------------------------------------------------------------
ALTER TABLE organization ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organization
  USING (id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
-- The organizations of the user's memberships, for the workspace switcher.
CREATE POLICY member_read ON organization FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.organization_id = organization.id
      AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  ));

-- workspace --------------------------------------------------------------------------------------
ALTER TABLE workspace ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workspace
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
-- The workspaces the user may open, without organization context: resolves /w/:ws (ADR 0010) and
-- fills the switcher. Owners and admins see all workspaces of the organization, other members all
-- of them unless their membership is restricted to some.
CREATE POLICY member_read ON workspace FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.organization_id = workspace.organization_id
      AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
      AND (
        m.role IN ('OWNER', 'ADMIN')
        OR NOT EXISTS (SELECT 1 FROM membership_workspace mw WHERE mw.membership_id = m.id)
        OR EXISTS (
          SELECT 1 FROM membership_workspace mw
          WHERE mw.membership_id = m.id AND mw.workspace_id = workspace.id
        )
      )
  ));

-- workspace_settings -----------------------------------------------------------------------------
ALTER TABLE workspace_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workspace_settings
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

-- membership -------------------------------------------------------------------------------------
ALTER TABLE membership ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON membership
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
-- The user's own memberships are readable without organization context.
CREATE POLICY own_memberships ON membership FOR SELECT
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

-- membership_workspace ---------------------------------------------------------------------------
ALTER TABLE membership_workspace ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership_workspace FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON membership_workspace
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY own_memberships ON membership_workspace FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.id = membership_workspace.membership_id
      AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  ));

-- invitation -------------------------------------------------------------------------------------
ALTER TABLE invitation ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitation FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invitation
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
-- Invitations to the address of the signed-in user.
CREATE POLICY own_invitations ON invitation FOR SELECT
  USING (email = (
    SELECT u.email FROM users u
    WHERE u.id = NULLIF(current_setting('app.user_id', true), '')::uuid
  ));
-- The holder of an invitation link reads that one invitation. Knowing the hash requires the token.
CREATE POLICY token_holder ON invitation FOR SELECT
  USING (token_hash = NULLIF(current_setting('app.invitation_token_hash', true), ''));

-- audit_log: append-only -------------------------------------------------------------------------
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON audit_log FOR SELECT
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY tenant_insert ON audit_log FOR INSERT
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
REVOKE UPDATE, DELETE ON audit_log FROM app_user;

-- notification and notification_preference: per user --------------------------------------------
ALTER TABLE notification ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification FORCE ROW LEVEL SECURITY;
CREATE POLICY own_notifications ON notification
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

ALTER TABLE notification_preference ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preference FORCE ROW LEVEL SECURITY;
CREATE POLICY own_preferences ON notification_preference
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

-- feature_flag: read-only at runtime; platform operators write through app_system ---------------
ALTER TABLE feature_flag ENABLE ROW LEVEL SECURITY;
ALTER TABLE feature_flag FORCE ROW LEVEL SECURITY;
CREATE POLICY scoped_read ON feature_flag FOR SELECT
  USING (
    (organization_id IS NULL
      OR organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
    AND (workspace_id IS NULL
      OR workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  );
