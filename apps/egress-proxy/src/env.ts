import { observabilityEnvSchema } from '@smp/observability';
import { egressHostsEnvSchema } from '@smp/x-browser';
import { z } from 'zod';

// The egress proxy knows the hosts of X from the selector map and gets the origins of the media
// storage, the same XB_EGRESS_HOSTS as the browser worker. It holds no credentials at all.
const unsetIfEmpty = (value: unknown): unknown => (value === '' ? undefined : value);

export const egressProxyEnvSchema = z
  .object({
    EGRESS_PORT: z.coerce.number().int().min(1).max(65_535).default(3128),
    XB_EGRESS_HOSTS: z.preprocess(unsetIfEmpty, egressHostsEnvSchema),
  })
  .extend(observabilityEnvSchema.pick({ NODE_ENV: true, LOG_LEVEL: true }).shape);

export type EgressProxyEnv = z.infer<typeof egressProxyEnvSchema>;

/** Validates the process environment. Failures name the variables, never their values. */
export function loadEgressProxyEnv(source: NodeJS.ProcessEnv): EgressProxyEnv {
  const result = egressProxyEnvSchema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  return result.data;
}
