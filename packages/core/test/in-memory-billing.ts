import type {
  BillingCustomers,
  BillingGateway,
  BillingJobs,
  BillingLock,
  BillingNotifier,
  BillingState,
  CheckoutRequest,
  InvoiceSummary,
  Plan,
  PlanPrice,
  PortalRequest,
  ProviderSubscription,
  StoredWebhook,
  Subscription,
  SubscriptionReader,
  SubscriptionSync,
  TrialStarter,
  WebhookInbox,
} from '../src';

// The price list of migration 0018 and an in-memory store of subscriptions for the use cases of
// billing.

export const TEST_PLANS: Plan[] = [
  {
    key: 'trial',
    priceLookupKey: null,
    position: 0,
    active: true,
    limits: {
      maxWorkspaces: 1,
      maxSocialAccounts: 3,
      maxMembers: 3,
      aiCreditsMicros: 2_000_000,
      aiOverageCapMicros: 0,
      scheduledPostsPerMonth: 30,
      storageBytes: 1024 ** 3,
      analyticsHistoryDays: 30,
      xBrowserAllowed: false,
      xApiSpendCapMicros: 1_000_000,
    },
  },
  {
    key: 'starter',
    priceLookupKey: 'smp_starter_monthly',
    position: 1,
    active: true,
    limits: {
      maxWorkspaces: 1,
      maxSocialAccounts: 5,
      maxMembers: 3,
      aiCreditsMicros: 10_000_000,
      aiOverageCapMicros: 10_000_000,
      scheduledPostsPerMonth: 150,
      storageBytes: 5 * 1024 ** 3,
      analyticsHistoryDays: 90,
      xBrowserAllowed: false,
      xApiSpendCapMicros: 10_000_000,
    },
  },
  {
    key: 'pro',
    priceLookupKey: 'smp_pro_monthly',
    position: 2,
    active: true,
    limits: {
      maxWorkspaces: 3,
      maxSocialAccounts: 15,
      maxMembers: 10,
      aiCreditsMicros: 30_000_000,
      aiOverageCapMicros: 50_000_000,
      scheduledPostsPerMonth: 600,
      storageBytes: 25 * 1024 ** 3,
      analyticsHistoryDays: 365,
      xBrowserAllowed: true,
      xApiSpendCapMicros: 50_000_000,
    },
  },
  {
    key: 'agency',
    priceLookupKey: 'smp_agency_monthly',
    position: 3,
    active: true,
    limits: {
      maxWorkspaces: 15,
      maxSocialAccounts: 75,
      maxMembers: 50,
      aiCreditsMicros: 100_000_000,
      aiOverageCapMicros: 200_000_000,
      scheduledPostsPerMonth: 3_000,
      storageBytes: 100 * 1024 ** 3,
      analyticsHistoryDays: 730,
      xBrowserAllowed: true,
      xApiSpendCapMicros: 200_000_000,
    },
  },
];

export const planOf = (key: Plan['key']): Plan => {
  const plan = TEST_PLANS.find((entry) => entry.key === key);
  if (!plan) {
    throw new Error(`No plan ${key}`);
  }
  return plan;
};

/** A subscription on a plan, active and without Stripe unless the patch says otherwise. */
export const subscriptionOf = (
  organizationId: string,
  key: Plan['key'],
  patch: Partial<Subscription> = {},
): Subscription => ({
  organizationId,
  plan: planOf(key),
  status: 'ACTIVE',
  limitOverrides: null,
  trialEndsAt: null,
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  currentPeriodStart: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  pastDueSince: null,
  readOnlyAt: null,
  billingStartedAt: null,
  ...patch,
});

export class MemorySubscriptions implements SubscriptionReader, TrialStarter {
  readonly rows = new Map<string, Subscription>();
  reads = 0;

  find(organizationId: string): Promise<Subscription | null> {
    this.reads += 1;
    return Promise.resolve(this.rows.get(organizationId) ?? null);
  }

  plans(): Promise<Plan[]> {
    return Promise.resolve(TEST_PLANS);
  }

  startTrial(trial: {
    id: string;
    organizationId: string;
    trialEndsAt: Date;
    readOnlyAt: Date;
  }): Promise<void> {
    this.rows.set(
      trial.organizationId,
      subscriptionOf(trial.organizationId, 'trial', {
        status: 'TRIALING',
        trialEndsAt: trial.trialEndsAt,
        readOnlyAt: trial.readOnlyAt,
      }),
    );
    return Promise.resolve();
  }

  put(subscription: Subscription): void {
    this.rows.set(subscription.organizationId, subscription);
  }
}

