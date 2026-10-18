import { toLocale } from '@smp/contracts';
import type { GdprNotifier } from '@smp/core';
import type { BillingContact } from '@smp/db';
import type { NotificationProducer } from '@smp/queue';

// The emails of data protection (guide step 8.1): the owner who asked for an export hears that it
// is ready, in the language and the time zone of that owner, through the queue of the role
// "notify". When that owner has left the organization or is no owner any more, every owner hears
// it. The link leads to the data page of the organization; the archive itself is never linked.

export class EmailGdprNotifier implements GdprNotifier {
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

  async exportReady(notice: {
    requestId: string;
    organizationId: string;
    requestedById: string | null;
    expiresAt: Date;
  }): Promise<void> {
    const organization = await this.deps.directory.owners(notice.organizationId);
    if (!organization) {
      return;
    }
    const requester = organization.owners.filter((owner) => owner.userId === notice.requestedById);
    // The id of the request keys every email, so a job that runs again sends none twice.
    for (const owner of requester.length > 0 ? requester : organization.owners) {
      await this.deps.notifications.dispatchEventEmail(
        `export.${notice.requestId}`,
        owner.userId,
        owner.email,
        {
          template: 'gdpr-export-ready',
          locale: toLocale(owner.locale),
          name: owner.name,
          url: `${this.deps.appUrl}/org/${notice.organizationId}/data`,
          organizationName: organization.organizationName,
          expiresAt: notice.expiresAt.toISOString(),
          timeZone: owner.timezone,
        },
      );
    }
  }
}
