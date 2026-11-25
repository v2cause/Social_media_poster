import { PlatformError, isPlatformError, type PlatformErrorDetails } from '@smp/core';
import { z } from 'zod';

import { DEFAULT_RATE_LIMIT_WAIT_MS } from '../http/errors';
import type { ErrorResponse } from '../http/platform-http-client';
import { retryAfterMsOf } from '../http/rate-headers';

// The Graph API errors of Facebook Pages and Instagram mapped to the error taxonomy (architecture
// 4.1 and 7.1). Graph answers most errors with HTTP 400 and the real reason in error.code and
// error.error_subcode, so these come before the generic mapping by HTTP status. Messages carry the
// codes only, never the message of Meta, which may quote the request.
//
// Sources, checked 2026-11-25:
// - Graph error codes and authentication subcodes:
//   https://developers.facebook.com/docs/graph-api/guides/error-handling/
// - Throttling codes (4, 17, 32, 613, 80001, 80002):
//   https://developers.facebook.com/docs/graph-api/overview/rate-limiting/
// - Instagram codes and subcodes (2207xxx):
//   https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/error-codes

const graphErrorBodySchema = z.object({
  error: z.object({
    code: z.number().int(),
    error_subcode: z.number().int().optional(),
    is_transient: z.boolean().optional(),
  }),
});

/** Subcodes after which only a new login helps: app removed, checkpoint, password changed, expired. */
const AUTH_SUBCODES = new Set([458, 459, 460, 463, 464, 467]);
/** App, user, page (user token), custom, application, page (page token) and Instagram throttling. */
const RATE_LIMIT_CODES = new Set([4, 17, 32, 341, 613, 80001, 80002]);
/** Image too large, unsupported format, aspect ratio, caption too long (Instagram). */
const MEDIA_REJECTED_CODES = new Set([36000, 36001, 36003, 36004]);
/** Unknown and service errors that Meta asks to retry; -1 and -2 are Instagram server errors. */
const TRANSIENT_CODES = new Set([1, 2, -1, -2]);

const HOUR_MS = 60 * 60 * 1000;

/**
 * Not documented on the pages above: Graph answers a read of a deleted or unknown object with code
 * 100 and subcode 33 ("Unsupported get request. Object ... does not exist"). The adapters treat it
 * like an HTTP 404.
 */
const OBJECT_MISSING = '100/33';

function waitOf(response: ErrorResponse, fallbackMs: number): number {
  return Math.max(retryAfterMsOf(response.headers) ?? 0, fallbackMs);
}

/** The mapping of one call; undefined leaves the answer to the generic mapping by HTTP status. */
export function metaErrorMapper(operation: string): (response: ErrorResponse) => PlatformError | undefined {
  return (response) => {
    const parsed = graphErrorBodySchema.safeParse(response.body);
    if (!parsed.success) {
      return undefined;
    }
    const { code, error_subcode: subcode, is_transient: isTransient } = parsed.data.error;
    const platformCode = subcode === undefined ? String(code) : `${String(code)}/${String(subcode)}`;
    const details: PlatformErrorDetails = { status: response.status, platformCode };
    const fail = (errorCode: PlatformError['code'], reason: string, extra: PlatformErrorDetails = {}) =>
      new PlatformError(errorCode, `${operation} failed: ${reason} (Graph error ${platformCode})`, {
        ...details,
        ...extra,
      });

    if (subcode === 492) {
      // "User associated with the Page access token does not have an appropriate role on the Page."
      return fail('PERMISSION_DENIED', 'the user lost the role on the Page');
    }
    if (code === 190 || code === 102 || (subcode !== undefined && AUTH_SUBCODES.has(subcode))) {
      return fail('AUTH_EXPIRED', 'the access token is invalid or expired');
    }
    if (code === 4 && subcode === 2207051) {
      // Instagram suspects spam; retrying makes it worse.
      return fail('PERMISSION_DENIED', 'Instagram restricted the publishing as suspected spam');
    }
    if (code === 9 && subcode === 2207042) {
      // The daily publishing limit of the account; Meta does not say when a slot frees up.
      return fail('RATE_LIMITED', 'the daily Instagram publishing limit is reached', {
        retryAfterMs: waitOf(response, HOUR_MS),
      });
    }
    if (RATE_LIMIT_CODES.has(code)) {
      return fail('RATE_LIMITED', 'the Graph API rate limit is reached', {
        retryAfterMs: waitOf(response, DEFAULT_RATE_LIMIT_WAIT_MS),
      });
    }
    if (code === 368) {
      // "Temporarily blocked for policies violations. Wait and retry the operation."
      return fail('RATE_LIMITED', 'the account is temporarily blocked by Meta', {
        retryAfterMs: waitOf(response, HOUR_MS),
      });
    }
    if (code === 10 || code === 3 || (code >= 200 && code <= 299)) {
      return fail('PERMISSION_DENIED', 'a permission is missing or was removed');
    }
    if (code === 25 && subcode === 2207050) {
      return fail('PERMISSION_DENIED', 'the Instagram account is restricted; open the Instagram app');
    }
    if (code === 506) {
      return fail('DUPLICATE', 'the same post was published just before');
    }
    if (code === 9007 || subcode === 2207027) {
      return fail('MEDIA_PROCESSING', 'the media is not ready for publishing yet');
    }
    if (code === 9004 || subcode === 2207052) {
      return fail(
        'VALIDATION_REJECTED',
        'Meta could not fetch the media from its URL; the URL must be reachable from the public internet',
      );
    }
    if (MEDIA_REJECTED_CODES.has(code)) {
      return fail('VALIDATION_REJECTED', 'the media or caption breaks an Instagram limit');
    }
    if (subcode === 2207008 || subcode === 2207003 || subcode === 2207001 || subcode === 2207032) {
      return fail('TRANSIENT', 'Instagram asks to try again', {
        retryAfterMs: retryAfterMsOf(response.headers),
      });
    }
    if (TRANSIENT_CODES.has(code) || isTransient === true) {
      return fail('TRANSIENT', 'a temporary Graph API error', {
        retryAfterMs: retryAfterMsOf(response.headers),
      });
    }
    if (platformCode === OBJECT_MISSING) {
      return fail('VALIDATION_REJECTED', 'the object does not exist', { status: 404 });
    }
    return undefined;
  };
}

/** True for an error that says the post is gone: HTTP 404 or Graph error 100/33. */
export function isMissingObject(error: unknown): boolean {
  return isPlatformError(error) && (error.status === 404 || error.platformCode === OBJECT_MISSING);
}

/** Errors that end a batch of reads: the account itself cannot be read now. */
export function endsBatch(error: unknown): boolean {
  return (
    isPlatformError(error) &&
    (error.code === 'AUTH_EXPIRED' || error.code === 'PERMISSION_DENIED' || error.code === 'RATE_LIMITED')
  );
}
