import { EventEmitter } from 'node:events';

import type { Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RequestAccess } from '../../common/guards/request-access';
import type { LiveEventHub } from './live-event-hub';
import { LiveEventsController, STREAM_LIFETIME_MS, toLiveEventDto } from './live-events.controller';
import type { LiveStreamSlots } from './live-stream-slots';

// Guide step 4.10: a stream passes on the status of variants, and a new notification to its user
// only; the steps of an X login reach the user who started it alone (guide step 6.4).

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

  it('gives the steps of an X login to the user who started it only, without the user id', () => {
    const event = { type: 'xb.login' as const, loginSessionId: id, status: 'AWAITING_2FA', userId };

    expect(toLiveEventDto(event, userId)).toEqual({
      type: 'xb.login',
      loginSessionId: id,
      status: 'AWAITING_2FA',
    });
    expect(toLiveEventDto(event, '0192f5d4-0000-7000-8000-000000000005')).toBeNull();
    expect(toLiveEventDto({ ...event, status: 'SOMETHING_NEW' }, userId)).toBeNull();
  });
});

describe('LiveEventsController', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ends a stream after its lifetime, so that the browser passes the guards again', async () => {
    vi.useFakeTimers();
    const unsubscribe = vi.fn().mockResolvedValue(undefined);
    const release = vi.fn().mockResolvedValue(undefined);
    const hub = { subscribe: vi.fn().mockResolvedValue(unsubscribe) } as unknown as LiveEventHub;
    const slots = {
      acquire: vi.fn().mockResolvedValue({ renew: vi.fn().mockResolvedValue(undefined), release }),
    } as unknown as LiveStreamSlots;
    const res = Object.assign(new EventEmitter(), {
      destroyed: false,
      status: vi.fn(),
      set: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn(),
      end: vi.fn(() => {
        res.emit('close');
      }),
    });
    const access = { userId, workspaceId: id } as RequestAccess;

    await new LiveEventsController(hub, slots).stream(access, res as unknown as Response);
    await vi.advanceTimersByTimeAsync(STREAM_LIFETIME_MS - 1);
    expect(res.end).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(res.end).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });
});
