import type {
  BillingCustomers,
  BillingState,
  Plan,
  StoredWebhook,
  Subscription,
  SubscriptionReader,
  SubscriptionSync,
  WebhookInbox,
} from '@smp/core';
import { z } from 'zod';

import type { PrismaClient } from '../generated/prisma/client';
import { runInSystemScope, type SystemPrismaClient } from '../system-client';
import { withTenantTx } from '../tenant-context';
import { toPlan, toSubscription } from './prisma-subscriptions';

// The stores of billing besides the reader (guide step 7.2, ADR 0034). The checkout stores the
// Stripe customer as app_user, which may change nothing else of a subscription. The API records a
// webhook as app_user; the role "billing" reads and marks it and writes plan and status as
// app_system, because Stripe names a customer, not a tenant.

const PROVIDER = 'stripe';

/** What the inbox keeps of an event: its ids, never the payload of Stripe. */
const payloadSchema = z.object({ subscriptionId: z.string().nullable(), customerId: z.string().nullable() });

export class PrismaBillingCustomers implements BillingCustomers {
  constructor(private readonly base: PrismaClient) {}

  saveCustomer(organizationId: string, customerId: string): Promise<string> {
    return withTenantTx(this.base, { organizationId }, async (tx) => {
      // The first customer stays; a second checkout at the same time keeps it.
      await tx.subscription.updateMany({
        where: { organizationId, stripeCustomerId: null },
        data: { stripeCustomerId: customerId },
      });
      const row = await tx.subscription.findUnique({
        where: { organizationId },
        select: { stripeCustomerId: true },
      });
      if (!row?.stripeCustomerId) {
        throw new Error(`The organization ${organizationId} has no subscription to store the customer in.`);
      }
      return row.stripeCustomerId;
    });
  }
}

/** Records the webhooks of Stripe once (app_user, the API). */
export class PrismaWebhookRecorder implements Pick<WebhookInbox, 'record'> {
  constructor(private readonly base: PrismaClient) {}

  async record(event: Omit<StoredWebhook, 'processedAt'>): Promise<{ processed: boolean }> {
    const payload = JSON.stringify({ subscriptionId: event.subscriptionId, customerId: event.customerId });
    await this.base.$executeRaw`
      INSERT INTO webhook_event (id, provider, external_id, type, payload)
      VALUES (gen_random_uuid(), ${PROVIDER}, ${event.id}, ${event.type}, ${payload}::jsonb)
      ON CONFLICT (provider, external_id) DO NOTHING`;
    const rows = await this.base.$queryRaw<{ processed_at: Date | null }[]>`
      SELECT processed_at FROM webhook_event WHERE provider = ${PROVIDER} AND external_id = ${event.id}`;
    return { processed: rows[0]?.processed_at != null };
  }
}

/** Reads and marks the recorded webhooks (app_system, the role "billing"). */
export class PrismaWebhookInbox implements Pick<WebhookInbox, 'find' | 'markProcessed'> {
  constructor(private readonly system: SystemPrismaClient) {}

  async find(eventId: string): Promise<StoredWebhook | null> {
    const row = await runInSystemScope(() =>
      this.system.webhookEvent.findUnique({
        where: { provider_externalId: { provider: PROVIDER, externalId: eventId } },
      }),
    );
    if (!row) {
      return null;
    }
    const payload = payloadSchema.parse(row.payload);
    return { id: row.externalId, type: row.type, processedAt: row.processedAt, ...payload };
  }

  async markProcessed(eventId: string, at: Date): Promise<void> {
    await runInSystemScope(() =>
      this.system.webhookEvent.updateMany({
        where: { provider: PROVIDER, externalId: eventId, processedAt: null },
        data: { processedAt: at },
      }),
    );
  }
}

/** The subscription as the role "billing" takes it over from Stripe (app_system). */
export class PrismaSubscriptionSync implements SubscriptionSync, Pick<SubscriptionReader, 'plans'> {
  constructor(private readonly system: SystemPrismaClient) {}

  /** The price list, to find the plan of the prices Stripe names. */
  async plans(): Promise<Plan[]> {
    const rows = await runInSystemScope(() => this.system.plan.findMany({ orderBy: { position: 'asc' } }));
    return rows.map(toPlan);
  }

  async byCustomer(customerId: string): Promise<Subscription | null> {
    const row = await runInSystemScope(() =>
      this.system.subscription.findUnique({
        where: { stripeCustomerId: customerId },
        include: { plan: true },
      }),
    );
    return row ? toSubscription(row) : null;
  }

  async save(organizationId: string, state: BillingState): Promise<void> {
    await runInSystemScope(() =>
      this.system.$transaction(async (tx) => {
        const current = await tx.subscription.findUniqueOrThrow({
          where: { organizationId },
          select: { readOnlyAt: true, readOnlyNotifiedAt: true },
        });
        // A new moment of read-only access is announced again.
        const sameReadOnly = current.readOnlyAt?.getTime() === state.readOnlyAt?.getTime();
        await tx.subscription.update({
          where: { organizationId },
          data: {
            ...state,
            readOnlyNotifiedAt: sameReadOnly ? current.readOnlyNotifiedAt : null,
            syncedAt: new Date(),
          },
        });
      }),
    );
  }
}

export interface BillingContact {
  userId: string;
  email: string;
  name: string;
  locale: string;
  timezone: string;
}

/** Who hears about the billing of an organization: its owners with a verified address (app_system). */
export class PrismaBillingDirectory {
  constructor(private readonly system: SystemPrismaClient) {}

  async owners(
    organizationId: string,
  ): Promise<{ organizationName: string; owners: BillingContact[] } | null> {
    const organization = await runInSystemScope(() =>
      this.system.organization.findUnique({
        where: { id: organizationId },
        select: {
          name: true,
          memberships: {
            where: { role: 'OWNER', user: { emailVerified: true } },
            select: {
              user: { select: { id: true, email: true, name: true, locale: true, timezone: true } },
            },
            orderBy: { createdAt: 'asc' },
          },
        },
      }),
    );
    return organization
      ? {
          organizationName: organization.name,
          owners: organization.memberships.map(({ user: { id, ...user } }) => ({ userId: id, ...user })),
        }
      : null;
  }
}
