import type { Clock } from '../../shared/ports/clock';
import { graceEndOf } from '../domain/subscription';
import { syncSubscription, type BillingState } from '../domain/sync';
import {
  BILLING_WEBHOOK_TYPES,
  type BillingGateway,
  type BillingWebhookEvent,
} from '../ports/billing-gateway';
import type {
  BillingJobs,
  BillingLock,
  BillingNotifier,
  SubscriptionSync,
  WebhookInbox,
} from '../ports/billing-store';
import type { Subscription, SubscriptionReader } from '../ports/subscription-store';

// The webhooks of Stripe (guide step 7.2, ADR 0034): the API checks the signature, records each
// event once and hands it to the role "billing", which reads the subscription from Stripe and
// takes it over. The order of the events does not matter, and an event delivered twice changes
// nothing.

const HANDLED: readonly string[] = BILLING_WEBHOOK_TYPES;

export class RecordStripeWebhook {
  constructor(private readonly deps: { inbox: Pick<WebhookInbox, 'record'>; jobs: BillingJobs }) {}

  /** Records an event and queues it unless it was processed already; other types are ignored. */
  async execute(event: BillingWebhookEvent): Promise<'queued' | 'duplicate' | 'ignored'> {
    if (!HANDLED.includes(event.type)) {
      return 'ignored';
    }
    const { processed } = await this.deps.inbox.record({
      id: event.id,
      type: event.type,
      subscriptionId: event.subscriptionId,
      customerId: event.customerId,
    });
    if (processed) {
      return 'duplicate';
    }
    await this.deps.jobs.processWebhook(event.id);
    return 'queued';
  }
}

export interface ProcessStripeWebhookDependencies {
  inbox: Pick<WebhookInbox, 'find' | 'markProcessed'>;
  gateway: BillingGateway;
  subscriptions: Pick<SubscriptionReader, 'plans'>;
  sync: SubscriptionSync;
  lock: BillingLock;
  notifier: BillingNotifier;
  clock: Clock;
}

export type ProcessStripeWebhookResult =
  | 'missing'
  | 'done_before'
  | 'no_subscription'
  | 'unknown_subscription'
  | 'unknown_customer'
  | 'not_started'
  | 'other_subscription'
  | 'synced';

const stateOf = (subscription: Subscription): BillingState => ({
  planKey: subscription.plan.key,
  status: subscription.status,
  trialEndsAt: subscription.trialEndsAt,
  stripeSubscriptionId: subscription.stripeSubscriptionId,
  currentPeriodStart: subscription.currentPeriodStart,
  currentPeriodEnd: subscription.currentPeriodEnd,
  cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
  pastDueSince: subscription.pastDueSince,
  readOnlyAt: subscription.readOnlyAt,
  billingStartedAt: subscription.billingStartedAt,
});

export class ProcessStripeWebhook {
  constructor(private readonly deps: ProcessStripeWebhookDependencies) {}

  async execute(eventId: string): Promise<ProcessStripeWebhookResult> {
    const { deps } = this;
    const event = await deps.inbox.find(eventId);
    if (!event) {
      return 'missing';
    }
    if (event.processedAt) {
      return 'done_before';
    }
    const subscriptionId = event.subscriptionId;
    const result: ProcessStripeWebhookResult =
      subscriptionId === null
        ? 'no_subscription'
        : await deps.lock.run(`billing.${event.customerId ?? subscriptionId}`, () =>
            this.sync(subscriptionId),
          );
    await deps.inbox.markProcessed(eventId, deps.clock.now());
    return result;
  }

  private async sync(subscriptionId: string): Promise<ProcessStripeWebhookResult> {
    const { deps } = this;
    const reported = await deps.gateway.fetchSubscription(subscriptionId);
    if (!reported) {
      return 'unknown_subscription';
    }
    const local = await deps.sync.byCustomer(reported.customerId);
    if (!local) {
      return 'unknown_customer';
    }
    const plan = (await deps.subscriptions.plans()).find(
      (entry) => entry.priceLookupKey !== null && reported.priceLookupKeys.includes(entry.priceLookupKey),
    );
    const now = deps.clock.now();
    const outcome = syncSubscription(stateOf(local), { ...reported, planKey: plan?.key ?? null }, now);
    if (outcome.kind === 'ignored') {
      return outcome.reason;
    }
    await deps.sync.save(local.organizationId, outcome.state);
    if (outcome.pastDueStarted && outcome.state.pastDueSince) {
      await deps.notifier.paymentFailed({
        organizationId: local.organizationId,
        graceEndsAt: graceEndOf(outcome.state.pastDueSince),
      });
    }
    return 'synced';
  }
}
