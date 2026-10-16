-- Row-level security for the content and AI tables (guide step 2.1, architecture 6.3).
--
-- Same rules as rls_tenancy: FORCE applies the policies to the owner, every policy reads the
-- context as NULLIF(current_setting(name, true), '')::uuid, and app_system bypasses them.

-- post_style: presets (no workspace) are readable by everyone, custom styles by their workspace --
ALTER TABLE post_style ENABLE ROW LEVEL SECURITY;
ALTER TABLE post_style FORCE ROW LEVEL SECURITY;
CREATE POLICY presets_and_own_read ON post_style FOR SELECT
  USING (workspace_id IS NULL
    OR workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
-- Writes need the workspace of the context, so app_user can never change a preset.
CREATE POLICY own_insert ON post_style FOR INSERT
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY own_update ON post_style FOR UPDATE
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY own_delete ON post_style FOR DELETE
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

-- brand_voice, idea, post, post_variant: keyed by workspace ------------------------------------
ALTER TABLE brand_voice ENABLE ROW LEVEL SECURITY;
ALTER TABLE brand_voice FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON brand_voice
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE idea ENABLE ROW LEVEL SECURITY;
ALTER TABLE idea FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON idea
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE post ENABLE ROW LEVEL SECURITY;
ALTER TABLE post FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON post
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE post_variant ENABLE ROW LEVEL SECURITY;
ALTER TABLE post_variant FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON post_variant
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

-- brand_voice_version: immutable snapshots, insert and read only -------------------------------
ALTER TABLE brand_voice_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE brand_voice_version FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON brand_voice_version FOR SELECT
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY tenant_insert ON brand_voice_version FOR INSERT
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
REVOKE UPDATE, DELETE ON brand_voice_version FROM app_user;

-- ai_generation: written once when a call ends, insert and read only --------------------------
ALTER TABLE ai_generation ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_generation FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON ai_generation FOR SELECT
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY tenant_insert ON ai_generation FOR INSERT
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
REVOKE UPDATE, DELETE ON ai_generation FROM app_user;

-- usage_counter: keyed by organization; the quota service updates it atomically ---------------
ALTER TABLE usage_counter ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_counter FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON usage_counter
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
REVOKE DELETE ON usage_counter FROM app_user;

-- usage_record: the append-only ledger. The billing job of phase 7 marks rows as reported
-- through app_system. --------------------------------------------------------------------------
ALTER TABLE usage_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_record FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON usage_record FOR SELECT
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY tenant_insert ON usage_record FOR INSERT
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
REVOKE UPDATE, DELETE ON usage_record FROM app_user;

-- price_book: global reference data without a tenant. Readable at runtime, changed only by
-- migrations. ---------------------------------------------------------------------------------
REVOKE INSERT, UPDATE, DELETE ON price_book FROM app_user, app_system;
