-- Row-level security of taking a deletion back (guide step 8.2, architecture 6.3, ADR 0037).
--
-- Same rules as the earlier rls_* migrations: FORCE applies the policies to the owner, every
-- policy reads the context as NULLIF(current_setting(name, true), '')::uuid, and app_system
-- bypasses them.

-- gdpr_request: the owners cancel the erasure of their organization while it waits, as app_user,
-- and change nothing else of a request. Everything else stays with the worker role "gdpr".
GRANT UPDATE (status, completed_at, updated_at) ON gdpr_request TO app_user;
CREATE POLICY erasure_cancel ON gdpr_request FOR UPDATE
  USING (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
    AND kind = 'ERASURE'
    AND status = 'PENDING'
  )
  WITH CHECK (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
    AND kind = 'ERASURE'
    AND status = 'CANCELED'
  );
