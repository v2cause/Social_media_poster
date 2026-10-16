-- Row-level security for the media tables (guide step 3.1, architecture 6.3).
--
-- Same rules as rls_content_ai: FORCE applies the policies to the owner, every policy reads the
-- context as NULLIF(current_setting(name, true), '')::uuid, and app_system bypasses them. The
-- media worker processes a job in the context of the workspace the job names.

ALTER TABLE media_asset ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_asset FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON media_asset
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE media_rendition ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_rendition FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON media_rendition
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE post_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE post_media FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON post_media
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
