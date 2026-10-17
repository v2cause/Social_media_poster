import type { PlanUsage } from '@smp/core';

import { runInSystemScope, type SystemPrismaClient } from '../system-client';

// What an organization uses of the limits its plan counts across all its workspaces (guide step
// 7.4, ADR 0035). Accounts, posts and media are rows of one workspace each, which app_user sees
// only in the context of that workspace, so the counts run as app_system and read what is
// committed.

/** The variants that go out or went out: they count against the posts of their month. */
const COUNTED_STATUSES = ['SCHEDULED', 'QUEUED', 'PUBLISHING', 'RETRYING', 'PUBLISHED', 'NEEDS_ATTENTION'];

/** The calendar month (UTC) of a moment, as [start, end). */
function monthOf(at: Date): { start: Date; end: Date } {
  return {
    start: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)),
    end: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1)),
  };
}

export class PrismaPlanUsage implements PlanUsage {
  constructor(private readonly system: SystemPrismaClient) {}

  workspaces(organizationId: string): Promise<number> {
    return runInSystemScope(() => this.system.workspace.count({ where: { organizationId } }));
  }

  async members(organizationId: string, at: Date): Promise<number> {
    const [members, invitations] = await runInSystemScope(() =>
      Promise.all([
        this.system.membership.count({ where: { organizationId } }),
        this.system.invitation.count({
          where: { organizationId, acceptedAt: null, revokedAt: null, expiresAt: { gt: at } },
        }),
      ]),
    );
    return members + invitations;
  }

  async socialAccounts(organizationId: string): Promise<number> {
    const [row] = await runInSystemScope(
      () => this.system.$queryRaw<{ used: number }[]>`
        SELECT count(*)::int AS used
          FROM social_account a JOIN workspace w ON w.id = a.workspace_id
         WHERE w.organization_id = ${organizationId}::uuid AND a.disconnected_at IS NULL`,
    );
    return row?.used ?? 0;
  }

  async postsInMonth(organizationId: string, at: Date, exceptVariantId: string | null): Promise<number> {
    const { start, end } = monthOf(at);
    const [row] = await runInSystemScope(
      () => this.system.$queryRaw<{ used: number }[]>`
        SELECT count(*)::int AS used
          FROM post_variant v JOIN workspace w ON w.id = v.workspace_id
         WHERE w.organization_id = ${organizationId}::uuid
           AND v.status::text = ANY(${COUNTED_STATUSES})
           AND COALESCE(v.published_at, v.scheduled_at) >= ${start}
           AND COALESCE(v.published_at, v.scheduled_at) < ${end}
           AND v.id IS DISTINCT FROM ${exceptVariantId}::uuid`,
    );
    return row?.used ?? 0;
  }

  async storageBytes(organizationId: string): Promise<number> {
    // The measured size once the file arrived, the announced one before.
    const [row] = await runInSystemScope(
      () => this.system.$queryRaw<{ used: bigint }[]>`
        SELECT COALESCE(SUM(COALESCE(m.size_bytes, m.declared_size)), 0)::bigint AS used
          FROM media_asset m JOIN workspace w ON w.id = m.workspace_id
         WHERE w.organization_id = ${organizationId}::uuid
           AND m.deleted_at IS NULL
           AND m.status <> 'REJECTED'`,
    );
    return Number(row?.used ?? 0n);
  }

  async xApiSpendMicros(organizationId: string, at: Date): Promise<number> {
    const { start, end } = monthOf(at);
    const [row] = await runInSystemScope(
      () => this.system.$queryRaw<{ spent: bigint }[]>`
        SELECT COALESCE(SUM(cost_micros), 0)::bigint AS spent
          FROM api_cost_record
         WHERE organization_id = ${organizationId}::uuid AND platform = 'X'
           AND created_at >= ${start} AND created_at < ${end}`,
    );
    return Number(row?.spent ?? 0n);
  }
}
