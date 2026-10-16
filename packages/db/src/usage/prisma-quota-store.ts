import { uuidV7Ids, type IdGenerator, type QuotaKey, type QuotaStore, type UsageSettlement } from '@smp/core';

import type { PrismaClient } from '../generated/prisma/client';
import { withTenantTx } from '../tenant-context';

// QuotaStore on PostgreSQL (guide step 2.6). Runs as app_user in the context of the organization,
// so row-level security limits every statement to its own counters and ledger. The period is
// passed as a date string: a Date parameter would be converted through the session time zone.

const dateOnly = (date: Date): string => date.toISOString().slice(0, 10);

export class PrismaQuotaStore implements QuotaStore {
  constructor(
    private readonly base: PrismaClient,
    private readonly ids: IdGenerator = uuidV7Ids,
  ) {}

  reserve(key: QuotaKey, amount: bigint, limit: bigint): Promise<bigint | null> {
    const period = dateOnly(key.periodStart);
    return withTenantTx(this.base, { organizationId: key.organizationId }, async (tx) => {
      // The counter of the period exists before the reservation, so the reservation is one
      // conditional update.
      await tx.$executeRaw`
        INSERT INTO usage_counter (id, organization_id, meter, period_start, value, updated_at)
        VALUES (${this.ids.newId()}::uuid, ${key.organizationId}::uuid, ${key.meter}, ${period}::date, 0, now())
        ON CONFLICT (organization_id, meter, period_start) DO NOTHING`;
      // The row lock serializes concurrent reservations, and PostgreSQL checks the condition again
      // on the row as the previous reservation left it: the sum never passes the limit.
      const rows = await tx.$queryRaw<{ value: bigint }[]>`
        UPDATE usage_counter
           SET value = value + ${amount}::bigint, updated_at = now()
         WHERE organization_id = ${key.organizationId}::uuid
           AND meter = ${key.meter}
           AND period_start = ${period}::date
           AND value + ${amount}::bigint <= ${limit}::bigint
        RETURNING value`;
      return rows[0]?.value ?? null;
    });
  }

  settle(key: QuotaKey, settlement: UsageSettlement): Promise<boolean> {
    const period = dateOnly(key.periodStart);
    const context = {
      organizationId: key.organizationId,
      ...(settlement.workspaceId === null ? {} : { workspaceId: settlement.workspaceId }),
    };
    return withTenantTx(this.base, context, async (tx) => {
      const booked = await tx.$executeRaw`
        INSERT INTO usage_record (id, organization_id, workspace_id, meter, source_type, source_id, quantity, period_start)
        VALUES (${this.ids.newId()}::uuid, ${key.organizationId}::uuid, ${settlement.workspaceId}::uuid,
                ${key.meter}, ${settlement.sourceType}, ${settlement.sourceId}::uuid,
                ${settlement.quantity}::bigint, ${period}::date)
        ON CONFLICT (source_type, source_id, meter) DO NOTHING`;
      if (booked === 0) {
        return false;
      }
      await tx.$executeRaw`
        UPDATE usage_counter
           SET value = GREATEST(value + ${settlement.quantity - settlement.reserved}::bigint, 0),
               updated_at = now()
         WHERE organization_id = ${key.organizationId}::uuid
           AND meter = ${key.meter}
           AND period_start = ${period}::date`;
      return true;
    });
  }

  current(key: QuotaKey): Promise<bigint> {
    return withTenantTx(this.base, { organizationId: key.organizationId }, async (tx) => {
      const rows = await tx.$queryRaw<{ value: bigint }[]>`
        SELECT value FROM usage_counter
         WHERE organization_id = ${key.organizationId}::uuid
           AND meter = ${key.meter}
           AND period_start = ${dateOnly(key.periodStart)}::date`;
      return rows[0]?.value ?? 0n;
    });
  }
}
