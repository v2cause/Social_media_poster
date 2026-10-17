import { describe, expect, it } from 'vitest';

import {
  accountHintOf,
  defaultPlanTime,
  initialAccountOf,
  isContentLocked,
  nowStepOf,
  planStepOf,
} from './schedule-model';

describe('schedule bar', () => {
  it('plans, moves or retries by status and locks the content while a variant goes out', () => {
    expect(planStepOf('DRAFT')).toBe('schedule');
    expect(planStepOf('CANCELED')).toBe('schedule');
    expect(planStepOf('SCHEDULED')).toBe('reschedule');
    expect(planStepOf('QUEUED')).toBe('reschedule');
    expect(planStepOf('FAILED')).toBe('retry');
    expect(planStepOf('PUBLISHING')).toBeNull();
    expect(planStepOf('NEEDS_ATTENTION')).toBeNull();
    expect(nowStepOf('SCHEDULED')).toBe('publish-now');
    expect(nowStepOf('FAILED')).toBe('retry');
    expect(nowStepOf('QUEUED')).toBeNull();
    expect(isContentLocked('SCHEDULED')).toBe(false);
    expect(isContentLocked('QUEUED')).toBe(true);
    expect(isContentLocked('PUBLISHED')).toBe(true);
  });

  it('suggests a time at least an hour ahead on a quarter hour of the zone', () => {
    expect(defaultPlanTime(new Date('2026-10-17T08:05:00Z'), 'Europe/Berlin')).toEqual({
      date: '2026-10-17',
      time: '11:15',
    });
    expect(defaultPlanTime(new Date('2026-10-17T22:50:00Z'), 'Europe/Berlin')).toEqual({
      date: '2026-10-18',
      time: '02:00',
    });
  });

  it('warns about an account to reconnect or with access ending before the plan', () => {
    const plannedAt = new Date('2026-10-20T07:30:00Z');
    expect(accountHintOf(undefined, plannedAt)).toBeNull();
    expect(accountHintOf({ status: 'NEEDS_REAUTH', accessExpiresAt: null }, plannedAt)).toBe('needs-reauth');
    expect(accountHintOf({ status: 'EXPIRING', accessExpiresAt: '2026-10-19T00:00:00Z' }, plannedAt)).toBe(
      'expires-before',
    );
    expect(accountHintOf({ status: 'EXPIRING', accessExpiresAt: '2026-10-25T00:00:00Z' }, plannedAt)).toBe(
      'expiring',
    );
    expect(
      accountHintOf({ status: 'ACTIVE', accessExpiresAt: '2026-12-01T00:00:00Z' }, plannedAt),
    ).toBeNull();
  });

  it('starts with the account of the variant or the only usable one of its platform', () => {
    const accounts = [
      { id: 'li-1', platform: 'LINKEDIN' as const, status: 'ACTIVE' as const },
      { id: 'x-1', platform: 'X' as const, status: 'NEEDS_REAUTH' as const },
      { id: 'fb-1', platform: 'FACEBOOK' as const, status: 'ACTIVE' as const },
      { id: 'fb-2', platform: 'FACEBOOK' as const, status: 'EXPIRING' as const },
    ];
    expect(initialAccountOf({ platform: 'LINKEDIN', socialAccountId: null }, accounts)).toBe('li-1');
    expect(initialAccountOf({ platform: 'FACEBOOK', socialAccountId: null }, accounts)).toBe('');
    expect(initialAccountOf({ platform: 'FACEBOOK', socialAccountId: 'fb-2' }, accounts)).toBe('fb-2');
    expect(initialAccountOf({ platform: 'X', socialAccountId: null }, accounts)).toBe('');
  });
});
