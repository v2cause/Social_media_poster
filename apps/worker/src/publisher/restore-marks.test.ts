import { describe, expect, it } from 'vitest';

import { restoreSinceOf } from './restore-marks';

const NOW = new Date('2026-10-19T03:00:00Z');

describe('restoreSinceOf', () => {
  it('reads the time of the restore with its offset', () => {
    expect(restoreSinceOf(['--since', '2026-10-19T01:57:53.434051Z'], NOW)).toEqual(
      new Date('2026-10-19T01:57:53.434Z'),
    );
    expect(restoreSinceOf(['--since=2026-10-19T03:57:53+02:00'], NOW)).toEqual(
      new Date('2026-10-19T01:57:53Z'),
    );
    // As the restore drill writes it, for the recovery and the mark alike.
    expect(restoreSinceOf(['--since', '2026-10-19T01:57:53.434051+00:00'], NOW)).toEqual(
      new Date('2026-10-19T01:57:53.434Z'),
    );
  });

  it('takes the current time, but none in the future', () => {
    expect(restoreSinceOf(['--since', NOW.toISOString()], NOW)).toEqual(NOW);
    expect(restoreSinceOf(['--since', '2026-10-19T03:00:01Z'], NOW)).toBeUndefined();
  });

  it('refuses a time without offset, other formats, missing and unknown arguments', () => {
    for (const args of [
      ['--since', '2026-10-19T01:57:53'],
      ['--since', '2026-10-19 01:57:53+00'],
      ['--since', 'yesterday'],
      ['--since'],
      [],
      ['--since', '2026-10-19T01:57:53Z', '--all'],
      ['2026-10-19T01:57:53Z'],
    ]) {
      expect(restoreSinceOf(args, NOW)).toBeUndefined();
    }
  });
});
