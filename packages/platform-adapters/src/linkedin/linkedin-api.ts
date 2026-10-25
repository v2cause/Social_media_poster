import { PlatformError } from '@smp/core';
import { z } from 'zod';

import type { ErrorResponse } from '../http/platform-http-client';

// The shared parts of the LinkedIn calls (guide step 4.12, architecture 4.2): the hosts, the
// headers of the versioned REST API and the mapping of its error answers.

export const LINKEDIN_OAUTH_URL = 'https://www.linkedin.com/oauth/v2';
export const LINKEDIN_API_URL = 'https://api.linkedin.com';

/** The settings of the LinkedIn app. */
export interface LinkedInAppConfig {
  clientId: string;
  clientSecret: string;
  /** The pinned version of the REST API, YYYYMM. */
  version: string;
  /** Company pages through the Community Management API. */
  organizations: boolean;
  /** Impressions of personal posts through Member Post Analytics. */
  memberAnalytics: boolean;
}

/** The headers of every call of the versioned REST API under /rest. */
export const restHeaders = (accessToken: string, version: string): Record<string, string> => ({
  authorization: `Bearer ${accessToken}`,
  'linkedin-version': version,
  'x-restli-protocol-version': '2.0.0',
});

/** A URN in a path segment or a Rest.li list, for example urn%3Ali%3Ashare%3A123. */
export const encodeUrn = (urn: string): string => encodeURIComponent(urn);

export const tokenAnswerSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive().optional(),
  refresh_token: z.string().min(1).optional(),
  refresh_token_expires_in: z.number().int().positive().optional(),
  scope: z.string().optional(),
});

const errorBodySchema = z
  .object({
    message: z.string().optional(),
    serviceErrorCode: z.number().optional(),
    code: z.string().optional(),
    status: z.number().optional(),
  })
  .loose();

/**
 * LinkedIn names a duplicate post in the message of a 422 ("Content is a duplicate of ...").
 * Everything else follows the generic mapping.
 */
export function linkedInErrorOf(operation: string) {
  return (response: ErrorResponse): PlatformError | undefined => {
    const body = errorBodySchema.safeParse(response.body);
    const message = body.success ? (body.data.message ?? '') : '';
    if ((response.status === 422 || response.status === 409) && /duplicate/i.test(message)) {
      return new PlatformError('DUPLICATE', `${operation}: LinkedIn refused a duplicate post`, {
        status: response.status,
        ...(body.success && body.data.serviceErrorCode !== undefined
          ? { platformCode: String(body.data.serviceErrorCode) }
          : {}),
      });
    }
    return undefined;
  };
}
