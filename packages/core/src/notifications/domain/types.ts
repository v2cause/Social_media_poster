import type { Platform } from '@smp/platform-rules';

import type { PublishFailureCode } from '../../publishing/domain/publish-job';

// The notifications of events (guide step 4.9, ADR 0025): a token runs out, a connection needs a
// new grant, a post failed or needs a decision. A use case writes the request into the outbox
// with its change; the role "notify" reads the rest from the database, finds the recipients and
// delivers in the app and by email, as each recipient wants it.

export const NOTIFICATION_TYPES = [
  'token-expiring',
  'reauth-required',
  'publish-failed',
  'needs-attention',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_CHANNELS = ['IN_APP', 'EMAIL'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/** What happened, with the ids to read the rest from the database. */
export type NotificationRequest =
  | {
      type: 'token-expiring';
      connectionId: string;
      /** The stage of the reminder: 14, 7 or 1 days before the access runs out. */
      daysLeft: number;
      expiresAt: string;
    }
  | {
      type: 'reauth-required';
      connectionId: string;
      /** For example EXPIRED, REFRESH_FAILED or CHALLENGE_REQUIRED. */
      reason: string;
      /** The scheduled variants of its accounts that are marked now. */
      scheduledVariants: number;
    }
  | { type: 'publish-failed'; variantId: string; failureCode: PublishFailureCode }
  | { type: 'needs-attention'; variantId: string; failureCode: PublishFailureCode };

/** What a notification shows, read from the database when it is delivered. */
export type NotificationContent =
  | {
      type: 'token-expiring';
      connectionId: string;
      platform: Platform;
      /** The connected accounts of the connection. */
      accounts: string[];
      daysLeft: number;
      expiresAt: string;
    }
  | {
      type: 'reauth-required';
      connectionId: string;
      platform: Platform;
      accounts: string[];
      reason: string;
      scheduledVariants: number;
    }
  | {
      type: 'publish-failed';
      postId: string;
      variantId: string;
      platform: Platform;
      accounts: string[];
      /** The beginning of the text. */
      preview: string;
      failureCode: PublishFailureCode;
    }
  | {
      type: 'needs-attention';
      postId: string;
      variantId: string;
      platform: Platform;
      accounts: string[];
      preview: string;
      failureCode: PublishFailureCode;
    };

/** The workspace a notification is about, for links and dates. */
export interface NotificationWorkspace {
  id: string;
  slug: string;
  name: string;
  timeZone: string;
}

export interface NotificationRecipient {
  userId: string;
  email: string;
  name: string | null;
  locale: 'de' | 'en';
}

/** How a recipient wants a type of notification; without a setting both channels are on. */
export interface NotificationChannels {
  inApp: boolean;
  email: boolean;
}
