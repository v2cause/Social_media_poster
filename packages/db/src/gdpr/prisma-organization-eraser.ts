import type { OrganizationEraser, SocialConnection } from '@smp/core';

import { toSocialConnection } from '../channels/mappers';
import { toGdprRequest } from './prisma-gdpr-requests';
import { Prisma } from '../generated/prisma/client';
import { runInSystemScope, type SystemPrismaClient } from '../system-client';

// The erasure of an organization on PostgreSQL (guide step 8.2, ADR 0037), as app_system. Most rows
// leave with the organization through the foreign keys; what the keys do not reach goes first: the
// media of the posts, whose key to the asset restricts, the notifications and feature flags, which
// have no key to the organization, the other data protection requests, which have none on purpose,
// and the webhook events of Stripe of its customer. Counting and check read the catalog, so a new
// table with an organization_id or a workspace_id is covered without a change here. The erasure
// request itself stays.

/** Long enough for a large organization; the job runs again after a timeout. */
const ERASE_TIMEOUT_MS = 10 * 60_000;
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

type Reader = Pick<Prisma.TransactionClient, '$queryRaw'>;

interface Target {
  organizationId: string;
  workspaceIds: readonly string[];
  keepRequestId: string;
  /** The customer at Stripe that the erasure deleted, once the subscription that named it is gone. */
  customerId: string | null;
}

/** A quoted identifier from the catalog, never from input. */
const identifier = (name: string): Prisma.Sql => {
  if (!IDENTIFIER.test(name)) {
    throw new RangeError(`Not an identifier: ${name}`);
  }
  return Prisma.raw(`"${name}"`);
};

/**
 * The webhook events of Stripe of the organization, or null when it has no customer there. The API
 * keeps only the ids of an event (ADR 0034): those of the customer and the subscription, which the
 * subscription of the organization names until the erasure deletes it.
 */
async function webhookEventsOf(tx: Reader, target: Target): Promise<Prisma.Sql | null> {
  const [subscription] = await tx.$queryRaw<{ customer: string | null; subscription: string | null }[]>`
    SELECT stripe_customer_id AS customer, stripe_subscription_id AS subscription
      FROM subscription WHERE organization_id = ${target.organizationId}::uuid`;
  const customers = [
    ...new Set([subscription?.customer, target.customerId].filter((id): id is string => Boolean(id))),
  ];
  const subscriptions = subscription?.subscription ? [subscription.subscription] : [];
  if (customers.length === 0 && subscriptions.length === 0) {
    return null;
  }
  return Prisma.sql`provider = 'stripe' AND (payload ->> 'customerId' = ANY(${customers}::text[])
                     OR payload ->> 'subscriptionId' = ANY(${subscriptions}::text[]))`;
}

/**
 * The rows of every table that name the organization or one of its workspaces, per table, and the
 * webhook events of its customer at Stripe.
 */
async function countRows(tx: Reader, target: Target): Promise<Record<string, number>> {
  const tables = await tx.$queryRaw<{ table_name: string; columns: string[] }[]>`
    SELECT table_name::text, array_agg(column_name::text ORDER BY column_name) AS columns
      FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name IN ('organization_id', 'workspace_id')
     GROUP BY table_name
     ORDER BY table_name`;
  const workspaceIds = [...target.workspaceIds];
  const counts: Record<string, number> = {};
  const [organization] = await tx.$queryRaw<{ count: number }[]>`
    SELECT count(*)::int AS count FROM organization WHERE id = ${target.organizationId}::uuid`;
  counts['organization'] = organization?.count ?? 0;
  for (const table of tables) {
    const conditions: Prisma.Sql[] = [];
    if (table.columns.includes('organization_id')) {
      conditions.push(Prisma.sql`organization_id = ${target.organizationId}::uuid`);
    }
    if (table.columns.includes('workspace_id')) {
      conditions.push(Prisma.sql`workspace_id = ANY(${workspaceIds}::uuid[])`);
    }
    // The erasure request is the record that the data is gone.
    const kept =
      table.table_name === 'gdpr_request'
        ? Prisma.sql`AND id <> ${target.keepRequestId}::uuid`
        : Prisma.empty;
    const [row] = await tx.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count FROM ${identifier(table.table_name)}
       WHERE (${Prisma.join(conditions, ' OR ')}) ${kept}`;
    counts[table.table_name] = row?.count ?? 0;
  }
  const events = await webhookEventsOf(tx, target);
  if (events) {
    const [row] = await tx.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count FROM webhook_event WHERE ${events}`;
    counts['webhook_event'] = row?.count ?? 0;
  }
  return counts;
}

