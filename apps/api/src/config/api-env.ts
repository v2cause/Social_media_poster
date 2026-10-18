import { aiEnvSchema, checkAiEnv } from '@smp/ai';
import { billingEnvSchema, checkBillingEnv } from '@smp/billing';
import { dbEnvSchema } from '@smp/db';
import { storageEnvSchema } from '@smp/media';
import { observabilityEnvSchema } from '@smp/observability';
import { platformEnvSchema } from '@smp/platform-adapters';
import { z } from 'zod';

// .env.example and Compose set empty strings for unset values.
const unsetIfEmpty = (value: unknown): unknown => (value === '' ? undefined : value);

/**
 * The keys of Better Auth by version, the current one first: "2:<secret>,1:<secret>". Messages
 * name the rule, never a value.
 */
const authSecretsSchema = z.string().transform((value, context) => {
  const entries: { version: number; value: string }[] = [];
  for (const entry of value.split(',').map((part) => part.trim())) {
    const separator = entry.indexOf(':');
    const version = entry.slice(0, separator);
    const secret = entry.slice(separator + 1);
    if (separator < 1 || !/^\d+$/.test(version)) {
      context.addIssue({ code: 'custom', message: 'entries are "<version>:<secret>", comma-separated' });
      return z.NEVER;
    }
    if (secret.length < 32) {
      context.addIssue({ code: 'custom', message: 'every secret has at least 32 characters' });
      return z.NEVER;
    }
    entries.push({ version: Number(version), value: secret });
  }
  if (new Set(entries.map((entry) => entry.version)).size !== entries.length) {
    context.addIssue({ code: 'custom', message: 'every version appears once' });
    return z.NEVER;
  }
  return entries;
});

// The API connects only as app_user and app_system. MIGRATION_DATABASE_URL belongs to the migrations.
export const apiEnvSchema = z
  .object({
    APP_URL: z.url(),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    REDIS_URL: z.url({ protocol: /^rediss?$/ }),
    // Better Auth: signs session cookies and tokens. Generate with `pnpm gen:keys`.
    BETTER_AUTH_SECRET: z.string().min(32),
    // A rotation (docs/runbooks/secret-rotation.md): the versioned keys, the current one first.
    // BETTER_AUTH_SECRET then only opens what was encrypted before versions existed.
    BETTER_AUTH_SECRETS: z.preprocess(unsetIfEmpty, authSecretsSchema.optional()),
    // The public origin the browser talks to (same origin as the web app).
    BETTER_AUTH_URL: z.url({ protocol: /^https?$/ }),
    // Seal the tokens of the platforms; @smp/crypto checks the format at start.
    TOKEN_KEKS: z.string().min(1),
    TOKEN_KEK_ACTIVE: z.string().min(1),
    // The deployment runs the browser worker of X (guide step 6.1); without it the X browser is
    // off everywhere, whatever the flags say.
    FEATURE_X_BROWSER_GLOBAL: z.preprocess(unsetIfEmpty, z.stringbool().default(false)),
    // Seal the credentials of a login of X for the browser worker, which alone opens them (guide
    // step 6.4); required once the X browser is offered.
    SESSION_KEKS: z.preprocess(unsetIfEmpty, z.string().optional()),
    SESSION_KEK_ACTIVE: z.preprocess(unsetIfEmpty, z.string().optional()),
    // The breach check of new passwords (guide step 8.4): the range API of Have I Been Pwned or a
    // mirror of it. Empty turns the check off; production needs it.
    PWNED_PASSWORDS_API_URL: z.preprocess(unsetIfEmpty, z.url({ protocol: /^https?$/ }).optional()),
  })
  .extend(dbEnvSchema.pick({ DATABASE_URL: true, DATABASE_SYSTEM_URL: true }).shape)
  .extend(storageEnvSchema.shape)
  .extend(observabilityEnvSchema.shape)
  .extend(aiEnvSchema.shape)
  .extend(platformEnvSchema.shape)
  // Stripe (guide step 7.2): without a key there is no checkout; the webhooks need their secret.
  .extend(billingEnvSchema.shape)
  // The mock AI provider never starts in production, and the Claude API needs a key.
  .superRefine(checkAiEnv)
  .superRefine(checkBillingEnv)
  .superRefine((env, context) => {
    if (Boolean(env.STRIPE_SECRET_KEY) !== Boolean(env.STRIPE_WEBHOOK_SECRET)) {
      context.addIssue({
        code: 'custom',
        path: ['STRIPE_WEBHOOK_SECRET'],
        message: 'STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are set together or not at all',
      });
    }
  })
  .superRefine((env, context) => {
    if (env.NODE_ENV === 'production' && !env.PWNED_PASSWORDS_API_URL?.startsWith('https://')) {
      context.addIssue({
        code: 'custom',
        path: ['PWNED_PASSWORDS_API_URL'],
        message: 'an https URL is required in production, for example https://api.pwnedpasswords.com',
      });
    }
  })
  .superRefine((env, context) => {
    if (env.FEATURE_X_BROWSER_GLOBAL && (!env.SESSION_KEKS || !env.SESSION_KEK_ACTIVE)) {
      context.addIssue({
        code: 'custom',
        path: ['SESSION_KEKS'],
        message: 'SESSION_KEKS and SESSION_KEK_ACTIVE are required when FEATURE_X_BROWSER_GLOBAL is true',
      });
    }
  });

export type ApiEnv = z.infer<typeof apiEnvSchema>;

/**
 * Validates the process environment. Failures name the variables and the rule that failed,
 * but never the rejected values.
 */
export function loadApiEnv(source: NodeJS.ProcessEnv): ApiEnv {
  const result = apiEnvSchema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  return result.data;
}
