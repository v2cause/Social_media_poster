import { describe, expect, it } from 'vitest';

import {
  resolveVariantSchema,
  retryVariantSchema,
  scheduleVariantSchema,
  variantListQuerySchema,
} from './publishing';

describe('planning requests', () => {
  it('takes a local date and time to the minute in a known time zone', () => {
    const plan = { version: 3, localDateTime: '2026-10-20T09:30', timeZone: 'Europe/Berlin' };
    expect(scheduleVariantSchema.safeParse(plan).success).toBe(true);
    for (const localDateTime of ['2026-10-20 09:30', '2026-10-20T09:30:00', '2026-10-20T09:30Z']) {
      expect(scheduleVariantSchema.safeParse({ ...plan, localDateTime }).success, localDateTime).toBe(false);
    }
    expect(scheduleVariantSchema.safeParse({ ...plan, timeZone: 'Europe/Atlantis' }).success).toBe(false);
  });

  it('retries now without a local time and knows the choices for an unclear publish', () => {
    expect(retryVariantSchema.parse({ version: 1, timeZone: 'UTC' })).toEqual({
      version: 1,
      timeZone: 'UTC',
    });
    expect(resolveVariantSchema.safeParse({ version: 1, action: 'publish_anyway' }).success).toBe(true);
    expect(resolveVariantSchema.safeParse({ version: 1, action: 'ignore' }).success).toBe(false);
  });

  it('reads the filters of the variant list from the query string', () => {
    expect(
      variantListQuerySchema.parse({
        status: 'SCHEDULED,QUEUED',
        from: '2026-10-01T00:00:00Z',
        to: '2026-11-01T00:00:00.000Z',
        order: 'schedule',
        limit: '200',
      }),
    ).toEqual({
      status: ['SCHEDULED', 'QUEUED'],
      from: '2026-10-01T00:00:00Z',
      to: '2026-11-01T00:00:00.000Z',
      order: 'schedule',
      limit: 200,
    });
    expect(variantListQuerySchema.parse({})).toEqual({ order: 'recent', limit: 50 });
    expect(variantListQuerySchema.safeParse({ status: 'SCHEDULED,LOST' }).success).toBe(false);
    expect(
      variantListQuerySchema.safeParse({ from: '2026-11-01T00:00:00Z', to: '2026-10-01T00:00:00Z' }).success,
    ).toBe(false);
  });
});
