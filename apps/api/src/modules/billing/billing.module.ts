import { Module } from '@nestjs/common';

import { BillingController } from './billing.controller';
import { billingProviders, STRIPE_CLIENT } from './billing.providers';
import { StripeWebhookController } from './stripe-webhook.controller';

/** Billing with Stripe (phase 7): checkout, plan change, portal, invoices and the webhooks. */
@Module({
  controllers: [BillingController, StripeWebhookController],
  providers: billingProviders,
  // The deletion of an organization ends its subscription with the period (guide step 8.2).
  exports: [STRIPE_CLIENT],
})
export class BillingModule {}
