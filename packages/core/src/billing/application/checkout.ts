import type { OrganizationActor } from '../../tenancy/domain/types';
import { NotPermittedError } from '../../shared/domain/errors';
import {
  BillingCustomerMissingError,
  BillingUnavailableError,
  SubscriptionExistsError,
} from '../domain/errors';
import type { PlanKey } from '../domain/plan';
import type { SubscriptionStatus } from '../domain/subscription';
import type { BillingGateway, InvoiceSummary } from '../ports/billing-gateway';
import type { BillingCustomers } from '../ports/billing-store';
import type { Subscription, SubscriptionReader } from '../ports/subscription-store';

// Checkout, customer portal and invoices (guide steps 7.2 and 7.5, ADR 0034). Only owners manage
// billing (architecture 10). The checkout never changes the subscription itself: Stripe reports
// the result with a webhook, and only that changes plan and status.

export interface BillingDependencies {
  /** Null while Stripe is not set up in the deployment. */
  gateway: BillingGateway | null;
  subscriptions: SubscriptionReader;
  customers: BillingCustomers;
  /** The public origin of the web app, for the ways back from Stripe. */
  appUrl: string;
}

/** The owner who pays, with the address Stripe sends the invoices to first. */
export type BillingActor = OrganizationActor & { email: string };

const RUNNING: readonly SubscriptionStatus[] = ['TRIALING', 'ACTIVE', 'PAST_DUE'];

const assertOwner = (actor: OrganizationActor): void => {
  if (actor.role !== 'OWNER') {
    throw new NotPermittedError();
  }
};

const gatewayOf = (deps: BillingDependencies): BillingGateway => {
  if (!deps.gateway) {
    throw new BillingUnavailableError();
  }
  return deps.gateway;
};

const billingPage = (deps: BillingDependencies, organizationId: string): string =>
  `${deps.appUrl}/org/${organizationId}/billing`;

/** A paid subscription that still runs; plans change in the customer portal then. */
const runsPaid = (
  subscription: Subscription | null,
): subscription is Subscription & { stripeSubscriptionId: string } =>
  subscription?.stripeSubscriptionId != null && RUNNING.includes(subscription.status);

export class StartCheckout {
  constructor(private readonly deps: BillingDependencies) {}

  async execute(input: {
    actor: BillingActor;
    organizationName: string;
    plan: Exclude<PlanKey, 'trial'>;
    locale: 'de' | 'en';
  }): Promise<string> {
    assertOwner(input.actor);
    const gateway = gatewayOf(this.deps);
    const { organizationId } = input.actor;
    const subscription = await this.deps.subscriptions.find(organizationId);
    if (runsPaid(subscription)) {
      throw new SubscriptionExistsError();
    }
    const plan = (await this.deps.subscriptions.plans()).find((entry) => entry.key === input.plan);
    if (!plan?.active || plan.priceLookupKey === null) {
      throw new BillingUnavailableError();
    }
    const customerId =
      subscription?.stripeCustomerId ??
      (await this.deps.customers.saveCustomer(
        organizationId,
        await gateway.createCustomer({
          organizationId,
          name: input.organizationName,
          email: input.actor.email,
          locale: input.locale,
        }),
      ));
    const page = billingPage(this.deps, organizationId);
    return gateway.createCheckout({
      customerId,
      organizationId,
      priceLookupKey: plan.priceLookupKey,
      locale: input.locale,
      successUrl: `${page}?checkout=success`,
      cancelUrl: `${page}?checkout=canceled`,
    });
  }
}

/** The customer portal: payment methods, invoices, addresses and cancellation. */
export class OpenBillingPortal {
  constructor(private readonly deps: BillingDependencies) {}

  async execute(input: { actor: OrganizationActor; locale: 'de' | 'en' }): Promise<string> {
    assertOwner(input.actor);
    const gateway = gatewayOf(this.deps);
    const subscription = await this.deps.subscriptions.find(input.actor.organizationId);
    if (!subscription?.stripeCustomerId) {
      throw new BillingCustomerMissingError();
    }
    return gateway.createPortal({
      customerId: subscription.stripeCustomerId,
      locale: input.locale,
      returnUrl: billingPage(this.deps, input.actor.organizationId),
    });
  }
}

/**
 * Moves a running paid subscription to another plan, up or down; the provider prorates the
 * difference. The plan of the organization changes with the webhook that follows, as always.
 * Resources beyond a smaller plan stay; only new ones are blocked (guide step 7.4).
 */
export class ChangePlan {
  constructor(private readonly deps: BillingDependencies) {}

  async execute(input: { actor: OrganizationActor; plan: Exclude<PlanKey, 'trial'> }): Promise<void> {
    assertOwner(input.actor);
    const gateway = gatewayOf(this.deps);
    const subscription = await this.deps.subscriptions.find(input.actor.organizationId);
    if (!runsPaid(subscription)) {
      throw new BillingCustomerMissingError();
    }
    if (subscription.plan.key === input.plan) {
      return;
    }
    const plan = (await this.deps.subscriptions.plans()).find((entry) => entry.key === input.plan);
    if (!plan?.active || plan.priceLookupKey === null) {
      throw new BillingUnavailableError();
    }
    await gateway.changePlan({
      subscriptionId: subscription.stripeSubscriptionId,
      priceLookupKey: plan.priceLookupKey,
    });
  }
}

export class ListInvoices {
  constructor(private readonly deps: BillingDependencies) {}

  /** Empty while Stripe is not set up or the organization never paid. */
  async execute(actor: OrganizationActor): Promise<InvoiceSummary[]> {
    assertOwner(actor);
    const subscription = await this.deps.subscriptions.find(actor.organizationId);
    if (!this.deps.gateway || !subscription?.stripeCustomerId) {
      return [];
    }
    return this.deps.gateway.listInvoices(subscription.stripeCustomerId);
  }
}
