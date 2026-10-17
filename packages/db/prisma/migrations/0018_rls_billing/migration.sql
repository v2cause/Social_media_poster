-- The price list, the trial of existing organizations and row-level security of billing (guide
-- steps 7.1 to 7.3, architecture 6.3, ADR 0033).
--
-- Same rules as the earlier rls_* migrations: FORCE applies the policies to the owner, every
-- policy reads the context as NULLIF(current_setting(name, true), '')::uuid, and app_system
-- bypasses them. The rows below are written before row-level security is switched on.

-- plan: the price list, reference data like the price book. The limits are checked against
-- planLimitsSchema of @smp/contracts by a test; the amounts are placeholders until the prices are
-- set in Stripe (tools/stripe-sync.ts).
INSERT INTO plan (key, limits, price_lookup_key, position) VALUES
  ('trial', '{"maxWorkspaces": 1, "maxSocialAccounts": 3, "maxMembers": 3, "aiCreditsMicros": 2000000, "aiOverageCapMicros": 0, "scheduledPostsPerMonth": 30, "storageBytes": 1073741824, "analyticsHistoryDays": 30, "xBrowserAllowed": false, "xApiSpendCapMicros": 1000000}', NULL, 0),
  ('starter', '{"maxWorkspaces": 1, "maxSocialAccounts": 5, "maxMembers": 3, "aiCreditsMicros": 10000000, "aiOverageCapMicros": 10000000, "scheduledPostsPerMonth": 150, "storageBytes": 5368709120, "analyticsHistoryDays": 90, "xBrowserAllowed": false, "xApiSpendCapMicros": 10000000}', 'smp_starter_monthly', 1),
  ('pro', '{"maxWorkspaces": 3, "maxSocialAccounts": 15, "maxMembers": 10, "aiCreditsMicros": 30000000, "aiOverageCapMicros": 50000000, "scheduledPostsPerMonth": 600, "storageBytes": 26843545600, "analyticsHistoryDays": 365, "xBrowserAllowed": true, "xApiSpendCapMicros": 50000000}', 'smp_pro_monthly', 2),
  ('agency', '{"maxWorkspaces": 15, "maxSocialAccounts": 75, "maxMembers": 50, "aiCreditsMicros": 100000000, "aiOverageCapMicros": 200000000, "scheduledPostsPerMonth": 3000, "storageBytes": 107374182400, "analyticsHistoryDays": 730, "xBrowserAllowed": true, "xApiSpendCapMicros": 200000000}', 'smp_agency_monthly', 3);
REVOKE INSERT, UPDATE, DELETE ON plan FROM app_user, app_system;

-- Organizations from before billing start a trial of 14 days now, like a new one.
INSERT INTO subscription (id, organization_id, plan_key, status, trial_ends_at, read_only_at, updated_at)
SELECT gen_random_uuid(), o.id, 'trial', 'TRIALING', now() + interval '14 days', now() + interval '14 days', now()
  FROM organization o;

-- subscription: keyed by organization. app_user reads it, a new organization adds its trial, and
-- the checkout stores the Stripe customer; plan and status come only from the webhooks, which the
-- role "billing" writes as app_system.
ALTER TABLE subscription ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON subscription FOR SELECT
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY trial_insert ON subscription FOR INSERT
  WITH CHECK (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
    AND plan_key = 'trial'
    AND status = 'TRIALING'
    AND limit_overrides IS NULL
    AND stripe_customer_id IS NULL
    AND stripe_subscription_id IS NULL
    AND billing_started_at IS NULL
  );
CREATE POLICY customer_update ON subscription FOR UPDATE
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
REVOKE UPDATE, DELETE ON subscription FROM app_user;
GRANT UPDATE (stripe_customer_id, updated_at) ON subscription TO app_user;
