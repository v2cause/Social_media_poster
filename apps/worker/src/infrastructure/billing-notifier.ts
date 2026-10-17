import { toLocale } from '@smp/contracts';
import type { BillingNotifier, ReadOnlyReason } from '@smp/core';
import type { BillingContact } from '@smp/db';
import type { NotificationProducer } from '@smp/queue';

// The billing emails to the owners of an organization (guide step 7.4): one each, in the language
// and the time zone of the owner, through the queue of the role "notify". Its link leads to the
// billing page of the organization. The id of the Stripe event keys every email, so an event that
// runs again sends none twice; the moment keys the notice of read-only access the same way.

export class EmailBillingNotifier implements BillingNotifier {
  constructor(
    private readonly deps: {
      directory: {
        owners(
          organizationId: string,
        ): Promise<{ organizationName: string; owners: BillingContact[] } | null>;
      };
      notifications: Pick<NotificationProducer, 'dispatchEventEmail'>;
      /** The web app, without a trailing slash. */
      appUrl: string;
    },
  ) {}

  async paymentFailed(notice: { eventId: string; organizationId: string; graceEndsAt: Date }): Promise<void> {
    const organization = await this.deps.directory.owners(notice.organizationId);
    if (!organization) {
      return;
    }
    for (const owner of organization.owners) {
      await this.deps.notifications.dispatchEventEmail(notice.eventId, owner.userId, owner.email, {
        template: 'billing-payment-failed',
        locale: toLocale(owner.locale),
        name: owner.name,
        url: `${this.deps.appUrl}/org/${notice.organizationId}/billing`,
        organizationName: organization.organizationName,
        graceEndsAt: notice.graceEndsAt.toISOString(),
        timeZone: owner.timezone,
      });
    }
  }

  async readOnly(notice: {
    organizationId: string;
    readOnlyAt: Date;
    reason: ReadOnlyReason;
  }): Promise<void> {
    const organization = await this.deps.directory.owners(notice.organizationId);
    if (!organization) {
      return;
    }
    const key = `read-only.${notice.organizationId}.${String(notice.readOnlyAt.getTime())}`;
    for (const owner of organization.owners) {
      await this.deps.notifications.dispatchEventEmail(key, owner.userId, owner.email, {
        template: 'billing-read-only',
        locale: toLocale(owner.locale),
        name: owner.name,
        url: `${this.deps.appUrl}/org/${notice.organizationId}/billing`,
        organizationName: organization.organizationName,
        reason: notice.reason,
      });
    }
  }
}
