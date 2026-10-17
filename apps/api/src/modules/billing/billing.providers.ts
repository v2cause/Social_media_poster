import type { Provider } from '@nestjs/common';
import {
  createStripeClient,
  StripeBillingGateway,
  StripeWebhookVerifier,
  type StripeClient,
} from '@smp/billing';
import {
  BillingUnavailableError,
  ChangePlan,
  EntitlementsService,
  GetBillingOverview,
  ListInvoices,
  OpenBillingPortal,
  planQuotaLimits,
  PlanPrices,
  QuotaService,
  RecordStripeWebhook,
  StartCheckout,
  systemClock,
  type BillingDependencies,
  type BillingJobs,
  type BillingWebhookVerifier,
  type PlanUsage,
} from '@smp/core';
import {
  PrismaBillingCustomers,
  PrismaQuotaStore,
  PrismaSubscriptionReader,
  PrismaWebhookRecorder,
  type PrismaClient,
} from '@smp/db';
import { BillingProducer } from '@smp/queue';
import type { Queue } from 'bullmq';

import type { ApiEnv } from '../../config/api-env';
import { API_ENV } from '../../config/config.module';
import { BILLING_JOBS_QUEUE, DATABASE_CLIENT } from '../../infrastructure/clients.module';
import { PLAN_USAGE } from './plan.module';

// Billing in the API (guide steps 7.2 and 7.5, ADR 0034): overview, checkout, plan change,
// customer portal and invoices for the owner, as app_user in the organization, and the webhooks
// of Stripe, which the API checks, records once and hands to the role "billing". Without
// STRIPE_SECRET_KEY there is no client: the use cases answer BILLING_UNAVAILABLE, and the overview
// shows the plans without prices.

export const STRIPE_CLIENT = Symbol('STRIPE_CLIENT');
export const BILLING = Symbol('BILLING');
export const STRIPE_VERIFIER = Symbol('STRIPE_VERIFIER');

const noJobs: BillingJobs = { processWebhook: () => Promise.reject(new BillingUnavailableError()) };

export const billingProviders: Provider[] = [
  {
    provide: STRIPE_CLIENT,
    inject: [API_ENV],
    useFactory: (env: ApiEnv): StripeClient | null =>
      env.STRIPE_SECRET_KEY
        ? createStripeClient({
            secretKey: env.STRIPE_SECRET_KEY,
            ...(env.STRIPE_API_BASE ? { apiBase: env.STRIPE_API_BASE } : {}),
          })
        : null,
  },
  {
    provide: BILLING,
    inject: [API_ENV, STRIPE_CLIENT, DATABASE_CLIENT],
    useFactory: (env: ApiEnv, stripe: StripeClient | null, base: PrismaClient): BillingDependencies => ({
      gateway: stripe ? new StripeBillingGateway(stripe) : null,
      subscriptions: new PrismaSubscriptionReader(base),
      customers: new PrismaBillingCustomers(base),
      appUrl: env.APP_URL.replace(/\/$/, ''),
    }),
  },
  ...[StartCheckout, OpenBillingPortal, ChangePlan, ListInvoices].map((UseCase) => ({
    provide: UseCase,
    inject: [BILLING],
    useFactory: (deps: BillingDependencies) => new UseCase(deps),
  })),
  {
    provide: GetBillingOverview,
    inject: [STRIPE_CLIENT, DATABASE_CLIENT, EntitlementsService, PLAN_USAGE],
    useFactory: (
      stripe: StripeClient | null,
      base: PrismaClient,
      entitlements: EntitlementsService,
      usage: PlanUsage,
    ) =>
      new GetBillingOverview({
        entitlements,
        subscriptions: new PrismaSubscriptionReader(base),
        usage,
        quota: new QuotaService({
          store: new PrismaQuotaStore(base),
          limits: planQuotaLimits(entitlements),
          clock: systemClock,
        }),
        prices: stripe
          ? new PlanPrices({ gateway: new StripeBillingGateway(stripe), clock: systemClock })
          : null,
        clock: systemClock,
      }),
  },
  {
    provide: STRIPE_VERIFIER,
    inject: [API_ENV, STRIPE_CLIENT],
    useFactory: (env: ApiEnv, stripe: StripeClient | null): BillingWebhookVerifier | null =>
      stripe && env.STRIPE_WEBHOOK_SECRET
        ? new StripeWebhookVerifier(stripe, env.STRIPE_WEBHOOK_SECRET)
        : null,
  },
  {
    provide: RecordStripeWebhook,
    inject: [DATABASE_CLIENT, BILLING_JOBS_QUEUE],
    useFactory: (base: PrismaClient, queue: Queue | null) => {
      const producer = queue ? new BillingProducer(queue) : null;
      return new RecordStripeWebhook({
        inbox: new PrismaWebhookRecorder(base),
        jobs: producer ? { processWebhook: (eventId) => producer.stripeWebhook({ eventId }) } : noJobs,
      });
    },
  },
];
