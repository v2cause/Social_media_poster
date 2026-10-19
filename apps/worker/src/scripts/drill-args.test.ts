import { describe, expect, it } from 'vitest';

import { drillOf } from './drill-args';

// Guide step 8.7: the drills of the runbooks name their fault and its size; anything else is the
// usage, so that a typo never injects a different fault.

describe('the arguments of a drill', () => {
  it('reads an outage of a platform with its defaults and with options', () => {
    expect(drillOf(['platform-outage', '--platform', 'LINKEDIN'])).toEqual({
      scenario: 'platform-outage',
      platform: 'LINKEDIN',
      status: 503,
      minutes: 20,
      organizations: 6,
      duePosts: 2,
    });
    expect(
      drillOf([
        'platform-outage',
        '--platform',
        'X',
        '--status',
        '502',
        '--minutes',
        '5',
        '--due-posts',
        '3',
      ]),
    ).toMatchObject({ platform: 'X', status: 502, minutes: 5, duePosts: 3 });
  });

  it('reads a wave of expired tokens and the reports of the X browser', () => {
    expect(drillOf(['token-wave', '--platform', 'X', '--organizations', '8'])).toEqual({
      scenario: 'token-wave',
      platform: 'X',
      minutes: 20,
      organizations: 8,
      duePosts: 2,
    });
    expect(drillOf(['xb-drift'])).toEqual({ scenario: 'xb-drift', count: 3 });
    expect(drillOf(['xb-drift', '--count', '1'])).toEqual({ scenario: 'xb-drift', count: 1 });
    expect(drillOf(['xb-canary'])).toEqual({ scenario: 'xb-canary' });
  });

  it('refuses unknown scenarios, options, platforms and values out of range', () => {
    expect(drillOf([])).toBeNull();
    expect(drillOf(['redis-loss'])).toBeNull();
    expect(drillOf(['platform-outage'])).toBeNull();
    expect(drillOf(['platform-outage', '--platform', 'TIKTOK'])).toBeNull();
    expect(drillOf(['platform-outage', '--platform', 'X', '--status', '404'])).toBeNull();
    expect(drillOf(['token-wave', '--platform', 'X', '--minutes', '0'])).toBeNull();
    expect(drillOf(['xb-drift', '--force'])).toBeNull();
    expect(drillOf(['xb-drift', 'xb-canary'])).toBeNull();
  });
});
