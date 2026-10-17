import { Module } from '@nestjs/common';

import { BillingController } from './billing.controller';
import { billingProviders } from './billing.providers';
import { StripeWebhookController } from './stripe-webhook.controller';

/** Billing with Stripe (phase 7): checkout, plan change, portal, invoices and the webhooks. */
@Module({
  controllers: [BillingController, StripeWebhookController],
  providers: billingProviders,
})
export class BillingModule {}
