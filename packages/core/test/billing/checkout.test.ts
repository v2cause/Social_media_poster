import { describe, expect, it } from 'vitest';

import {
  BillingCustomerMissingError,
  BillingUnavailableError,
  ListInvoices,
  NotPermittedError,
  OpenBillingPortal,
  StartCheckout,
  SubscriptionExistsError,
  type BillingActor,
  type BillingDependencies,
} from '../../src';
import {
  FakeBillingGateway,
  MemoryBillingStores,
  MemorySubscriptions,
  subscriptionOf,
} from '../in-memory-billing';

// Guide steps 7.2 and 7.5: checkout, customer portal and invoices for the owner.

const ORG = '0192f000-0000-7000-8000-000000000001';
const owner: BillingActor = {
  userId: 'user-1',
  organizationId: ORG,
  role: 'OWNER',
  email: 'owner@example.test',
};

const testbed = (withGateway = true) => {
  const subscriptions = new MemorySubscriptions();
  const stores = new MemoryBillingStores(subscriptions);
  const gateway = new FakeBillingGateway();
  const deps: BillingDependencies = {
    gateway: withGateway ? gateway : null,
    subscriptions,
    customers: stores,
    appUrl: 'https://app.example.test',
  };
  subscriptions.put(subscriptionOf(ORG, 'trial', { status: 'TRIALING' }));
  return { subscriptions, gateway, deps };
};

describe('checkout', () => {
  it('makes the organization a customer once and opens the checkout of the plan', async () => {
    const { subscriptions, gateway, deps } = testbed();
    const checkout = new StartCheckout(deps);

    const url = await checkout.execute({ actor: owner, organizationName: 'Acme', plan: 'pro', locale: 'de' });
    await checkout.execute({ actor: owner, organizationName: 'Acme', plan: 'agency', locale: 'en' });

    expect(url).toBe('https://checkout.example.test/c/1');
    expect(gateway.customers).toEqual([
      { organizationId: ORG, name: 'Acme', email: 'owner@example.test', locale: 'de' },
    ]);
    expect(subscriptions.rows.get(ORG)?.stripeCustomerId).toBe('cus_1');
    expect(gateway.checkouts).toEqual([
      {
        customerId: 'cus_1',
        organizationId: ORG,
        priceLookupKey: 'smp_pro_monthly',
        locale: 'de',
        successUrl: `https://app.example.test/org/${ORG}/billing?checkout=success`,
        cancelUrl: `https://app.example.test/org/${ORG}/billing?checkout=canceled`,
      },
      expect.objectContaining({ customerId: 'cus_1', priceLookupKey: 'smp_agency_monthly', locale: 'en' }),
    ]);
    // Only the webhook changes the plan.
    expect(subscriptions.rows.get(ORG)).toMatchObject({ status: 'TRIALING', plan: { key: 'trial' } });
  });

  it('sends a paying organization to the portal and refuses everybody but the owner', async () => {
    const { subscriptions, deps } = testbed();
    const checkout = new StartCheckout(deps);
    subscriptions.put(
      subscriptionOf(ORG, 'pro', { stripeCustomerId: 'cus_9', stripeSubscriptionId: 'sub_9' }),
    );

    await expect(
      checkout.execute({ actor: owner, organizationName: 'Acme', plan: 'agency', locale: 'de' }),
    ).rejects.toBeInstanceOf(SubscriptionExistsError);
    await expect(
      checkout.execute({
        actor: { ...owner, role: 'ADMIN' },
        organizationName: 'Acme',
        plan: 'pro',
        locale: 'de',
      }),
    ).rejects.toBeInstanceOf(NotPermittedError);

    // A subscription that ended does not stand in the way of a new one.
    subscriptions.put(
      subscriptionOf(ORG, 'pro', {
        status: 'CANCELED',
        stripeCustomerId: 'cus_9',
        stripeSubscriptionId: 'sub_9',
      }),
    );
    await expect(
      checkout.execute({ actor: owner, organizationName: 'Acme', plan: 'pro', locale: 'de' }),
    ).resolves.toMatch(/^https:/);
  });

  it('says so when Stripe is not set up', async () => {
    const { deps } = testbed(false);

    await expect(
      new StartCheckout(deps).execute({ actor: owner, organizationName: 'Acme', plan: 'pro', locale: 'de' }),
    ).rejects.toBeInstanceOf(BillingUnavailableError);
    await expect(new ListInvoices(deps).execute(owner)).resolves.toEqual([]);
  });
});

describe('customer portal and invoices', () => {
  it('opens the portal of the customer, straight to the change of plan when asked', async () => {
    const { subscriptions, gateway, deps } = testbed();
    const portal = new OpenBillingPortal(deps);
    await expect(portal.execute({ actor: owner, locale: 'de', flow: 'manage' })).rejects.toBeInstanceOf(
      BillingCustomerMissingError,
    );

    subscriptions.put(
      subscriptionOf(ORG, 'pro', { stripeCustomerId: 'cus_9', stripeSubscriptionId: 'sub_9' }),
    );
    await portal.execute({ actor: owner, locale: 'en', flow: 'change_plan' });
    await portal.execute({ actor: owner, locale: 'de', flow: 'manage' });

    expect(gateway.portals).toEqual([
      {
        customerId: 'cus_9',
        locale: 'en',
        returnUrl: `https://app.example.test/org/${ORG}/billing`,
        changePlanOf: 'sub_9',
      },
      { customerId: 'cus_9', locale: 'de', returnUrl: `https://app.example.test/org/${ORG}/billing` },
    ]);
  });

  it('lists the invoices of a customer and none before the first payment', async () => {
    const { subscriptions, gateway, deps } = testbed();
    gateway.invoices = [
      {
        id: 'in_1',
        number: 'SMP-0001',
        status: 'paid',
        total: 5831,
        currency: 'eur',
        createdAt: new Date('2026-10-01T08:00:00Z'),
        hostedInvoiceUrl: 'https://invoice.example.test/in_1',
        pdfUrl: null,
      },
    ];
    const invoices = new ListInvoices(deps);

    await expect(invoices.execute(owner)).resolves.toEqual([]);
    subscriptions.put(subscriptionOf(ORG, 'pro', { stripeCustomerId: 'cus_9' }));
    await expect(invoices.execute(owner)).resolves.toHaveLength(1);
  });
});
