import type { VariantListItemDto } from '@smp/contracts';
import { describe, expect, it } from 'vitest';

import {
  byDay,
  calendarQuerySchema,
  daysOf,
  isMovable,
  moveTo,
  moveToDay,
  periodOf,
  shiftAnchor,
  shiftMonth,
  shortPreview,
} from './calendar-model';

const item = (id: string, scheduledAt: string, status: VariantListItemDto['status'] = 'SCHEDULED') => ({
  id,
  postId: 'p',
  platform: 'LINKEDIN' as const,
  status,
  version: 1,
  preview: id,
  account: null,
  scheduledAt,
  scheduledTimezone: 'Europe/Berlin',
  publishedAt: null,
  externalUrl: null,
  failureCode: null,
  isDryRun: false,
  updatedAt: '2026-10-17T10:00:00.000Z',
});

describe('calendar', () => {
  it('shows the weeks of a month from Monday, one week, or the days of the month', () => {
    const month = daysOf('month', '2026-10-17');
    expect(month[0]).toBe('2026-09-28');
    expect(month.at(-1)).toBe('2026-11-01');
    expect(month).toHaveLength(35);
    expect(daysOf('week', '2026-10-17')).toEqual([
      '2026-10-12',
      '2026-10-13',
      '2026-10-14',
      '2026-10-15',
      '2026-10-16',
      '2026-10-17',
      '2026-10-18',
    ]);
    const list = daysOf('list', '2026-02-10');
    expect([list[0], list.at(-1), list.length]).toEqual(['2026-02-01', '2026-02-28', 28]);
    expect(shiftAnchor('week', '2026-10-17', -1)).toBe('2026-10-10');
    expect(shiftAnchor('month', '2026-10-17', 1)).toBe('2026-11-01');
    expect(shiftMonth('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('asks for the planned period of the days in the time zone shown', () => {
    expect(periodOf(daysOf('week', '2026-10-21'), 'Europe/Berlin')).toEqual({
      from: '2026-10-18T22:00:00.000Z',
      // The week ends after October 25, the day the clocks go back.
      to: '2026-10-25T23:00:00.000Z',
    });
  });

  it('puts the variants on the day of the zone shown, by time', () => {
    const days = byDay(
      [
        item('late', '2026-10-20T16:00:00Z'),
        item('night', '2026-10-20T22:30:00Z'),
        item('early', '2026-10-20T06:00:00Z'),
      ],
      'Europe/Berlin',
    );
    expect(days.get('2026-10-20')?.map((entry) => entry.id)).toEqual(['early', 'late']);
    // 22:30 UTC is already the next day in Berlin, still the same one in New York.
    expect(days.get('2026-10-21')?.map((entry) => entry.id)).toEqual(['night']);
    expect(byDay([item('night', '2026-10-20T22:30:00Z')], 'America/New_York').get('2026-10-20')).toHaveLength(
      1,
    );
  });

  it('moves a variant to another day at the same time and keeps the zone of its plan', () => {
    const planned = item('a', '2026-10-20T07:30:00Z');
    expect(moveToDay(planned, '2026-10-27', 'Europe/Berlin')).toEqual({
      // 09:30 in Berlin, now in winter time.
      instant: new Date('2026-10-27T08:30:00Z'),
      localDateTime: '2026-10-27T09:30',
      timeZone: 'Europe/Berlin',
    });
    // Shown in New York (03:30 there), sent in Berlin.
    expect(moveTo(planned, '2026-10-21T03:30', 'America/New_York')).toEqual({
      instant: new Date('2026-10-21T07:30:00Z'),
      localDateTime: '2026-10-21T09:30',
      timeZone: 'Europe/Berlin',
    });
    expect(isMovable(planned)).toBe(true);
    expect(isMovable(item('b', '2026-10-20T07:30:00Z', 'PUBLISHED'))).toBe(false);
  });

  it('reads the view from the query string and falls back to this month in the workspace zone', () => {
    expect(calendarQuerySchema.parse({})).toEqual({ view: 'month', date: '', zone: 'workspace' });
    expect(calendarQuerySchema.parse({ view: 'week', date: '2026-10-19', zone: 'own' })).toEqual({
      view: 'week',
      date: '2026-10-19',
      zone: 'own',
    });
    expect(calendarQuerySchema.parse({ view: 'year', date: '19.10.2026', zone: 'Mars/Olympus' })).toEqual({
      view: 'month',
      date: '',
      zone: 'workspace',
    });
  });

  it('cuts the preview after 40 characters', () => {
    expect(shortPreview('Kurz')).toBe('Kurz');
    expect(shortPreview('Am Samstag öffnen wir unsere Werkstatt für alle')).toBe(
      'Am Samstag öffnen wir unsere Werkstatt f...',
    );
  });
});
