import { describe, expect, it } from 'vitest';

import { addDays, instantOf, localDateOf, localDateTimeOf, startOfLocalDay, weekdayOf } from './zoned-time';

describe('dates and times in a time zone', () => {
  it('shows an instant on the wall clock of the zone', () => {
    const instant = new Date('2026-10-20T22:30:00Z');
    expect(localDateTimeOf(instant, 'Europe/Berlin')).toBe('2026-10-21T00:30');
    expect(localDateTimeOf(instant, 'America/New_York')).toBe('2026-10-20T18:30');
    expect(localDateOf(instant, 'Asia/Tokyo')).toBe('2026-10-21');
    expect(localDateTimeOf(new Date('2026-10-20T00:05:00Z'), 'UTC')).toBe('2026-10-20T00:05');
  });

  it('starts a local day at its midnight, also around a change of the clocks', () => {
    expect(startOfLocalDay('2026-10-21', 'Europe/Berlin')).toEqual(new Date('2026-10-20T22:00:00Z'));
    // Summer time ends on October 25 at 03:00; the day itself starts in summer time.
    expect(startOfLocalDay('2026-10-25', 'Europe/Berlin')).toEqual(new Date('2026-10-24T22:00:00Z'));
    expect(startOfLocalDay('2026-10-26', 'Europe/Berlin')).toEqual(new Date('2026-10-25T23:00:00Z'));
    expect(startOfLocalDay('2026-10-21', 'Pacific/Auckland')).toEqual(new Date('2026-10-20T11:00:00Z'));
    // Sao Paulo skipped from 00:00 to 01:00 on November 4, 2018: the day began at 01:00.
    expect(startOfLocalDay('2018-11-04', 'America/Sao_Paulo')).toEqual(new Date('2018-11-04T03:00:00Z'));
  });

  it('finds the instant of a local time like the API: after a gap, the earlier of a repeated hour', () => {
    expect(instantOf('2026-10-20T09:30', 'Europe/Berlin')).toEqual(new Date('2026-10-20T07:30:00Z'));
    // 02:30 on March 28, 2027 does not exist in Berlin; 03:00 is the first minute after the gap.
    expect(instantOf('2027-03-28T02:30', 'Europe/Berlin')).toEqual(new Date('2027-03-28T01:00:00Z'));
    // 02:30 on October 25, 2026 exists twice; the first one, still in summer time, counts.
    expect(instantOf('2026-10-25T02:30', 'Europe/Berlin')).toEqual(new Date('2026-10-25T00:30:00Z'));
  });

  it('counts days and weekdays of local dates', () => {
    expect(addDays('2026-10-30', 3)).toBe('2026-11-02');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(weekdayOf('2026-10-19')).toBe(0);
    expect(weekdayOf('2026-10-25')).toBe(6);
  });
});
