import { audienceOf } from '../domain/rules';
import type { NotificationContent, NotificationRecipient, NotificationRequest } from '../domain/types';
import type {
  NotificationDirectory,
  NotificationInbox,
  NotificationMailer,
  NotificationScope,
} from '../ports/notification-store';

// Delivers the notification of an outbox event (guide step 4.9, ADR 0025): reads what it is
// about, finds its recipients and gives each the channels they want. Running it again after a
// failure is harmless: the in-app notification exists once per user and event, the email job
// once per event and recipient.

export interface DeliverNotificationInput {
  eventId: string;
  organizationId: string;
  workspaceId: string;
  request: NotificationRequest;
}

export interface DeliveryReport {
  recipients: number;
  inApp: number;
  emails: number;
}

export class DeliverNotification {
  constructor(
    private readonly deps: {
      directory: NotificationDirectory;
      inbox: NotificationInbox;
      mailer: NotificationMailer;
    },
  ) {}

  async execute(input: DeliverNotificationInput): Promise<DeliveryReport> {
    const scope: NotificationScope = { organizationId: input.organizationId, workspaceId: input.workspaceId };
    const described = await this.deps.directory.describe(scope, input.request);
    if (!described) {
      return { recipients: 0, inApp: 0, emails: 0 };
    }
    const recipients = await this.recipientsOf(scope, described.content);
    const report: DeliveryReport = { recipients: recipients.length, inApp: 0, emails: 0 };
    for (const recipient of recipients) {
      const channels = await this.deps.inbox.channelsOf(recipient.userId, input.request.type);
      if (
        channels.inApp &&
        (await this.deps.inbox.addOnce(recipient.userId, {
          eventId: input.eventId,
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
          content: described.content,
        }))
      ) {
        report.inApp += 1;
      }
      if (channels.email) {
        await this.deps.mailer.send({
          eventId: input.eventId,
          recipient,
          workspace: described.workspace,
          content: described.content,
        });
        report.emails += 1;
      }
    }
    return report;
  }

  /** The author of a post, else the owners and admins; each user once. */
  private async recipientsOf(
    scope: NotificationScope,
    content: NotificationContent,
  ): Promise<NotificationRecipient[]> {
    let recipients: NotificationRecipient[] = [];
    if (audienceOf(content.type) === 'post_author' && 'postId' in content) {
      recipients = await this.deps.directory.postAuthor(scope, content.postId);
    }
    if (recipients.length === 0) {
      recipients = await this.deps.directory.channelManagers(scope);
    }
    return [...new Map(recipients.map((recipient) => [recipient.userId, recipient])).values()];
  }
}
