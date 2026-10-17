-- Row-level security of the data protection requests (guide steps 8.1 and 8.2, architecture 6.3,
-- ADR 0036).
--
-- Same rules as the earlier rls_* migrations: FORCE applies the policies to the owner, every
-- policy reads the context as NULLIF(current_setting(name, true), '')::uuid, and app_system
-- bypasses them.

-- gdpr_request: keyed by organization, without a foreign key, so that the record of an erasure
-- can outlive the organization. The owners read the requests of their organization and add one
-- that waits; only the worker role "gdpr" changes them, as app_system.
ALTER TABLE gdpr_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE gdpr_request FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON gdpr_request FOR SELECT
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY request_insert ON gdpr_request FOR INSERT
  WITH CHECK (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
    AND status = 'PENDING'
    AND started_at IS NULL
    AND completed_at IS NULL
    AND object_key IS NULL
    AND expires_at IS NULL
  );
REVOKE UPDATE, DELETE ON gdpr_request FROM app_user;