const nonZero = (counts: Record<string, number>): Record<string, number> =>
  Object.fromEntries(Object.entries(counts).filter(([, count]) => count > 0));

export class PrismaOrganizationEraser implements OrganizationEraser {
  constructor(private readonly system: SystemPrismaClient) {}

  async connections(organizationId: string): Promise<SocialConnection[]> {
    const rows = await runInSystemScope(() =>
      this.system.socialConnection.findMany({
        where: { workspace: { organizationId } },
        orderBy: { id: 'asc' },
      }),
    );
    return rows.map(toSocialConnection);
  }

  async billingCustomerOf(organizationId: string): Promise<string | null> {
    const row = await runInSystemScope(() =>
      this.system.subscription.findUnique({ where: { organizationId }, select: { stripeCustomerId: true } }),
    );
    return row?.stripeCustomerId ?? null;
  }

  erase(
    organizationId: string,
    workspaceIds: readonly string[],
    keepRequestId: string,
  ): Promise<Record<string, number>> {
    const target = { organizationId, workspaceIds, keepRequestId, customerId: null };
    const workspaces = [...workspaceIds];
    return runInSystemScope(() =>
      this.system.$transaction(
        async (tx) => {
          const counts = await countRows(tx, target);
          const events = await webhookEventsOf(tx, target);
          await tx.$executeRaw`DELETE FROM post_media WHERE workspace_id = ANY(${workspaces}::uuid[])`;
          await tx.$executeRaw`
            DELETE FROM notification
             WHERE organization_id = ${organizationId}::uuid OR workspace_id = ANY(${workspaces}::uuid[])`;
          await tx.$executeRaw`
            DELETE FROM feature_flag
             WHERE organization_id = ${organizationId}::uuid OR workspace_id = ANY(${workspaces}::uuid[])`;
          await tx.$executeRaw`
            DELETE FROM gdpr_request WHERE organization_id = ${organizationId}::uuid AND id <> ${keepRequestId}::uuid`;
          if (events) {
            await tx.$executeRaw`DELETE FROM webhook_event WHERE ${events}`;
          }
          // Everything else follows through the foreign keys of the organization and its workspaces.
          await tx.$executeRaw`DELETE FROM workspace WHERE id = ANY(${workspaces}::uuid[])`;
          await tx.$executeRaw`DELETE FROM organization WHERE id = ${organizationId}::uuid`;
          return nonZero(counts);
        },
        { timeout: ERASE_TIMEOUT_MS, maxWait: 10_000 },
      ),
    );
  }

  leftovers(
    organizationId: string,
    workspaceIds: readonly string[],
    keepRequestId: string,
    customerId: string | null,
  ): Promise<Record<string, number>> {
    return runInSystemScope(async () =>
      nonZero(await countRows(this.system, { organizationId, workspaceIds, keepRequestId, customerId })),
    );
  }
}

/** What the check of an erasure finds (tools/check-erasure.ts). */
export interface ErasureCheck {
  /** The erasure request; null when there is none with this id. */
  request: {
    id: string;
    organizationId: string;
    status: string;
    workspaceIds: string[];
    /** The record still names who asked; a finished erasure names nobody. */
    namesRequester: boolean;
  } | null;
  /** Rows that still name the organization or one of its workspaces, per table. */
  rows: Record<string, number>;
}

/**
 * Checks an erasure in the database (guide step 8.2): the request, and every row that still names
 * the organization or one of its workspaces. The objects in the storage are checked separately.
 */
export async function checkErasure(system: SystemPrismaClient, requestId: string): Promise<ErasureCheck> {
  const row = await runInSystemScope(() =>
    system.gdprRequest.findFirst({ where: { id: requestId, kind: 'ERASURE' } }),
  );
  if (!row) {
    return { request: null, rows: {} };
  }
  const request = toGdprRequest(row);
  const ids = request.details['workspaceIds'];
  // The only list among the details.
  const workspaceIds = typeof ids === 'object' ? [...ids] : [];
  return {
    request: {
      id: request.id,
      organizationId: request.organizationId,
      status: request.status,
      workspaceIds,
      namesRequester: request.requestedById !== null,
    },
    // The customer at Stripe is known while the subscription of the organization is there.
    rows: await new PrismaOrganizationEraser(system).leftovers(
      request.organizationId,
      workspaceIds,
      request.id,
      null,
    ),
  };
}
