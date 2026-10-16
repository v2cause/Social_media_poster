import { z } from 'zod';

export const DEFAULT_TIMEZONE = 'Europe/Berlin';

/** True for an IANA time zone that the runtime knows, such as "Europe/Berlin" or "UTC". */
export const isTimezone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

export const timezoneSchema = z.string().min(1).max(64).refine(isTimezone, { message: 'invalid_timezone' });
