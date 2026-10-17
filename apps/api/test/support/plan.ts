import type { ApiTestApp } from './api-app';

/** The keys of the price list (migration 0018). */
type PlanKey = 'trial' | 'starter' | 'pro' | 'agency';

/**
 * Puts an organization on a plan as if it had paid: active and writable, with single limits
 * overridden like the operators can (guide step 7.4). The tests that need more than the trial of
 * a new organization call it right after creating one.
 */
export async function onPlan(
  api: ApiTestApp,
  organizationId: string,
  plan: PlanKey = 'agency',
  overrides: Record<string, number | boolean> | null = null,
): Promise<void> {
  const client = await api.database.connectAs('app_system');
  try {
    await client.query(
      `UPDATE subscription
          SET plan_key = $2, status = 'ACTIVE', trial_ends_at = NULL, read_only_at = NULL, past_due_since = NULL,
              limit_overrides = $3::jsonb, updated_at = now()
        WHERE organization_id = $1`,
      [organizationId, plan, overrides === null ? null : JSON.stringify(overrides)],
    );
  } finally {
    await client.end();
  }
}
