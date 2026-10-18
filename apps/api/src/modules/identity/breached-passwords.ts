import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { BreachCheck } from './password-policy';

// The breach check of new passwords (guide step 8.4, ADR 0039, ASVS 6.2.12) against the range API
// of Have I Been Pwned, or a mirror of it: only the first five hex characters of the SHA-1 of the
// password leave the API, and the answer lists the suffixes of every breached password with that
// prefix, padded with entries of count 0. When the service fails or answers in another format, the
// check lets the password pass and logs a warning; the list of common passwords still applies.

export const BREACH_CHECK_TIMEOUT_MS = 3_000;

/** One line of the answer: the 35 hex characters after the prefix and how often they appeared. */
const rangeLine = z.string().regex(/^[0-9A-F]{35}:\d+$/i);
const rangeAnswer = z
  .string()
  .transform((body) => body.split(/\r?\n/).filter((line) => line.length > 0))
  .pipe(z.array(rangeLine));

export interface BreachedPasswordsOptions {
  /** The base URL of the range API, for example https://api.pwnedpasswords.com. */
  baseUrl: string;
  logger: { warn: (data: object, message: string) => void };
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export function createBreachCheck({
  baseUrl,
  logger,
  timeoutMs = BREACH_CHECK_TIMEOUT_MS,
  fetch: fetchRange = fetch,
}: BreachedPasswordsOptions): BreachCheck {
  const base = baseUrl.replace(/\/+$/, '');
  return async (password) => {
    const hash = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
    const prefix = hash.slice(0, 5);
    const suffix = hash.slice(5);
    try {
      const response = await fetchRange(`${base}/range/${prefix}`, {
        headers: { 'Add-Padding': 'true', 'User-Agent': 'Social Media Poster password check' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        logger.warn({ status: response.status }, 'auth.breach_check_unavailable');
        return false;
      }
      const parsed = rangeAnswer.safeParse(await response.text());
      if (!parsed.success) {
        logger.warn({ reason: 'format' }, 'auth.breach_check_unavailable');
        return false;
      }
      const match = parsed.data.find((line) => line.slice(0, 35).toUpperCase() === suffix);
      return match !== undefined && Number(match.slice(36)) > 0;
    } catch (error) {
      logger.warn(
        { reason: error instanceof Error ? error.name : 'unknown' },
        'auth.breach_check_unavailable',
      );
      return false;
    }
  };
}

/** No breach check, where PWNED_PASSWORDS_API_URL is empty (development and tests by default). */
export const noBreachCheck: BreachCheck = () => Promise.resolve(false);
