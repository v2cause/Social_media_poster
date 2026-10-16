import type { Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import {
  NOTIFY_DISPATCH,
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
});
