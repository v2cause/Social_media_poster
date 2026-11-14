import { PlatformError } from '@smp/core';
import { z } from 'zod';

import type { ErrorResponse } from '../http/platform-http-client';

// The shared parts of the X API v2 (guide step 4.14): hosts and the mapping of its error answers.
// X answers a post with the same text as a recent one with 403 and a "duplicate content" detail,
// and a call without credits with 402. Not confirmed against docs.x.com, which is not reachable
// from the development environment (ADR 0046).

export const X_API_URL = 'https://api.x.com';
export const X_AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';

/** The settings of the X app; a confidential client has a secret, a public one has none. */
export interface XAppConfig {
  clientId: string;
  clientSecret?: string;
}

const problemSchema = z
  .object({
    detail: z.string().optional(),
    title: z.string().optional(),
    errors: z.array(z.object({ message: z.string().optional() }).loose()).optional(),
  })
  .loose();

const messageOf = (body: unknown): string => {
  const parsed = problemSchema.safeParse(body);
  if (!parsed.success) {
    return '';
  }
  return [parsed.data.detail, parsed.data.title, ...(parsed.data.errors ?? []).map((error) => error.message)]
    .filter((part): part is string => typeof part === 'string')
    .join(' ');
};

export function xErrorOf(operation: string) {
  return (response: ErrorResponse): PlatformError | undefined => {
    const message = messageOf(response.body);
    if (response.status === 403 && /duplicate/i.test(message)) {
      return new PlatformError('DUPLICATE', `${operation}: X refused a duplicate post`, { status: 403 });
    }
    if (response.status === 402) {
      return new PlatformError('PERMISSION_DENIED', `${operation}: the X app has no credits left`, {
        status: 402,
      });
    }
    return undefined;
  };
}

export const bearer = (accessToken: string): Record<string, string> => ({
  authorization: `Bearer ${accessToken}`,
});
