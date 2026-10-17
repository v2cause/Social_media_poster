import { describe, expect, it } from 'vitest';

import { countdownOf } from './countdown';

const now = new Date('2026-10-17T12:00:00Z');

describe('countdown of the next posts', () => {
  it('counts the last hour in minutes and seconds and names longer spans relatively', () => {
    expect(countdownOf(new Date('2026-10-17T12:00:00Z'), now)).toEqual({ kind: 'due' });
    expect(countdownOf(new Date('2026-10-17T11:59:00Z'), now)).toEqual({ kind: 'due' });
    expect(countdownOf(new Date('2026-10-17T12:00:00.400Z'), now)).toEqual({
      kind: 'clock',
      minutes: 0,
      seconds: 1,
    });
    expect(countdownOf(new Date('2026-10-17T12:12:05Z'), now)).toEqual({
      kind: 'clock',
      minutes: 12,
      seconds: 5,
    });
    expect(countdownOf(new Date('2026-10-17T12:59:59Z'), now)).toEqual({
      kind: 'clock',
      minutes: 59,
      seconds: 59,
    });
    expect(countdownOf(new Date('2026-10-17T13:00:00Z'), now)).toEqual({ kind: 'relative' });
  });
});
