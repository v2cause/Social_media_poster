import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { formatLocalTime, resolveLocalTime } from '../../src/publishing/domain/local-time';

// Guide step 4.6: local times around the changes of the offset (architecture 7.3). Examples for
// the known changes, then properties over many zones and twenty years.

describe('resolveLocalTime', () => {
  it('turns an ordinary local time into its instant', () => {
    expect(resolveLocalTime('2026-10-16T12:00', 'Europe/Berlin')).toEqual({
      kind: 'exact',
      instant: new Date('2026-10-16T10:00:00Z'),
    });
    expect(resolveLocalTime('2026-12-24T18:30', 'UTC')).toEqual({
      kind: 'exact',
      instant: new Date('2026-12-24T18:30:00Z'),
    });
  });

  it('names the first minute after a gap of spring forward', () => {
    expect(resolveLocalTime('2026-03-29T02:30', 'Europe/Berlin')).toEqual({
      kind: 'gap',
      next: { localDateTime: '2026-03-29T03:00', instant: new Date('2026-03-29T01:00:00Z') },
    });
    expect(resolveLocalTime('2026-03-08T02:15', 'America/New_York')).toEqual({
      kind: 'gap',
      next: { localDateTime: '2026-03-08T03:00', instant: new Date('2026-03-08T07:00:00Z') },
    });
    // Lord Howe moves by half an hour.
    expect(resolveLocalTime('2026-10-04T02:15', 'Australia/Lord_Howe')).toMatchObject({
      kind: 'gap',
      next: { localDateTime: '2026-10-04T02:30' },
    });
  });

  it('takes the earlier instant of a repeated hour of fall back', () => {
    expect(resolveLocalTime('2026-10-25T02:30', 'Europe/Berlin')).toEqual({
      kind: 'ambiguous',
      instant: new Date('2026-10-25T00:30:00Z'),
      later: new Date('2026-10-25T01:30:00Z'),
    });
  });

  it('refuses what is not a date and time or not a time zone', () => {
    for (const [local, zone] of [
      ['2026-02-30T10:00', 'Europe/Berlin'],
      ['2026-13-01T10:00', 'Europe/Berlin'],
      ['2026-10-16T24:00', 'Europe/Berlin'],
      ['2026-10-16 10:00', 'Europe/Berlin'],
      ['2026-10-16T10:00:00', 'Europe/Berlin'],
      ['2026-10-16T10:00', 'Mars/Olympus_Mons'],
    ] as const) {
      expect(resolveLocalTime(local, zone), `${local} ${zone}`).toEqual({ kind: 'invalid' });
    }
  });
});

const ZONES = [
  'Europe/Berlin',
  'Europe/London',
  'America/New_York',
  'America/Sao_Paulo',
  'America/Santiago',
  'Australia/Lord_Howe',
  'Australia/Sydney',
  'Pacific/Chatham',
  'Asia/Kolkata',
  'Asia/Tehran',
  'UTC',
] as const;

const pad = (value: number): string => String(value).padStart(2, '0');

/** Local times of 2016 to 2036, with the hours around the usual changes drawn more often. */
const localTimes = fc
  .record({
    year: fc.integer({ min: 2016, max: 2036 }),
    month: fc.integer({ min: 1, max: 12 }),
    day: fc.integer({ min: 1, max: 28 }),
    hour: fc.oneof(fc.integer({ min: 0, max: 23 }), fc.constantFrom(0, 1, 2, 3)),
    minute: fc.oneof(fc.integer({ min: 0, max: 59 }), fc.constantFrom(0, 15, 30, 45)),
  })
  .map(
    ({ year, month, day, hour, minute }) =>
      `${String(year)}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}`,
  );

/** Every Sunday in March, April, September, October and November, when most zones change. */
const changeDays = fc
  .record({
    year: fc.integer({ min: 2016, max: 2036 }),
    month: fc.constantFrom(3, 4, 9, 10, 11),
    week: fc.integer({ min: 0, max: 4 }),
    hour: fc.integer({ min: 0, max: 3 }),
    minute: fc.constantFrom(0, 1, 15, 29, 30, 31, 45, 59),
  })
  .map(({ year, month, week, hour, minute }) => {
    const first = new Date(Date.UTC(year, month - 1, 1));
    const day = Math.min(28, 1 + ((7 - first.getUTCDay()) % 7) + week * 7);
    return `${String(year)}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}`;
  });

describe('resolveLocalTime properties', () => {
  const zones = fc.constantFrom(...ZONES);
  const anyLocal = fc.oneof(localTimes, changeDays);

  it('maps every existing local time to an instant that shows that local time', () => {
    fc.assert(
      fc.property(anyLocal, zones, (local, zone) => {
        const result = resolveLocalTime(local, zone);
        expect(result.kind).not.toBe('invalid');
        if (result.kind === 'exact' || result.kind === 'ambiguous') {
          expect(formatLocalTime(result.instant, zone)).toBe(local);
        }
      }),
      { numRuns: 3000 },
    );
  });

  it('reports both instants of a repeated time, the earlier first', () => {
    fc.assert(
      fc.property(anyLocal, zones, (local, zone) => {
        const result = resolveLocalTime(local, zone);
        if (result.kind === 'ambiguous') {
          expect(formatLocalTime(result.later, zone)).toBe(local);
          expect(result.later.getTime()).toBeGreaterThan(result.instant.getTime());
          // The time exists twice because the clock was set back by the difference.
          expect(result.later.getTime() - result.instant.getTime()).toBeLessThanOrEqual(2 * 3_600_000);
        }
      }),
      { numRuns: 3000 },
    );
  });

  it('suggests the first minute after a gap, and no instant shows the missing time', () => {
    fc.assert(
      fc.property(anyLocal, zones, (local, zone) => {
        const result = resolveLocalTime(local, zone);
        if (result.kind === 'gap') {
          const { next } = result;
          expect(formatLocalTime(next.instant, zone)).toBe(next.localDateTime);
          expect(next.localDateTime > local).toBe(true);
          // One minute earlier the clock still showed a time before the missing one.
          expect(formatLocalTime(new Date(next.instant.getTime() - 60_000), zone) < local).toBe(true);
          expect(resolveLocalTime(next.localDateTime, zone).kind).not.toBe('gap');
        }
      }),
      { numRuns: 3000 },
    );
  });

  it('finds gaps and repeats where the zone changes, and none in UTC or India', () => {
    const kinds = new Set<string>();
    fc.assert(
      fc.property(changeDays, (local) => {
        for (const zone of ['UTC', 'Asia/Kolkata']) {
          expect(resolveLocalTime(local, zone).kind).toBe('exact');
        }
        kinds.add(resolveLocalTime(local, 'Europe/Berlin').kind);
      }),
      { numRuns: 2000 },
    );
    expect(kinds).toEqual(new Set(['exact', 'gap', 'ambiguous']));
  });
});
