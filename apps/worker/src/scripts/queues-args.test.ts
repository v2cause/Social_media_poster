import { describe, expect, it } from 'vitest';

import { queuesCommandOf } from './queues-args';

// Guide step 8.7: the operators name what they look at; anything else is the usage, so that a typo
// never removes something else.

describe('the arguments of pnpm queues', () => {
  it('reads the counts, the dead letters and the failed jobs of a queue', () => {
    expect(queuesCommandOf(['counts'])).toEqual({ command: 'counts' });
    expect(queuesCommandOf(['dead-letters'])).toEqual({ command: 'dead-letters', limit: 50 });
    expect(queuesCommandOf(['dead-letters', '--limit', '5'])).toEqual({ command: 'dead-letters', limit: 5 });
    expect(queuesCommandOf(['failed', '--queue', 'notifications'])).toEqual({
      command: 'failed',
      queue: 'notifications',
      limit: 20,
    });
  });

  it('removes the dead letters, all or those failed before a time with its offset', () => {
    expect(queuesCommandOf(['remove-dead-letters'])).toEqual({ command: 'remove-dead-letters' });
    expect(queuesCommandOf(['remove-dead-letters', '--before', '2026-10-19T07:30:00+02:00'])).toEqual({
      command: 'remove-dead-letters',
      before: new Date('2026-10-19T05:30:00Z'),
    });
  });

  it('refuses unknown commands, queues, options and values', () => {
    expect(queuesCommandOf([])).toBeNull();
    expect(queuesCommandOf(['drain'])).toBeNull();
    expect(queuesCommandOf(['failed'])).toBeNull();
    expect(queuesCommandOf(['failed', '--queue', 'bull'])).toBeNull();
    expect(queuesCommandOf(['remove-dead-letters', '--before', 'yesterday'])).toBeNull();
    expect(queuesCommandOf(['dead-letters', '--limit', '0'])).toBeNull();
    expect(queuesCommandOf(['counts', '--all'])).toBeNull();
    expect(queuesCommandOf(['counts', 'failed'])).toBeNull();
  });
});
