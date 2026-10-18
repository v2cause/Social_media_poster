import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';

import type { SecretSealer } from '@smp/core';
import type { Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import {
  NOTIFY_DISPATCH,
  NOTIFY_EVENT_JOB_OPTIONS,
  NOTIFY_JOB_OPTIONS,
  NotificationProducer,
  openNotifyEmail,
  parseNotifyDispatch,
  type EmailDispatch,
} from './notifications';

const verifyEmail = {
  template: 'verify-email' as const,
  locale: 'de' as const,
  name: 'Ada',
  url: 'http://localhost:3000/api/auth/verify-email?token=secret-token-of-the-link',
};

/** AES-256-GCM with the AAD, like the envelopes of the keyring, with one key. */
function testSealer(): SecretSealer {
  const key = randomBytes(32);
  return {
    seal: (plaintext, aad) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv).setAAD(Buffer.from(aad));
      const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return Promise.resolve(Buffer.concat([iv, cipher.getAuthTag(), body]));
    },
    open: (sealed, aad) => {
      const buffer = Buffer.from(sealed);
      const decipher = createDecipheriv('aes-256-gcm', key, buffer.subarray(0, 12))
        .setAAD(Buffer.from(aad))
        .setAuthTag(buffer.subarray(12, 28));
      return Promise.resolve(
        Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString(),
      );
    },
  };
}

describe('notifications queue', () => {
  it('adds the email sealed, with retries and short retention, and opens it for the delivery', async () => {
    const sealer = testSealer();
    const add = vi.fn().mockResolvedValue(undefined);
    await new NotificationProducer({ add } as unknown as Queue, sealer).dispatchEmail(
      'ada@example.test',
      verifyEmail,
    );

    expect(add).toHaveBeenCalledWith(
      NOTIFY_DISPATCH,
      { channel: 'email', sealed: expect.any(String) as unknown },
      NOTIFY_JOB_OPTIONS,
    );
    expect(NOTIFY_JOB_OPTIONS).toMatchObject({ removeOnComplete: true, attempts: 6 });
    const payload = parseNotifyDispatch(add.mock.calls[0]?.[1]) as EmailDispatch;
    // Neither the address nor the link reach Redis in the clear.
    expect(JSON.stringify(payload)).not.toMatch(/ada@|secret-token-of-the-link/);
    await expect(openNotifyEmail(sealer, payload)).resolves.toEqual({
      to: 'ada@example.test',
      email: verifyEmail,
    });
  });

  it('refuses invalid payloads before they reach the queue', async () => {
    const add = vi.fn();
    const producer = new NotificationProducer({ add } as unknown as Queue, testSealer());
    await expect(producer.dispatchEmail('not-an-address', verifyEmail)).rejects.toThrow();
    await expect(
      producer.dispatchEmail('ada@example.test', { ...verifyEmail, url: 'javascript:alert(1)' }),
    ).rejects.toThrow();
    expect(add).not.toHaveBeenCalled();
  });

  it('validates payloads when they are processed and opens only envelopes of an email', async () => {
    const sealer = testSealer();
    expect(() => parseNotifyDispatch({ channel: 'sms' })).toThrow();
    // A job in the clear, as before the envelopes, is no valid job any more.
    expect(() =>
      parseNotifyDispatch({ channel: 'email', to: 'ada@example.test', email: verifyEmail }),
    ).toThrow();

    const content = JSON.stringify({ to: 'ada@example.test', email: verifyEmail });
    const otherPurpose = Buffer.from(await sealer.seal(content, 'connection.access_token')).toString(
      'base64',
    );
    await expect(
      openNotifyEmail(
        sealer,
        parseNotifyDispatch({ channel: 'email', sealed: otherPurpose }) as EmailDispatch,
      ),
    ).rejects.toThrow();
    const noEmail = Buffer.from(await sealer.seal('{"to":"ada@example.test"}', 'notify.email')).toString(
      'base64',
    );
    await expect(
      openNotifyEmail(sealer, parseNotifyDispatch({ channel: 'email', sealed: noEmail }) as EmailDispatch),
    ).rejects.toThrow();
  });

  it('adds one job per outbox event and one email per event and recipient, kept for their ids', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const producer = new NotificationProducer({ add } as unknown as Queue, testSealer());
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
      { channel: 'email', sealed: expect.any(String) as unknown },
      { ...NOTIFY_EVENT_JOB_OPTIONS, jobId: `ntf.${event.eventId}.${userId}` },
    );
    expect(NOTIFY_EVENT_JOB_OPTIONS.removeOnComplete).toEqual({ age: 24 * 60 * 60 });
  });

  it('refuses events that the core does not know', async () => {
    const add = vi.fn();
    const producer = new NotificationProducer({ add } as unknown as Queue, testSealer());
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
