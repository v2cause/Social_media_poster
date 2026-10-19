import type { ProxyEnv } from 'node:http';

import { z } from 'zod';

// The way out of API and worker in production (guide step 8.9): their networks have no route to
// the internet, only to the egress proxy, which lets through the hosts of its allowlist. With
// NODE_USE_ENV_PROXY=1 Node sends fetch through HTTPS_PROXY unless NO_PROXY names the host, and
// with it the SDKs of Anthropic and the platforms. The SDKs of Stripe and S3 and the transport of
// Sentry keep agents of their own and get the same settings from proxyEnvOf; SMTP takes
// SMTP_PROXY. Without NODE_USE_ENV_PROXY every connection goes direct, as in development.

const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

/** Node speaks to a proxy over http or https; "egress:3128" would be a URL of its own scheme. */
const proxyUrl = z.url({ protocol: /^https?$/ });

export const egressEnvSchema = z.object({
  // Node turns the proxy on for "1" only and ignores "true" without a word, so other values fail.
  NODE_USE_ENV_PROXY: optional(z.enum(['0', '1'])),
  // Read only with NODE_USE_ENV_PROXY=1: a proxy of a developer machine stays its own business.
  HTTPS_PROXY: optional(z.string()),
  HTTP_PROXY: optional(z.string()),
  NO_PROXY: optional(z.string()),
});

export type EgressEnv = z.infer<typeof egressEnvSchema>;

/** With NODE_USE_ENV_PROXY=1 there is an HTTPS_PROXY, and each proxy is a URL of http or https. */
export function checkEgressEnv(env: EgressEnv, context: z.RefinementCtx): void {
  if (env.NODE_USE_ENV_PROXY !== '1') {
    return;
  }
  if (env.HTTPS_PROXY === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['HTTPS_PROXY'],
      message: 'HTTPS_PROXY is required with NODE_USE_ENV_PROXY=1',
    });
  }
  for (const name of ['HTTPS_PROXY', 'HTTP_PROXY'] as const) {
    const value = env[name];
    if (value !== undefined && !proxyUrl.safeParse(value).success) {
      context.addIssue({ code: 'custom', path: [name], message: `${name} must be an http or https URL` });
    }
  }
}

/** The settings for the proxyEnv of an agent of node:http, or undefined when Node goes direct. */
export function proxyEnvOf(env: EgressEnv): ProxyEnv | undefined {
  if (env.NODE_USE_ENV_PROXY !== '1') {
    return undefined;
  }
  return { HTTPS_PROXY: env.HTTPS_PROXY, HTTP_PROXY: env.HTTP_PROXY, NO_PROXY: env.NO_PROXY };
}
