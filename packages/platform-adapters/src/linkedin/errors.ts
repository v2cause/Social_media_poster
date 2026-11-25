import { PlatformError } from '@smp/core';

import type { ErrorResponse } from '../http/platform-http-client';
import { oauthErrorSchema, restErrorSchema } from './schemas';

// LinkedIn-specific answers before the generic mapping of src/http/errors.ts (401 AUTH_EXPIRED,
// 403 PERMISSION_DENIED, 429 RATE_LIMITED with Retry-After, 5xx TRANSIENT, other 4xx
// VALIDATION_REJECTED). Messages name the operation and the status, never a body or a token.

/** The serviceErrorCode or OAuth error value of an answer, when it looks like a plain code. */
export function platformCodeOf(body: unknown): string | undefined {
  const rest = restErrorSchema.safeParse(body);
  if (rest.success && rest.data.serviceErrorCode !== undefined) {
    return String(rest.data.serviceErrorCode);
  }
  if (rest.success && rest.data.code !== undefined && /^[A-Z_]{1,64}$/.test(rest.data.code)) {
    return rest.data.code;
  }
  const oauth = oauthErrorSchema.safeParse(body);
  return oauth.success && /^[a-z_]{1,64}$/.test(oauth.data.error) ? oauth.data.error : undefined;
}

const messageOf = (body: unknown): string => {
  const parsed = restErrorSchema.safeParse(body);
  return parsed.success ? (parsed.data.message ?? '') : '';
};

/** The mapping of the REST APIs (posts, images, analytics, organizations). */
export function mapRestError(operation: string, options: { create?: boolean } = {}) {
  return (response: ErrorResponse): PlatformError | undefined => {
    const { status, body } = response;
    const details = { status, platformCode: platformCodeOf(body) };
    const message = `${operation} failed with HTTP ${String(status)}`;
    // 409 CONFLICT: "A write conflict occurred. Retry the request." It does not mean duplicate
    // content, so the generic DUPLICATE mapping does not apply.
    // https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
    // (checked 2026-11-25)
    if (status === 409) {
      return new PlatformError('TRANSIENT', message, details);
    }
    // Not documented: LinkedIn answers a repeated post with 422 and a message naming it a
    // duplicate. Matched by the message only; any other 422 stays VALIDATION_REJECTED, which
    // fails the variant the same way.
    if (status === 422 && /duplicate/i.test(messageOf(body))) {
      return new PlatformError('DUPLICATE', `${operation} was refused as a duplicate`, details);
    }
    // 426: the LinkedIn-Version header names a version that is no longer supported. Retrying does
    // not help; LINKEDIN_VERSION has to be raised.
    // https://learn.microsoft.com/en-us/linkedin/shared/api-guide/concepts/error-handling
    // (checked 2026-11-25)
    if (status === 426) {
      return new PlatformError(
        'VALIDATION_REJECTED',
        `${operation} failed: the LinkedIn-Version is no longer supported (HTTP 426)`,
        details,
      );
    }
    // 504: LinkedIn took too long to process the call. For a create call the post may exist now.
    // https://learn.microsoft.com/en-us/linkedin/shared/api-guide/concepts/error-handling
    // (checked 2026-11-25)
    if (status === 504 && options.create === true) {
      return new PlatformError('OUTCOME_UNKNOWN', `${operation} timed out at LinkedIn (HTTP 504)`, details);
    }
    return undefined;
  };
}

/**
 * The token endpoint: 400 and 401 refuse the code or the refresh token (invalid_request,
 * invalid_redirect_uri, "authorization code not found"). A refused refresh is AUTH_EXPIRED, so the
 * connection is reconnected; a refused code is VALIDATION_REJECTED.
 * https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow
 * https://learn.microsoft.com/en-us/linkedin/shared/authentication/programmatic-refresh-tokens
 * (checked 2026-11-25)
 */
export function mapTokenError(operation: string, kind: 'code' | 'refresh') {
  return (response: ErrorResponse): PlatformError | undefined => {
    const { status, body } = response;
    if (status !== 400 && status !== 401) {
      return undefined;
    }
    const platformCode = platformCodeOf(body);
    const reason = platformCode === undefined ? '' : ` (${platformCode})`;
    return new PlatformError(
      kind === 'refresh' ? 'AUTH_EXPIRED' : 'VALIDATION_REJECTED',
      `${operation} was refused${reason}`,
      { status, platformCode },
    );
  };
}
