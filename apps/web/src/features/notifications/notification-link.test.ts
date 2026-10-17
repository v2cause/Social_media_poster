import type { NotificationDto } from '@smp/contracts';
import { describe, expect, it } from 'vitest';

import { hrefOf } from './notification-link';

const base = {
  id: '0192f5d4-0000-7000-8000-000000000001',
  createdAt: '2026-10-16T12:00:00.000Z',
  readAt: null,
  workspace: { slug: 'nordlicht', name: 'Nordlicht' },
};

describe('hrefOf', () => {
  it('leads a connection to the accounts page and a post to the post', () => {
    const connection: NotificationDto = {
      ...base,
      content: {
        type: 'reauth-required',
        connectionId: '0192f5d4-0000-7000-8000-000000000002',
        platform: 'LINKEDIN',
        accounts: ['Mira'],
        reason: 'EXPIRED',
        scheduledVariants: 0,
      },
    };
    const post: NotificationDto = {
      ...base,
      content: {
        type: 'needs-attention',
        postId: '0192f5d4-0000-7000-8000-000000000003',
        variantId: '0192f5d4-0000-7000-8000-000000000004',
        platform: 'X',
        accounts: ['@nordlicht'],
        preview: 'Neu im Team',
        failureCode: 'OUTCOME_UNKNOWN',
      },
    };

    expect(hrefOf(connection)).toBe('/w/nordlicht/accounts');
    expect(hrefOf(post)).toBe('/w/nordlicht/posts/0192f5d4-0000-7000-8000-000000000003');
  });
});
