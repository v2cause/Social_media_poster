import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  isTick,
  parsePublishVariant,
  parseStripeWebhook,
  publishDeadLetterSchema,
  parseTokenRefresh,
  parseXbCommand,
  parseXbResult,
  TICK_SCHEDULES,
  TICKS,
} from './index';

// The payloads of the queues of architecture 7.4 are validated when added and when processed.

const ids = { organizationId: randomUUID(), workspaceId: randomUUID() };

describe('queue payloads', () => {
  it('accepts a publish job and refuses one without a valid schedule version or trace context', () => {
    const job = { ...ids, variantId: randomUUID(), scheduleVersion: 2, trigger: 'schedule' };
    expect(parsePublishVariant(job)).toEqual(job);
    expect(
      parsePublishVariant({ ...job, traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' }),
    ).toHaveProperty('traceparent');
    expect(() => parsePublishVariant({ ...job, scheduleVersion: -1 })).toThrow();
    expect(() => parsePublishVariant({ ...job, trigger: 'later' })).toThrow();
    expect(() => parsePublishVariant({ ...job, traceparent: 'not-a-trace' })).toThrow();
  });

  it('keeps the reason and the time of a dead letter next to the ids of its job', () => {
    const job = { ...ids, variantId: randomUUID(), scheduleVersion: 2, trigger: 'schedule' };
    const letter = {
      ...job,
      failedReason: 'VALIDATION_REJECTED',
      attemptsMade: 1,
      failedAt: '2026-10-16T12:00:00.000Z',
    };
    expect(publishDeadLetterSchema.parse(letter)).toEqual(letter);
    expect(() => publishDeadLetterSchema.parse({ ...letter, failedReason: 'x'.repeat(1_001) })).toThrow();
    expect(() => publishDeadLetterSchema.parse({ ...letter, failedAt: 'yesterday' })).toThrow();
  });

  it('carries ids only, except for the browser worker', () => {
    expect(() =>
      parseTokenRefresh({ ...ids, connectionId: randomUUID(), accessToken: 'secret' }),
    ).not.toThrow();
    // Unknown keys are dropped, so no token travels through Redis by accident.
    expect(
      parseTokenRefresh({ ...ids, connectionId: randomUUID(), accessToken: 'secret' }),
    ).not.toHaveProperty('accessToken');
    const command = {
      workspaceId: ids.workspaceId,
      accountId: randomUUID(),
      session: Buffer.from('sealed').toString('base64'),
      variantId: randomUUID(),
      scheduleVersion: 1,
      text: 'Hallo',
      media: [{ url: 'https://storage.example/a.jpg', altText: null }],
    };
    expect(parseXbCommand('publish', command)).toEqual(command);
    expect(() => parseXbCommand('publish', { ...command, session: 'not base64!' })).toThrow();
    expect(
      parseXbResult({
        operation: 'publish',
        targetId: command.variantId,
        version: 1,
        ok: false,
        error: { code: 'CHALLENGE_REQUIRED', message: 'Login challenge' },
      }),
    ).toHaveProperty('error.code', 'CHALLENGE_REQUIRED');
    expect(() => parseStripeWebhook({ eventId: 'evt_123' })).not.toThrow();
    expect(() => parseStripeWebhook({ eventId: 'ch_123' })).toThrow();
  });

  it('schedules every tick of the architecture', () => {
    for (const tick of TICKS) {
      expect(TICK_SCHEDULES[tick], tick).toBeDefined();
      expect(isTick(tick)).toBe(true);
    }
    expect(TICK_SCHEDULES['tick.outbox-relay']).toEqual({ every: 1_000 });
    expect(TICK_SCHEDULES['tick.publish']).toEqual({ every: 15_000 });
    expect(isTick('tick.unknown')).toBe(false);
  });
});