/** The provider as the use cases see it: it remembers what they asked for. */
export class FakeBillingGateway implements BillingGateway {
  readonly customers: { organizationId: string; name: string; email: string; locale: 'de' | 'en' }[] = [];
  readonly checkouts: CheckoutRequest[] = [];
  readonly portals: PortalRequest[] = [];
  readonly usage: Parameters<BillingGateway['reportUsage']>[0][] = [];
  readonly subscriptions = new Map<string, ProviderSubscription>();
  invoices: InvoiceSummary[] = [];

  createCustomer(customer: {
    organizationId: string;
    name: string;
    email: string;
    locale: 'de' | 'en';
  }): Promise<string> {
    this.customers.push(customer);
    return Promise.resolve(`cus_${String(this.customers.length)}`);
  }

  createCheckout(request: CheckoutRequest): Promise<string> {
    this.checkouts.push(request);
    return Promise.resolve(`https://checkout.example.test/c/${String(this.checkouts.length)}`);
  }

  createPortal(request: PortalRequest): Promise<string> {
    this.portals.push(request);
    return Promise.resolve(`https://portal.example.test/p/${String(this.portals.length)}`);
  }

  fetchSubscription(subscriptionId: string): Promise<ProviderSubscription | null> {
    return Promise.resolve(this.subscriptions.get(subscriptionId) ?? null);
  }

  listInvoices(): Promise<InvoiceSummary[]> {
    return Promise.resolve(this.invoices);
  }

  prices(lookupKeys: readonly string[]): Promise<PlanPrice[]> {
    return Promise.resolve(
      lookupKeys.map((lookupKey) => ({
        lookupKey,
        unitAmount: 4900,
        currency: 'eur',
        interval: 'month' as const,
      })),
    );
  }

  reportUsage(event: Parameters<BillingGateway['reportUsage']>[0]): Promise<void> {
    this.usage.push(event);
    return Promise.resolve();
  }
}

/** The stores of billing on top of MemorySubscriptions. */
export class MemoryBillingStores implements BillingCustomers, WebhookInbox, BillingJobs, SubscriptionSync {
  readonly webhooks = new Map<string, StoredWebhook>();
  readonly queued: string[] = [];

  constructor(private readonly subscriptions: MemorySubscriptions) {}

  saveCustomer(organizationId: string, customerId: string): Promise<string> {
    const subscription =
      this.subscriptions.rows.get(organizationId) ?? subscriptionOf(organizationId, 'trial');
    const kept = subscription.stripeCustomerId ?? customerId;
    this.subscriptions.put({ ...subscription, stripeCustomerId: kept });
    return Promise.resolve(kept);
  }

  record(event: Omit<StoredWebhook, 'processedAt'>): Promise<{ processed: boolean }> {
    const existing = this.webhooks.get(event.id);
    if (!existing) {
      this.webhooks.set(event.id, { ...event, processedAt: null });
    }
    return Promise.resolve({ processed: existing?.processedAt != null });
  }

  find(eventId: string): Promise<StoredWebhook | null> {
    return Promise.resolve(this.webhooks.get(eventId) ?? null);
  }

  markProcessed(eventId: string, at: Date): Promise<void> {
    const event = this.webhooks.get(eventId);
    if (event) {
      this.webhooks.set(eventId, { ...event, processedAt: at });
    }
    return Promise.resolve();
  }

  processWebhook(eventId: string): Promise<void> {
    this.queued.push(eventId);
    return Promise.resolve();
  }

  byCustomer(customerId: string): Promise<Subscription | null> {
    return Promise.resolve(
      [...this.subscriptions.rows.values()].find((row) => row.stripeCustomerId === customerId) ?? null,
    );
  }

  save(organizationId: string, state: BillingState): Promise<void> {
    const subscription = this.subscriptions.rows.get(organizationId);
    if (!subscription) {
      throw new Error(`No subscription of ${organizationId}`);
    }
    const { planKey, ...rest } = state;
    this.subscriptions.put({ ...subscription, ...rest, plan: planOf(planKey) });
    return Promise.resolve();
  }
}

export class RecordingBillingNotifier implements BillingNotifier {
  readonly paymentsFailed: { organizationId: string; graceEndsAt: Date }[] = [];

  paymentFailed(notice: { organizationId: string; graceEndsAt: Date }): Promise<void> {
    this.paymentsFailed.push(notice);
    return Promise.resolve();
  }
}

/** Runs the work at once and remembers the keys. */
export class RecordingLock implements BillingLock {
  readonly keys: string[] = [];

  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    this.keys.push(key);
    return work();
  }
}
