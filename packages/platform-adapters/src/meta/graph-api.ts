import { isPlatformError, PlatformError } from '@smp/core';
import { z } from 'zod';

import { DEFAULT_RATE_LIMIT_WAIT_MS } from '../http/errors';
import type { ErrorResponse } from '../http/platform-http-client';
import { retryAfterMsOf } from '../http/rate-headers';

// The shared parts of the Graph API of Facebook and Instagram (guide step 4.13): the pinned
// version, and the mapping of its error answers ({ error: { code, error_subcode } }) to the error
// taxonomy before the generic mapping by HTTP status. Codes after the error handling guide of the
// Graph API; it was not reachable from the development environment (ADR 0046).

/** The settings of the Meta app for Facebook pages. */
export interface MetaAppConfig {
  appId: string;
  appSecret: string;
  /** The pinned Graph API version, for example v24.0. */
  graphVersion: string;
  /** The configuration of Facebook Login for Business; without it the login asks with scopes. */
  loginConfigId?: string;
}

/** The settings of the Instagram app (Instagram API with Instagram Login). */
export interface InstagramAppConfig {
  appId: string;
  appSecret: string;
  graphVersion: string;
}

const graphErrorSchema = z.object({
  error: z
    .object({
      message: z.string().optional(),
      code: z.number().optional(),
      error_subcode: z.number().optional(),
      is_transient: z.boolean().optional(),
    })
    .loose(),
});

const AUTH_CODES = new Set([102, 190, 463, 467]);
const RATE_CODES = new Set([4, 9, 17, 32, 613]);
/** Instagram: the media is not ready to publish yet. */
const NOT_READY_SUBCODES = new Set([2207027]);
/** Instagram: the image could not be fetched from its URL. */
const FETCH_FAILED_SUBCODES = new Set([2207052]);

/** The Graph API names an object that does not exist (any more) with code 100, subcode 33. */
export const NOT_FOUND_STATUS = 404;

export function graphErrorOf(operation: string) {
  return (response: ErrorResponse): PlatformError | undefined => {
    const parsed = graphErrorSchema.safeParse(response.body);
    if (!parsed.success) {
      return undefined;
    }
    const { code, error_subcode: subcode, is_transient: transient } = parsed.data.error;
    const platformCode =
      code === undefined ? undefined : `${String(code)}${subcode === undefined ? '' : `/${String(subcode)}`}`;
    const details = { status: response.status, ...(platformCode ? { platformCode } : {}) };
    const message = `${operation} failed (Graph API ${platformCode ?? String(response.status)})`;
    if (code !== undefined && AUTH_CODES.has(code)) {
      return new PlatformError('AUTH_EXPIRED', message, details);
    }
    if (subcode !== undefined && NOT_READY_SUBCODES.has(subcode)) {
      return new PlatformError('MEDIA_PROCESSING', message, details);
    }
    if (subcode !== undefined && FETCH_FAILED_SUBCODES.has(subcode)) {
      return new PlatformError(
        'VALIDATION_REJECTED',
        `${message}: the image could not be fetched; the storage must be reachable over https`,
        details,
      );
    }
    if (
      (code !== undefined && (RATE_CODES.has(code) || (code >= 80001 && code <= 80014))) ||
      response.status === 429
    ) {
      return new PlatformError('RATE_LIMITED', message, {
        ...details,
        retryAfterMs: retryAfterMsOf(response.headers) ?? DEFAULT_RATE_LIMIT_WAIT_MS,
      });
    }
    if (code === 506) {
      return new PlatformError('DUPLICATE', message, details);
    }
    if (code === 10 || code === 368 || (code !== undefined && code >= 200 && code <= 299)) {
      return new PlatformError('PERMISSION_DENIED', message, details);
    }
    if (code === 100 && subcode === 33) {
      return new PlatformError('VALIDATION_REJECTED', message, { ...details, status: NOT_FOUND_STATUS });
    }
    if (transient === true || code === 1 || code === 2) {
      return new PlatformError('TRANSIENT', message, details);
    }
    return undefined;
  };
}

/** Whether a failure means the object is gone. */
export const isNotFound = (error: unknown): boolean =>
  isPlatformError(error) && (error.status === NOT_FOUND_STATUS || error.status === 410);

export const bearer = (accessToken: string): Record<string, string> => ({
  authorization: `Bearer ${accessToken}`,
});

/** The answer of a create call: the id of the new object. */
export const idSchema = z.object({ id: z.string().min(1) }).loose();
