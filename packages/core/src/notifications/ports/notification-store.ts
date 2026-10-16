import type {
  NotificationChannels,
  NotificationContent,
  NotificationRecipient,
  NotificationRequest,
  NotificationType,
  NotificationWorkspace,
} from '../domain/types';

// What the delivery of a notification needs (guide step 4.9, ADR 0025). The directory reads in
// the tenant of the event; the inbox writes per recipient, because notifications and their
// settings belong to one user each (architecture 6.3); the mailer queues one email per event and
// recipient.

export interface NotificationScope {
  organizationId: string;
  workspaceId: string;
}

export interface NotificationDirectory {
  /** The workspace and what the notification shows; null when its subject is gone. */
  describe(
    scope: NotificationScope,
    request: NotificationRequest,
  ): Promise<{ workspace: NotificationWorkspace; content: NotificationContent } | null>;
  /** The owners and admins of the organization. */
  channelManagers(scope: NotificationScope): Promise<NotificationRecipient[]>;
  /** The author of the post while a member with access to the workspace; none otherwise. */
  postAuthor(scope: NotificationScope, postId: string): Promise<NotificationRecipient[]>;
}

export interface InAppNotification {
  /** The outbox event the notification comes from. */
  eventId: string;
  organizationId: string;
  workspaceId: string;
  content: NotificationContent;
}

export interface NotificationInbox {
  /** How the user wants this type; without a setting both channels are on. */
  channelsOf(userId: string, type: NotificationType): Promise<NotificationChannels>;
  /** Adds the notification of an event for the user once; false when it is there already. */
  addOnce(userId: string, notification: InAppNotification): Promise<boolean>;
}

export interface NotificationEmail {
  eventId: string;
  recipient: NotificationRecipient;
  workspace: NotificationWorkspace;
  content: NotificationContent;
}

export interface NotificationMailer {
  /** Queues the email of an event for one recipient; a second call for both changes nothing. */
  send(email: NotificationEmail): Promise<void>;
}
