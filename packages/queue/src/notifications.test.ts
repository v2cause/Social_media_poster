import { randomUUID } from 'node:crypto';

import type { Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import {
  NOTIFY_DISPATCH,
  NOTIFY_EVENT_JOB_OPTIONS,
  NOTIFY_JOB_OPTIONS,
  NotificationProducer,
  parseNotifyDispatch,
} from './notifications';

const verifyEmail = {
  template: 'verify-email' as const,
  locale: 'de' as const,
  name: 'Ada',
  url: 'http://localhost:3000/api/auth/verify-email?token=abc',
};

describe('notifications queue', () => {
  it('adds a validated email job with retries and short retention', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    await new NotificationProducer({ add } as unknown as Queue).dispatchEmail(
      'ada@example.test',
      verifyEmail,
    );

    expect(add).toHaveBeenCalledWith(
      NOTIFY_DISPATCH,
      { channel: 'email', to: 'ada@example.test', email: verifyEmail },
      NOTIFY_JOB_OPTIONS,
    );
    expect(NOTIFY_JOB_OPTIONS).toMatchObject({ removeOnComplete: true, attempts: 6 });
  });

  it('refuses invalid payloads before they reach the queue', async () => {
    const add = vi.fn();
    const producer = new NotificationProducer({ add } as unknown as Queue);
    await expect(producer.dispatchEmail('not-an-address', verifyEmail)).rejects.toThrow();
    await expect(
      producer.dispatchEmail('ada@example.test', { ...verifyEmail, url: 'javascript:alert(1)' }),
    ).rejects.toThrow();
    expect(add).not.toHaveBeenCalled();
  });

  it('validates payloads when they are processed', () => {
    expect(
      parseNotifyDispatch({ channel: 'email', to: 'ada@example.test', email: verifyEmail }),
    ).toMatchObject({
      to: 'ada@example.test',
    });
    expect(() => parseNotifyDispatch({ channel: 'sms' })).toThrow();
  });

  it('adds one job per outbox event and one email per event and recipient, kept for their ids', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const producer = new NotificationProducer({ add } as unknown as Queue);
    const event = {
      eventId: randomUUID(),
      organizationId: randomUUID(),
      workspaceId: randomUUID(),
      request: {
        type: 'publish-failed' as const,
        variantId: randomUUID(),
        failureCode: 'MISSED_WINDOW' as const,
      },
    };
    const userId = randomUUID();

    await producer.dispatchEvent(event);
    await producer.dispatchEventEmail(event.eventId, userId, 'ada@example.test', verifyEmail);

    expect(add).toHaveBeenNthCalledWith(
      1,
      NOTIFY_DISPATCH,
      { channel: 'event', ...event },
      { ...NOTIFY_EVENT_JOB_OPTIONS, jobId: `ntf.${event.eventId}` },
    );
    expect(add).toHaveBeenNthCalledWith(
      2,
      NOTIFY_DISPATCH,
      { channel: 'email', to: 'ada@example.test', email: verifyEmail },
      { ...NOTIFY_EVENT_JOB_OPTIONS, jobId: `ntf.${event.eventId}.${userId}` },
    );
    expect(NOTIFY_EVENT_JOB_OPTIONS.removeOnComplete).toEqual({ age: 24 * 60 * 60 });
  });

  it('refuses events that the core does not know', async () => {
    const add = vi.fn();
    const producer = new NotificationProducer({ add } as unknown as Queue);
    const base = { eventId: randomUUID(), organizationId: randomUUID(), workspaceId: randomUUID() };

    await expect(
      producer.dispatchEvent({
        ...base,
        request: { type: 'publish-failed', variantId: randomUUID(), failureCode: 'GONE' as 'INTERNAL' },
      }),
    ).rejects.toThrow();
    await expect(
      producer.dispatchEvent({
        ...base,
        request: { type: 'token-expiring', connectionId: 'x', daysLeft: 7, expiresAt: 'soon' },
      }),
    ).rejects.toThrow();
    expect(add).not.toHaveBeenCalled();
    expect(
      parseNotifyDispatch({
        channel: 'event',
        ...base,
        request: {
          type: 'reauth-required',
          connectionId: randomUUID(),
          reason: 'EXPIRED',
          scheduledVariants: 2,
        },
      }),
    ).toMatchObject({ channel: 'event', request: { reason: 'EXPIRED' } });
  });
});
