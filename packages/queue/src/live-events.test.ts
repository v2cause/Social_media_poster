import type Redis from 'ioredis';
import { describe, expect, it } from 'vitest';

import { LiveBrowserLoginEvents, liveEventChannel, LiveEventPublisher, parseLiveEvent } from './live-events';

const recordingRedis = (sent: [string, string][]): Redis =>
  ({
    publish: (channel: string, message: string) => {
      sent.push([channel, message]);
      return Promise.resolve(1);
    },
  }) as unknown as Redis;

describe('live events', () => {
  it('publish a checked event on the channel of the workspace', async () => {
    const sent: [string, string][] = [];
    const redis = recordingRedis(sent);
    const event = {
      type: 'variant.status' as const,
      variantId: '0192a0b4-6f1e-7c3a-9d2b-5e8f4a1c2d3e',
      postId: '0192a0b4-6f1e-7c3a-9d2b-5e8f4a1c2d3f',
      status: 'QUEUED',
      scheduleVersion: 3,
    };

    await new LiveEventPublisher(redis).publish('ws-1', event);

    expect(sent).toEqual([['ws:ws-1:events', JSON.stringify(event)]]);
    expect(liveEventChannel('ws-1')).toBe('ws:ws-1:events');
    expect(parseLiveEvent(JSON.parse(sent[0]?.[1] ?? '{}'))).toEqual(event);
    expect(() => parseLiveEvent({ type: 'variant.status', variantId: 'x' })).toThrow();
  });

  it('names the user of a new notification', () => {
    const created = {
      type: 'notification.created',
      id: '0192a0b4-6f1e-7c3a-9d2b-5e8f4a1c2d40',
      userId: '0192a0b4-6f1e-7c3a-9d2b-5e8f4a1c2d41',
    };

    expect(parseLiveEvent(created)).toEqual(created);
    expect(() => parseLiveEvent({ type: 'notification.created', id: created.id })).toThrow();
  });

  it('name the user who started an X login with each of its steps', async () => {
    const sent: [string, string][] = [];
    const login = {
      id: '0192a0b4-6f1e-7c3a-9d2b-5e8f4a1c2d42',
      organizationId: '0192a0b4-6f1e-7c3a-9d2b-5e8f4a1c2d43',
      workspaceId: 'ws-1',
      userId: '0192a0b4-6f1e-7c3a-9d2b-5e8f4a1c2d44',
      status: 'AWAITING_2FA' as const,
      failure: null,
      accountId: null,
      reconnectAccountId: null,
      locale: 'de' as const,
      startedAt: new Date('2026-10-17T08:00:00Z'),
      expiresAt: new Date('2026-10-17T08:05:00Z'),
    };

    await new LiveBrowserLoginEvents(new LiveEventPublisher(recordingRedis(sent))).changed(login);

    expect(sent).toEqual([
      [
        'ws:ws-1:events',
        JSON.stringify({
          type: 'xb.login',
          loginSessionId: login.id,
          status: 'AWAITING_2FA',
          userId: login.userId,
        }),
      ],
    ]);
  });
});
