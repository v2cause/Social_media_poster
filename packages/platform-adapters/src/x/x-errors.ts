import { PlatformError } from '@smp/core';
import { z } from 'zod';

import { platformErrorOf } from '../http/errors';
import type { ErrorResponse } from '../http/platform-http-client';

// The error answers of X in the error taxonomy (architecture 4.1). Only the type and a fixed
// label reach the message, never the detail text of X, which can quote the post.
//
// The API answers problem details: {type, title, detail, status}, the type a URI such as
// https://api.x.com/2/problems/usage-capped, and a 200 can carry partial "errors" too. Checked
// 2026-11-25: https://docs.x.com/x-api/fundamentals/response-codes-and-errors
//
// The token endpoint answers {error, error_description} with HTTP 400 for invalid_request,
// invalid_grant and invalid_scope, and unauthorized_client or invalid_client when the app's
// credentials are refused. Checked 2026-11-25:
// https://docs.x.com/fundamentals/authentication/oauth-2-0/oauth-1-0a-token-exchange ("Errors").

const problemSchema = z.looseObject({
  type: z.string().optional(),
  title: z.string().optional(),
  detail: z.string().optional(),
  status: z.number().optional(),
});

const oauthErrorSchema = z.looseObject({ error: z.string() });

const PROBLEM_PREFIX = /^https:\/\/api\.(?:x|twitter)\.com\/2\/problems\//;

/** The last part of the problem type, for example usage-capped; undefined without one. */
export function problemTypeOf(body: unknown): string | undefined {
  const parsed = problemSchema.safeParse(body);
  const type = parsed.success ? parsed.data.type : undefined;
  return type && PROBLEM_PREFIX.test(type) ? type.replace(PROBLEM_PREFIX, '') : undefined;
}

// X refuses a post whose text equals a recent post of the same account. The docs of 2026-11-25 do
// not document this answer (searched https://docs.x.com/llms-full.txt and openapi.json for
// "duplicate"); the answer seen in practice is HTTP 403 with the detail "You are not allowed to
// create a Tweet with duplicate content." Matched on the detail, case-insensitive, also with 400.
const DUPLICATE_DETAIL = /duplicate content/i;

const withCode = (failure: PlatformError, platformCode: string | undefined): PlatformError =>
  platformCode === undefined
    ? failure
    : new PlatformError(failure.code, failure.message, {
        retryable: failure.retryable,
        retryAfterMs: failure.retryAfterMs,
        status: failure.status,
        platformCode,
      });

/** The mapping of answers of the v2 API; anything not special falls back to the generic one. */
export function mapXApiError(operation: string, now: () => number) {
  return (response: ErrorResponse): PlatformError => {
    const problem = problemSchema.safeParse(response.body);
    const detail = problem.success ? (problem.data.detail ?? problem.data.title ?? '') : '';
    if ((response.status === 403 || response.status === 400) && DUPLICATE_DETAIL.test(detail)) {
      return new PlatformError('DUPLICATE', `${operation} was refused as duplicate content`, {
        status: response.status,
        platformCode: 'duplicate-content',
      });
    }
    return withCode(platformErrorOf(response, operation, now()), problemTypeOf(response.body));
  };
}

/**
 * The mapping of the token endpoint. A refused grant (invalid_grant: revoked, expired or already
 * used refresh token) means the account must be connected again; refused client credentials are a
 * setting of the app, not of the account.
 */
export function mapXTokenError(
  operation: string,
  now: () => number,
  refusedGrant: 'AUTH_EXPIRED' | 'VALIDATION_REJECTED',
) {
  return (response: ErrorResponse): PlatformError => {
    const parsed = oauthErrorSchema.safeParse(response.body);
    const error = parsed.success && /^[a-z_]{1,40}$/.test(parsed.data.error) ? parsed.data.error : undefined;
    if (error === 'invalid_grant') {
      return new PlatformError(refusedGrant, `${operation} was refused (invalid_grant)`, {
        status: response.status,
        platformCode: error,
      });
    }
    if (error === 'invalid_client' || error === 'unauthorized_client') {
      return new PlatformError(
        'PERMISSION_DENIED',
        `${operation}: the app credentials were refused (${error})`,
        {
          status: response.status,
          platformCode: error,
        },
      );
    }
    return withCode(platformErrorOf(response, operation, now()), error);
  };
}
