import { z } from 'zod';

// Plans, limits and the billing of an organization (guide steps 7.1 to 7.5, ADR 0033). The
// limits of a plan are JSON in the table plan; this schema checks them wherever they are read.
// Money is in micro-USD (1 USD = 1000000) like the AI and X cost ledgers; invoices keep the
// minor units and currency Stripe reports.

const timestamp = z.iso.datetime();

export const PLAN_KEYS = ['trial', 'starter', 'pro', 'agency'] as const;
export const planKeySchema = z.enum(PLAN_KEYS);
export type PlanKey = z.infer<typeof planKeySchema>;

/** The plans a customer can buy; every new organization starts with the trial. */
export const PAID_PLAN_KEYS = ['starter', 'pro', 'agency'] as const satisfies readonly PlanKey[];
export const paidPlanKeySchema = z.enum(PAID_PLAN_KEYS);
export type PaidPlanKey = z.infer<typeof paidPlanKeySchema>;

const micros = z.int().min(0).max(Number.MAX_SAFE_INTEGER);

export const planLimitsSchema = z.strictObject({
  maxWorkspaces: z.int().min(1).max(10_000),
  /** Connected accounts in all workspaces of the organization. */
  maxSocialAccounts: z.int().min(0).max(100_000),
  /** Members and open invitations. */
  maxMembers: z.int().min(1).max(100_000),
  /** AI usage included per calendar month (UTC). */
  aiCreditsMicros: micros,
  /** AI usage beyond the credits, billed through the meter; 0 stops at the credits. */
  aiOverageCapMicros: micros,
  /** Posts that go out per calendar month (UTC), planned or published. */
  scheduledPostsPerMonth: z.int().min(0).max(10_000_000),
  /** The originals of the media library in all workspaces. */
  storageBytes: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  analyticsHistoryDays: z.int().min(7).max(3_650),
  xBrowserAllowed: z.boolean(),
  /** X API costs per calendar month (UTC), passed on with the invoice. */
  xApiSpendCapMicros: micros,
});
export type PlanLimits = z.infer<typeof planLimitsSchema>;

/** Single limits the operators set for one organization on top of its plan. */
export const limitOverridesSchema = planLimitsSchema.partial();
export type LimitOverrides = z.infer<typeof limitOverridesSchema>;

/** The limits a request can run into; PLAN_LIMIT_REACHED names one in its params. */
export const COUNTED_LIMITS = [
  'maxWorkspaces',
  'maxSocialAccounts',
  'maxMembers',
  'scheduledPostsPerMonth',
] as const;
export const countedLimitSchema = z.enum(COUNTED_LIMITS);
export type CountedLimit = z.infer<typeof countedLimitSchema>;

/** The states of a subscription, as Stripe names them. */
export const SUBSCRIPTION_STATUSES = [
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
  'CANCELED',
  'UNPAID',
  'INCOMPLETE',
  'INCOMPLETE_EXPIRED',
  'PAUSED',
] as const;
export const subscriptionStatusSchema = z.enum(SUBSCRIPTION_STATUSES);
export type SubscriptionStatusDto = z.infer<typeof subscriptionStatusSchema>;

/** What an organization may do: everything, or only read, export and pay. */
export const BILLING_ACCESS = ['full', 'read_only'] as const;
export const billingAccessSchema = z.enum(BILLING_ACCESS);
export type BillingAccessDto = z.infer<typeof billingAccessSchema>;

const usageSchema = z.object({ used: z.number().int().min(0), limit: z.number().int().min(0) });

export const planPriceSchema = z.object({
  /** In the minor unit of the currency, as Stripe has it. */
  unitAmount: z.number().int().min(0),
  currency: z.string().length(3),
  interval: z.enum(['day', 'week', 'month', 'year']),
});
export type PlanPriceDto = z.infer<typeof planPriceSchema>;

export const billingPlanSchema = z.object({
  key: planKeySchema,
  limits: planLimitsSchema,
  /** Null while Stripe is not set up or the plan has no price. */
  price: planPriceSchema.nullable(),
});
export type BillingPlanDto = z.infer<typeof billingPlanSchema>;

export const billingOverviewSchema = z.object({
  plan: billingPlanSchema,
  status: subscriptionStatusSchema,
  access: billingAccessSchema,
  trialEndsAt: timestamp.nullable(),
  /** While a payment is overdue: from then on the organization is read-only. */
  graceEndsAt: timestamp.nullable(),
  /** Since when the organization is read-only, while it is. */
  readOnlySince: timestamp.nullable(),
  currentPeriodEnd: timestamp.nullable(),
  cancelAtPeriodEnd: z.boolean(),
  /** Stripe is set up in this deployment; without it there is no checkout and no portal. */
  billingEnabled: z.boolean(),
  /** Paid through Stripe: plans change in the customer portal, not in a new checkout. */
  hasStripeSubscription: z.boolean(),
  /** The organization is a Stripe customer, so the customer portal can open. */
  hasCustomer: z.boolean(),
  /** The first day of the calendar month the monthly limits count in (UTC). */
  periodStart: z.iso.date(),
  usage: z.object({
    workspaces: usageSchema,
    socialAccounts: usageSchema,
    members: usageSchema,
    scheduledPosts: usageSchema,
    storageBytes: usageSchema,
    xApiMicros: usageSchema,
    ai: z.object({
      usedMicros: z.number().int().min(0),
      includedMicros: z.number().int().min(0),
      overageCapMicros: z.number().int().min(0),
    }),
  }),
  /** The plans to compare and buy. */
  plans: z.array(billingPlanSchema),
});
export type BillingOverviewDto = z.infer<typeof billingOverviewSchema>;

export const checkoutRequestSchema = z.object({ plan: paidPlanKeySchema });
export type CheckoutRequest = z.input<typeof checkoutRequestSchema>;

/** The customer portal: everything, or straight to the change of plan. */
export const portalRequestSchema = z.object({
  flow: z.enum(['manage', 'change_plan']).default('manage'),
});
export type PortalRequest = z.input<typeof portalRequestSchema>;

/** Where the browser goes next: the hosted checkout or the customer portal of Stripe. */
export const billingRedirectSchema = z.object({ url: z.url() });
export type BillingRedirectDto = z.infer<typeof billingRedirectSchema>;

export const INVOICE_STATUSES = ['draft', 'open', 'paid', 'uncollectible', 'void'] as const;

export const invoiceSchema = z.object({
  id: z.string(),
  number: z.string().nullable(),
  status: z.enum(INVOICE_STATUSES).nullable(),
  /** In the minor unit of the currency, taxes included. */
  total: z.number().int(),
  currency: z.string().length(3),
  createdAt: timestamp,
  hostedInvoiceUrl: z.url().nullable(),
  pdfUrl: z.url().nullable(),
});
export type InvoiceDto = z.infer<typeof invoiceSchema>;

export const invoiceListSchema = z.object({ items: z.array(invoiceSchema) });
export type InvoiceListDto = z.infer<typeof invoiceListSchema>;
