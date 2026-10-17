import { describe, expect, it } from 'vitest';

import { toLiveEventDto } from './live-events.controller';

// Guide step 4.10: a stream passes on the status of variants, and a new notification to its user only.

const variantId = '0192f5d4-0000-7000-8000-000000000001';
const postId = '0192f5d4-0000-7000-8000-000000000002';
const id = '0192f5d4-0000-7000-8000-000000000003';
const userId = '0192f5d4-0000-7000-8000-000000000004';

describe('toLiveEventDto', () => {
  it('passes the status of a variant on as it is', () => {
    const event = {
      type: 'variant.status' as const,
      variantId,
      postId,
      status: 'QUEUED',
      scheduleVersion: 2,
    };

    expect(toLiveEventDto(event, userId)).toEqual(event);
    expect(toLiveEventDto({ ...event, status: 'SOMETHING_NEW' }, userId)).toBeNull();
  });

  it('gives a new notification to its user only, without the user id', () => {
    const event = { type: 'notification.created' as const, id, userId };

    expect(toLiveEventDto(event, userId)).toEqual({ type: 'notification.created', id });
    expect(toLiveEventDto(event, '0192f5d4-0000-7000-8000-000000000005')).toBeNull();
  });
});
