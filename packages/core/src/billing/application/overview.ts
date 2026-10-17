import type { OrganizationActor } from '../../tenancy/domain/types';
import { NotPermittedError } from '../../shared/domain/errors';
import type { Clock } from '../../shared/ports/clock';
import type { QuotaService } from '../../usage/application/quota-service';
import { monthlyPeriodStart } from '../../usage/domain/meters';
import type { Plan } from '../domain/plan';
import type { BillingGateway, PlanPrice } from '../ports/billing-gateway';
import type { PlanUsage } from '../ports/plan-usage';
import type { SubscriptionReader } from '../ports/subscription-store';
import { runsPaid } from './checkout';
import type { Entitlements, EntitlementsService } from './entitlements';

// The billing page of an organization (guide step 7.5): its plan and the state of its
// subscription, what it uses of every limit, and the plans to compare with their prices. Only
// owners see it, like the rest of billing. After a downgrade a count can be beyond its limit; the
// page asks to reduce it then (guide step 7.4).

/** What an organization uses of its limits; the monthly ones in the calendar month (UTC) of now. */
export interface OrganizationUsage {
  workspaces: number;
  /** Members and open invitations, as the limit counts them. */
  members: number;
  socialAccounts: number;
  scheduledPosts: number;
  storageBytes: number;
  xApiMicros: number;
  aiMicros: number;
}

export interface BillingOverview {
  entitlements: Entitlements;
  /** Stripe is set up: checkout, plan changes and the portal work. */
  billingEnabled: boolean;
  /** A paid subscription runs: its plan changes in place, not with a new checkout. */
  hasRunningSubscription: boolean;
  /** The first day of the calendar month (UTC) the monthly limits count in. */
  periodStart: Date;
  usage: OrganizationUsage;
  /** The active plans in their order; a price is null without Stripe or for the trial. */
  plans: { plan: Plan; price: PlanPrice | null }[];
}

/** How long the prices stay in memory: they change rarely, and the page should not wait for Stripe. */
const PRICES_TTL_MS = 10 * 60_000;
/** A list that misses a price, for example while Stripe is away, is asked for again this soon. */
const INCOMPLETE_PRICES_TTL_MS = 60_000;

/** The prices of the plans from the provider, kept in memory for a while. */
export class PlanPrices {
  private cached: { key: string; until: number; prices: PlanPrice[] } | null = null;

  constructor(private readonly deps: { gateway: Pick<BillingGateway, 'prices'>; clock: Clock }) {}

  async of(lookupKeys: readonly string[]): Promise<PlanPrice[]> {
    const key = [...lookupKeys].sort().join(',');
    const now = this.deps.clock.now().getTime();
    if (this.cached?.key === key && this.cached.until > now) {
      return this.cached.prices;
    }
    const prices = await this.deps.gateway.prices(lookupKeys);
    const complete = lookupKeys.every((lookupKey) => prices.some((price) => price.lookupKey === lookupKey));
    this.cached = { key, until: now + (complete ? PRICES_TTL_MS : INCOMPLETE_PRICES_TTL_MS), prices };
    return prices;
  }
}

export interface BillingOverviewDependencies {
  entitlements: Pick<EntitlementsService, 'of'>;
  subscriptions: Pick<SubscriptionReader, 'plans'>;
  usage: PlanUsage;
  quota: Pick<QuotaService, 'usage'>;
  /** Null while Stripe is not set up in the deployment. */
  prices: Pick<PlanPrices, 'of'> | null;
  clock: Clock;
}

export class GetBillingOverview {
  constructor(private readonly deps: BillingOverviewDependencies) {}

  async execute(actor: OrganizationActor): Promise<BillingOverview> {
    if (actor.role !== 'OWNER') {
      throw new NotPermittedError();
    }
    const { organizationId } = actor;
    const now = this.deps.clock.now();
    const [entitlements, plans, usage] = await Promise.all([
      this.deps.entitlements.of(organizationId),
      this.deps.subscriptions.plans(),
      this.usageOf(organizationId, now),
    ]);
    const offered = plans.filter((plan) => plan.active).sort((left, right) => left.position - right.position);
    const lookupKeys = offered.flatMap((plan) => (plan.priceLookupKey ? [plan.priceLookupKey] : []));
    const prices = this.deps.prices && lookupKeys.length > 0 ? await this.deps.prices.of(lookupKeys) : [];
    return {
      entitlements,
      billingEnabled: this.deps.prices !== null,
      hasRunningSubscription: runsPaid(entitlements),
      periodStart: monthlyPeriodStart(now),
      usage,
      plans: offered.map((plan) => ({
        plan,
        price: prices.find((price) => price.lookupKey === plan.priceLookupKey) ?? null,
      })),
    };
  }

  private async usageOf(organizationId: string, now: Date): Promise<OrganizationUsage> {
    const { usage } = this.deps;
    const [workspaces, members, socialAccounts, scheduledPosts, storageBytes, xApiMicros, ai] =
      await Promise.all([
        usage.workspaces(organizationId),
        usage.members(organizationId, now),
        usage.socialAccounts(organizationId),
        usage.postsInMonth(organizationId, now, null),
        usage.storageBytes(organizationId),
        usage.xApiSpendMicros(organizationId, now),
        this.deps.quota.usage(organizationId, 'ai_micros'),
      ]);
    return {
      workspaces,
      members,
      socialAccounts,
      scheduledPosts,
      storageBytes,
      xApiMicros,
      aiMicros: Number(ai.used),
    };
  }
}
