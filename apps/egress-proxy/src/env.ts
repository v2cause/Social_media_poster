import { observabilityEnvSchema } from '@smp/observability';
import { egressHostsEnvSchema } from '@smp/x-browser';
import { z } from 'zod';

// The egress proxy runs with one of two policies. "x-browser" (guide step 6.2) knows the hosts of
// X from the selector map and gets the origins of the media storage, the same XB_EGRESS_HOSTS as
// the browser worker. "hosts" (guide step 8.9) is the way out of API and worker: exactly the
// entries of EGRESS_HOSTS, for example the APIs of Stripe, Anthropic and the platforms and the
// SMTP server, and nothing of X. The proxy holds no credentials at all.
const unsetIfEmpty = (value: unknown): unknown => (value === '' ? undefined : value);

export const egressProxyEnvSchema = z
  .object({
    EGRESS_PORT: z.coerce.number().int().min(1).max(65_535).default(3128),
    EGRESS_POLICY: z.preprocess(unsetIfEmpty, z.enum(['x-browser', 'hosts']).default('x-browser')),
    EGRESS_HOSTS: z.preprocess(unsetIfEmpty, egressHostsEnvSchema),
    XB_EGRESS_HOSTS: z.preprocess(unsetIfEmpty, egressHostsEnvSchema),
  })
  .extend(observabilityEnvSchema.pick({ NODE_ENV: true, LOG_LEVEL: true }).shape)
  .superRefine((env, context) => {
    // Each list belongs to one policy; a list the policy ignores would be a misunderstanding.
    const ignored = env.EGRESS_POLICY === 'hosts' ? 'XB_EGRESS_HOSTS' : 'EGRESS_HOSTS';
    if (env[ignored].length > 0) {
      context.addIssue({
        code: 'custom',
        path: [ignored],
        message: `does not apply to the policy ${env.EGRESS_POLICY}`,
      });
    }
  });

export type EgressProxyEnv = z.infer<typeof egressProxyEnvSchema>;

/** The hosts the proxy lets through: those of X and XB_EGRESS_HOSTS, or exactly EGRESS_HOSTS. */
export const egressHostsOf = (env: EgressProxyEnv, xWebHosts: readonly string[]): string[] =>
  env.EGRESS_POLICY === 'hosts' ? [...env.EGRESS_HOSTS] : [...xWebHosts, ...env.XB_EGRESS_HOSTS];

/** Validates the process environment. Failures name the variables, never their values. */
export function loadEgressProxyEnv(source: NodeJS.ProcessEnv): EgressProxyEnv {
  const result = egressProxyEnvSchema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  return result.data;
}
