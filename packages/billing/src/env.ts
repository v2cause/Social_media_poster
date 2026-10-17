import { z } from 'zod';

// The configuration of Stripe (guide step 7.2). Without STRIPE_SECRET_KEY billing is off: no
// checkout, no portal, no usage reports. STRIPE_API_BASE points the SDK at the fake Stripe of the
// tests and the local stack; it takes test keys only and never runs in production.

const unsetIfEmpty = (value: unknown): unknown => (value === '' ? undefined : value);

export const billingEnvSchema = z.object({
  STRIPE_SECRET_KEY: z.preprocess(
    unsetIfEmpty,
    z
      .string()
      .regex(/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/, 'must be a secret or restricted key of Stripe')
      .optional(),
  ),
  STRIPE_WEBHOOK_SECRET: z.preprocess(
    unsetIfEmpty,
    z
      .string()
      .regex(/^whsec_\S+$/, 'must be the signing secret of a webhook endpoint')
      .optional(),
  ),
  STRIPE_API_BASE: z.preprocess(unsetIfEmpty, z.url({ protocol: /^https?$/ }).optional()),
});

export type BillingEnv = z.infer<typeof billingEnvSchema>;

/** Rules across the variables; the apps add theirs, such as the webhook secret of the API. */
export function checkBillingEnv(env: BillingEnv & { NODE_ENV: string }, context: z.RefinementCtx): void {
  if (env.STRIPE_API_BASE && env.NODE_ENV === 'production') {
    context.addIssue({
      code: 'custom',
      path: ['STRIPE_API_BASE'],
      message: 'STRIPE_API_BASE is for tests only and is refused in production',
    });
  }
  if (env.STRIPE_API_BASE && env.STRIPE_SECRET_KEY && !/^(sk|rk)_test_/.test(env.STRIPE_SECRET_KEY)) {
    context.addIssue({
      code: 'custom',
      path: ['STRIPE_SECRET_KEY'],
      message: 'STRIPE_API_BASE takes test keys only',
    });
  }
}
