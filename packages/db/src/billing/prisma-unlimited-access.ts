import { UNLIMITED_PLAN_LIMITS } from '@smp/contracts';
import { assertSafeAuditMetadata } from '@smp/core';

import { runInSystemScope, type SystemPrismaClient } from '../system-client';

// Unlimited access for the operators' own use (ADR 0047): the organizations a person owns go on
// the largest plan, active, without trial, grace period or read-only, and with every limit at
// its largest value. Nothing is billed, because only an organization with a Stripe customer and
// a started subscription reports usage. An organization that Stripe bills keeps its subscription,
// since the next webhook would overwrite the change. Writes as app_system: plan and status are
// not writable for app_user (ADR 0033).

/** The plan an unlimited organization shows; its limits are overridden. */
export const UNLIMITED_PLAN_KEY = 'agency';

export interface OwnedOrganization {
  id: string;
  name: string;
  /** Unlimited already: active on the plan with the unlimited limits. */
  unlimited: boolean;
  /** Billed through Stripe, so not changed here. */
  billedByStripe: boolean;
}

export type UnlimitedGrant = 'granted' | 'unchanged' | 'billed_by_stripe';

/** Whether stored overrides are the unlimited limits; PostgreSQL keeps JSON keys in its own order. */
function sameLimits(overrides: unknown): boolean {
  if (typeof overrides !== 'object' || overrides === null) {
    return false;
  }
  const stored = overrides as Record<string, unknown>;
  const expected = Object.entries(UNLIMITED_PLAN_LIMITS);
  return (
    Object.keys(stored).length === expected.length && expected.every(([key, value]) => stored[key] === value)
  );
}

export class PrismaUnlimitedAccess {
  constructor(private readonly system: SystemPrismaClient) {}

  /** The user with this address and the organizations the user owns; null without such a user. */
  async ownedOrganizations(
    email: string,
  ): Promise<{ userId: string; organizations: OwnedOrganization[] } | null> {
    return runInSystemScope(async () => {
      const user = await this.system.user.findUnique({ where: { email }, select: { id: true } });
      if (!user) {
        return null;
      }
      const memberships = await this.system.membership.findMany({
        where: { userId: user.id, role: 'OWNER', organization: { deletedAt: null } },
        select: {
          organization: {
            select: {
              id: true,
              name: true,
              subscription: {
                select: { planKey: true, status: true, limitOverrides: true, stripeSubscriptionId: true },
              },
            },
          },
        },
        orderBy: { organizationId: 'asc' },
      });
      return {
        userId: user.id,
        organizations: memberships.map(({ organization }) => {
          const subscription = organization.subscription;
          return {
            id: organization.id,
            name: organization.name,
            unlimited:
              subscription?.planKey === UNLIMITED_PLAN_KEY &&
              subscription.status === 'ACTIVE' &&
              sameLimits(subscription.limitOverrides),
            billedByStripe: subscription?.stripeSubscriptionId != null,
          };
        }),
      };
    });
  }

  /**
   * Makes one organization unlimited and records it in its audit log, in one transaction. The
   * operator acts outside the app, so the entry has no actor; the ticket names the request.
   */
  async grant(organizationId: string, ticket: string, now: Date): Promise<UnlimitedGrant> {
    return runInSystemScope(() =>
      this.system.$transaction(async (tx) => {
        const current = await tx.subscription.findUnique({
          where: { organizationId },
          select: { planKey: true, status: true, limitOverrides: true, stripeSubscriptionId: true },
        });
        if (current?.stripeSubscriptionId != null) {
          return 'billed_by_stripe';
        }
        if (
          current?.planKey === UNLIMITED_PLAN_KEY &&
          current.status === 'ACTIVE' &&
          sameLimits(current.limitOverrides)
        ) {
          return 'unchanged';
        }
        const state = {
          planKey: UNLIMITED_PLAN_KEY,
          status: 'ACTIVE' as const,
          limitOverrides: UNLIMITED_PLAN_LIMITS,
          trialEndsAt: null,
          pastDueSince: null,
          readOnlyAt: null,
          readOnlyNotifiedAt: null,
          cancelAtPeriodEnd: false,
        };
        await tx.subscription.upsert({
          where: { organizationId },
          create: { organizationId, ...state },
          update: state,
        });
        const metadata = { plan: UNLIMITED_PLAN_KEY, previousPlan: current?.planKey ?? null, ticket };
        assertSafeAuditMetadata(metadata);
        await tx.auditLog.create({
          data: {
            organizationId,
            actorUserId: null,
            action: 'billing.unlimited_granted',
            targetType: 'subscription',
            targetId: organizationId,
            metadata,
            createdAt: now,
          },
        });
        return 'granted';
      }),
    );
  }
}
