import { systemClock, type AdapterLogger, type Clock } from '@smp/core';
import { z } from 'zod';

import type { PlatformRateLimiter } from '../rate-limit/platform-rate-limiter';

// The configuration of the X API adapter (guide step 4.14) and the facts it rests on. Every fact
// names the page of docs.x.com it comes from and the day it was checked.

/**
 * The API host. Checked 2026-11-25: the OpenAPI document lists https://api.x.com as its only
 * server (https://docs.x.com/openapi.json, version 2.175).
 */
export const X_API_BASE_URL = 'https://api.x.com';

/**
 * The consent page of OAuth 2.0. Checked 2026-11-25:
 * https://docs.x.com/fundamentals/authentication/oauth-2-0/user-access-token (Step 2) and the
 * authorization server metadata quoted in https://docs.x.com/tools/mcp
 * (authorization_endpoint https://x.com/i/oauth2/authorize).
 */
export const X_AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';

/** Everything the adapter needs from the app; the secrets never leave the process. */
export interface XAdapterConfig {
  /** The OAuth 2.0 Client ID from "Keys and tokens" (the long string, not the numeric app id). */
  clientId: string;
  /** The OAuth 2.0 Client Secret of a confidential client (app type Web App or Automated App). */
  clientSecret: string;
  /**
   * The X user id of the account that owns the developer app. Reads of that account's own
   * timeline are billed as Owned Reads ($0.001 instead of $0.005 per post); without it the adapter
   * records the regular price.
   */
  ownerUserId?: string;
  clock?: Clock;
  logger?: AdapterLogger;
  limiter?: PlatformRateLimiter;
  /** Injected in tests; the fetch of Node otherwise. Also downloads the media from the storage. */
  fetch?: typeof fetch;
  apiBaseUrl?: string;
  authorizeUrl?: string;
  /** Upper bound of a single wait while X processes a GIF; the docs ask for check_after_secs. */
  maxMediaPollWaitMs?: number;
  /** How long the adapter waits for X to process an upload in total. */
  mediaProcessingTimeoutMs?: number;
}

export const xAdapterConfigSchema = z.object({
  clientId: z.string().trim().min(1),
  clientSecret: z.string().trim().min(1),
  ownerUserId: z
    .string()
    .regex(/^[0-9]{1,19}$/)
    .optional(),
  apiBaseUrl: z.url().optional(),
  authorizeUrl: z.url().optional(),
  maxMediaPollWaitMs: z.number().int().positive().optional(),
  mediaProcessingTimeoutMs: z.number().int().positive().optional(),
});

/** The configuration with its defaults, checked once when the adapter is built. */
export interface ResolvedXConfig {
  clientId: string;
  clientSecret: string;
  ownerUserId: string | null;
  clock: Clock;
  logger: AdapterLogger | undefined;
  limiter: PlatformRateLimiter | undefined;
  fetch: typeof fetch;
  apiBaseUrl: string;
  authorizeUrl: string;
  maxMediaPollWaitMs: number;
  mediaProcessingTimeoutMs: number;
}

export function resolveXConfig(config: XAdapterConfig): ResolvedXConfig {
  const checked = xAdapterConfigSchema.safeParse(config);
  if (!checked.success) {
    // The issues name the fields, never their values: the secret must not reach a log.
    const fields = checked.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new Error(`The X adapter configuration is invalid (${fields}).`);
  }
  const data = checked.data;
  return {
    clientId: data.clientId,
    clientSecret: data.clientSecret,
    ownerUserId: data.ownerUserId ?? null,
    clock: config.clock ?? systemClock,
    logger: config.logger,
    limiter: config.limiter,
    fetch: config.fetch ?? globalThis.fetch.bind(globalThis),
    apiBaseUrl: (data.apiBaseUrl ?? X_API_BASE_URL).replace(/\/+$/, ''),
    authorizeUrl: data.authorizeUrl ?? X_AUTHORIZE_URL,
    maxMediaPollWaitMs: data.maxMediaPollWaitMs ?? 10_000,
    mediaProcessingTimeoutMs: data.mediaProcessingTimeoutMs ?? 120_000,
  };
}

/**
 * HTTP Basic authentication of a confidential client at the token and revoke endpoints. Checked
 * 2026-11-25: https://docs.x.com/fundamentals/authentication/oauth-2-0/user-access-token
 * ("Working with confidential clients": base64 of client id and secret); X accepts
 * client_secret_basic and rejects client_secret_post (https://docs.x.com/tools/mcp,
 * troubleshooting).
 */
export const basicAuthOf = (config: Pick<ResolvedXConfig, 'clientId' | 'clientSecret'>): string =>
  `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`, 'utf8').toString('base64')}`;
