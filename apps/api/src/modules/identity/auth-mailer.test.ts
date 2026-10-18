import { Logger } from '@nestjs/common';
import type { NotificationProducer } from '@smp/queue';
import type Redis from 'ioredis';
import { beforeAll, describe, expect, it } from 'vitest';

import { AUTH_MAILS_PER_ADDRESS_AND_HOUR, AuthMailer } from './auth-mailer';

// Guide step 8.4: sign-up, resend and reset can be asked for any address, so an address gets at
// most five emails of the auth flows an hour. The rest are dropped; the requests answer the same.

/** The counter script of the mailer: INCR, with the expiry set on the first hit. */
class CountingRedis {
  readonly counts = new Map<string, number>();
  readonly expiries = new Map<string, number>();

  eval(_script: string, _keys: number, key: string, seconds: string): Promise<number> {
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    if (count === 1) {
      this.expiries.set(key, Number(seconds));
    }
    return Promise.resolve(count);
  }
}

interface QueuedEmail {
  to: string;
  template: string;
  locale: string;
  name: string;
  url: string;
}

function setUp() {
  const queued: QueuedEmail[] = [];
  const notifications = {
    dispatchEmail: (to: string, email: Omit<QueuedEmail, 'to'>) => {
      queued.push({ to, ...email });
      return Promise.resolve();
    },
  } as unknown as NotificationProducer;
  const redis = new CountingRedis();
  return { queued, redis, mailer: new AuthMailer(notifications, redis as unknown as Redis) };
}

describe('AuthMailer', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  it('queues the emails of the auth flows in the language of the user', async () => {
    const { queued, mailer } = setUp();
    await mailer.sendVerificationEmail({ email: 'ada@example.test', name: 'Ada', locale: 'en' }, 'https://a');
    await mailer.sendResetPassword({ email: 'linus@example.test', name: 'Linus' }, 'https://b');
    await mailer.sendExistingAccountNotice(
      { email: 'grace@example.test', name: 'Grace', locale: 'de' },
      'https://c',
    );

    expect(queued).toEqual([
      { to: 'ada@example.test', template: 'verify-email', locale: 'en', name: 'Ada', url: 'https://a' },
      { to: 'linus@example.test', template: 'reset-password', locale: 'de', name: 'Linus', url: 'https://b' },
      {
        to: 'grace@example.test',
        template: 'existing-account',
        locale: 'de',
        name: 'Grace',
        url: 'https://c',
      },
    ]);
  });

  it('sends an address at most five emails an hour, whatever the flow, and drops the rest', async () => {
    const { queued, redis, mailer } = setUp();
    const target = { email: 'Target@Example.test', name: 'Target' };
    for (let index = 0; index < AUTH_MAILS_PER_ADDRESS_AND_HOUR + 2; index += 1) {
      await mailer.sendVerificationEmail(target, `https://verify/${String(index)}`);
    }
    await mailer.sendResetPassword({ ...target, email: 'target@example.test' }, 'https://reset');
    await mailer.sendExistingAccountNotice({ email: 'other@example.test', name: 'Other' }, 'https://login');

    expect(queued.filter((email) => email.to !== 'other@example.test')).toHaveLength(
      AUTH_MAILS_PER_ADDRESS_AND_HOUR,
    );
    expect(queued.at(-1)).toMatchObject({ to: 'other@example.test', template: 'existing-account' });
    // One counter per address, whatever its case, named by a digest and living for an hour.
    expect([...redis.counts.values()]).toEqual([AUTH_MAILS_PER_ADDRESS_AND_HOUR + 3, 1]);
    expect([...redis.expiries.values()]).toEqual([3600, 3600]);
    expect([...redis.counts.keys()].join(' ')).not.toMatch(/example/i);
  });
});
