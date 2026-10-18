import { Logger } from '@nestjs/common';
import type { InvitationMessage } from '@smp/core';
import type { TenancyReadModel } from '@smp/db';
import type { NotificationProducer } from '@smp/queue';
import type Redis from 'ioredis';
import { beforeAll, describe, expect, it } from 'vitest';

import type { ApiEnv } from '../../config/api-env';
import { INVITATION_MAILS_PER_ADDRESS_AND_HOUR, QueueInvitationNotifier } from './invitation-notifier';

// Guide step 8.4: anyone can invite any address, so an address gets at most five invitation
// emails an hour, from all organizations together. The rest are dropped; the invitations stay.

/** The counter script of the notifier: INCR, with the expiry set on the first hit. */
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
  url: string;
}

function setUp() {
  const queued: QueuedEmail[] = [];
  const notifications = {
    dispatchEmail: (to: string, email: Omit<QueuedEmail, 'to'>) => {
      queued.push({ to, template: email.template, url: email.url });
      return Promise.resolve();
    },
  } as unknown as NotificationProducer;
  const readModel = {
    invitationMailContext: () =>
      Promise.resolve({ locale: 'de', organizationName: 'Acme', inviterName: 'Ada' }),
  } as unknown as TenancyReadModel;
  const env = { APP_URL: 'https://app.example.test' } as ApiEnv;
  const redis = new CountingRedis();
  const notifier = new QueueInvitationNotifier(notifications, readModel, env, redis as unknown as Redis);
  return { queued, redis, notifier };
}

const invitation = (email: string, n: number): InvitationMessage => ({
  invitationId: `invitation-${String(n)}`,
  organizationId: `organization-${String(n % 3)}`,
  email,
  token: `token-${String(n)}`,
  role: 'EDITOR',
  inviterUserId: 'user-1',
  expiresAt: new Date('2026-10-25T09:00:00Z'),
});

describe('QueueInvitationNotifier', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  it('queues the invitation with the link of the web app', async () => {
    const { queued, notifier } = setUp();
    await notifier.invitationCreated(invitation('grace@example.test', 1));

    expect(queued).toEqual([
      {
        to: 'grace@example.test',
        template: 'invitation',
        url: 'https://app.example.test/invite/token-1',
      },
    ]);
  });

  it('sends an address at most five invitations an hour, from all organizations together', async () => {
    const { queued, redis, notifier } = setUp();
    for (let n = 0; n < INVITATION_MAILS_PER_ADDRESS_AND_HOUR + 3; n += 1) {
      await notifier.invitationCreated(invitation('grace@example.test', n));
    }
    await notifier.invitationCreated(invitation('linus@example.test', 99));

    expect(queued.filter((email) => email.to === 'grace@example.test')).toHaveLength(
      INVITATION_MAILS_PER_ADDRESS_AND_HOUR,
    );
    expect(queued.filter((email) => email.to === 'linus@example.test')).toHaveLength(1);
    // The counter keys hold a digest of the address, never the address, and live for an hour.
    expect([...redis.counts.keys()].join(' ')).not.toContain('example.test');
    expect([...redis.expiries.values()]).toEqual([3600, 3600]);
  });

  it('counts an address the same way whatever its case and spaces', async () => {
    const { queued, notifier } = setUp();
    for (let n = 0; n < INVITATION_MAILS_PER_ADDRESS_AND_HOUR; n += 1) {
      await notifier.invitationCreated(invitation('grace@example.test', n));
    }
    await notifier.invitationCreated(invitation(' Grace@Example.TEST ', 9));

    expect(queued).toHaveLength(INVITATION_MAILS_PER_ADDRESS_AND_HOUR);
  });
});
