import { toLocale } from '@smp/contracts';
import type { GdprNotifier } from '@smp/core';
import type { BillingContact } from '@smp/db';
import type { NotificationProducer } from '@smp/queue';

// The email after the deletion of an organization (guide step 8.2, ADR 0037): every owner hears
// on which day it is erased for good and how to take the deletion back, in the language and the
// time zone of that owner, through the queue of the role "notify". The link leads to the data
// page of the organization, where the owners restore it or export its data first.

export class EmailErasureNotifier implements Pick<GdprNotifier, 'erasureScheduled'> {
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

  async erasureScheduled(notice: {
    requestId: string;
    organizationId: string;
    eraseAfter: Date;
  }): Promise<void> {
    const organization = await this.deps.directory.owners(notice.organizationId);
    if (!organization) {
      return;
    }
    // The id of the request keys every email, so a retry sends none twice.
    for (const owner of organization.owners) {
      await this.deps.notifications.dispatchEventEmail(
        `erasure.${notice.requestId}`,
        owner.userId,
        owner.email,
        {
          template: 'gdpr-erasure-scheduled',
          locale: toLocale(owner.locale),
          name: owner.name,
          url: `${this.deps.appUrl}/org/${notice.organizationId}/data`,
          organizationName: organization.organizationName,
          eraseAfter: notice.eraseAfter.toISOString(),
          timeZone: owner.timezone,
        },
      );
    }
  }
}
