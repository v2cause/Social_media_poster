import type { DeletionBilling } from '../../gdpr/ports/gdpr-store';
import type { BillingGateway } from '../ports/billing-gateway';
import type { SubscriptionReader } from '../ports/subscription-store';
import { runsPaid } from './checkout';

// The subscription of an organization in deletion (guide step 8.2, ADR 0037): a paid subscription
// ends with its period, so that the owners pay no further period while the erasure waits; taking
// the deletion back lets it renew again. A trial or an ended subscription has nothing to end.

export class SubscriptionDeletionBilling implements DeletionBilling {
  constructor(
    private readonly deps: {
      subscriptions: Pick<SubscriptionReader, 'find'>;
      gateway: Pick<BillingGateway, 'setCancelAtPeriodEnd'>;
    },
  ) {}

  async endWithPeriod(organizationId: string, end: boolean): Promise<void> {
    const subscription = await this.deps.subscriptions.find(organizationId);
    if (!runsPaid(subscription)) {
      return;
    }
    await this.deps.gateway.setCancelAtPeriodEnd(subscription.stripeSubscriptionId, end);
  }
}
